//! Contexte des rédactions IA du panneau Git : ce que voit le modèle pour écrire un
//! message de commit (fichiers choisis) ou une PR (branche contre sa base). Diff
//! partagé équitablement entre les fichiers et coupé sur des fins de ligne, fichiers de
//! secrets exclus, valeurs sensibles masquées.

use crate::git::{
    current_branch, detect_main_branch, git_output, require_repo_root, status_files,
    validate_git_paths,
};
use crate::*;

use super::masque::{fichier_bruit, fichier_secret, masquer};

/// Arbre vide de git : base du diff quand le dépôt n'a pas encore de commit.
const ARBRE_VIDE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
pub(crate) const BUDGET_COMMIT: usize = 24_000;
pub(crate) const BUDGET_PR: usize = 32_000;
/// Fichier non suivi plus gros : seul son nom part.
const NOUVEAU_MAX: u64 = 200_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContexteInput {
    pub(crate) workspace_path: String,
    pub(crate) genre: String,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
    #[serde(default)]
    pub(crate) base: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FichierContexte {
    pub(crate) chemin: String,
    pub(crate) ajouts: Option<u32>,
    pub(crate) suppressions: Option<u32>,
    pub(crate) statut: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContexteIa {
    pub(crate) genre: String,
    pub(crate) branche: Option<String>,
    pub(crate) base: Option<String>,
    pub(crate) fichiers: Vec<FichierContexte>,
    pub(crate) diff: String,
    pub(crate) tronque: bool,
    pub(crate) masques: u32,
    pub(crate) exclus: Vec<String>,
    pub(crate) commits_recents: Vec<String>,
    pub(crate) commits_branche: Vec<String>,
}

#[tauri::command]
pub(crate) async fn git_contexte_ia_command(
    input: ContexteInput,
) -> std::result::Result<ContexteIa, String> {
    let workspace_root =
        normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let repo = require_repo_root(&workspace_root).map_err(error_to_string)?;
    match input.genre.as_str() {
        "commit" => contexte_commit(&repo, &input.paths, BUDGET_COMMIT),
        "pr" => contexte_pr(&repo, input.base.as_deref(), BUDGET_PR),
        autre => Err(anyhow::anyhow!("genre de rédaction inconnu : {autre}")),
    }
    .map_err(error_to_string)
}

fn sortie(repo: &Path, args: &[&str]) -> Result<String> {
    let out = git_output(repo, args)?;
    if !out.success {
        anyhow::bail!("échec de git {} : {}", args.join(" "), out.stderr.trim());
    }
    Ok(out.stdout)
}

fn tete_valide(repo: &Path) -> Result<bool> {
    Ok(git_output(repo, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.success)
}

fn derniers_sujets(repo: &Path, args: &[&str]) -> Result<Vec<String>> {
    let out = git_output(repo, args)?;
    if !out.success {
        return Ok(Vec::new());
    }
    Ok(out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| l.chars().take(200).collect())
        .collect())
}

pub(crate) fn contexte_commit(repo: &Path, paths: &[String], budget: usize) -> Result<ContexteIa> {
    let choisis = validate_git_paths(paths)?;
    if choisis.is_empty() {
        anyhow::bail!("sélectionnez au moins un fichier à valider");
    }
    let statuts = status_files(repo)?;
    let tete = tete_valide(repo)?;
    let base = if tete { "HEAD" } else { ARBRE_VIDE };
    let mut suivis: Vec<String> = Vec::new();
    let mut nouveaux: Vec<String> = Vec::new();
    for chemin in &choisis {
        let Some(statut) = statuts.iter().find(|s| &s.path == chemin) else {
            continue;
        };
        if statut.kind == "untracked" {
            nouveaux.push(chemin.clone());
        } else {
            suivis.push(chemin.clone());
            if let Some(ancien) = &statut.old_path {
                suivis.push(ancien.clone());
            }
        }
    }
    let mut fichiers = Vec::new();
    let mut sections = Vec::new();
    if !suivis.is_empty() {
        let mut args = vec!["diff", "--numstat", "-z", "-M", base, "--"];
        args.extend(suivis.iter().map(String::as_str));
        fichiers.extend(lire_numstat(&sortie(repo, &args)?));
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M", "--unified=3", base, "--"];
        args.extend(suivis.iter().map(String::as_str));
        sections.extend(decouper_diff(&sortie(repo, &args)?));
    }
    for chemin in &nouveaux {
        let complet = repo.join(chemin);
        let taille = fs::metadata(&complet).map(|m| m.len()).unwrap_or(0);
        if taille > NOUVEAU_MAX || fichier_secret(chemin) || fichier_bruit(chemin) {
            fichiers.push(FichierContexte { chemin: chemin.clone(), ajouts: None, suppressions: None, statut: "nouveau".into() });
            sections.push((chemin.clone(), format!("diff --git a/{chemin} b/{chemin}\nnew file\n")));
            continue;
        }
        let out = git_output(repo, &["diff", "--no-color", "--no-index", "--", "/dev/null", chemin])?;
        let texte = out.stdout;
        let ajouts = texte.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count() as u32;
        let binaire = texte.contains("Binary files");
        fichiers.push(FichierContexte {
            chemin: chemin.clone(),
            ajouts: (!binaire).then_some(ajouts),
            suppressions: (!binaire).then_some(0),
            statut: "nouveau".into(),
        });
        sections.extend(decouper_diff(&texte).into_iter().map(|(_, s)| (chemin.clone(), s)));
    }
    let (diff, tronque, masques, exclus) = preparer(sections, budget);
    let commits_recents = if tete {
        derniers_sujets(repo, &["log", "-n", "12", "--no-merges", "--format=%s"])?
    } else {
        Vec::new()
    };
    Ok(ContexteIa {
        genre: "commit".into(),
        branche: current_branch(repo)?,
        base: None,
        fichiers,
        diff,
        tronque,
        masques,
        exclus,
        commits_recents,
        commits_branche: Vec::new(),
    })
}

pub(crate) fn contexte_pr(repo: &Path, base: Option<&str>, budget: usize) -> Result<ContexteIa> {
    let branche = current_branch(repo)?
        .ok_or_else(|| anyhow::anyhow!("HEAD détachée : placez-vous sur une branche"))?;
    let base = base
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(ToOwned::to_owned)
        .or(detect_main_branch(repo)?)
        .ok_or_else(|| anyhow::anyhow!("branche cible introuvable"))?;
    if base == branche {
        anyhow::bail!("la branche cible est la branche actuelle ({branche})");
    }
    // La base distante si elle existe (plus à jour que la copie locale).
    let distante = format!("origin/{base}");
    let reference = if git_output(repo, &["rev-parse", "--verify", "--quiet", &format!("{distante}^{{commit}}")])?.success {
        distante
    } else {
        base.clone()
    };
    let point = sortie(repo, &["merge-base", &reference, "HEAD"])
        .map_err(|_| anyhow::anyhow!("aucun ancêtre commun entre {branche} et {reference}"))?;
    let point = point.trim().to_string();
    let intervalle = format!("{point}..HEAD");
    let commits_branche =
        derniers_sujets(repo, &["log", "-n", "50", "--no-merges", "--format=%s", &intervalle])?;
    let fichiers = lire_numstat(&sortie(repo, &["diff", "--numstat", "-z", "-M", &point, "HEAD"])?);
    let sections = decouper_diff(&sortie(
        repo,
        &["diff", "--no-color", "--no-ext-diff", "-M", "--unified=3", &point, "HEAD"],
    )?);
    let (diff, tronque, masques, exclus) = preparer(sections, budget);
    Ok(ContexteIa {
        genre: "pr".into(),
        branche: Some(branche),
        base: Some(base),
        fichiers,
        diff,
        tronque,
        masques,
        exclus,
        commits_recents: Vec::new(),
        commits_branche,
    })
}

/// `git diff --numstat -z` : « a\td\tchemin\0 » ou, pour un renommage, « a\td\t\0avant\0après\0 ».
pub(crate) fn lire_numstat(brut: &str) -> Vec<FichierContexte> {
    let mut fichiers = Vec::new();
    let mut morceaux = brut.split('\0').peekable();
    while let Some(entree) = morceaux.next() {
        let entree = entree.trim_start_matches('\n');
        if entree.is_empty() {
            continue;
        }
        let mut cols = entree.splitn(3, '\t');
        let (Some(a), Some(d), Some(chemin)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let nombre = |v: &str| v.parse::<u32>().ok();
        let (chemin, statut) = if chemin.is_empty() {
            let _avant = morceaux.next().unwrap_or_default();
            (morceaux.next().unwrap_or_default().to_string(), "renommé")
        } else {
            (chemin.to_string(), "modifié")
        };
        fichiers.push(FichierContexte {
            chemin,
            ajouts: nombre(a),
            suppressions: nombre(d),
            statut: statut.into(),
        });
    }
    fichiers
}

/// Coupe un diff en sections par fichier : (chemin, texte de la section).
pub(crate) fn decouper_diff(diff: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    for ligne in diff.split_inclusive('\n') {
        if let Some(entete) = ligne.strip_prefix("diff --git ") {
            let chemin = entete
                .trim_end()
                .rsplit_once(" b/")
                .map(|(_, b)| b.trim_matches('"').to_string())
                .unwrap_or_else(|| entete.trim().to_string());
            sections.push((chemin, String::new()));
        }
        if let Some((_, texte)) = sections.last_mut() {
            texte.push_str(ligne);
        }
    }
    sections
}

/// Exclut, masque et tronque : (diff, tronqué, masques, exclus).
pub(crate) fn preparer(sections: Vec<(String, String)>, budget: usize) -> (String, bool, u32, Vec<String>) {
    let mut gardees = Vec::new();
    let mut exclus = Vec::new();
    let mut masques = 0;
    for (chemin, texte) in sections {
        if fichier_secret(&chemin) {
            exclus.push(format!("{chemin} (secret)"));
            continue;
        }
        if fichier_bruit(&chemin) {
            exclus.push(format!("{chemin} (fichier généré)"));
            continue;
        }
        let (propre, n) = masquer(&texte);
        masques += n;
        gardees.push(propre);
    }
    let (diff, tronque) = tronquer(&gardees, budget);
    (diff, tronque, masques, exclus)
}

/// Partage `budget` entre les sections (un gros fichier ne mange pas les petits) et
/// coupe chacune sur une fin de ligne, avec le nombre de lignes coupées.
pub(crate) fn tronquer(sections: &[String], budget: usize) -> (String, bool) {
    let total: usize = sections.iter().map(String::len).sum();
    if total <= budget {
        return (sections.concat(), false);
    }
    let mut parts = vec![0usize; sections.len()];
    let mut ordre: Vec<usize> = (0..sections.len()).collect();
    ordre.sort_by_key(|&i| sections[i].len());
    let mut reste = budget;
    for (k, &i) in ordre.iter().enumerate() {
        let restants = sections.len() - k;
        let part = (reste / restants).min(sections[i].len());
        parts[i] = part;
        reste -= part;
    }
    let mut sortie = String::with_capacity(budget + 64 * sections.len());
    for (texte, part) in sections.iter().zip(parts) {
        sortie.push_str(&couper_section(texte, part));
    }
    (sortie, true)
}

fn couper_section(texte: &str, limite: usize) -> String {
    if texte.len() <= limite {
        return texte.to_string();
    }
    // Au moins l'en-tête : le modèle sait que le fichier change.
    let entete = texte.find('\n').map(|i| i + 1).unwrap_or(texte.len());
    let mut coupe = limite.max(entete).min(texte.len());
    while !texte.is_char_boundary(coupe) {
        coupe -= 1;
    }
    if let Some(fin_ligne) = texte[..coupe].rfind('\n') {
        if fin_ligne + 1 >= coupe / 2 || fin_ligne + 1 >= entete {
            coupe = fin_ligne + 1;
        }
    }
    let lignes_coupees = texte[coupe..].lines().count();
    let mut s = texte[..coupe].to_string();
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(&format!("[… {lignes_coupees} ligne(s) coupée(s) …]\n"));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn depot(nom: &str) -> PathBuf {
        let racine = std::env::temp_dir().join(format!(
            "axecode-contexte-{nom}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&racine).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
        ] {
            assert!(git_output(&racine, &args).unwrap().success);
        }
        fs::canonicalize(&racine).unwrap()
    }

    fn commit(repo: &Path, fichier: &str, contenu: &str, message: &str) {
        if let Some(parent) = repo.join(fichier).parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(repo.join(fichier), contenu).unwrap();
        assert!(git_output(repo, &["add", fichier]).unwrap().success);
        assert!(git_output(repo, &["commit", "-m", message]).unwrap().success);
    }

    #[test]
    fn commit_avec_style_fichiers_choisis_et_secrets_exclus() {
        let repo = depot("commit");
        commit(&repo, "src/a.rs", "fn a() {}\n", "ajout de a");
        commit(&repo, "src/b.rs", "fn b() {}\n", "Banc : ajout de b");
        fs::write(repo.join("src/a.rs"), "fn a() { println!(\"a\"); }\nconst TOKEN: &str = \"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\";\n").unwrap();
        fs::write(repo.join("src/b.rs"), "fn b() { /* pas choisi */ }\n").unwrap();
        fs::write(repo.join(".env"), "API_KEY=tres-secret-123456\n").unwrap();
        fs::write(repo.join("nouveau.txt"), "ligne 1\nligne 2\n").unwrap();
        let paths = ["src/a.rs", ".env", "nouveau.txt"].map(String::from);
        let ctx = contexte_commit(&repo, &paths, BUDGET_COMMIT).unwrap();
        assert_eq!(ctx.commits_recents, vec!["Banc : ajout de b", "ajout de a"]);
        assert_eq!(ctx.branche.as_deref(), Some("main"));
        assert!(ctx.diff.contains("println!"), "{}", ctx.diff);
        assert!(!ctx.diff.contains("pas choisi"));
        assert!(!ctx.diff.contains("ghp_ABC") && ctx.masques >= 1, "{}", ctx.diff);
        assert!(!ctx.diff.contains("tres-secret"));
        assert!(ctx.exclus.iter().any(|e| e.starts_with(".env")), "{:?}", ctx.exclus);
        assert!(ctx.diff.contains("+ligne 2"));
        let a = ctx.fichiers.iter().find(|f| f.chemin == "src/a.rs").unwrap();
        assert_eq!((a.ajouts, a.suppressions), (Some(2), Some(1)));
        let n = ctx.fichiers.iter().find(|f| f.chemin == "nouveau.txt").unwrap();
        assert_eq!((n.ajouts, n.statut.as_str()), (Some(2), "nouveau"));
        assert!(!ctx.tronque);
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn premier_commit_sans_historique() {
        let repo = depot("premier");
        fs::write(repo.join("lisez-moi.md"), "# Projet\n").unwrap();
        assert!(git_output(&repo, &["add", "lisez-moi.md"]).unwrap().success);
        let ctx = contexte_commit(&repo, &["lisez-moi.md".to_string()], BUDGET_COMMIT).unwrap();
        assert!(ctx.diff.contains("+# Projet"), "{}", ctx.diff);
        assert!(ctx.commits_recents.is_empty());
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn pr_compare_la_branche_a_sa_base() {
        let repo = depot("pr");
        commit(&repo, "a.txt", "a\n", "initial");
        assert!(git_output(&repo, &["checkout", "-b", "fonction"]).unwrap().success);
        commit(&repo, "b.txt", "b\n", "ajoute b");
        commit(&repo, "a.txt", "a2\n", "change a");
        let ctx = contexte_pr(&repo, Some("main"), BUDGET_PR).unwrap();
        assert_eq!(ctx.commits_branche, vec!["change a", "ajoute b"]);
        assert_eq!(ctx.base.as_deref(), Some("main"));
        assert_eq!(ctx.fichiers.len(), 2);
        assert!(ctx.diff.contains("+a2") && ctx.diff.contains("+b"));
        assert!(contexte_pr(&repo, Some("fonction"), BUDGET_PR).is_err());
        fs::remove_dir_all(repo).ok();
    }

    #[test]
    fn gros_diff_partage_et_coupe_sur_des_lignes() {
        let gros = format!("diff --git a/gros b/gros\n{}", "+ligne générée très longue\n".repeat(2000));
        let petit = "diff --git a/petit b/petit\n+une ligne\n".to_string();
        let (diff, tronque) = tronquer(&[gros.clone(), petit.clone()], 2_000);
        assert!(tronque);
        assert!(diff.contains(&petit), "le petit fichier reste entier");
        assert!(diff.len() < 2_200, "{}", diff.len());
        assert!(diff.contains("ligne(s) coupée(s)"));
        for ligne in diff.lines() {
            assert!(ligne == "+ligne générée très longue" || !ligne.starts_with("+ligne"), "ligne coupée au milieu : {ligne}");
        }
    }

    #[test]
    fn numstat_avec_renommage_et_binaire() {
        let brut = "3\t1\tsrc/a.rs\0-\t-\timage.png\0\x002\t0\t\0ancien.rs\0nouveau.rs\0";
        let f = lire_numstat(brut);
        assert_eq!(f.len(), 3, "{f:?}");
        assert_eq!((f[0].ajouts, f[0].suppressions), (Some(3), Some(1)));
        assert_eq!(f[1].ajouts, None);
        assert_eq!((f[2].chemin.as_str(), f[2].statut.as_str()), ("nouveau.rs", "renommé"));
    }

    #[test]
    fn decoupage_par_fichier() {
        let diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n+1\ndiff --git a/dossier/y z b/dossier/y z\n+2\n";
        let s = decouper_diff(diff);
        assert_eq!(s.len(), 2);
        assert_eq!(s[1].0, "dossier/y z");
        assert!(s[0].1.ends_with("+1\n"));
    }
}
