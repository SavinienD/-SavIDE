//! axe:file-demon — file d'attente des messages, tenue par le service.
//!
//! Avant, la file vivait dans le navigateur de l'IDE (localStorage) et ne
//! partait que si l'IDE montrait l'espace de la conversation. Elle vit
//! maintenant ici, par session, sur disque (`<données>/queues/<id>.json`) :
//! dès que le tour d'une session finit (worker terminé, session `idle`), le
//! premier message part, puis le suivant au tour d'après. Ordre conservé,
//! un seul envoi par élément (retiré de la file sous le même verrou).
//!
//! - `queue.list {sessionId?}` -> `{sessionId: [item]}` ou `[item]`
//! - `queue.push {sessionId, item: {id, text, message, model?, createdAtMs?}, index?}`
//! - `queue.remove {sessionId, itemId}` ; `queue.move {sessionId, itemId, index}`
//! - `queue.clear {sessionId}`
//! Chaque changement diffuse l'événement `queue` `{sessionId, items}`.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
};

use axecode_core::{ChatMessage, ModelRef, SessionError, SessionResult, SessionStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::daemon::{lock, Daemon};
use crate::sessions::valid_session_id;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    /// Texte affiché dans la file.
    pub text: String,
    /// Message prêt à journaliser (pièces jointes déjà résolues par l'IDE).
    pub message: ChatMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// Données d'affichage de l'IDE (pièces jointes, réflexion, mode…), rendues telles quelles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<Value>,
    #[serde(default)]
    pub created_at_ms: i64,
}

#[derive(Default)]
pub struct Queues {
    loaded: bool,
    map: HashMap<String, Vec<QueueItem>>,
    /// axe:file-pause — files en pause après un Stop (« Reprendre la file »).
    paused: std::collections::HashSet<String>,
}

pub type QueuesState = Mutex<Queues>;

fn dir(d: &Daemon) -> PathBuf {
    d.config.data_dir.join("queues")
}

fn ensure_loaded(d: &Daemon, q: &mut Queues) {
    if q.loaded {
        return;
    }
    q.loaded = true;
    let Ok(entries) = std::fs::read_dir(dir(d)) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        if path.extension().and_then(|e| e.to_str()) != Some("json") || valid_session_id(&id).is_err() {
            continue;
        }
        if let Ok(items) = std::fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice::<Vec<QueueItem>>(&b).map_err(|e| e.to_string()))
        {
            if !items.is_empty() {
                q.map.insert(id, items);
            }
        }
    }
}

fn pause_path(d: &Daemon, id: &str) -> PathBuf {
    dir(d).join(format!("{id}.paused"))
}

fn is_paused(d: &Daemon, q: &Queues, id: &str) -> bool {
    q.paused.contains(id) || pause_path(d, id).exists()
}

fn set_paused(d: &Daemon, q: &mut Queues, id: &str, on: bool) {
    if on {
        q.paused.insert(id.to_string());
        let _ = std::fs::create_dir_all(dir(d));
        let _ = std::fs::write(pause_path(d, id), b"");
    } else {
        q.paused.remove(id);
        let _ = std::fs::remove_file(pause_path(d, id));
    }
}

fn save(d: &Daemon, id: &str, items: &[QueueItem]) {
    let dir = dir(d);
    let path = dir.join(format!("{id}.json"));
    if items.is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let tmp = dir.join(format!("{id}.json.tmp"));
    if let Ok(bytes) = serde_json::to_vec(items) {
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Modifie la file d'une session (sauvée + diffusée).
fn edit<R>(d: &Daemon, id: &str, f: impl FnOnce(&mut Vec<QueueItem>) -> R) -> R {
    let (out, items) = {
        let mut q = lock(&d.queues);
        ensure_loaded(d, &mut q);
        let items = q.map.entry(id.to_string()).or_default();
        let out = f(items);
        let snapshot = items.clone();
        if snapshot.is_empty() {
            q.map.remove(id);
            set_paused(d, &mut q, id, false); // file vide : plus de pause
        }
        save(d, id, &snapshot);
        let paused = is_paused(d, &q, id);
        (out, (snapshot, paused))
    };
    let (items, paused) = items;
    d.broadcast("queue", Some(id), json!({"sessionId": id, "items": items, "paused": paused}));
    out
}

pub fn items(d: &Daemon, id: &str) -> Vec<QueueItem> {
    let mut q = lock(&d.queues);
    ensure_loaded(d, &mut q);
    q.map.get(id).cloned().unwrap_or_default()
}

fn idle(d: &Daemon, id: &str) -> bool {
    lock(&d.sessions)
        .get(id)
        .is_some_and(|s| s.cancel.is_none() && s.meta.status != SessionStatus::Running)
}

/// Fin de tour (ou ajout sur une session libre) : le premier message part.
/// Appelé sans aucun verrou tenu.
pub fn dispatch_next(d: &Daemon, id: &str) {
    if !idle(d, id) {
        return;
    }
    {
        let mut q = lock(&d.queues);
        ensure_loaded(d, &mut q);
        if is_paused(d, &q, id) {
            return; // axe:file-pause — après un Stop, on attend « Reprendre la file »
        }
    }
    let next = edit(d, id, |items| (!items.is_empty()).then(|| items.remove(0)));
    let Some(item) = next else { return };
    if let Some(model) = item.model.clone() {
        let _ = d.set_model(id, model);
    }
    if let Err(err) = d.send_user(id, item.message.clone()) {
        tracing::warn!(session = %id, error = %err, "queued message not sent, back in queue");
        edit(d, id, |items| items.insert(0, item));
    }
}

/// Au démarrage du service : les files des sessions libres partent.
pub fn dispatch_all(d: &Daemon) {
    let ids: Vec<String> = {
        let mut q = lock(&d.queues);
        ensure_loaded(d, &mut q);
        q.map.keys().cloned().collect()
    };
    for id in ids {
        dispatch_next(d, &id);
    }
}

/// axe:file-pause — Stop de l'utilisateur : la file (non vide) se met en pause.
pub fn pause_after_stop(d: &Daemon, id: &str) {
    let paused = {
        let mut q = lock(&d.queues);
        ensure_loaded(d, &mut q);
        if q.map.get(id).is_none_or(|v| v.is_empty()) {
            return;
        }
        set_paused(d, &mut q, id, true);
        true
    };
    d.broadcast("queue", Some(id), json!({"sessionId": id, "items": items(d, id), "paused": paused}));
}

fn sid(p: &Value) -> SessionResult<String> {
    let id = p.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
    valid_session_id(&id)?;
    Ok(id)
}

pub fn dispatch(d: &Daemon, m: &str, p: &Value) -> SessionResult<Value> {
    match m {
        "queue.list" => {
            if p.get("sessionId").and_then(Value::as_str).is_some() {
                let id = sid(p)?;
                return Ok(serde_json::to_value(items(d, &id))?);
            }
            let mut q = lock(&d.queues);
            ensure_loaded(d, &mut q);
            Ok(serde_json::to_value(&q.map)?)
        }
        "queue.push" => {
            let id = sid(p)?;
            d.meta(&id)?;
            let mut item: QueueItem = serde_json::from_value(p.get("item").cloned().unwrap_or_default())
                .map_err(|e| SessionError::Protocol(e.to_string()))?;
            if item.id.is_empty() {
                item.id = crate::util::new_id();
            }
            if item.created_at_ms == 0 {
                item.created_at_ms = crate::util::now_ms();
            }
            let index = p.get("index").and_then(Value::as_u64).map(|i| i as usize);
            let out = edit(d, &id, |items| {
                // Même id = remplacement (édition), jamais de doublon.
                let old = items.iter().position(|i| i.id == item.id);
                if let Some(pos) = old {
                    items.remove(pos);
                }
                let at = index.or(old).unwrap_or(items.len()).min(items.len());
                items.insert(at, item);
                items.clone()
            });
            dispatch_next(d, &id);
            Ok(serde_json::to_value(out)?)
        }
        "queue.remove" => {
            let id = sid(p)?;
            let item_id = p.get("itemId").and_then(Value::as_str).unwrap_or("").to_string();
            let out = edit(d, &id, |items| {
                let pos = items.iter().position(|i| i.id == item_id);
                pos.map(|pos| items.remove(pos))
            });
            Ok(serde_json::to_value(out)?)
        }
        "queue.move" => {
            let id = sid(p)?;
            let item_id = p.get("itemId").and_then(Value::as_str).unwrap_or("").to_string();
            let index = p.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let out = edit(d, &id, |items| {
                if let Some(pos) = items.iter().position(|i| i.id == item_id) {
                    let item = items.remove(pos);
                    let at = index.min(items.len());
                    items.insert(at, item);
                }
                items.clone()
            });
            Ok(serde_json::to_value(out)?)
        }
        "queue.state" => {
            let id = sid(p)?;
            let list = items(d, &id);
            let mut q = lock(&d.queues);
            ensure_loaded(d, &mut q);
            Ok(json!({"items": list, "paused": is_paused(d, &q, &id)}))
        }
        "queue.resume" => {
            let id = sid(p)?;
            {
                let mut q = lock(&d.queues);
                ensure_loaded(d, &mut q);
                set_paused(d, &mut q, &id, false);
            }
            d.broadcast("queue", Some(&id), json!({"sessionId": id, "items": items(d, &id), "paused": false}));
            dispatch_next(d, &id);
            Ok(json!({"ok": true}))
        }
        "queue.clear" => {
            let id = sid(p)?;
            edit(d, &id, |items| items.clear());
            Ok(json!({"ok": true}))
        }
        _ => Err(SessionError::Protocol(format!("unknown method: {m}"))),
    }
}
