//! axe:commandes — état des commandes de session (`/goal`, `/heartbeat`) pour
//! les indicateurs de l'IDE (à côté du sélecteur de modèle).
//!
//! L'état est tenu par le crochet de session (`axecode_app::session_commands`)
//! dans `<data_dir>/session_state/<id>.json` ; ce crochet relit le fichier à
//! chaque usage, ce qui permet à l'IDE de l'arrêter d'ici :
//! - `sessions.commands_state {sessionId}` -> `{goal, heartbeat, autonomous}`
//! - `sessions.commands_set {sessionId, op}` avec `op` dans `heartbeat_off`,
//!   `goal_pause`, `goal_resume`, `goal_done`, `goal_clear`.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use axecode_core::{JournalEntryKind, SessionError, SessionResult};

use crate::daemon::Daemon;

fn state_path(data_dir: &Path, id: &str) -> SessionResult<PathBuf> {
    if id.is_empty() || id.contains(['/', '\\', '.']) {
        return Err(SessionError::Runtime("identifiant de session invalide".into()));
    }
    Ok(data_dir.join("session_state").join(format!("{id}.json")))
}

fn read(data_dir: &Path, id: &str) -> SessionResult<Value> {
    let path = state_path(data_dir, id)?;
    Ok(std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({})))
}

/// Vue renvoyée à l'IDE (champs absents = `null`).
pub fn view(state: &Value) -> Value {
    let get = |k: &str| state.get(k).cloned().unwrap_or(Value::Null);
    json!({"goal": get("goal"), "heartbeat": get("heartbeat"), "autonomous": get("autonomous")})
}

/// Applique `op` à l'état (fonction pure, testée).
pub fn apply(state: &mut Value, op: &str) -> SessionResult<()> {
    let obj = state
        .as_object_mut()
        .ok_or_else(|| SessionError::Runtime("état de session illisible".into()))?;
    match op {
        "heartbeat_off" => {
            obj.insert("heartbeat".into(), Value::Null);
        }
        "goal_clear" => {
            obj.insert("goal".into(), Value::Null);
        }
        "goal_pause" | "goal_resume" | "goal_done" => {
            let goal = obj
                .get_mut("goal")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| SessionError::Runtime("aucun goal en cours".into()))?;
            let status = match op {
                "goal_pause" => "paused",
                "goal_resume" => "active",
                _ => "complete",
            };
            goal.insert("status".into(), json!(status));
            if op == "goal_done" {
                goal.insert("summary".into(), json!("marqué atteint par l'utilisateur"));
            }
        }
        other => return Err(SessionError::Runtime(format!("opération inconnue : {other}"))),
    }
    Ok(())
}

pub fn state(daemon: &Daemon, id: &str) -> SessionResult<Value> {
    Ok(view(&read(daemon.data_dir(), id)?))
}

pub fn set(daemon: &Daemon, id: &str, op: &str) -> SessionResult<Value> {
    let mut state = read(daemon.data_dir(), id)?;
    apply(&mut state, op)?;
    let path = state_path(daemon.data_dir(), id)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| SessionError::Io(e.to_string()))?;
    }
    let bytes = serde_json::to_vec_pretty(&state).map_err(|e| SessionError::Io(e.to_string()))?;
    std::fs::write(&path, bytes).map_err(|e| SessionError::Io(e.to_string()))?;
    let (name, payload) = match op {
        "heartbeat_off" => ("heartbeat", json!({"op": "clear", "by": "ide"})),
        _ => ("goal", json!({"op": op.trim_start_matches("goal_"), "by": "ide", "goal": state.get("goal")})),
    };
    let _ = daemon.append(id, JournalEntryKind::Extension { name: name.into(), payload });
    Ok(view(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_de_l_ide() {
        let mut s = json!({"goal": {"text": "lot 3", "status": "active"}, "heartbeat": {"interval_ms": 60000, "message": "coucou", "next_at_ms": 1}});
        apply(&mut s, "goal_pause").unwrap();
        assert_eq!(s["goal"]["status"], "paused");
        apply(&mut s, "goal_resume").unwrap();
        assert_eq!(s["goal"]["status"], "active");
        apply(&mut s, "goal_done").unwrap();
        assert_eq!(s["goal"]["status"], "complete");
        apply(&mut s, "heartbeat_off").unwrap();
        assert!(view(&s)["heartbeat"].is_null());
        apply(&mut s, "goal_clear").unwrap();
        assert!(view(&s)["goal"].is_null());
        assert!(apply(&mut s, "goal_pause").is_err(), "pas de goal : refus");
        assert!(apply(&mut s, "rm -rf").is_err());
        assert!(state_path(Path::new("/d"), "../x").is_err());
    }
}
