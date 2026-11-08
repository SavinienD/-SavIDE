// Lot palette (P4) — explorateur : état git de chaque fichier (modifié, nouveau, ignoré, en
// conflit) pour colorer l'arbre, et recherche limitée à un sous-dossier (« Rechercher dans ce
// dossier »).

use crate::*;
use std::process::Stdio;

/// git status ne bloque jamais l'explorateur plus longtemps.
const DELAI_GIT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EtatGitInput {
    workspace_path: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FichierGit {
    /// Relatif au dossier ouvert, séparateur « / » ; un dossier entier finit par « / ».
    pub(crate) chemin: String,
    /// « modifie », « nouveau », « ignore », « conflit » ou « supprime ».
    pub(crate) etat: &'static str,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EtatGit {
    /// Le dossier est dans un dépôt git (et git répond).
    pub(crate) depot: bool,
    pub(crate) fichiers: Vec<FichierGit>,
}

/// État d'une ligne de `git status --porcelain` (deux lettres XY).
pub(crate) fn etat_xy(x: char, y: char) -> &'static str {
    match (x, y) {
        ('!', '!') => "ignore",
        ('?', '?') => "nouveau",
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U') => "conflit",
        (_, 'D') | ('D', _) => "supprime",
        ('A', _) | ('R', _) | ('C', _) => "nouveau",
        _ => "modifie",
    }
}

/// Lignes de `git status --porcelain=v1 -z` (chemins relatifs à la racine du dépôt) →
/// chemins relatifs au dossier ouvert (`prefixe` = son chemin dans le dépôt, « » ou « a/b/ »).
pub(crate) fn lire_status(brut: &str, prefixe: &str) -> Vec<FichierGit> {
    let mut sortie = Vec::new();
    let mut parties = brut.split('\0').filter(|p| !p.is_empty());
    while let Some(entree) = parties.next() {
        let mut lettres = entree.chars();
        let (Some(x), Some(y)) = (lettres.next(), lettres.next()) else { continue };
        if entree.len() < 4 {
            continue;
        }
        // Renommage / copie : l'ancien chemin suit (ignoré).
        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            parties.next();
        }
        let chemin = &entree[3..];
        let Some(relatif) = chemin.strip_prefix(prefixe) else { continue };
        if relatif.is_empty() {
            continue;
        }
        sortie.push(FichierGit { chemin: relatif.to_string(), etat: etat_xy(x, y) });
    }
    sortie
}

async fn git_texte(racine: &Path, args: &[&str]) -> Result<String> {
    let mut commande = tokio::process::Command::new("git");
    commande
        .args(args)
        .current_dir(racine)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    commande.creation_flags(0x0800_0000);
    let sortie = tokio::time::timeout(DELAI_GIT, commande.output())
        .await
        .context("git trop long")?
        .context("git introuvable")?;
    if !sortie.status.success() {
        anyhow::bail!("git a échoué ({})", sortie.status);
    }
    Ok(String::from_utf8_lossy(&sortie.stdout).into_owned())
}

/// État git du dossier : fichiers suivis modifiés, nouveaux, en conflit, et dossiers ou
/// fichiers ignorés (un dossier ignoré ou non suivi en entier est donné une seule fois).
pub(crate) async fn etat_git(racine: &Path) -> EtatGit {
    let Ok(prefixe) = git_texte(racine, &["rev-parse", "--show-prefix"]).await else {
        return EtatGit { depot: false, fichiers: Vec::new() };
    };
    let prefixe = prefixe.trim().to_string();
    let args = [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignored=matching",
        "--",
        ".",
    ];
    match git_texte(racine, &args).await {
        Ok(brut) => EtatGit { depot: true, fichiers: lire_status(&brut, &prefixe) },
        Err(err) => {
            tracing::warn!(%err, "git status pour l'explorateur");
            EtatGit { depot: true, fichiers: Vec::new() }
        }
    }
}

#[tauri::command]
pub(crate) async fn explorateur_git(input: EtatGitInput) -> std::result::Result<EtatGit, String> {
    let racine = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    Ok(etat_git(&racine).await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RechercheDossierInput {
    workspace_path: String,
    /// Sous-dossier, relatif au dossier ouvert (« / »).
    dossier: String,
    query: String,
}

/// Sous-dossier sûr : relatif, sans « .. », existant et bien DANS le dossier ouvert.
pub(crate) fn sous_dossier(racine: &Path, relatif: &str) -> std::result::Result<PathBuf, String> {
    let propre = relatif.replace('\\', "/");
    let propre = propre.trim_matches('/');
    if propre.is_empty() {
        return Ok(racine.to_path_buf());
    }
    let chemin = Path::new(propre);
    if chemin.is_absolute() || chemin.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("dossier hors de l'espace".into());
    }
    let complet = racine.join(chemin);
    let reel = complet.canonicalize().map_err(|_| format!("dossier introuvable : {propre}"))?;
    let base = racine.canonicalize().unwrap_or_else(|_| racine.to_path_buf());
    if !reel.starts_with(&base) || !reel.is_dir() {
        return Err("dossier hors de l'espace".into());
    }
    Ok(complet)
}

/// « Rechercher dans ce dossier » : même recherche que le volet, limitée au sous-dossier ;
/// les chemins rendus restent relatifs au dossier ouvert.
#[tauri::command]
pub(crate) async fn palette_recherche_dossier(
    input: RechercheDossierInput,
) -> std::result::Result<WorkspaceSearchResult, String> {
    let racine = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let dossier = sous_dossier(&racine, &input.dossier)?;
    let prefixe = input.dossier.replace('\\', "/").trim_matches('/').to_string();
    let mut resultat = search_workspace_files(&dossier, &input.query).map_err(error_to_string)?;
    if !prefixe.is_empty() {
        for fichier in &mut resultat.files {
            fichier.relative_path = format!("{prefixe}/{}", fichier.relative_path);
        }
    }
    Ok(resultat)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(d: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(d).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn lettres_xy_vers_etat() {
        assert_eq!(etat_xy(' ', 'M'), "modifie");
        assert_eq!(etat_xy('M', ' '), "modifie");
        assert_eq!(etat_xy('?', '?'), "nouveau");
        assert_eq!(etat_xy('A', ' '), "nouveau");
        assert_eq!(etat_xy('U', 'U'), "conflit");
        assert_eq!(etat_xy('A', 'A'), "conflit");
        assert_eq!(etat_xy(' ', 'D'), "supprime");
        assert_eq!(etat_xy('!', '!'), "ignore");
    }

    #[test]
    fn status_relatif_au_dossier_ouvert() {
        let brut = "R  web/neuf.ts\0web/vieux.ts\0 M web/a.ts\0?? web/tmp/\0!! web/dist/\0 M autre.ts\0";
        let liste = lire_status(brut, "web/");
        assert_eq!(
            liste,
            vec![
                FichierGit { chemin: "neuf.ts".into(), etat: "nouveau" },
                FichierGit { chemin: "a.ts".into(), etat: "modifie" },
                FichierGit { chemin: "tmp/".into(), etat: "nouveau" },
                FichierGit { chemin: "dist/".into(), etat: "ignore" },
            ]
        );
    }

    #[tokio::test]
    async fn vrai_depot_modifie_nouveau_ignore_conflit() {
        let d = std::env::temp_dir().join(format!(
            "axe-git-explorateur-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(d.join("src")).unwrap();
        git(&d, &["init", "-q", "-b", "main"]);
        git(&d, &["config", "user.email", "t@t"]);
        git(&d, &["config", "user.name", "t"]);
        fs::write(d.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::write(d.join("src/a.txt"), "un\n").unwrap();
        fs::write(d.join("c.txt"), "base\n").unwrap();
        git(&d, &["add", "."]);
        git(&d, &["commit", "-q", "-m", "init"]);
        // conflit sur c.txt
        git(&d, &["checkout", "-q", "-b", "autre"]);
        fs::write(d.join("c.txt"), "autre\n").unwrap();
        git(&d, &["commit", "-q", "-am", "autre"]);
        git(&d, &["checkout", "-q", "main"]);
        fs::write(d.join("c.txt"), "main\n").unwrap();
        git(&d, &["commit", "-q", "-am", "main"]);
        let _ = std::process::Command::new("git").args(["merge", "-q", "autre"]).current_dir(&d).output();
        fs::write(d.join("src/a.txt"), "deux\n").unwrap();
        fs::write(d.join("src/neuf.txt"), "x").unwrap();
        fs::create_dir_all(d.join("build")).unwrap();
        fs::write(d.join("build/sortie.bin"), "x").unwrap();
        fs::write(d.join("trace.log"), "x").unwrap();
        let etat = etat_git(&d).await;
        assert!(etat.depot);
        let de = |c: &str| etat.fichiers.iter().find(|f| f.chemin == c).map(|f| f.etat);
        assert_eq!(de("src/a.txt"), Some("modifie"));
        assert_eq!(de("src/neuf.txt"), Some("nouveau"));
        assert_eq!(de("build/"), Some("ignore"));
        assert_eq!(de("trace.log"), Some("ignore"));
        assert_eq!(de("c.txt"), Some("conflit"));
        // vu depuis le sous-dossier src : chemins relatifs à lui
        let sous = etat_git(&d.join("src")).await;
        assert_eq!(sous.fichiers.iter().map(|f| f.chemin.as_str()).collect::<Vec<_>>(), vec!["a.txt", "neuf.txt"]);
        // hors dépôt
        let hors = std::env::temp_dir().join(format!("axe-git-hors-{}", std::process::id()));
        fs::create_dir_all(&hors).unwrap();
        assert!(!etat_git(&hors).await.depot || hors.starts_with(&d));
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_dir_all(&hors);
    }

    #[test]
    fn sous_dossier_refuse_de_sortir() {
        let d = std::env::temp_dir().join(format!("axe-sous-dossier-{}", std::process::id()));
        fs::create_dir_all(d.join("src/x")).unwrap();
        assert!(sous_dossier(&d, "src/x").is_ok());
        assert!(sous_dossier(&d, "src\\x").is_ok());
        assert!(sous_dossier(&d, "../").is_err());
        assert!(sous_dossier(&d, "src/../../etc").is_err());
        assert!(sous_dossier(&d, "absent").is_err());
        assert_eq!(sous_dossier(&d, "").unwrap(), d);
        let _ = fs::remove_dir_all(&d);
    }
}
