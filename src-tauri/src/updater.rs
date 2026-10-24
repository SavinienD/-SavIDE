//! In-app updater integration around `tauri-plugin-updater`.
//!
//! Exposes three commands to the frontend:
//!   * `updater_check`          → check the configured endpoint for a newer release.
//!   * `updater_download_and_install` → stream the signed bundle, verify, install.
//!   * `updater_restart`        → relaunch the app after an install (frontend-driven).
//!
//! During download the backend emits two events to the focused webview:
//!   * `updater://progress` `{ downloaded: u64, total: Option<u64> }`
//!   * `updater://finished`
//!
//! The plugin is desktop-only (Windows, macOS, Linux). On mobile targets the
//! commands compile to a stub that returns "unsupported", which keeps the
//! `invoke_handler` registration uniform.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[cfg(desktop)]
use tauri_plugin_updater::{Update, UpdaterExt};

/// Snapshot of an available update exposed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    /// `None` when `available == false`.
    pub version: Option<String>,
    /// Release notes / body returned by the manifest, if any.
    pub notes: Option<String>,
    /// RFC-3339 publish date, if the manifest provided one.
    pub date: Option<String>,
}

/// Stores the last `Update` returned by a successful `check()` so that
/// `updater_download_and_install` can reuse it without re-hitting the endpoint.
///
/// We keep this in Tauri-managed state (registered in `lib.rs`).
#[derive(Default)]
pub struct UpdaterState {
    #[cfg(desktop)]
    pending: Arc<Mutex<Option<Update>>>,
    /// Verrou : une seule installation à la fois (deux clics, deux vues, deux appels).
    installing: Arc<AtomicBool>,
    #[cfg(not(desktop))]
    _phantom: std::marker::PhantomData<Arc<Mutex<()>>>,
}

impl UpdaterState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Marqueur « installation lancée » : survit au redémarrage pour qu'aucune
/// installation de la même version ne soit relancée (bug du 23/10 : l'installeur
/// NSIS repartait après une mise à jour réussie et butait sur python-runtime).
const MARQUEUR: &str = "maj-en-cours.json";
/// Au-delà, un marqueur d'une version toujours pas installée est considéré comme
/// un échec : on autorise un nouvel essai (sur clic seulement).
const MARQUEUR_VALIDITE_S: u64 = 15 * 60;

fn version(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim().trim_start_matches('v')).ok()
}

/// Décision pure (testée) : `Some(raison)` si l'installation de `cible` doit être refusée.
pub(crate) fn refus_installation(
    courante: &str,
    cible: &str,
    marqueur: Option<(&str, u64)>,
    maintenant: u64,
    en_cours: bool,
) -> Option<String> {
    if en_cours {
        return Some("une installation est déjà en cours".into());
    }
    match (version(courante), version(cible)) {
        (Some(c), Some(t)) if t <= c => {
            return Some(format!("la version {cible} est déjà installée"));
        }
        (_, None) => return Some(format!("version de mise à jour invalide : {cible}")),
        _ => {}
    }
    if let Some((v, quand)) = marqueur {
        if version(v) == version(cible) && maintenant.saturating_sub(quand) < MARQUEUR_VALIDITE_S {
            return Some(format!("l'installation de la version {cible} est déjà lancée"));
        }
    }
    None
}

/// Le marqueur est périmé (à effacer) quand sa version est déjà installée.
pub(crate) fn marqueur_perime(courante: &str, marqueur_version: &str) -> bool {
    match (version(courante), version(marqueur_version)) {
        (Some(c), Some(m)) => m <= c,
        _ => true,
    }
}

fn maintenant() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn chemin_marqueur(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_local_data_dir().ok().map(|d| d.join(MARQUEUR))
}

fn lire_marqueur(app: &AppHandle) -> Option<(String, u64)> {
    let texte = std::fs::read_to_string(chemin_marqueur(app)?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&texte).ok()?;
    Some((v.get("version")?.as_str()?.to_string(), v.get("quand")?.as_u64()?))
}

fn ecrire_marqueur(app: &AppHandle, version: &str) {
    if let Some(p) = chemin_marqueur(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::json!({"version": version, "quand": maintenant()}).to_string());
    }
}

/// Au démarrage / à chaque vérification : efface le marqueur d'une version déjà installée.
fn nettoyer_marqueur(app: &AppHandle, courante: &str) {
    if let (Some((v, _)), Some(p)) = (lire_marqueur(app), chemin_marqueur(app)) {
        if marqueur_perime(courante, &v) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Avant de lancer l'installeur : arrêt propre du démon (et donc des noyaux Python
/// qu'il porte), puis fin de tout processus restant lancé depuis le dossier de
/// l'appli (python.exe de python-runtime, démon détaché…), sauf nous-mêmes.
/// Sans cela NSIS échoue sur « python-runtime\DLLs\_bz2.pyd » ouvert en écriture.
async fn arreter_noyaux(app: &AppHandle) {
    use tauri::Manager;
    let client = app.state::<crate::daemon_client::DaemonState>().client.lock().await.take();
    if let Some(client) = client {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.call("shutdown", serde_json::json!({"force": true})),
        )
        .await;
    }
    #[cfg(windows)]
    {
        if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
            let dossier = dir.to_string_lossy().replace('\'', "''");
            let script = format!(
                "$d='{dossier}\\'; Get-Process | Where-Object {{ $_.Id -ne {pid} -and $_.Path -and $_.Path.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) }} | Stop-Process -Force -ErrorAction SilentlyContinue",
                pid = std::process::id()
            );
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
                .stdin(std::process::Stdio::null())
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status();
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
}

const PROGRESS_EVENT: &str = "updater://progress";
const FINISHED_EVENT: &str = "updater://finished";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    downloaded: u64,
    total: Option<u64>,
}

/// Query the configured update endpoint. Returns `available = false` when the
/// remote manifest reports the current version is already the latest.
#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    if !crate::MAJ_AUTO {
        let _ = &state;
        return Ok(UpdateInfo { available: false, current_version, version: None, notes: None, date: None });
    }

    #[cfg(desktop)]
    {
        nettoyer_marqueur(&app, &current_version);
        let pending = state.pending.clone();
        let updater = app
            .updater_builder()
            .build()
            .map_err(|err| format!("impossible de préparer la mise à jour : {err}"))?;

        match updater.check().await {
            Ok(Some(update)) if version(&update.version) > version(&current_version) => {
                let info = UpdateInfo {
                    available: true,
                    current_version,
                    version: Some(update.version.clone()),
                    notes: update.body.clone(),
                    // `OffsetDateTime`'s Display impl yields an ISO-8601 ish
                    // representation already; that's plenty for the UI.
                    date: update.date.map(|d| d.to_string()),
                };
                if let Ok(mut guard) = pending.lock() {
                    *guard = Some(update);
                }
                Ok(info)
            }
            Ok(_) => {
                if let Ok(mut guard) = pending.lock() {
                    *guard = None;
                }
                Ok(UpdateInfo {
                    available: false,
                    current_version,
                    version: None,
                    notes: None,
                    date: None,
                })
            }
            Err(err) => Err(format!("échec de la recherche de mise à jour : {err}")),
        }
    }

    #[cfg(not(desktop))]
    {
        let _ = state;
        Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
            date: None,
        })
    }
}

/// Downloads + verifies + installs the update that was previously discovered by
/// `updater_check`. If no pending update is cached we re-run the check first.
///
/// Progress is streamed via `updater://progress` events. When the install
/// completes successfully we emit `updater://finished` so the frontend can show
/// the "Restart" affordance. The caller is responsible for invoking
/// `updater_restart` afterwards.
#[tauri::command]
pub async fn updater_download_and_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let pending = state.pending.clone();

        // Pull the cached Update or refresh.
        let update = {
            let guard = pending
                .lock()
                .map_err(|_| "état de la mise à jour indisponible (verrou)".to_string())?;
            guard.clone()
        };

        let update = match update {
            Some(u) => u,
            None => {
                let updater = app
                    .updater_builder()
                    .build()
                    .map_err(|err| format!("impossible de préparer la mise à jour : {err}"))?;
                let fresh = updater
                    .check()
                    .await
                    .map_err(|err| format!("échec de la recherche de mise à jour : {err}"))?
                    .ok_or_else(|| "aucune mise à jour disponible".to_string())?;
                if let Ok(mut guard) = pending.lock() {
                    *guard = Some(fresh.clone());
                }
                fresh
            }
        };

        // Une seule installation par version : verrou, version installée, marqueur.
        let courante = app.package_info().version.to_string();
        let marqueur = lire_marqueur(&app);
        if let Some(raison) = refus_installation(
            &courante,
            &update.version,
            marqueur.as_ref().map(|(v, t)| (v.as_str(), *t)),
            maintenant(),
            state.installing.load(Ordering::SeqCst),
        ) {
            return Err(raison);
        }
        if state.installing.swap(true, Ordering::SeqCst) {
            return Err("une installation est déjà en cours".into());
        }
        let installing = state.installing.clone();

        let progress_app = app.clone();
        let mut downloaded: u64 = 0;
        let bytes = match update
            .download(
                move |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    let _ =
                        progress_app.emit(PROGRESS_EVENT, ProgressPayload { downloaded, total });
                },
                || {},
            )
            .await
        {
            Ok(b) => b,
            Err(err) => {
                installing.store(false, Ordering::SeqCst);
                return Err(format!("échec du téléchargement de la mise à jour : {err}"));
            }
        };

        // Rien ne doit rester ouvert dans le dossier de l'appli pendant l'installation.
        ecrire_marqueur(&app, &update.version);
        arreter_noyaux(&app).await;

        match update.install(bytes) {
            Ok(()) => {
                let _ = app.emit(FINISHED_EVENT, ());
                Ok(())
            }
            Err(err) => {
                installing.store(false, Ordering::SeqCst);
                if let Some(p) = chemin_marqueur(&app) {
                    let _ = std::fs::remove_file(p);
                }
                Err(format!("échec de l'installation de la mise à jour : {err}"))
            }
        }
    }

    #[cfg(not(desktop))]
    {
        let _ = (app, state);
        Err("mise à jour automatique non prise en charge sur ce système".into())
    }
}

/// Relaunch the application. Called by the frontend once the user accepts the
/// restart prompt that appears after a successful install.
#[tauri::command]
pub fn updater_restart(app: AppHandle) {
    app.restart();
}

/// Returns the current app version. Used by the frontend to render the badge
/// tooltip even when no update is available.
#[tauri::command]
pub fn updater_current_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deja_installee_pas_de_relance() {
        // Version déjà installée (manifeste relu après le redémarrage) : refus.
        assert!(refus_installation("0.1.62", "0.1.62", None, 1000, false).is_some());
        assert!(refus_installation("0.1.62", "0.1.61", None, 1000, false).is_some());
        // Installation en cours : refus (verrou).
        assert!(refus_installation("0.1.61", "0.1.62", None, 1000, true).is_some());
        // Marqueur récent de la même version : refus (pas de seconde installation).
        assert!(refus_installation("0.1.61", "0.1.62", Some(("0.1.62", 900)), 1000, false).is_some());
        // Marqueur ancien (échec) ou d'une autre version : nouvel essai permis.
        assert!(refus_installation("0.1.61", "0.1.62", Some(("0.1.62", 0)), 10_000, false).is_none());
        assert!(refus_installation("0.1.61", "0.1.63", Some(("0.1.62", 900)), 1000, false).is_none());
        assert!(refus_installation("0.1.61", "0.1.62", None, 1000, false).is_none());
        assert!(refus_installation("0.1.61", "pas-une-version", None, 1000, false).is_some());
    }

    #[test]
    fn marqueur_efface_une_fois_installee() {
        assert!(marqueur_perime("0.1.62", "0.1.62"));
        assert!(marqueur_perime("0.1.63", "0.1.62"));
        assert!(!marqueur_perime("0.1.61", "0.1.62"));
    }
}
