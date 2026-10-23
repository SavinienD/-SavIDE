//! axe:v2-l7c — `agents.*` RPC: external agents (OpenCode/DeepSeek, later
//! Codex/Claude) driven by the service in an on-disk task queue.
//!
//! The queue lives under `<workspace>/.axecode/agents/` (the daemon's own
//! `config.workspace_root`), never at a path supplied by the client. Only the
//! commands declared in `<data_dir>/agents-settings.json` can be launched:
//! the client sends a key, never an argv.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use serde_json::{json, Value};
use axecode_agents::{AgentStore, AgentsConfig, AgentsError, SpawnRequest};
use axecode_core::{SessionError, SessionResult};

use crate::Daemon;

fn err(error: AgentsError) -> SessionError {
    SessionError::Protocol(error.to_string())
}

fn protocol(message: &str) -> SessionError {
    SessionError::Protocol(message.to_string())
}

/// One store per canonical workspace root, shared by every connection.
fn stores() -> &'static Mutex<HashMap<PathBuf, AgentStore>> {
    static STORES: OnceLock<Mutex<HashMap<PathBuf, AgentStore>>> = OnceLock::new();
    STORES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn workspace_root(d: &Daemon) -> SessionResult<PathBuf> {
    let raw = d
        .config
        .workspace_root
        .as_ref()
        .ok_or_else(|| protocol("agents: espace de travail non configure"))?;
    let root = raw
        .canonicalize()
        .map_err(|_| protocol("agents: espace de travail non configure"))?;
    if !root.is_dir() {
        return Err(protocol("agents: espace de travail non configure"));
    }
    Ok(root)
}

fn store(d: &Daemon) -> SessionResult<AgentStore> {
    let root = workspace_root(d)?;
    {
        let stores = stores().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(store) = stores.get(&root) {
            return Ok(store.clone());
        }
    }
    let config = AgentsConfig::load(d.data_dir());
    let opened = AgentStore::open(&root, config).map_err(err)?;
    let mut stores = stores().lock().unwrap_or_else(|p| p.into_inner());
    // Another request may have opened it first; keep the shared supervisor.
    Ok(stores.entry(root).or_insert(opened).clone())
}

fn id_of(p: &Value) -> SessionResult<String> {
    p.get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| protocol("agents: id obligatoire"))
}

fn string_field(p: &Value, key: &str) -> SessionResult<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(protocol(&format!("agents: {key} doit etre une chaine"))),
    }
}

fn spawn_request(p: &Value) -> SessionResult<SpawnRequest> {
    let brief = p
        .get("brief")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(AgentsError::MissingBrief)
        .map_err(err)?;
    Ok(SpawnRequest {
        brief,
        label: string_field(p, "label")?,
        commande: string_field(p, "commande")?,
        modele: string_field(p, "modele")?,
    })
}

/// Opens the queue at daemon startup: this recovers ghost `en_cours` tasks
/// (their PID no longer exists) before any client asks for the list.
pub fn start(d: &Daemon) -> SessionResult<()> {
    if d.config.workspace_root.is_none() {
        return Ok(());
    }
    store(d).map(|_| ())
}

pub fn dispatch(d: &Daemon, m: &str, p: &Value) -> SessionResult<Value> {
    let store = store(d)?;
    match m {
        "agents.list" => {
            let agents = store.list();
            Ok(json!({ "agents": agents }))
        }
        "agents.spawn" => {
            let spawned = store.spawn(spawn_request(p)?).map_err(err)?;
            Ok(serde_json::to_value(spawned)?)
        }
        "agents.status" => {
            let status = store.status(&id_of(p)?).map_err(err)?;
            Ok(serde_json::to_value(status)?)
        }
        "agents.stop" => {
            let stopped = store.stop(&id_of(p)?).map_err(err)?;
            Ok(serde_json::to_value(stopped)?)
        }
        "agents.result" => {
            let result = store.result(&id_of(p)?).map_err(err)?;
            Ok(serde_json::to_value(result)?)
        }
        _ => Err(protocol("unknown agents method")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        daemon: Option<Arc<Daemon>>,
    }

    impl Fixture {
        fn new(max: usize) -> Self {
            let base = std::env::temp_dir().join(format!("l7c-agents-{}", uuid::Uuid::new_v4()));
            let root = base.join("work");
            std::fs::create_dir_all(&root).unwrap();
            let data = base.join("data");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(
                data.join(axecode_agents::config::CONFIG_FILE),
                serde_json::to_vec(&json!({
                    "agents_max": max,
                    "agents_delai_s": 30,
                    "agents_modele": "test/modele",
                    "agents_commandes": {
                        "test": ["/bin/sh", "-c", "echo started; sleep 30"]
                    }
                }))
                .unwrap(),
            )
            .unwrap();
            let mut config = crate::DaemonConfig::new(data);
            config.workspace_root = Some(root.clone());
            let daemon = Daemon::new(config, Arc::new(crate::stub::EchoFactory));
            Self {
                base,
                root,
                daemon: Some(daemon),
            }
        }

        fn call(&self, method: &str, params: Value) -> SessionResult<Value> {
            dispatch(self.daemon.as_ref().unwrap(), method, &params)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.daemon = None;
            // Stop any process still alive before removing the folder.
            let agents = self.root.join(".axecode/agents");
            if let Ok(entries) = std::fs::read_dir(&agents) {
                for entry in entries.flatten() {
                    let raw = std::fs::read_to_string(entry.path().join("etat.json"));
                    if let Ok(raw) = raw {
                        if let Ok(state) =
                            serde_json::from_str::<axecode_agents::TaskState>(&raw)
                        {
                            if state.statut == axecode_agents::Statut::EnCours {
                                if let Some(pid) = state.pid {
                                    let _ = std::process::Command::new("kill")
                                        .args(["-9", &format!("-{pid}")])
                                        .output();
                                }
                            }
                        }
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_list_status_result_and_stop() {
        let f = Fixture::new(2);
        let spawned = f
            .call(
                "agents.spawn",
                json!({"brief": "fais le travail", "commande": "test"}),
            )
            .unwrap();
        let id = spawned["id"].as_str().unwrap().to_string();
        assert_eq!(spawned["statut"], "en_cours");

        let listed = f.call("agents.list", json!({})).unwrap();
        let entry = listed["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id.as_str())
            .unwrap()
            .clone();
        assert_eq!(entry["label"], "fais le travail");
        assert_eq!(entry["modele"], "test/modele");
        assert_eq!(entry["resume"], Value::Null);
        assert!(entry["journalTaille"].as_u64().is_some());

        // The journal is appended as the child writes.
        let mut journal = String::new();
        for _ in 0..100 {
            let status = f.call("agents.status", json!({"id": id})).unwrap();
            journal = status["journal"].as_str().unwrap_or_default().to_string();
            if journal.contains("started") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        assert!(journal.contains("started"), "journal: {journal:?}");

        let result = f.call("agents.result", json!({"id": id})).unwrap();
        assert_eq!(result["present"], false);
        assert_eq!(result["resultat"], "");

        let stopped = f.call("agents.stop", json!({"id": id})).unwrap();
        assert_eq!(stopped["statut"], "arrete");
        // Idempotent.
        let again = f.call("agents.stop", json!({"id": id})).unwrap();
        assert_eq!(again["statut"], "arrete");
        let status = f.call("agents.status", json!({"id": id})).unwrap();
        assert_eq!(status["statut"], "arrete");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn invalid_parameters_are_refused() {
        let f = Fixture::new(2);
        assert_eq!(
            f.call("agents.spawn", json!({"commande": "test"}))
                .unwrap_err()
                .to_string(),
            "protocol error: agents: brief obligatoire"
        );
        assert_eq!(
            f.call("agents.spawn", json!({"brief": "   "}))
                .unwrap_err()
                .to_string(),
            "protocol error: agents: brief obligatoire"
        );
        assert_eq!(
            f.call(
                "agents.spawn",
                json!({"brief": "ok", "commande": "rm -rf /"})
            )
            .unwrap_err()
            .to_string(),
            "protocol error: agents: commande inconnue"
        );
        assert!(f.call("agents.spawn", json!({"brief": "ok", "label": 3})).is_err());
        assert!(f.call("agents.status", json!({})).is_err());
        assert!(f.call("agents.nope", json!({})).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unknown_ids_are_refused() {
        let f = Fixture::new(2);
        for method in ["agents.status", "agents.stop", "agents.result"] {
            assert_eq!(
                f.call(method, json!({"id": "2026-01-01-000000-abcdef"}))
                    .unwrap_err()
                    .to_string(),
                "protocol error: agents: tache inconnue",
                "{method}"
            );
            assert_eq!(
                f.call(method, json!({"id": "../escape"}))
                    .unwrap_err()
                    .to_string(),
                "protocol error: agents: tache inconnue",
                "{method}"
            );
        }
        assert!(!f.root.join(".axecode/agents/../escape").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn methods_need_a_workspace_root() {
        let base = std::env::temp_dir().join(format!("l7c-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let daemon = Daemon::new(
            crate::DaemonConfig::new(base.join("data")),
            Arc::new(crate::stub::EchoFactory),
        );
        let error = dispatch(&daemon, "agents.list", &json!({}))
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "protocol error: agents: espace de travail non configure"
        );
        drop(daemon);
        let _ = std::fs::remove_dir_all(&base);
    }
}
