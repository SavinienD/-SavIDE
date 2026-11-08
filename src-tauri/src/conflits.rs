//! Conflits : fusion, rebase, cherry-pick ou revert arrêté
//! sur des conflits. Versions « base / nôtre / leur » d'un fichier, résultat
//! écrit puis marqué résolu (`git add`), « Continuer » et « Abandonner ».

use crate::diff::{git, git_ok, Depot};
use crate::*;

/// Opération en cours dans le dépôt : « fusion », « rebase », « cherry-pick », « revert ».
pub(crate) fn operation(depot: &Depot) -> Option<String> {
    let existe = |nom: &str| chemin_git(depot, nom).map(|p| p.exists()).unwrap_or(false);
    if existe("rebase-merge") || existe("rebase-apply") {
        Some("rebase".into())
    } else if existe("MERGE_HEAD") {
        Some("fusion".into())
    } else if existe("CHERRY_PICK_HEAD") {
        Some("cherry-pick".into())
    } else if existe("REVERT_HEAD") {
        Some("revert".into())
    } else {
        None
    }
}

fn chemin_git(depot: &Depot, nom: &str) -> Option<PathBuf> {
    let s = git(&depot.racine, &["rev-parse", "--git-path", nom], None, &[]).ok()?;
    let texte = s.texte().trim().to_string();
    if !s.ok || texte.is_empty() {
        return None;
    }
    let p = PathBuf::from(texte);
    Some(if p.is_absolute() { p } else { depot.racine.join(p) })
}

/// Codes de `git status` d'un fichier en conflit.
const CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FichierConflit {
    pub(crate) chemin: String,
    /// Code de git (UU : modifié des deux côtés, AA : ajouté des deux côtés, DU / UD : supprimé d'un côté…).
    pub(crate) code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EtatConflits {
    pub(crate) operation: Option<String>,
    /// Nom du côté « nôtre » (branche actuelle) et du côté « leur ».
    pub(crate) nous: String,
    pub(crate) eux: String,
    pub(crate) fichiers: Vec<FichierConflit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetailConflit {
    pub(crate) chemin: String,
    pub(crate) base: Option<String>,
    pub(crate) nous: Option<String>,
    pub(crate) eux: Option<String>,
    /// Fichier sur le disque, avec les marqueurs de conflit.
    pub(crate) resultat: Option<String>,
    pub(crate) binaire: bool,
}

fn nom_de(depot: &Depot, reference: &str) -> Option<String> {
    let s = git(&depot.racine, &["name-rev", "--name-only", "--always", reference], None, &[]).ok()?;
    let nom = s.texte().trim().to_string();
    (s.ok && !nom.is_empty()).then(|| nom.trim_start_matches("remotes/").to_string())
}

pub(crate) fn fichiers_en_conflit(depot: &Depot) -> Result<Vec<FichierConflit>> {
    let mut args = vec!["status", "--porcelain=v1", "-z", "--untracked-files=no"];
    let prefixe = depot.prefixe.clone();
    if !prefixe.is_empty() {
        args.push("--");
        args.push(&prefixe);
    }
    let s = git_ok(&depot.racine, &args)?;
    let texte = s.texte();
    let mut sortie = Vec::new();
    let mut morceaux = texte.split('\0').filter(|e| !e.is_empty());
    while let Some(entree) = morceaux.next() {
        if entree.len() < 4 {
            continue;
        }
        let code = &entree[..2];
        if code.starts_with('R') || code.starts_with('C') {
            morceaux.next();
        }
        if CODES.contains(&code) {
            let chemin = &entree[3..];
            sortie.push(FichierConflit {
                chemin: chemin.strip_prefix(prefixe.as_str()).unwrap_or(chemin).to_string(),
                code: code.to_string(),
            });
        }
    }
    Ok(sortie)
}

pub(crate) fn etat(dossier: &str) -> Result<EtatConflits> {
    let depot = Depot::ouvrir(dossier)?;
    let op = operation(&depot);
    let autre = match op.as_deref() {
        Some("fusion") => "MERGE_HEAD",
        Some("rebase") => "REBASE_HEAD",
        Some("cherry-pick") => "CHERRY_PICK_HEAD",
        Some("revert") => "REVERT_HEAD",
        _ => "MERGE_HEAD",
    };
    // Pendant un rebase, « nôtre » est la branche de destination (le commit rejoué est « le leur »).
    let nous = if op.as_deref() == Some("rebase") {
        chemin_git(&depot, "rebase-merge/onto")
            .or_else(|| chemin_git(&depot, "rebase-apply/onto"))
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|sha| nom_de(&depot, sha.trim()))
            .unwrap_or_else(|| "HEAD".into())
    } else {
        depot.branche().unwrap_or_else(|| "HEAD".into())
    };
    Ok(EtatConflits {
        eux: nom_de(&depot, autre).unwrap_or_else(|| "l'autre branche".into()),
        nous,
        fichiers: fichiers_en_conflit(&depot)?,
        operation: op,
    })
}

pub(crate) fn detail(dossier: &str, chemin: &str) -> Result<DetailConflit> {
    let depot = Depot::ouvrir(dossier)?;
    let p = depot.chemin_depot(chemin)?;
    let base = depot.blob(&format!(":1:{p}"));
    let nous = depot.blob(&format!(":2:{p}"));
    let eux = depot.blob(&format!(":3:{p}"));
    let resultat = depot.fichier(&p);
    let binaire = [&base, &nous, &eux, &resultat].iter().any(|c| c.as_deref().map(crate::diff::est_binaire).unwrap_or(false));
    let texte = |c: Option<Vec<u8>>| if binaire { None } else { c.map(|o| String::from_utf8_lossy(&o).into_owned()) };
    Ok(DetailConflit { chemin: chemin.to_string(), base: texte(base), nous: texte(nous), eux: texte(eux), resultat: texte(resultat), binaire })
}

/// Lignes de marqueur laissées par git (« <<<<<<< », « >>>>>>> »).
pub(crate) fn a_des_marqueurs(texte: &str) -> bool {
    texte.lines().any(|l| {
        let l = l.trim_end_matches('\r');
        (l.starts_with("<<<<<<<") || l.starts_with(">>>>>>>")) && (l.len() == 7 || l.as_bytes()[7] == b' ')
    })
}

pub(crate) const MARQUEURS_RESTANTS: &str = "Il reste des marqueurs de conflit (<<<<<<< ou >>>>>>>) : choisissez une version pour chaque bloc, ou corrigez le résultat.";

/// Écrit le résultat (s'il est donné) et, si demandé, marque le fichier résolu (`git add`).
/// `supprimer` : le fichier est retiré (conflit « supprimé d'un côté »).
pub(crate) fn resoudre(dossier: &str, chemin: &str, contenu: Option<&str>, supprimer: bool, marquer: bool) -> Result<String> {
    let depot = Depot::ouvrir(dossier)?;
    let p = depot.chemin_depot(chemin)?;
    if supprimer {
        git_ok(&depot.racine, &["rm", "--quiet", "--", &p])?;
        return Ok("Fichier supprimé et marqué résolu.".into());
    }
    if let Some(texte) = contenu {
        if marquer && a_des_marqueurs(texte) {
            anyhow::bail!(MARQUEURS_RESTANTS);
        }
        fs::write(depot.racine.join(&p), texte.as_bytes()).with_context(|| format!("écriture de {chemin}"))?;
    }
    if !marquer {
        return Ok("Résultat enregistré.".into());
    }
    if contenu.is_none() {
        if let Some(sur_disque) = depot.fichier(&p) {
            if a_des_marqueurs(&String::from_utf8_lossy(&sur_disque)) {
                anyhow::bail!(MARQUEURS_RESTANTS);
            }
        }
    }
    git_ok(&depot.racine, &["add", "--", &p])?;
    Ok("Fichier marqué résolu.".into())
}

/// « continuer » ou « abandonner » l'opération en cours.
pub(crate) fn action(dossier: &str, quoi: &str) -> Result<String> {
    let depot = Depot::ouvrir(dossier)?;
    let op = operation(&depot).ok_or_else(|| anyhow::anyhow!("Aucune fusion ni rebase en cours."))?;
    let commande = match op.as_str() {
        "fusion" => "merge",
        "rebase" => "rebase",
        "cherry-pick" => "cherry-pick",
        _ => "revert",
    };
    // « : » = pas d'éditeur : git garde le message préparé (fusion, rebase, cherry-pick).
    let env = [("GIT_EDITOR", ":"), ("GIT_SEQUENCE_EDITOR", ":")];
    let sortie = match quoi {
        "continuer" => {
            let restants = git_ok(&depot.racine, &["diff", "--name-only", "--diff-filter=U"])?.texte();
            let n = restants.lines().filter(|l| !l.trim().is_empty()).count();
            if n > 0 {
                anyhow::bail!("Il reste {n} fichier{} en conflit : marquez-les résolus d'abord.", if n > 1 { "s" } else { "" });
            }
            git(&depot.racine, &[commande, "--continue"], None, &env)?
        }
        "abandonner" => git(&depot.racine, &[commande, "--abort"], None, &env)?,
        autre => anyhow::bail!("action inconnue : {autre}"),
    };
    if !sortie.ok {
        let detail = sortie.stderr.trim();
        let detail = if detail.is_empty() { sortie.texte() } else { detail.to_string() };
        anyhow::bail!("git {commande} --{} : {}", if quoi == "continuer" { "continue" } else { "abort" }, detail.trim());
    }
    let encore = operation(&depot);
    Ok(match (quoi, op.as_str(), encore.is_some()) {
        ("abandonner", "fusion", _) => "Fusion abandonnée : le dépôt est revenu à l'état d'avant.".into(),
        ("abandonner", _, _) => "Opération abandonnée : le dépôt est revenu à l'état d'avant.".into(),
        (_, _, true) => "Étape suivante : de nouveaux conflits sont à résoudre.".into(),
        (_, "fusion", false) => "Fusion terminée.".into(),
        _ => "Opération terminée.".into(),
    })
}

// ---------------------------------------------------------------------------
// Commandes Tauri

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DossierInput {
    pub(crate) workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FichierInput {
    pub(crate) workspace_path: String,
    pub(crate) chemin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResoudreInput {
    pub(crate) workspace_path: String,
    pub(crate) chemin: String,
    pub(crate) contenu: Option<String>,
    #[serde(default)]
    pub(crate) supprimer: bool,
    #[serde(default)]
    pub(crate) marquer: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionInput {
    pub(crate) workspace_path: String,
    pub(crate) action: String,
}

async fn en_tache<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> std::result::Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

fn signaler(app: &AppHandle, dossier: &str, chemin: &str) {
    if let Ok(racine) = normalize_workspace_root(dossier) {
        crate::platform::emit_workspace_file_change(app, &racine, chemin);
    }
}

#[tauri::command]
pub(crate) async fn revue_conflits(input: DossierInput) -> std::result::Result<EtatConflits, String> {
    en_tache(move || etat(&input.workspace_path)).await
}

#[tauri::command]
pub(crate) async fn revue_conflit_fichier(input: FichierInput) -> std::result::Result<DetailConflit, String> {
    en_tache(move || detail(&input.workspace_path, &input.chemin)).await
}

#[tauri::command]
pub(crate) async fn revue_conflit_resoudre(app: AppHandle, input: ResoudreInput) -> std::result::Result<String, String> {
    let (dossier, chemin) = (input.workspace_path.clone(), input.chemin.clone());
    let message = en_tache(move || resoudre(&input.workspace_path, &input.chemin, input.contenu.as_deref(), input.supprimer, input.marquer)).await?;
    signaler(&app, &dossier, &chemin);
    Ok(message)
}

#[tauri::command]
pub(crate) async fn revue_conflits_action(app: AppHandle, input: ActionInput) -> std::result::Result<String, String> {
    let dossier = input.workspace_path.clone();
    let message = en_tache(move || action(&input.workspace_path, &input.action)).await?;
    signaler(&app, &dossier, "");
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::tests::{depot_temp, ecrire};

    fn ws(r: &Path) -> String {
        r.display().to_string()
    }

    /// main et « autre » modifient la même ligne : `git merge autre` s'arrête sur un conflit.
    fn fusion_en_conflit(nom: &str) -> PathBuf {
        let r = depot_temp(nom, &[("f.txt", b"a\nb\nc\n"), ("g.txt", b"g\n")]);
        git_ok(&r, &["checkout", "-q", "-b", "autre"]).unwrap();
        ecrire(&r, "f.txt", b"a\nB autre\nc\n");
        git_ok(&r, &["commit", "-qam", "autre"]).unwrap();
        git_ok(&r, &["checkout", "-q", "main"]).unwrap();
        ecrire(&r, "f.txt", b"a\nB main\nc\n");
        git_ok(&r, &["commit", "-qam", "main"]).unwrap();
        let s = git(&r, &["merge", "autre"], None, &[]).unwrap();
        assert!(!s.ok, "la fusion doit s'arrêter sur un conflit");
        r
    }

    #[test]
    fn fusion_lire_resoudre_continuer() {
        let r = fusion_en_conflit("fusion");
        let e = etat(&ws(&r)).unwrap();
        assert_eq!(e.operation.as_deref(), Some("fusion"));
        assert_eq!((e.nous.as_str(), e.eux.as_str()), ("main", "autre"));
        assert_eq!(e.fichiers.len(), 1);
        assert_eq!((e.fichiers[0].chemin.as_str(), e.fichiers[0].code.as_str()), ("f.txt", "UU"));
        let d = detail(&ws(&r), "f.txt").unwrap();
        assert_eq!(d.base.as_deref(), Some("a\nb\nc\n"));
        assert_eq!(d.nous.as_deref(), Some("a\nB main\nc\n"));
        assert_eq!(d.eux.as_deref(), Some("a\nB autre\nc\n"));
        assert!(a_des_marqueurs(d.resultat.as_deref().unwrap()));
        // Continuer refusé tant qu'un fichier est en conflit ; marqueurs refusés.
        assert!(action(&ws(&r), "continuer").unwrap_err().to_string().contains("1 fichier en conflit"));
        assert!(resoudre(&ws(&r), "f.txt", d.resultat.as_deref(), false, true).is_err());
        resoudre(&ws(&r), "f.txt", Some("a\nB main\nB autre\nc\n"), false, true).unwrap();
        assert!(etat(&ws(&r)).unwrap().fichiers.is_empty());
        assert_eq!(action(&ws(&r), "continuer").unwrap(), "Fusion terminée.");
        assert_eq!(operation(&Depot::ouvrir(&ws(&r)).unwrap()), None);
        let parents = git_ok(&r, &["log", "-1", "--format=%P"]).unwrap().texte();
        assert_eq!(parents.split_whitespace().count(), 2, "commit de fusion");
        assert_eq!(fs::read_to_string(r.join("f.txt")).unwrap(), "a\nB main\nB autre\nc\n");
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn fusion_abandonnee_revient_avant() {
        let r = fusion_en_conflit("abandon");
        let avant = git_ok(&r, &["rev-parse", "HEAD"]).unwrap().texte();
        assert!(action(&ws(&r), "abandonner").unwrap().starts_with("Fusion abandonnée"));
        assert_eq!(git_ok(&r, &["rev-parse", "HEAD"]).unwrap().texte(), avant);
        assert_eq!(fs::read_to_string(r.join("f.txt")).unwrap(), "a\nB main\nc\n");
        assert!(action(&ws(&r), "continuer").is_err(), "plus rien en cours");
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn rebase_en_conflit_puis_continuer() {
        let r = depot_temp("rebase", &[("f.txt", b"1\n2\n3\n")]);
        git_ok(&r, &["checkout", "-q", "-b", "sujet"]).unwrap();
        ecrire(&r, "f.txt", b"1\ndeux sujet\n3\n");
        git_ok(&r, &["commit", "-qam", "sujet"]).unwrap();
        git_ok(&r, &["checkout", "-q", "main"]).unwrap();
        ecrire(&r, "f.txt", b"1\ndeux main\n3\n");
        git_ok(&r, &["commit", "-qam", "main"]).unwrap();
        git_ok(&r, &["checkout", "-q", "sujet"]).unwrap();
        assert!(!git(&r, &["rebase", "main"], None, &[]).unwrap().ok);
        let e = etat(&ws(&r)).unwrap();
        assert_eq!(e.operation.as_deref(), Some("rebase"));
        assert_eq!(e.nous, "main", "pendant un rebase, « nôtre » = la destination");
        let d = detail(&ws(&r), "f.txt").unwrap();
        assert_eq!(d.nous.as_deref(), Some("1\ndeux main\n3\n"));
        assert_eq!(d.eux.as_deref(), Some("1\ndeux sujet\n3\n"));
        resoudre(&ws(&r), "f.txt", Some("1\ndeux main et sujet\n3\n"), false, true).unwrap();
        assert_eq!(action(&ws(&r), "continuer").unwrap(), "Opération terminée.");
        assert_eq!(operation(&Depot::ouvrir(&ws(&r)).unwrap()), None);
        assert_eq!(fs::read_to_string(r.join("f.txt")).unwrap(), "1\ndeux main et sujet\n3\n");
        fs::remove_dir_all(r).ok();
    }

    #[test]
    fn marqueurs_reconnus() {
        assert!(a_des_marqueurs("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> autre\n"));
        assert!(!a_des_marqueurs("Titre\n=======\n<<<<<<<<< pas un marqueur\n"));
    }
}
