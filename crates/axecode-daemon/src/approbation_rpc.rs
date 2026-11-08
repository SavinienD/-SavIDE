//! `approbation.*` : mode « Demander avant d'agir ».
//!
//! - `approbation.liste` -> demandes en attente (les plus anciennes d'abord)
//! - `approbation.repondre {id, decision: autoriser|refuser|toujours, motif?}`
//! - `approbation.mode {sessionId?}` -> `{mode, explicite?, heriteDe?, defaut}`
//! - `approbation.regler {sessionId?, mode: autonome|demander|null}` (sans
//!   sessionId : le défaut global ; mode null : la session suit de nouveau son parent)
//! La demande elle-même part dans le flux de la session (`stream`, type `approbation`).

use std::path::Path;

use axecode_app::agent::approbation::{self, Decision, Mode};
use axecode_core::{SessionError, SessionResult};
use serde_json::{json, Value};

use crate::daemon::Daemon;

fn protocole(e: impl std::fmt::Display) -> SessionError {
    SessionError::Protocol(e.to_string())
}

/// Même règle que les autres méthodes : un service limité à un dossier ne montre que ses sessions.
fn visible(d: &Daemon, session_id: &str) -> bool {
    let Some(racine) = d.config.workspace_root.as_ref() else { return true };
    let (Ok(racine), Ok(meta)) = (racine.canonicalize(), d.meta(session_id)) else { return false };
    Path::new(&meta.workspace_id).canonicalize().is_ok_and(|p| p.starts_with(racine))
}

/// [session, parent, grand-parent…] d'après les métadonnées du service.
fn chaine(d: &Daemon, session_id: &str) -> Vec<String> {
    let mut out = vec![session_id.to_string()];
    let mut parent = d.meta(session_id).ok().and_then(|m| m.parent_id);
    while let Some(id) = parent.filter(|id| out.len() < 8 && !out.contains(id)) {
        parent = d.meta(&id).ok().and_then(|m| m.parent_id);
        out.push(id);
    }
    out
}

fn mode(v: &Value) -> SessionResult<Option<Mode>> {
    match v.get("mode") {
        None | Some(Value::Null) => Ok(None),
        Some(m) => serde_json::from_value(m.clone()).map(Some).map_err(protocole),
    }
}

pub fn dispatch(d: &Daemon, method: &str, params: &Value) -> SessionResult<Value> {
    let session = params.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty());
    if let Some(id) = session {
        if crate::sessions::valid_session_id(id).is_err() || (d.config.workspace_root.is_some() && !visible(d, id)) {
            return Err(SessionError::NotFound(id.to_string()));
        }
    }
    let data = &d.config.data_dir;
    match method {
        "approbation.liste" => {
            let liste: Vec<_> = approbation::en_attente().into_iter().filter(|x| visible(d, &x.session_id)).collect();
            Ok(serde_json::to_value(liste)?)
        }
        "approbation.repondre" => {
            let id = params.get("id").and_then(Value::as_str).ok_or_else(|| protocole("id manquant"))?;
            if let Some(attente) = approbation::en_attente().into_iter().find(|x| x.id == id) {
                if !visible(d, &attente.session_id) {
                    return Err(SessionError::NotFound(id.to_string()));
                }
            }
            let decision = match params.get("decision").and_then(Value::as_str).unwrap_or("") {
                "autoriser" => Decision::Autoriser,
                "toujours" => Decision::Toujours,
                "refuser" => Decision::Refuser {
                    motif: params.get("motif").and_then(Value::as_str).unwrap_or("").chars().take(2_000).collect(),
                },
                autre => return Err(protocole(format!("décision inconnue : {autre}"))),
            };
            let demande = approbation::repondre(id, decision).map_err(protocole)?;
            Ok(json!({"ok": true, "sessionId": demande.session_id}))
        }
        "approbation.mode" => {
            let reglages = approbation::lire(data);
            Ok(match session {
                Some(id) => serde_json::to_value(approbation::mode_de(&reglages, &chaine(d, id)))?,
                None => json!({"mode": reglages.defaut, "defaut": reglages.defaut}),
            })
        }
        "approbation.regler" => {
            let reglages = approbation::regler(data, session, mode(params)?).map_err(|e| SessionError::Io(e.to_string()))?;
            Ok(match session {
                Some(id) => serde_json::to_value(approbation::mode_de(&reglages, &chaine(d, id)))?,
                None => json!({"mode": reglages.defaut, "defaut": reglages.defaut}),
            })
        }
        _ => Err(protocole("méthode approbation inconnue")),
    }
}
