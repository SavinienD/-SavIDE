//! Conversations endormies : le délai après lequel une conversation inactive
//! est endormie se règle (Réglages > Service) au lieu des 30 min fixes. Endormir = décharger la
//! session (`unload`) : instantané du noyau (ses variables sont reprises par un nouveau noyau au
//! message suivant, sauf fichiers ouverts, connexions et processus), puis arrêt de son processus
//! Python, ce qui libère la mémoire. Le bouton « Endormir » de l'onglet Agents appelle
//! `sessions.unload`.
//!
//! Réglage : `<données>/sommeil.json` = `{"conversationsMinutes": n}` (0 : jamais ; absent : le
//! délai par défaut du service). RPC `sommeil.get` / `sommeil.set`, refusé sur un service
//! partagé (espace cloud) : le réglage vaut pour tous ses utilisateurs.

use std::path::Path;
use std::time::Duration;

use axecode_core::{SessionError, SessionResult};
use serde_json::{json, Value};

use crate::daemon::Daemon;

const FICHIER: &str = "sommeil.json";
/// Une semaine au plus.
const MAX_MINUTES: u64 = 7 * 24 * 60;

fn minutes_reglees(data_dir: &Path) -> Option<u64> {
    let octets = std::fs::read(data_dir.join(FICHIER)).ok()?;
    let valeur: Value = serde_json::from_slice(&octets).ok()?;
    valeur.get("conversationsMinutes")?.as_u64().map(|m| m.min(MAX_MINUTES))
}

/// Délai d'endormissement des conversations (sessions sans parent) : le réglage, sinon `defaut`.
/// `None` : jamais.
pub fn delai(data_dir: &Path, defaut: Duration) -> Option<Duration> {
    match minutes_reglees(data_dir) {
        Some(0) => None,
        Some(minutes) => Some(Duration::from_secs(minutes * 60)),
        None => Some(defaut),
    }
}

fn etat(d: &Daemon) -> Value {
    json!({
        "conversationsMinutes": minutes_reglees(&d.config.data_dir),
        "defautMinutes": d.config.idle_unload.as_secs() / 60,
    })
}

pub fn dispatch(d: &Daemon, methode: &str, params: &Value) -> SessionResult<Value> {
    match methode {
        "sommeil.get" => Ok(etat(d)),
        "sommeil.set" => {
            if d.config.workspace_root.is_some() {
                return Err(SessionError::Protocol("réglage du poste seulement (service partagé)".into()));
            }
            let chemin = d.config.data_dir.join(FICHIER);
            match params.get("conversationsMinutes") {
                None | Some(Value::Null) => {
                    let _ = std::fs::remove_file(&chemin);
                }
                Some(valeur) => {
                    let minutes = valeur
                        .as_u64()
                        .ok_or_else(|| SessionError::Protocol("conversationsMinutes : nombre de minutes attendu".into()))?
                        .min(MAX_MINUTES);
                    std::fs::create_dir_all(&d.config.data_dir).map_err(|e| SessionError::Io(e.to_string()))?;
                    std::fs::write(&chemin, json!({"conversationsMinutes": minutes}).to_string())
                        .map_err(|e| SessionError::Io(e.to_string()))?;
                }
            }
            Ok(etat(d))
        }
        autre => Err(SessionError::Protocol(format!("unknown method {autre}"))),
    }
}
