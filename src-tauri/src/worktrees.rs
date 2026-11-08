//! Worktrees (lot 186) : une tâche = un worktree prêt à l'emploi.
//! - config : fichier de projet `worktrees.toml` (+ scripts d'`orca.yaml`) ;
//! - partage : node_modules, .env… partagés (lien, jonction) ou copiés ;
//! - depot : petits appels à git.
//! git.rs (panneau Git) n'est pas modifié : rien n'en dépend ici.

mod config;
mod depot;
mod partage;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DepotInput {
    /// Un dossier du dépôt (principal ou worktree).
    pub(crate) depot: String,
}

/// Réglages d'un dépôt pour le dialogue « Nouveau worktree ».
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigDepot {
    /// Dossier principal du dépôt (forme canonique).
    pub(crate) depot: String,
    pub(crate) nom: String,
    pub(crate) branche_principale: Option<String>,
    pub(crate) branches: Vec<String>,
    pub(crate) config: config::Config,
    /// Fichier de départ proposé quand il n'y a pas encore de worktrees.toml.
    pub(crate) modele: Option<String>,
}

async fn en_fond<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|err| format!("tâche interrompue : {err}"))?
}

fn nom_dossier(chemin: &Path) -> String {
    chemin
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| chemin.display().to_string())
}

pub(crate) fn config_depot(chemin: &str) -> Result<ConfigDepot, String> {
    let racine = depot::racine_principale(Path::new(chemin.trim()))?;
    let cfg = config::lire(&racine);
    let modele = (!cfg.fichiers.iter().any(|f| f == config::FICHIER)).then(|| config::modele(&racine));
    Ok(ConfigDepot {
        depot: racine.display().to_string(),
        nom: nom_dossier(&racine),
        branche_principale: depot::branche_principale(&racine),
        branches: depot::branches_locales(&racine),
        config: cfg,
        modele,
    })
}

/// Réglages du dépôt : worktrees.toml, branches, branche principale.
#[tauri::command]
pub(crate) async fn worktrees_config(input: DepotInput) -> Result<ConfigDepot, String> {
    en_fond(move || config_depot(&input.depot)).await
}

/// Crée worktrees.toml à la racine du dépôt (modèle de départ), s'il n'existe pas.
#[tauri::command]
pub(crate) async fn worktrees_config_creer(input: DepotInput) -> Result<ConfigDepot, String> {
    en_fond(move || {
        let racine = depot::racine_principale(Path::new(input.depot.trim()))?;
        let chemin = racine.join(config::FICHIER);
        if chemin.exists() {
            return Err(format!("{} existe déjà", config::FICHIER));
        }
        std::fs::write(&chemin, config::modele(&racine))
            .map_err(|err| format!("{} impossible à écrire : {err}", config::FICHIER))?;
        config_depot(&racine.display().to_string())
    })
    .await
}
