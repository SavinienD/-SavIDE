//! commandes — état des commandes de session (`/goal`, `/heartbeat`) pour
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

/// Vue renvoyée à l'IDE (champs absents = `null`).
pub fn view(state: &Value) -> Value {
    let get = |k: &str| state.get(k).cloned().unwrap_or(Value::Null);
    json!({"goal": get("goal"), "heartbeat": get("heartbeat"), "autonomous": get("autonomous"),
        // Endless mode (/nonstop): badge « Sans fin » with its stop button.
        "sans_fin": get("sans_fin"),
        // guet — guets en cours (indicateur à côté du modèle).
        "guets": state.get("guets").cloned().filter(Value::is_array).unwrap_or_else(|| json!([]))})
}

/// Stop the endless mode in the raw state (pure, tested); false when it was not running.
pub fn arreter_sans_fin_valeur(state: &mut Value, raison: &str, maintenant: i64) -> bool {
    let Some(sf) = state.get_mut("sans_fin").and_then(Value::as_object_mut) else { return false };
    if sf.get("status").and_then(Value::as_str) != Some("running") {
        return false;
    }
    sf.insert("status".into(), json!("stopped"));
    sf.insert("next_relaunch_ms".into(), Value::Null);
    sf.insert("stopped_ms".into(), json!(maintenant));
    sf.insert("stop_reason".into(), json!(raison));
    true
}

/// Stop button / Échap (`sessions.stop`): the endless mode of the conversation ends
/// too (only the user ends it). No state file, or mode not running: nothing.
pub fn arreter_sans_fin(daemon: &Daemon, id: &str, raison: &str) {
    let Ok(path) = state_path(daemon.data_dir(), id) else { return };
    if !path.exists() {
        return;
    }
    let maintenant = axecode_app::session_commands::now_ms();
    let res = axecode_app::session_commands::update_state_value(daemon.data_dir(), id, |state| {
        let arrete = arreter_sans_fin_valeur(state, raison, maintenant);
        if arrete {
            if let Some(obj) = state.as_object_mut() {
                if let Some(list) = obj.entry("notices").or_insert_with(|| json!([])).as_array_mut() {
                    list.push(json!("L'utilisateur a arrêté le mode sans fin : tu ne seras plus relancé."));
                }
            }
        }
        Ok(arrete)
    });
    if let Ok((true, _)) = res {
        let _ = daemon.append(id, JournalEntryKind::Extension { name: "sans_fin".into(), payload: json!({"op": "stop", "by": "stop", "reason": raison}) });
    }
}

/// Applique `op` à l'état (fonction pure, testée).
pub fn apply(state: &mut Value, op: &str) -> SessionResult<()> {
    if op == "sans_fin_stop" {
        if !arreter_sans_fin_valeur(state, "arrêté depuis l'interface", axecode_app::session_commands::now_ms()) {
            return Err(SessionError::Runtime("le mode sans fin n'est pas actif".into()));
        }
        return Ok(());
    }
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

        // guet — `guet_annuler:<id>` (ou `guet_annuler` : tous). La tâche du guet
        // relit l'état et s'arrête (la commande lancée est tuée).
        op if op == "guet_annuler" || op.starts_with("guet_annuler:") => {
            let cible = op.strip_prefix("guet_annuler:").unwrap_or("");
            let liste = obj.get_mut("guets").and_then(Value::as_array_mut).ok_or_else(|| SessionError::Runtime("aucun guet en cours".into()))?;
            let avant = liste.len();
            liste.retain(|g| !(cible.is_empty() || g.get("id").and_then(Value::as_str) == Some(cible)));
            if liste.len() == avant {
                return Err(SessionError::Runtime(format!("aucun guet {cible}")));
            }
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

// goal165 — same store, same lock and atomic write as the session hook
// (`axecode_app::session_commands`): one source of truth for the objective.
pub fn state(daemon: &Daemon, id: &str) -> SessionResult<Value> {
    state_path(daemon.data_dir(), id)?;
    Ok(view(&axecode_app::session_commands::read_state(daemon.data_dir(), id)))
}

/// One-shot notice for the agent's next request: it learns that the user acted
/// from the IDE (before: the objective vanished without a word).
fn notice(op: &str) -> Option<&'static str> {
    Some(match op {
        "goal_clear" => "L'utilisateur a arrêté l'objectif depuis l'interface : il n'y en a plus, n'y travaille plus.",
        "goal_pause" => "L'utilisateur a mis l'objectif en pause depuis l'interface : plus de poursuite automatique tant qu'il ne l'a pas repris.",
        "goal_resume" => "L'utilisateur a repris l'objectif depuis l'interface : continue d'y travailler.",
        "goal_done" => "L'utilisateur a marqué l'objectif comme atteint depuis l'interface. N'y travaille plus.",
        "heartbeat_off" => "L'utilisateur a arrêté le réveil (heartbeat) depuis l'interface.",
        "sans_fin_stop" => "L'utilisateur a arrêté le mode sans fin depuis l'interface : tu ne seras plus relancé.",
        op if op.starts_with("guet_annuler") => "L'utilisateur a annulé le guet depuis l'interface : tu ne seras pas réveillé pour lui.",
        _ => return None,
    })
}

pub fn set(daemon: &Daemon, id: &str, op: &str) -> SessionResult<Value> {
    state_path(daemon.data_dir(), id)?;
    let ((), state) = axecode_app::session_commands::update_state_value(daemon.data_dir(), id, |state| {
        apply(state, op).map_err(|e| e.to_string())?;
        if let (Some(text), Some(obj)) = (notice(op), state.as_object_mut()) {
            let notices = obj.entry("notices").or_insert_with(|| json!([]));
            if let Some(list) = notices.as_array_mut() {
                list.push(json!(text));
            }
        }
        Ok(())
    })
    .map_err(SessionError::Runtime)?;
    let (name, payload) = match op {
        "heartbeat_off" => ("heartbeat", json!({"op": "clear", "by": "ide"})),
        "sans_fin_stop" => ("sans_fin", json!({"op": "stop", "by": "ide"})),
        op if op.starts_with("guet_annuler") => ("guet", json!({"op": "annule", "by": "ide", "cible": op.strip_prefix("guet_annuler:")})),
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

    #[test]
    fn arret_du_mode_sans_fin() {
        let mut s = json!({"sans_fin": {"task": "lot", "status": "running", "started_ms": 1, "next_relaunch_ms": 5}});
        assert!(view(&s)["sans_fin"]["status"] == "running", "visible par l'interface");
        apply(&mut s, "sans_fin_stop").unwrap();
        assert_eq!(s["sans_fin"]["status"], "stopped");
        assert!(s["sans_fin"]["next_relaunch_ms"].is_null());
        assert_eq!(s["sans_fin"]["stop_reason"], "arrêté depuis l'interface");
        assert!(apply(&mut s, "sans_fin_stop").is_err(), "déjà arrêté");
        assert!(!arreter_sans_fin_valeur(&mut json!({}), "x", 1), "pas de mode : rien");
    }
}
