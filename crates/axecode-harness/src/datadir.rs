//! Dossier de données de l'appli, hors du projet de l'utilisateur
//! (consigne : aucun dossier caché créé automatiquement dans le projet).
//! `~/.local/share/savide` (Linux), `%LOCALAPPDATA%\savide\savide\data`
//! (Windows), `~/Library/Application Support/fr.savide.savide` (macOS).
//! Un sous-dossier par projet : `projects/<nom>-<empreinte>`.

use std::path::{Path, PathBuf};

/// Remplace le dossier de données (tests, installations portables).
pub const DATA_ENV: &str = "AXECODE_DATA_DIR";

/// Racine des données de l'appli (pas créée ici).
pub fn app_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(DATA_ENV).filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    directories::ProjectDirs::from("fr", "savide", "savide")
        .map(|d| d.data_local_dir().to_path_buf())
        .unwrap_or_else(|| std::env::temp_dir().join("savide"))
}

/// Clé stable d'un projet : nom du dossier (nettoyé) + empreinte FNV-1a du chemin.
pub fn project_key(workspace_root: &Path) -> String {
    let canonical = workspace_root.canonicalize().unwrap_or_else(|_| workspace_root.to_path_buf());
    let mut text = crate::os_path(&canonical).to_string_lossy().replace('\\', "/");
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    if cfg!(windows) {
        text = text.to_lowercase();
    }
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let name: String = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(40)
        .collect();
    let name = name.trim_matches('_');
    if name.is_empty() { format!("{hash:016x}") } else { format!("{name}-{hash:016x}") }
}

/// Données internes d'un projet (images générées, plans, file d'agents,
/// corbeille, harnais « projet » neuf…). Pas créé ici.
pub fn project_data_dir(workspace_root: &Path) -> PathBuf {
    project_data_dir_in(&app_data_dir(), workspace_root)
}

pub fn project_data_dir_in(data_root: &Path, workspace_root: &Path) -> PathBuf {
    data_root.join("projects").join(project_key(workspace_root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_and_named() {
        let a = project_key(Path::new("/tmp/Mon projet"));
        assert_eq!(a, project_key(Path::new("/tmp/Mon projet/")));
        assert!(a.starts_with("Mon_projet-"), "{a}");
        assert_ne!(a, project_key(Path::new("/tmp/autre")));
    }
}
