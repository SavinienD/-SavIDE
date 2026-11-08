//! Worktrees : une tâche = un worktree prêt à l'emploi.
//! - config : fichier de projet `worktrees.toml` (+ scripts d'`orca.yaml`) ;
//! - partage : node_modules, .env… partagés (lien, jonction) ou copiés ;
//! - depot : petits appels à git ;
//! - taches : création / suppression en arrière-plan ; script : scripts dans un terminal ;
//! - nettoyage : fusionnés, introuvables, anciens, taille.
//! git.rs (panneau Git) n'est pas modifié : rien n'en dépend ici.

mod config;
mod depot;
mod nettoyage;
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

// ---------------------------------------------------------------------------
// Liste des worktrees par dépôt (W3) : état, en avance / en retard ; suppression, archivage.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeInfo {
    pub(crate) dossier: String,
    pub(crate) nom: String,
    pub(crate) branche: Option<String>,
    pub(crate) principal: bool,
    pub(crate) detache: bool,
    pub(crate) verrouille: bool,
    /// Dossier disparu (git propose de l'oublier).
    pub(crate) introuvable: bool,
    /// Fichiers modifiés ou non suivis.
    pub(crate) modifies: Option<usize>,
    pub(crate) avance: Option<u32>,
    pub(crate) retard: Option<u32>,
    /// Branche de comparaison (branche de départ du dépôt, ou l'amont pour la branche principale).
    pub(crate) reference: Option<String>,
    pub(crate) dernier_commit_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DepotWorktrees {
    pub(crate) depot: String,
    pub(crate) nom: String,
    pub(crate) branche_principale: Option<String>,
    pub(crate) worktrees: Vec<WorktreeInfo>,
    pub(crate) erreur: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListeInput {
    /// Dossiers de départ (dossier ouvert, dossiers récents) : un groupe par dépôt.
    pub(crate) chemins: Vec<String>,
    /// Branche de départ choisie par dépôt (réglage local), pour « en avance / en retard ».
    #[serde(default)]
    pub(crate) bases: std::collections::HashMap<String, String>,
}

const DEPOTS_MAX: usize = 30;

/// Dépôts (un par dossier principal) des chemins donnés, dans l'ordre, sans doublon.
pub(crate) fn racines(chemins: &[String]) -> Vec<std::path::PathBuf> {
    let mut racines: Vec<std::path::PathBuf> = Vec::new();
    for c in chemins.iter().filter(|c| !c.trim().is_empty() && !c.starts_with("axe-cloud://")) {
        if racines.len() >= DEPOTS_MAX {
            break;
        }
        if !Path::new(c.trim()).is_dir() {
            continue;
        }
        if let Ok(r) = depot::racine_principale(Path::new(c.trim())) {
            if !racines.iter().any(|x| depot::meme_chemin(x, &r)) {
                racines.push(r);
            }
        }
    }
    racines
}

pub(crate) fn lister_depots(chemins: &[String], bases: &std::collections::HashMap<String, String>) -> Vec<DepotWorktrees> {
    let racines = racines(chemins);
    std::thread::scope(|s| {
        let fils: Vec<_> = racines
            .iter()
            .map(|r| {
                let base = bases
                    .iter()
                    .find(|(k, _)| depot::meme_chemin(Path::new(k), r))
                    .map(|(_, v)| v.clone());
                s.spawn(move || infos_depot(r, base))
            })
            .collect();
        fils.into_iter().filter_map(|f| f.join().ok()).collect()
    })
}

fn infos_depot(racine: &Path, base_locale: Option<String>) -> DepotWorktrees {
    let principale = depot::branche_principale(racine);
    let base = base_locale
        .or_else(|| config::lire(racine).base)
        .filter(|b| depot::revision_existe(racine, b))
        .or_else(|| principale.clone());
    let liste = match depot::lister(racine) {
        Ok(l) => l,
        Err(err) => {
            return DepotWorktrees {
                depot: racine.display().to_string(),
                nom: nom_dossier(racine),
                branche_principale: principale,
                worktrees: Vec::new(),
                erreur: Some(err),
            }
        }
    };
    let worktrees = std::thread::scope(|s| {
        let fils: Vec<_> = liste
            .iter()
            .map(|w| {
                let base = base.clone();
                s.spawn(move || info_worktree(racine, w, base.as_deref()))
            })
            .collect();
        fils.into_iter().filter_map(|f| f.join().ok()).collect()
    });
    DepotWorktrees {
        depot: racine.display().to_string(),
        nom: nom_dossier(racine),
        branche_principale: principale,
        worktrees,
        erreur: None,
    }
}

fn info_worktree(racine: &Path, w: &depot::WorktreeBrut, base: Option<&str>) -> WorktreeInfo {
    let introuvable = w.prunable || !w.chemin.is_dir();
    let mut info = WorktreeInfo {
        dossier: w.chemin.display().to_string(),
        nom: nom_dossier(&w.chemin),
        branche: w.branche.clone(),
        principal: w.principal,
        detache: w.detache,
        verrouille: w.verrouille,
        introuvable,
        modifies: None,
        avance: None,
        retard: None,
        reference: None,
        dernier_commit_ms: None,
    };
    if introuvable {
        return info;
    }
    info.modifies = depot::fichiers_modifies(&w.chemin);
    info.dernier_commit_ms = depot::date_dernier_commit_ms(&w.chemin);
    if let Some(branche) = &w.branche {
        let reference = if Some(branche.as_str()) == base {
            depot::amont(racine, branche)
        } else {
            base.map(str::to_string)
        };
        if let Some(reference) = reference {
            if let Some((retard, avance)) = depot::retard_avance(racine, &reference, branche) {
                info.avance = Some(avance);
                info.retard = Some(retard);
            }
            info.reference = Some(reference);
        }
    }
    info
}

/// Worktrees des dépôts du dossier ouvert et des dossiers récents, avec leur état.
#[tauri::command]
pub(crate) async fn worktrees_lister(input: ListeInput) -> Result<Vec<DepotWorktrees>, String> {
    en_fond(move || Ok(lister_depots(&input.chemins, &input.bases))).await
}

/// Supprime ou archive un worktree (script de suppression, liens retirés, git) en arrière-plan.
#[tauri::command]
pub(crate) async fn worktree_supprimer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::DesktopState>,
    input: taches::DemandeSuppression,
) -> Result<taches::Tache, String> {
    let hote = hote(app, &state);
    en_fond(move || {
        let tache = taches::preparer_suppression(&input)?;
        Ok(taches::lancer(hote, tache))
    })
    .await
}

// ---------------------------------------------------------------------------
// Nettoyage (W4) : fusionnés, introuvables, anciens, taille ; prune.

#[tauri::command]
pub(crate) async fn worktrees_nettoyage(input: nettoyage::NettoyageInput) -> Result<Vec<nettoyage::InfoNettoyage>, String> {
    en_fond(move || Ok(nettoyage::examiner(&input.depots, &input.bases))).await
}

/// `git worktree prune` : oublie les worktrees dont le dossier a disparu.
#[tauri::command]
pub(crate) async fn worktrees_prune(input: DepotInput) -> Result<usize, String> {
    en_fond(move || nettoyage::oublier_introuvables(&input.depot)).await
}
