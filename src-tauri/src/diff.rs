//! Revue des changements : fichiers modifiés par rapport à
//! HEAD (non indexés / indexés) ou à une branche de base, textes avant / après
//! d'un fichier pour le diff Monaco, et indexation d'un bloc ou de lignes
//! choisies : patch partiel construit sur les blocs de `git diff -U0`, appliqué
//! par `git apply --cached` (désindexer : `-R`, annuler : `-R` sur le fichier).
//! Les chemins rendus au front sont relatifs au dossier ouvert (`--relative`).

use crate::*;
use std::process::Stdio;
use std::sync::OnceLock;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Au-delà, le texte n'est pas envoyé au diff (actions sur le fichier entier seulement).
const TAILLE_MAX: usize = 1_500_000;

pub(crate) struct Sortie {
    pub(crate) ok: bool,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}

impl Sortie {
    pub(crate) fn texte(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    fn message(&self) -> String {
        let err = self.stderr.trim();
        if err.is_empty() {
            String::from_utf8_lossy(&self.stdout).trim().to_string()
        } else {
            err.to_string()
        }
    }
}

/// Exécutable git : PATH, puis les dossiers d'installation habituels de Git for Windows.
pub(crate) fn git_exe() -> &'static Path {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let noms: &[&str] = if cfg!(windows) { &["git.exe", "git.cmd"] } else { &["git"] };
        let mut dossiers: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        if cfg!(windows) {
            for racine in [r"C:\Program Files\Git", r"C:\Program Files (x86)\Git"] {
                dossiers.push(Path::new(racine).join("cmd"));
                dossiers.push(Path::new(racine).join("bin"));
            }
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                dossiers.push(PathBuf::from(local).join("Programs").join("Git").join("cmd"));
            }
        }
        for dossier in dossiers {
            for nom in noms {
                let candidat = dossier.join(nom);
                if candidat.is_file() {
                    return candidat;
                }
            }
        }
        PathBuf::from("git")
    })
}

/// Lance git dans `racine` (entrée standard facultative, jamais de console ni d'invite).
pub(crate) fn git(
    racine: &Path,
    args: &[&str],
    entree: Option<&[u8]>,
    env: &[(&str, &str)],
) -> Result<Sortie> {
    let mut commande = Command::new(git_exe());
    #[cfg(target_os = "windows")]
    commande.creation_flags(0x0800_0000);
    commande
        .arg("-C")
        .arg(racine)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if entree.is_some() { Stdio::piped() } else { Stdio::null() });
    for (cle, valeur) in env {
        commande.env(cle, valeur);
    }
    let mut enfant = commande
        .spawn()
        .context("Git est introuvable : installez Git puis relancez l'application")?;
    if let Some(donnees) = entree {
        if let Some(mut stdin) = enfant.stdin.take() {
            stdin.write_all(donnees).context("écriture vers git")?;
        }
    }
    let sortie = enfant.wait_with_output().context("git n'a pas répondu")?;
    Ok(Sortie {
        ok: sortie.status.success(),
        stdout: sortie.stdout,
        stderr: String::from_utf8_lossy(&sortie.stderr).into_owned(),
    })
}

/// Comme `git`, mais un échec devient une erreur lisible.
pub(crate) fn git_ok(racine: &Path, args: &[&str]) -> Result<Sortie> {
    let sortie = git(racine, args, None, &[])?;
    if !sortie.ok {
        anyhow::bail!("git {} : {}", args.first().copied().unwrap_or(""), sortie.message());
    }
    Ok(sortie)
}

/// Dépôt d'un dossier ouvert : racine du dépôt et préfixe du dossier (« » ou « sous/dossier/ »).
pub(crate) struct Depot {
    pub(crate) racine: PathBuf,
    pub(crate) prefixe: String,
}

impl Depot {
    pub(crate) fn ouvrir(dossier: &str) -> Result<Depot> {
        if dossier.starts_with("axe-cloud://") {
            anyhow::bail!("La revue des changements ne marche que pour les dossiers de ce PC.");
        }
        let normal = normalize_workspace_root(dossier)?;
        let local = axecode_app::workspace::os_path(&normal);
        let sortie = git(&local, &["rev-parse", "--show-toplevel", "--show-prefix"], None, &[])?;
        if !sortie.ok {
            anyhow::bail!("Ce dossier n'est pas un dépôt Git.");
        }
        let texte = sortie.texte();
        let mut lignes = texte.lines();
        let racine = lignes.next().unwrap_or("").trim().to_string();
        if racine.is_empty() {
            anyhow::bail!("Ce dossier n'est pas un dépôt Git.");
        }
        let prefixe = lignes.next().unwrap_or("").trim().to_string();
        Ok(Depot { racine: PathBuf::from(racine), prefixe })
    }

    /// Chemin relatif à la racine du dépôt (pour git) d'un chemin relatif au dossier.
    pub(crate) fn chemin_depot(&self, chemin: &str) -> Result<String> {
        let propre = chemin.replace('\\', "/");
        if propre.is_empty()
            || propre.starts_with('/')
            || propre.contains(':')
            || propre.split('/').any(|p| p == ".." || p == "." || p.is_empty())
        {
            anyhow::bail!("chemin refusé : {chemin}");
        }
        Ok(format!("{}{}", self.prefixe, propre))
    }

    pub(crate) fn a_un_commit(&self) -> bool {
        git(&self.racine, &["rev-parse", "--verify", "--quiet", "HEAD"], None, &[])
            .map(|s| s.ok)
            .unwrap_or(false)
    }

    /// Contenu d'un objet (`:chemin`, `HEAD:chemin`, `<commit>:chemin`), None s'il n'existe pas.
    pub(crate) fn blob(&self, objet: &str) -> Option<Vec<u8>> {
        let sortie = git(&self.racine, &["cat-file", "blob", objet], None, &[]).ok()?;
        sortie.ok.then_some(sortie.stdout)
    }

    pub(crate) fn fichier(&self, chemin_depot: &str) -> Option<Vec<u8>> {
        let chemin = self.racine.join(chemin_depot);
        if chemin.is_file() {
            fs::read(chemin).ok()
        } else {
            None
        }
    }

    pub(crate) fn dans_index(&self, chemin_depot: &str) -> bool {
        git(&self.racine, &["ls-files", "-s", "--", chemin_depot], None, &[])
            .map(|s| s.ok && !s.stdout.is_empty())
            .unwrap_or(false)
    }

    pub(crate) fn branche(&self) -> Option<String> {
        let s = git(&self.racine, &["branch", "--show-current"], None, &[]).ok()?;
        let nom = s.texte().trim().to_string();
        (s.ok && !nom.is_empty()).then_some(nom)
    }
}

/// Octets nuls dans le début du contenu : binaire (même règle que git).
pub(crate) fn est_binaire(contenu: &[u8]) -> bool {
    contenu.iter().take(8000).any(|&o| o == 0)
}

/// FNV-1a 64 bits : empreinte des textes affichés (détecte un fichier changé entre-temps).
pub(crate) fn empreinte(parties: &[Option<&[u8]>]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for partie in parties {
        let octets: &[u8] = partie.unwrap_or(b"\xff\xfeabsent");
        for &o in octets.iter().chain(b"\xff\x00") {
            h ^= u64::from(o);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

// ---------------------------------------------------------------------------
// Liste des fichiers modifiés

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FichierRevue {
    /// Relatif au dossier ouvert, séparateur « / ».
    pub(crate) chemin: String,
    /// « non-indexe » (index → fichier), « indexe » (HEAD → index), « base » (branche → fichier), « conflit ».
    pub(crate) groupe: String,
    /// Lettre de git : M, A, D, T, U, ou « ? » (non suivi).
    pub(crate) statut: String,
    pub(crate) ajouts: Option<u32>,
    pub(crate) suppressions: Option<u32>,
    pub(crate) binaire: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListeRevue {
    pub(crate) branche: Option<String>,
    /// « HEAD » ou nom de la branche de base.
    pub(crate) base: String,
    /// Commit de comparaison (ancêtre commun avec la branche de base), court.
    pub(crate) base_commit: Option<String>,
    pub(crate) branche_principale: Option<String>,
    pub(crate) branches: Vec<String>,
    pub(crate) fichiers: Vec<FichierRevue>,
    /// Fusion, rebase, cherry-pick ou revert en cours (vue des conflits).
    pub(crate) operation: Option<String>,
    pub(crate) conflits: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListeInput {
    pub(crate) workspace_path: String,
    pub(crate) base: Option<String>,
}

/// `git diff --numstat -z` : (ajouts, suppressions, chemin) ; « - » = binaire.
pub(crate) fn analyser_numstat(brut: &[u8]) -> Vec<(Option<u32>, Option<u32>, String)> {
    let texte = String::from_utf8_lossy(brut);
    let mut sortie = Vec::new();
    for entree in texte.split('\0').filter(|e| !e.trim().is_empty()) {
        let mut champs = entree.splitn(3, '\t');
        let (Some(a), Some(s), Some(chemin)) = (champs.next(), champs.next(), champs.next()) else {
            continue;
        };
        sortie.push((a.trim().parse().ok(), s.trim().parse().ok(), chemin.to_string()));
    }
    sortie
}

/// `git diff --name-status -z` : (lettre, chemin).
pub(crate) fn analyser_statuts(brut: &[u8]) -> Vec<(String, String)> {
    let texte = String::from_utf8_lossy(brut);
    let mut morceaux = texte.split('\0').filter(|e| !e.is_empty());
    let mut sortie = Vec::new();
    while let Some(lettre) = morceaux.next() {
        let Some(chemin) = morceaux.next() else { break };
        sortie.push((lettre.chars().next().unwrap_or('M').to_string(), chemin.to_string()));
    }
    sortie
}

fn compter_lignes(contenu: &[u8]) -> u32 {
    if contenu.is_empty() {
        return 0;
    }
    let n = contenu.iter().filter(|&&o| o == b'\n').count() as u32;
    if contenu.ends_with(b"\n") { n } else { n + 1 }
}

impl Depot {
    fn relative(&self) -> Option<String> {
        (!self.prefixe.is_empty()).then(|| format!("--relative={}", self.prefixe))
    }

    /// Fichiers d'un `git diff` (arguments de comparaison donnés), groupe imposé.
    fn fichiers_diff(&self, comparaison: &[&str], groupe: &str) -> Result<Vec<FichierRevue>> {
        let relative = self.relative();
        let mut base: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "--no-renames", "--no-textconv", "-z"];
        if let Some(r) = relative.as_deref() {
            base.push(r);
        }
        let mut numstat = base.clone();
        numstat.push("--numstat");
        numstat.extend_from_slice(comparaison);
        let mut statuts = base;
        statuts.push("--name-status");
        statuts.extend_from_slice(comparaison);
        let compte = analyser_numstat(&git_ok(&self.racine, &numstat)?.stdout);
        let lettres: HashMap<String, String> =
            analyser_statuts(&git_ok(&self.racine, &statuts)?.stdout).into_iter().map(|(l, c)| (c, l)).collect();
        Ok(compte
            .into_iter()
            .map(|(ajouts, suppressions, chemin)| {
                let statut = lettres.get(&chemin).cloned().unwrap_or_else(|| "M".into());
                let groupe = if statut == "U" { "conflit" } else { groupe };
                FichierRevue {
                    binaire: ajouts.is_none() && suppressions.is_none(),
                    chemin,
                    groupe: groupe.to_string(),
                    statut,
                    ajouts,
                    suppressions,
                }
            })
            .collect())
    }

    /// Fichiers non suivis du dossier (lignes comptées si texte).
    fn non_suivis(&self) -> Result<Vec<FichierRevue>> {
        let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z"];
        let prefixe = self.prefixe.clone();
        if !prefixe.is_empty() {
            args.push("--");
            args.push(&prefixe);
        }
        let brut = git_ok(&self.racine, &args)?.stdout;
        let texte = String::from_utf8_lossy(&brut);
        let mut sortie = Vec::new();
        for chemin_depot in texte.split('\0').filter(|c| !c.is_empty()) {
            let chemin = chemin_depot.strip_prefix(prefixe.as_str()).unwrap_or(chemin_depot).to_string();
            let contenu = self.fichier(chemin_depot);
            let binaire = contenu.as_deref().map(est_binaire).unwrap_or(false);
            let grand = contenu.as_ref().map(|c| c.len() > TAILLE_MAX).unwrap_or(false);
            sortie.push(FichierRevue {
                chemin,
                groupe: "non-indexe".into(),
                statut: "?".into(),
                ajouts: (!binaire && !grand).then(|| contenu.as_deref().map(compter_lignes).unwrap_or(0)),
                suppressions: (!binaire && !grand).then_some(0),
                binaire,
            });
        }
        Ok(sortie)
    }

    pub(crate) fn branches(&self) -> Vec<String> {
        let Ok(s) = git_ok(&self.racine, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]) else {
            return Vec::new();
        };
        s.texte()
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty() && !n.ends_with("/HEAD") && !n.contains("HEAD ->"))
            .map(ToOwned::to_owned)
            .collect()
    }

    pub(crate) fn branche_principale(&self, branches: &[String]) -> Option<String> {
        if let Ok(s) = git(&self.racine, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], None, &[]) {
            let nom = s.texte().trim().to_string();
            if s.ok {
                if let Some((_, court)) = nom.split_once('/') {
                    if branches.iter().any(|b| b == court) {
                        return Some(court.to_string());
                    }
                    return Some(nom);
                }
            }
        }
        ["main", "master", "trunk"].iter().find(|c| branches.iter().any(|b| b == *c)).map(|c| c.to_string())
    }

    /// Ancêtre commun entre la branche de base et HEAD.
    pub(crate) fn ancetre(&self, base: &str) -> Result<String> {
        if base.starts_with('-') {
            anyhow::bail!("branche refusée : {base}");
        }
        let s = git(&self.racine, &["merge-base", base, "HEAD"], None, &[])?;
        let sha = s.texte().trim().to_string();
        if !s.ok || sha.is_empty() {
            anyhow::bail!("Pas d'ancêtre commun entre « {base} » et la branche actuelle.");
        }
        Ok(sha)
    }
}

/// Une base vide ou « HEAD » = comparer au dernier commit.
fn base_branche(base: Option<&str>) -> Option<&str> {
    base.map(str::trim).filter(|b| !b.is_empty() && *b != "HEAD")
}

pub(crate) fn liste(dossier: &str, base: Option<&str>) -> Result<ListeRevue> {
    let depot = Depot::ouvrir(dossier)?;
    let branches = depot.branches();
    let mut fichiers = Vec::new();
    let mut base_commit = None;
    match base_branche(base) {
        None => {
            fichiers.extend(depot.fichiers_diff(&[], "non-indexe")?);
            fichiers.extend(depot.non_suivis()?);
            // Sans commit, « --cached » compare l'index à l'arbre vide.
            fichiers.extend(depot.fichiers_diff(&["--cached"], "indexe")?.into_iter().filter(|f| f.groupe != "conflit"));
        }
        Some(nom) => {
            let sha = depot.ancetre(nom)?;
            fichiers.extend(depot.fichiers_diff(&[sha.as_str()], "base")?);
            fichiers.extend(depot.non_suivis()?.into_iter().map(|f| FichierRevue { groupe: "base".into(), ..f }));
            base_commit = Some(sha.chars().take(10).collect());
        }
    }
    let conflits_etat = crate::conflits::operation(&depot);
    let conflits = fichiers.iter().filter(|f| f.groupe == "conflit").count();
    Ok(ListeRevue {
        branche: depot.branche(),
        base: base_branche(base).unwrap_or("HEAD").to_string(),
        base_commit,
        branche_principale: depot.branche_principale(&branches),
        branches,
        fichiers,
        operation: conflits_etat,
        conflits,
    })
}

#[tauri::command]
pub(crate) async fn revue_liste(input: ListeInput) -> std::result::Result<ListeRevue, String> {
    tauri::async_runtime::spawn_blocking(move || liste(&input.workspace_path, input.base.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Diff d'un fichier : textes avant / après pour Monaco

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffRevue {
    pub(crate) chemin: String,
    pub(crate) groupe: String,
    /// Texte de gauche (None : le fichier n'existe pas de ce côté).
    pub(crate) ancien: Option<String>,
    pub(crate) nouveau: Option<String>,
    pub(crate) binaire: bool,
    pub(crate) trop_gros: bool,
    /// Fichier non suivi (indexation partielle : `git add -N` d'abord).
    pub(crate) non_suivi: bool,
    /// Empreinte des deux textes : une action partielle est refusée s'ils ont changé.
    pub(crate) empreinte: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffInput {
    pub(crate) workspace_path: String,
    pub(crate) chemin: String,
    pub(crate) groupe: String,
    pub(crate) base: Option<String>,
}

pub(crate) struct Cotes {
    pub(crate) ancien: Option<Vec<u8>>,
    pub(crate) nouveau: Option<Vec<u8>>,
    pub(crate) non_suivi: bool,
}

impl Depot {
    /// Les deux côtés d'un fichier selon le groupe (octets bruts).
    pub(crate) fn cotes(&self, chemin_depot: &str, groupe: &str, base: Option<&str>) -> Result<Cotes> {
        match groupe {
            "non-indexe" => {
                let dans_index = self.dans_index(chemin_depot);
                Ok(Cotes {
                    ancien: if dans_index { self.blob(&format!(":{chemin_depot}")) } else { None },
                    nouveau: self.fichier(chemin_depot),
                    non_suivi: !dans_index,
                })
            }
            "indexe" => Ok(Cotes {
                ancien: if self.a_un_commit() { self.blob(&format!("HEAD:{chemin_depot}")) } else { None },
                nouveau: self.blob(&format!(":{chemin_depot}")),
                non_suivi: false,
            }),
            "base" => {
                let nom = base_branche(base).ok_or_else(|| anyhow::anyhow!("branche de base manquante"))?;
                let sha = self.ancetre(nom)?;
                Ok(Cotes {
                    ancien: self.blob(&format!("{sha}:{chemin_depot}")),
                    nouveau: self.fichier(chemin_depot),
                    non_suivi: !self.dans_index(chemin_depot),
                })
            }
            autre => anyhow::bail!("groupe inconnu : {autre}"),
        }
    }
}

pub(crate) fn diff_fichier(dossier: &str, chemin: &str, groupe: &str, base: Option<&str>) -> Result<DiffRevue> {
    let depot = Depot::ouvrir(dossier)?;
    let chemin_depot = depot.chemin_depot(chemin)?;
    let cotes = depot.cotes(&chemin_depot, groupe, base)?;
    let empreinte = empreinte(&[cotes.ancien.as_deref(), cotes.nouveau.as_deref()]);
    let binaire = cotes.ancien.as_deref().map(est_binaire).unwrap_or(false)
        || cotes.nouveau.as_deref().map(est_binaire).unwrap_or(false);
    let trop_gros = cotes.ancien.as_ref().map(|c| c.len() > TAILLE_MAX).unwrap_or(false)
        || cotes.nouveau.as_ref().map(|c| c.len() > TAILLE_MAX).unwrap_or(false);
    let texte = |c: Option<Vec<u8>>| -> Option<String> {
        if binaire || trop_gros {
            return None;
        }
        c.map(|o| String::from_utf8_lossy(&o).into_owned())
    };
    Ok(DiffRevue {
        chemin: chemin.to_string(),
        groupe: groupe.to_string(),
        ancien: texte(cotes.ancien),
        nouveau: texte(cotes.nouveau),
        binaire,
        trop_gros,
        non_suivi: cotes.non_suivi,
        empreinte,
    })
}

#[tauri::command]
pub(crate) async fn revue_diff(input: DiffInput) -> std::result::Result<DiffRevue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff_fichier(&input.workspace_path, &input.chemin, &input.groupe, input.base.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Indexation partielle : blocs de `git diff -U0`, patch des lignes choisies

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    Contexte,
    Moins,
    Plus,
}

#[derive(Debug, Clone)]
pub(crate) struct LigneDiff {
    pub(crate) op: Op,
    /// Sans le caractère d'opération ni la fin de ligne.
    pub(crate) texte: Vec<u8>,
    /// Suivie de « \ No newline at end of file ».
    pub(crate) sans_fin: bool,
    /// Numéro côté ancien (contexte, moins), 0 sinon.
    pub(crate) ancien: u32,
    /// Numéro côté nouveau (contexte, plus), 0 sinon.
    pub(crate) nouveau: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct Morceau {
    pub(crate) ancien_debut: u32,
    pub(crate) ancien_nombre: u32,
    pub(crate) nouveau_debut: u32,
    pub(crate) nouveau_nombre: u32,
    pub(crate) lignes: Vec<LigneDiff>,
}

/// Lignes choisies dans l'affichage : numéros côté ancien et côté nouveau (1 = première ligne).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Lignes {
    #[serde(default)]
    pub(crate) anciennes: Vec<u32>,
    #[serde(default)]
    pub(crate) nouvelles: Vec<u32>,
}

fn plage(texte: &str) -> Option<(u32, u32)> {
    let mut parties = texte.splitn(2, ',');
    let debut = parties.next()?.parse().ok()?;
    let nombre = match parties.next() {
        Some(n) => n.parse().ok()?,
        None => 1,
    };
    Some((debut, nombre))
}

/// Morceaux (« hunks ») d'une sortie de `git diff` pour un seul fichier.
pub(crate) fn analyser_morceaux(brut: &[u8]) -> Vec<Morceau> {
    let mut morceaux: Vec<Morceau> = Vec::new();
    let (mut a, mut n) = (0u32, 0u32);
    for ligne in brut.split(|&o| o == b'\n') {
        if ligne.starts_with(b"@@ ") {
            let texte = String::from_utf8_lossy(ligne);
            let mut champs = texte.split_whitespace().skip(1);
            let ancien = champs.next().and_then(|c| c.strip_prefix('-')).and_then(plage);
            let nouveau = champs.next().and_then(|c| c.strip_prefix('+')).and_then(plage);
            if let (Some((ad, an)), Some((nd, nn))) = (ancien, nouveau) {
                a = if an == 0 { ad + 1 } else { ad };
                n = if nn == 0 { nd + 1 } else { nd };
                morceaux.push(Morceau { ancien_debut: ad, ancien_nombre: an, nouveau_debut: nd, nouveau_nombre: nn, lignes: Vec::new() });
            }
            continue;
        }
        let Some(m) = morceaux.last_mut() else { continue };
        match ligne.first() {
            Some(b' ') => {
                m.lignes.push(LigneDiff { op: Op::Contexte, texte: ligne[1..].to_vec(), sans_fin: false, ancien: a, nouveau: n });
                a += 1;
                n += 1;
            }
            Some(b'-') => {
                m.lignes.push(LigneDiff { op: Op::Moins, texte: ligne[1..].to_vec(), sans_fin: false, ancien: a, nouveau: 0 });
                a += 1;
            }
            Some(b'+') => {
                m.lignes.push(LigneDiff { op: Op::Plus, texte: ligne[1..].to_vec(), sans_fin: false, ancien: 0, nouveau: n });
                n += 1;
            }
            Some(b'\\') => {
                if let Some(derniere) = m.lignes.last_mut() {
                    derniere.sans_fin = true;
                }
            }
            _ => {}
        }
    }
    morceaux
}

/// Lignes choisies d'un bloc ; une ligne qui ne change que par la fin de ligne
/// (dernière ligne du fichier) suit les lignes ajoutées ou retirées après elle.
fn choisir(moins: &[&LigneDiff], plus: &[&LigneDiff], sel: &Lignes) -> (Vec<bool>, Vec<bool>) {
    let mut cm: Vec<bool> = moins.iter().map(|l| sel.anciennes.contains(&l.ancien)).collect();
    let mut cp: Vec<bool> = plus.iter().map(|l| sel.nouvelles.contains(&l.nouveau)).collect();
    for (i, m) in moins.iter().enumerate() {
        for (j, p) in plus.iter().enumerate() {
            if m.texte != p.texte || m.sans_fin == p.sans_fin {
                continue;
            }
            // m sans fin de ligne : la ligne en reçoit une si on ajoute après elle ;
            // p sans fin de ligne : elle la perd si on retire ce qui la suivait.
            let suite = if m.sans_fin { cp[j + 1..].iter().any(|&c| c) } else { cm[i + 1..].iter().any(|&c| c) };
            if suite || cm[i] || cp[j] {
                cm[i] = true;
                cp[j] = true;
            }
        }
    }
    (cm, cp)
}

/// Lignes du patch partiel d'un morceau. `inverse` : patch appliqué avec `-R`
/// (désindexer, annuler) : le côté nouveau reste entier, le côté ancien ne garde
/// que les lignes à rétablir. Sinon le côté ancien reste entier.
fn lignes_partielles<'a>(m: &'a Morceau, sel: &Lignes, inverse: bool) -> Vec<(Op, &'a LigneDiff)> {
    let mut sortie = Vec::new();
    let mut i = 0;
    while i < m.lignes.len() {
        if m.lignes[i].op == Op::Contexte {
            sortie.push((Op::Contexte, &m.lignes[i]));
            i += 1;
            continue;
        }
        let debut = i;
        while i < m.lignes.len() && m.lignes[i].op != Op::Contexte {
            i += 1;
        }
        let bloc = &m.lignes[debut..i];
        let moins: Vec<&LigneDiff> = bloc.iter().filter(|l| l.op == Op::Moins).collect();
        let plus: Vec<&LigneDiff> = bloc.iter().filter(|l| l.op == Op::Plus).collect();
        let (cm, cp) = choisir(&moins, &plus, sel);
        let paires = moins.len() == plus.len();
        let garde_moins = |k: usize| if cm[k] { Op::Moins } else { Op::Contexte };
        let garde_plus = |k: usize| if cp[k] { Op::Plus } else { Op::Contexte };
        if paires {
            for k in 0..moins.len() {
                if inverse {
                    if cm[k] {
                        sortie.push((Op::Moins, moins[k]));
                    }
                    sortie.push((garde_plus(k), plus[k]));
                } else {
                    sortie.push((garde_moins(k), moins[k]));
                    if cp[k] {
                        sortie.push((Op::Plus, plus[k]));
                    }
                }
            }
        } else if inverse {
            sortie.extend(moins.iter().enumerate().filter(|(k, _)| cm[*k]).map(|(_, l)| (Op::Moins, *l)));
            sortie.extend(plus.iter().enumerate().map(|(k, l)| (garde_plus(k), *l)));
        } else {
            sortie.extend(moins.iter().enumerate().map(|(k, l)| (garde_moins(k), *l)));
            sortie.extend(plus.iter().enumerate().filter(|(k, _)| cp[*k]).map(|(_, l)| (Op::Plus, *l)));
        }
    }
    sortie
}

/// Début de l'autre côté d'un morceau à zéro contexte (conventions de `git diff -U0` :
/// un côté vide commence à la ligne d'avant).
fn autre_debut(debut_fixe: u32, n_fixe: u32, n_autre: u32, decalage: i64) -> u32 {
    let base = if n_fixe == 0 { i64::from(debut_fixe) + 1 } else { i64::from(debut_fixe) };
    let pos = base + decalage;
    (if n_autre == 0 { pos - 1 } else { pos }).max(0) as u32
}

/// Chemin pour l'en-tête d'un patch (guillemets de git si nécessaire).
fn chemin_patch(prefixe: &str, chemin: &str) -> String {
    if chemin.bytes().any(|o| matches!(o, b'"' | b'\\' | b'\t' | b'\n')) || chemin.starts_with(' ') || chemin.ends_with(' ') {
        let echappe = chemin.replace('\\', "\\\\").replace('"', "\\\"").replace('\t', "\\t").replace('\n', "\\n");
        format!("\"{prefixe}{echappe}\"")
    } else {
        format!("{prefixe}{chemin}")
    }
}

/// Patch des seules lignes choisies (None : aucune ligne modifiée choisie).
pub(crate) fn construire_patch(chemin_depot: &str, morceaux: &[Morceau], sel: &Lignes, inverse: bool) -> Option<Vec<u8>> {
    let mut corps: Vec<u8> = Vec::new();
    let mut decalage: i64 = 0;
    for m in morceaux {
        let lignes = lignes_partielles(m, sel, inverse);
        if lignes.iter().all(|(op, _)| *op == Op::Contexte) {
            continue;
        }
        let n_anc = lignes.iter().filter(|(op, _)| *op != Op::Plus).count() as u32;
        let n_nouv = lignes.iter().filter(|(op, _)| *op != Op::Moins).count() as u32;
        let (ad, nd) = if inverse {
            (autre_debut(m.nouveau_debut, m.nouveau_nombre, n_anc, decalage), m.nouveau_debut)
        } else {
            (m.ancien_debut, autre_debut(m.ancien_debut, m.ancien_nombre, n_nouv, decalage))
        };
        decalage += if inverse { i64::from(n_anc) - i64::from(n_nouv) } else { i64::from(n_nouv) - i64::from(n_anc) };
        corps.extend_from_slice(format!("@@ -{ad},{n_anc} +{nd},{n_nouv} @@\n").as_bytes());
        for (op, l) in lignes {
            corps.push(match op {
                Op::Contexte => b' ',
                Op::Moins => b'-',
                Op::Plus => b'+',
            });
            corps.extend_from_slice(&l.texte);
            corps.push(b'\n');
            if l.sans_fin {
                corps.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
    }
    if corps.is_empty() {
        return None;
    }
    let (a, b) = (chemin_patch("a/", chemin_depot), chemin_patch("b/", chemin_depot));
    let mut patch = format!("diff --git {a} {b}\n--- {a}\n+++ {b}\n").into_bytes();
    patch.extend_from_slice(&corps);
    Some(patch)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppliquerInput {
    pub(crate) workspace_path: String,
    pub(crate) chemin: String,
    pub(crate) groupe: String,
    /// « indexer » (non indexé), « desindexer » (indexé), « annuler » (non indexé).
    pub(crate) action: String,
    /// Absent : tout le fichier.
    pub(crate) lignes: Option<Lignes>,
    /// Empreinte rendue par `revue_diff` (obligatoire pour des lignes choisies).
    pub(crate) empreinte: Option<String>,
}

pub(crate) const FICHIER_CHANGE: &str = "Le fichier a changé depuis l'affichage : la vue est actualisée, refaites le choix.";

fn fichier_entier(depot: &Depot, p: &str, action: &str) -> Result<String> {
    match action {
        "indexer" => {
            git_ok(&depot.racine, &["add", "-A", "--", p])?;
            Ok("Fichier indexé.".into())
        }
        "desindexer" => {
            if depot.a_un_commit() {
                git_ok(&depot.racine, &["restore", "--staged", "--", p])?;
            } else {
                git_ok(&depot.racine, &["rm", "--cached", "--quiet", "--", p])?;
            }
            Ok("Fichier retiré de l'index.".into())
        }
        "annuler" => {
            if !depot.dans_index(p) {
                anyhow::bail!("Fichier non suivi : rien à annuler (supprimez-le depuis l'explorateur si besoin).");
            }
            git_ok(&depot.racine, &["restore", "--", p])?;
            Ok("Modifications du fichier annulées.".into())
        }
        autre => anyhow::bail!("action inconnue : {autre}"),
    }
}

pub(crate) fn appliquer(input: &AppliquerInput) -> Result<String> {
    let depot = Depot::ouvrir(&input.workspace_path)?;
    let p = depot.chemin_depot(&input.chemin)?;
    let action = input.action.as_str();
    match (input.groupe.as_str(), action) {
        ("non-indexe", "indexer") | ("non-indexe", "annuler") | ("indexe", "desindexer") => {}
        ("base", _) => anyhow::bail!("Comparaison avec une branche : choisissez « HEAD » pour indexer ou annuler."),
        (groupe, _) => anyhow::bail!("Action « {action} » impossible pour le groupe « {groupe} »."),
    }
    let Some(lignes) = input.lignes.as_ref() else {
        return fichier_entier(&depot, &p, action);
    };
    let cotes = depot.cotes(&p, &input.groupe, None)?;
    let actuelle = empreinte(&[cotes.ancien.as_deref(), cotes.nouveau.as_deref()]);
    if input.empreinte.as_deref() != Some(actuelle.as_str()) {
        anyhow::bail!(FICHIER_CHANGE);
    }
    if action == "annuler" && cotes.non_suivi {
        anyhow::bail!("Fichier non suivi : rien à annuler (supprimez-le depuis l'explorateur si besoin).");
    }
    if action == "annuler" && cotes.nouveau.is_none() {
        anyhow::bail!("Fichier supprimé : restaurez-le en entier.");
    }
    // Fichier non suivi : « intention d'ajout » pour que git diff le montre ligne à ligne.
    let intention = input.groupe == "non-indexe" && cotes.non_suivi;
    if intention {
        git_ok(&depot.racine, &["add", "-N", "--", &p])?;
    }
    let resultat = (|| -> Result<String> {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-renames", "--no-textconv", "-U0", "--inter-hunk-context=0"];
        if input.groupe == "indexe" {
            args.push("--cached");
        }
        args.push("--");
        args.push(&p);
        let brut = git_ok(&depot.racine, &args)?.stdout;
        let inverse = action != "indexer";
        let patch = construire_patch(&p, &analyser_morceaux(&brut), lignes, inverse)
            .ok_or_else(|| anyhow::anyhow!("Aucune ligne modifiée dans la sélection."))?;
        let mut apply = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
        if action != "annuler" {
            apply.push("--cached");
        }
        if inverse {
            apply.push("-R");
        }
        apply.push("-");
        let s = git(&depot.racine, &apply, Some(&patch), &[])?;
        if !s.ok {
            anyhow::bail!("git n'a pas pu appliquer ce choix : {}", s.message());
        }
        Ok(match action {
            "indexer" => "Lignes indexées.",
            "desindexer" => "Lignes retirées de l'index.",
            _ => "Lignes annulées dans le fichier.",
        }
        .into())
    })();
    if resultat.is_err() && intention {
        let _ = git(&depot.racine, &["rm", "--cached", "--quiet", "--", &p], None, &[]);
    }
    resultat
}

#[tauri::command]
pub(crate) async fn revue_appliquer(app: AppHandle, input: AppliquerInput) -> std::result::Result<String, String> {
    let dossier = input.workspace_path.clone();
    let annule = input.action == "annuler";
    let chemin = input.chemin.clone();
    let message = tauri::async_runtime::spawn_blocking(move || appliquer(&input))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if annule {
        // Le fichier a changé sur le disque : onglets et arbre se rechargent.
        if let Ok(racine) = normalize_workspace_root(&dossier) {
            crate::platform::emit_workspace_file_change(&app, &racine, &chemin);
        }
    }
    Ok(message)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Dépôt temporaire avec un premier commit (fichiers donnés).
    pub(crate) fn depot_temp(nom: &str, fichiers: &[(&str, &[u8])]) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dossier = std::env::temp_dir().join(format!(
            "axecode-revue-{nom}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dossier);
        fs::create_dir_all(&dossier).unwrap();
        let racine = fs::canonicalize(&dossier).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "core.autocrlf", "false"],
        ] {
            git_ok(&racine, args).unwrap();
        }
        for (chemin, contenu) in fichiers {
            ecrire(&racine, chemin, contenu);
        }
        if !fichiers.is_empty() {
            git_ok(&racine, &["add", "-A"]).unwrap();
            git_ok(&racine, &["commit", "-q", "-m", "initial"]).unwrap();
        }
        racine
    }

    pub(crate) fn ecrire(racine: &Path, chemin: &str, contenu: &[u8]) {
        let p = racine.join(chemin);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, contenu).unwrap();
    }

    fn index(racine: &Path, chemin: &str) -> String {
        String::from_utf8(git_ok(racine, &["cat-file", "blob", &format!(":{chemin}")]).unwrap().stdout).unwrap()
    }

    fn ws(racine: &Path) -> String {
        racine.display().to_string()
    }

    fn agir(racine: &Path, chemin: &str, groupe: &str, action: &str, anciennes: &[u32], nouvelles: &[u32]) -> Result<String> {
        let d = diff_fichier(&ws(racine), chemin, groupe, None)?;
        appliquer(&AppliquerInput {
            workspace_path: ws(racine),
            chemin: chemin.into(),
            groupe: groupe.into(),
            action: action.into(),
            lignes: Some(Lignes { anciennes: anciennes.to_vec(), nouvelles: nouvelles.to_vec() }),
            empreinte: Some(d.empreinte),
        })
    }

    #[test]
    fn liste_groupes_et_compteurs() {
        let r = depot_temp("liste", &[("a.txt", b"1\n2\n3\n"), ("b.txt", b"x\n")]);
        ecrire(&r, "a.txt", b"1\ndeux\n3\n4\n");
        ecrire(&r, "neuf.md", b"titre\ntexte\n");
        ecrire(&r, "b.txt", b"x\ny\n");
        git_ok(&r, &["add", "b.txt"]).unwrap();
        let l = liste(&ws(&r), None).unwrap();
        let trouve = |c: &str, g: &str| l.fichiers.iter().find(|f| f.chemin == c && f.groupe == g).cloned();
        let a = trouve("a.txt", "non-indexe").expect("a non indexé");
        assert_eq!((a.statut.as_str(), a.ajouts, a.suppressions), ("M", Some(2), Some(1)));
        let n = trouve("neuf.md", "non-indexe").expect("non suivi");
        assert_eq!((n.statut.as_str(), n.ajouts), ("?", Some(2)));
        assert_eq!(trouve("b.txt", "indexe").expect("b indexé").ajouts, Some(1));
        assert!(trouve("b.txt", "non-indexe").is_none());
        assert_eq!(l.base, "HEAD");
        assert_eq!(l.branche.as_deref(), Some("main"));
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn base_branche_et_sous_dossier() {
        let r = depot_temp("base", &[("sous/a.txt", b"1\n"), ("hors.txt", b"h\n")]);
        git_ok(&r, &["checkout", "-q", "-b", "travail"]).unwrap();
        ecrire(&r, "sous/a.txt", b"1\n2\n");
        git_ok(&r, &["commit", "-qam", "deux"]).unwrap();
        ecrire(&r, "sous/b.txt", b"b\n");
        ecrire(&r, "hors.txt", b"h\nh2\n");
        let sous = ws(&r.join("sous"));
        let l = liste(&sous, Some("main")).unwrap();
        let mut chemins: Vec<_> = l.fichiers.iter().map(|f| (f.chemin.clone(), f.groupe.clone())).collect();
        chemins.sort();
        assert_eq!(chemins, vec![("a.txt".to_string(), "base".to_string()), ("b.txt".into(), "base".into())]);
        let d = diff_fichier(&sous, "a.txt", "base", Some("main")).unwrap();
        assert_eq!((d.ancien.as_deref(), d.nouveau.as_deref()), (Some("1\n"), Some("1\n2\n")));
        assert!(appliquer(&AppliquerInput { workspace_path: sous, chemin: "a.txt".into(), groupe: "base".into(), action: "indexer".into(), lignes: None, empreinte: None }).is_err());
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn indexer_un_bloc_puis_des_lignes() {
        let r = depot_temp("indexer", &[("f.txt", b"l1\nl2\nl3\nl4\nl5\n")]);
        ecrire(&r, "f.txt", b"l1\nX2\nl3\nl4\nY5\nnew6\n");
        // Bloc 1 (l2 -> X2) seulement.
        agir(&r, "f.txt", "non-indexe", "indexer", &[2], &[2]).unwrap();
        assert_eq!(index(&r, "f.txt"), "l1\nX2\nl3\nl4\nl5\n");
        // Ligne « new6 » seule (bloc inégal : l5 -> Y5 + new6) : l5 reste.
        agir(&r, "f.txt", "non-indexe", "indexer", &[], &[6]).unwrap();
        assert_eq!(index(&r, "f.txt"), "l1\nX2\nl3\nl4\nl5\nnew6\n");
        // Désindexer la ligne X2 (côté nouveau de l'index) et l2 revient.
        agir(&r, "f.txt", "indexe", "desindexer", &[2], &[2]).unwrap();
        assert_eq!(index(&r, "f.txt"), "l1\nl2\nl3\nl4\nl5\nnew6\n");
        // Rien de choisi : erreur claire.
        let e = agir(&r, "f.txt", "non-indexe", "indexer", &[], &[1]).unwrap_err();
        assert!(e.to_string().contains("Aucune ligne"), "{e}");
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn annuler_des_lignes_garde_le_reste() {
        let r = depot_temp("annuler", &[("f.txt", b"a\nb\nc\nd\n")]);
        ecrire(&r, "f.txt", b"a\nB\nc\nd\ne\n");
        agir(&r, "f.txt", "non-indexe", "annuler", &[], &[5]).unwrap();
        assert_eq!(fs::read_to_string(r.join("f.txt")).unwrap(), "a\nB\nc\nd\n");
        agir(&r, "f.txt", "non-indexe", "annuler", &[2], &[2]).unwrap();
        assert_eq!(fs::read_to_string(r.join("f.txt")).unwrap(), "a\nb\nc\nd\n");
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn insertion_suppression_et_debut_de_fichier() {
        let r = depot_temp("bords", &[("f.txt", b"1\n2\n3\n4\n5\n6\n")]);
        ecrire(&r, "f.txt", b"0\n1\n2\n4\n5\n6\n7\n");
        // Trois blocs : +0 en tête, -3, +7 en fin ; on prend le dernier puis le premier.
        agir(&r, "f.txt", "non-indexe", "indexer", &[], &[7]).unwrap();
        assert_eq!(index(&r, "f.txt"), "1\n2\n3\n4\n5\n6\n7\n");
        agir(&r, "f.txt", "non-indexe", "indexer", &[], &[1]).unwrap();
        assert_eq!(index(&r, "f.txt"), "0\n1\n2\n3\n4\n5\n6\n7\n");
        agir(&r, "f.txt", "non-indexe", "indexer", &[4], &[]).unwrap();
        assert_eq!(index(&r, "f.txt"), "0\n1\n2\n4\n5\n6\n7\n");
        // Retour en arrière par blocs (désindexer la suppression puis l'ajout de tête).
        agir(&r, "f.txt", "indexe", "desindexer", &[3], &[]).unwrap();
        agir(&r, "f.txt", "indexe", "desindexer", &[], &[1]).unwrap();
        assert_eq!(index(&r, "f.txt"), "1\n2\n3\n4\n5\n6\n7\n");
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn fin_de_fichier_sans_retour_a_la_ligne() {
        let r = depot_temp("eof", &[("f.txt", b"a\nb")]);
        ecrire(&r, "f.txt", b"a\nb\nc\nd");
        // Monaco ne montre que l'ajout des lignes 3-4 ; « b » gagne sa fin de ligne avec elles.
        agir(&r, "f.txt", "non-indexe", "indexer", &[], &[3, 4]).unwrap();
        assert_eq!(index(&r, "f.txt"), "a\nb\nc\nd");
        fs::remove_dir_all(r).ok();
    }
}
