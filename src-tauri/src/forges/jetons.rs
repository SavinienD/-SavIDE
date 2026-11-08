//! Jetons d'accès des forges, rangés comme les autres secrets de l'appli : un fichier
//! JSON du dossier de données (droits 0600 sous Unix), jamais renvoyé à l'interface.
//! GitHub : à défaut de jeton enregistré, celui de la CLI officielle (`gh auth token`).

use crate::*;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FICHIER: &str = "forge-tokens.json";

fn dossier() -> std::result::Result<PathBuf, String> {
    axecode_daemon::util::default_data_dir().map_err(|e| e.to_string())
}

pub(crate) fn lire_dans(dossier: &Path) -> HashMap<String, String> {
    fs::read(dossier.join(FICHIER))
        .ok()
        .and_then(|octets| serde_json::from_slice(&octets).ok())
        .unwrap_or_default()
}

pub(crate) fn enregistrer_dans(dossier: &Path, hote: &str, jeton: Option<&str>) -> std::result::Result<(), String> {
    let hote = hote.trim().to_ascii_lowercase();
    if hote.is_empty() {
        return Err("hôte de la forge manquant".into());
    }
    let mut jetons = lire_dans(dossier);
    match jeton.map(str::trim).filter(|j| !j.is_empty()) {
        Some(j) => {
            jetons.insert(hote, j.to_string());
        }
        None => {
            jetons.remove(&hote);
        }
    }
    fs::create_dir_all(dossier).map_err(|e| e.to_string())?;
    crate::connections::write_json(&dossier.join(FICHIER), &jetons)
}

/// Jeton enregistré pour cet hôte.
pub(crate) fn jeton_enregistre(hote: &str) -> Option<String> {
    let dossier = dossier().ok()?;
    lire_dans(&dossier).remove(&hote.trim().to_ascii_lowercase())
}

pub(crate) fn enregistrer(hote: &str, jeton: Option<&str>) -> std::result::Result<(), String> {
    enregistrer_dans(&dossier()?, hote, jeton)
}

static CACHE_GH: Mutex<Option<(Option<String>, Instant)>> = Mutex::new(None);

/// Jeton de `gh auth token` (gardé 10 minutes) : la connexion déjà faite avec GitHub CLI.
pub(crate) fn jeton_gh() -> Option<String> {
    if let Ok(cache) = CACHE_GH.lock() {
        if let Some((jeton, quand)) = cache.as_ref() {
            if quand.elapsed() < Duration::from_secs(600) {
                return jeton.clone();
            }
        }
    }
    let jeton = crate::git::resolve_executable("gh").and_then(|gh| {
        let mut commande = Command::new(gh);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // Pas de fenêtre de console (CREATE_NO_WINDOW).
            commande.creation_flags(0x0800_0000);
        }
        commande
            .args(["auth", "token", "--hostname", "github.com"])
            .stdin(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|sortie| sortie.status.success())
            .map(|sortie| String::from_utf8_lossy(&sortie.stdout).trim().to_string())
            .filter(|j| !j.is_empty())
    });
    if let Ok(mut cache) = CACHE_GH.lock() {
        *cache = Some((jeton.clone(), Instant::now()));
    }
    jeton
}

/// Oublie le jeton de gh gardé en mémoire (après « gh auth login » par exemple).
pub(crate) fn oublier_gh() {
    if let Ok(mut cache) = CACHE_GH.lock() {
        *cache = None;
    }
}

/// Jeton à utiliser pour un dépôt : celui enregistré, sinon (GitHub) celui de gh.
pub(crate) fn jeton_pour(genre: &str, hote: &str) -> Option<String> {
    jeton_enregistre(hote).or_else(|| (genre == "github").then(jeton_gh).flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jetons_par_hote_ajout_et_retrait() {
        let dossier = std::env::temp_dir().join(format!("axecode-jetons-{}", std::process::id()));
        enregistrer_dans(&dossier, "Git.Exemple.fr", Some("  abc123  ")).unwrap();
        enregistrer_dans(&dossier, "github.com", Some("ghp_x")).unwrap();
        let j = lire_dans(&dossier);
        assert_eq!(j.get("git.exemple.fr").map(String::as_str), Some("abc123"));
        enregistrer_dans(&dossier, "git.exemple.fr", None).unwrap();
        assert!(!lire_dans(&dossier).contains_key("git.exemple.fr"));
        assert!(lire_dans(&dossier).contains_key("github.com"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dossier.join(FICHIER)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(dossier).ok();
    }
}
