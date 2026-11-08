//! Worktrees (lot 186) : une tâche = un worktree prêt à l'emploi.
//! - config : fichier de projet `worktrees.toml` (+ scripts d'`orca.yaml`) ;
//! - partage : node_modules, .env… partagés (lien, jonction) ou copiés ;
//! - depot : petits appels à git ;
//! - taches : création / suppression en arrière-plan ; script : scripts dans un terminal.
//! git.rs (panneau Git) n'est pas modifié : rien n'en dépend ici.

mod config;
mod depot;
mod partage;
mod script;
mod taches;
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

// ---------------------------------------------------------------------------
// Tâches de fond (W1) : création en arrière-plan, Annuler / Réessayer / Relancer.

/// Événement : une tâche a changé (charge = la tâche).
pub(crate) const EVENEMENT_TACHE: &str = "worktrees-tache";
/// Événement : sortie du terminal d'un script ({ id, debut, texte }).
pub(crate) const EVENEMENT_SORTIE: &str = "worktrees-sortie";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SortieScript<'a> {
    id: &'a str,
    debut: u64,
    texte: &'a str,
}

/// Les tâches publient par l'appli ; le terminal du script est rangé avec les
/// autres terminaux (saisie, taille par write_terminal / resize_terminal).
struct HoteTauri {
    app: tauri::AppHandle,
    terminaux: std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, crate::TerminalProcess>>>,
}

impl taches::Hote for HoteTauri {
    fn publier(&self, tache: &taches::Tache) {
        use tauri::Emitter;
        let _ = self.app.emit(EVENEMENT_TACHE, tache);
    }

    fn sortie(&self, id: &str, debut: u64, texte: &str) {
        use tauri::Emitter;
        let _ = self.app.emit(EVENEMENT_SORTIE, SortieScript { id, debut, texte });
    }

    fn terminal_ouvert(&self, session: &str, terminal: taches::Joignable) {
        let ancien = self.terminaux.blocking_lock().insert(
            session.to_string(),
            crate::TerminalProcess {
                token: terminal.token,
                master: terminal.maitre,
                writer: terminal.ecriture,
                killer: terminal.arret,
            },
        );
        if let Some(ancien) = ancien {
            crate::terminal::terminate_terminal_process(ancien);
        }
    }

    fn terminal_ferme(&self, session: &str, token: &str) {
        let mut terminaux = self.terminaux.blocking_lock();
        if terminaux.get(session).map(|p| p.token == token).unwrap_or(false) {
            terminaux.remove(session);
        }
    }
}

fn hote(app: tauri::AppHandle, state: &crate::DesktopState) -> std::sync::Arc<dyn taches::Hote> {
    std::sync::Arc::new(HoteTauri { app, terminaux: state.terminal_sessions.clone() })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TacheInput {
    pub(crate) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepriseInput {
    pub(crate) id: String,
    #[serde(flatten)]
    pub(crate) reprise: taches::Reprise,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SortieTache {
    pub(crate) texte: String,
    pub(crate) fin: u64,
}

/// Lance la création d'un worktree (vérifications tout de suite, le reste en arrière-plan).
#[tauri::command]
pub(crate) async fn worktree_creer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::DesktopState>,
    input: taches::DemandeCreation,
) -> Result<taches::Tache, String> {
    let hote = hote(app, &state);
    en_fond(move || {
        let tache = taches::preparer_creation(&input)?;
        Ok(taches::lancer(hote, tache))
    })
    .await
}

/// Tâches connues (en cours et récentes), pour une fenêtre qui s'ouvre ou se recharge.
#[tauri::command]
pub(crate) async fn worktrees_taches() -> Result<Vec<taches::Tache>, String> {
    Ok(taches::lister())
}

#[tauri::command]
pub(crate) async fn worktree_tache_annuler(input: TacheInput) -> Result<(), String> {
    taches::annuler(&input.id)
}

/// Réessayer (création), Relancer (script), Supprimer quand même, Continuer sans le script.
#[tauri::command]
pub(crate) async fn worktree_tache_reprendre(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::DesktopState>,
    input: RepriseInput,
) -> Result<taches::Tache, String> {
    let hote = hote(app, &state);
    en_fond(move || taches::reprendre(hote, &input.id, input.reprise)).await
}

#[tauri::command]
pub(crate) async fn worktree_tache_oublier(input: TacheInput) -> Result<(), String> {
    taches::oublier(&input.id)
}

/// Sortie gardée du terminal du script (256 Ko au plus) et nombre d'octets émis.
#[tauri::command]
pub(crate) async fn worktree_tache_sortie(input: TacheInput) -> Result<SortieTache, String> {
    let (texte, fin) = taches::sortie(&input.id).unwrap_or_default();
    Ok(SortieTache { texte, fin })
}
