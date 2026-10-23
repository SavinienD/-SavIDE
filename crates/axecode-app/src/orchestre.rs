//! axe:ds16 — l'orchestrateur : l'agent principal confie des tâches longues à des
//! agents externes (store `axecode-agents`), attend sans dépenser de jetons (sondage
//! disque toutes les 500 ms) et lit leur rapport.
use std::{path::{Path, PathBuf}, time::Duration};

use serde_json::{json, Value};
use axecode_agents::{AgentStore, AgentsConfig, SpawnRequest};
use axecode_core::ToolDescriptor;

use crate::ToolRunResult;

pub const AGENTS_SPAWN: &str = "agents_spawn";
pub const AGENTS_WAIT: &str = "agents_wait";
pub const AGENTS_RESULT: &str = "agents_result";
const WAIT_DEFAULT_S: u64 = 600;
const WAIT_MAX_S: u64 = 1800;
const RESULT_MAX: usize = 20_000;

pub fn is_orchestrator_tool(name: &str) -> bool {
    matches!(name, AGENTS_SPAWN | AGENTS_WAIT | AGENTS_RESULT)
}

pub fn descriptors() -> Vec<ToolDescriptor> {
    let rappel = " Un agent externe ne voit ni l'historique ni les secrets de ce fil : le brief doit être autonome.";
    vec![
        ToolDescriptor {
            name: AGENTS_SPAWN.into(),
            description: format!("Confie une tâche longue à un agent externe (gratuit) et continue à travailler. Renvoie {{id, statut}}.{rappel}"),
            input_schema: json!({"type":"object","properties":{
                "brief":{"type":"string","description":"Consigne complète et autonome"},
                "label":{"type":"string"},
                "commande":{"type":"string","description":"Clé de la liste blanche (ex. opencode)"},
                "modele":{"type":"string"}},
                "required":["brief"],"additionalProperties":false}),
        },
        ToolDescriptor {
            name: AGENTS_WAIT.into(),
            description: "Attend, SANS dépenser de jetons, qu'au moins une des tâches se termine (ou le délai, 600 s par défaut, 1800 s maximum).".into(),
            input_schema: json!({"type":"object","properties":{
                "ids":{"type":"array","items":{"type":"string"}},
                "timeoutSecondes":{"type":"integer","minimum":1,"maximum":WAIT_MAX_S}},
                "required":["ids"],"additionalProperties":false}),
        },
        ToolDescriptor {
            name: AGENTS_RESULT.into(),
            description: "Lit le rapport final (resultat.md) d'un agent externe, tronqué à 20 000 caractères.".into(),
            input_schema: json!({"type":"object","properties":{"id":{"type":"string"}},
                "required":["id"],"additionalProperties":false}),
        },
    ]
}

fn data_dir() -> PathBuf {
    directories::ProjectDirs::from("", "", "savide")
        .map(|d| d.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn open(root: &Path) -> Result<AgentStore, String> {
    AgentStore::open(root, AgentsConfig::load(&data_dir())).map_err(|e| e.to_string())
}

pub async fn run(workspace_root: &Path, name: &str, input: Value) -> ToolRunResult {
    let store = match open(workspace_root) {
        Ok(s) => s,
        Err(e) => return ToolRunResult::err(e, Vec::new()),
    };
    run_with(&store, name, input, Duration::from_millis(500)).await
}

pub async fn run_with(store: &AgentStore, name: &str, input: Value, pas: Duration) -> ToolRunResult {
    let texte = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    match name {
        AGENTS_SPAWN => {
            let Some(brief) = texte("brief") else {
                return ToolRunResult::err("agents: brief obligatoire", Vec::new());
            };
            match store.spawn(SpawnRequest { brief, label: texte("label"), commande: texte("commande"), modele: texte("modele") }) {
                Ok(s) => ToolRunResult::ok(json!({"id": s.id, "statut": s.statut.as_str()}).to_string(), Vec::new()),
                Err(e) => ToolRunResult::err(e.to_string(), Vec::new()),
            }
        }
        AGENTS_WAIT => {
            let ids: Vec<String> = input.get("ids").and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                return ToolRunResult::err("agents: ids obligatoire", Vec::new());
            }
            let delai = input.get("timeoutSecondes").and_then(Value::as_u64)
                .unwrap_or(WAIT_DEFAULT_S).clamp(1, WAIT_MAX_S);
            let fin = tokio::time::Instant::now() + Duration::from_secs(delai);
            loop {
                store.pump();
                let mut termines = Vec::new();
                let mut encore = Vec::new();
                for id in &ids {
                    match store.status(id) {
                        Ok(v) if v.statut.is_terminal() => {
                            let resume: String = v.journal.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
                            termines.push(json!({"id": v.id, "statut": v.statut.as_str(), "codeSortie": v.code_sortie, "resume": resume}));
                        }
                        Ok(_) => encore.push(id.clone()),
                        Err(e) => termines.push(json!({"id": id, "statut": "erreur", "codeSortie": null, "resume": e.to_string()})),
                    }
                }
                let expire = tokio::time::Instant::now() >= fin;
                if !termines.is_empty() || expire {
                    return ToolRunResult::ok(json!({"termines": termines, "encoreEnCours": encore, "delaiAtteint": termines.is_empty() && expire}).to_string(), Vec::new());
                }
                tokio::time::sleep(pas).await; // non bloquant : rend la main au runtime
            }
        }
        AGENTS_RESULT => {
            let Some(id) = texte("id") else {
                return ToolRunResult::err("agents: id obligatoire", Vec::new());
            };
            match store.result(&id) {
                Ok(r) => {
                    let mut resultat = r.resultat;
                    if resultat.chars().count() > RESULT_MAX {
                        resultat = resultat.chars().take(RESULT_MAX).collect::<String>() + "\n(tronqué)";
                    }
                    ToolRunResult::ok(json!({"id": r.id, "present": r.present, "resultat": resultat}).to_string(), Vec::new())
                }
                Err(e) => ToolRunResult::err(e.to_string(), Vec::new()),
            }
        }
        _ => ToolRunResult::err(format!("unknown tool: {name}"), Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(cmd: &[&str]) -> (tempfile::TempDir, AgentStore) {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AgentsConfig::default();
        cfg.agents_commandes.clear();
        cfg.agents_commandes.insert("faux".into(), cmd.iter().map(|s| s.to_string()).collect());
        let s = AgentStore::open(dir.path(), cfg).unwrap();
        (dir, s)
    }

    fn val(r: &ToolRunResult) -> Value { serde_json::from_str(&r.content).unwrap() }

    #[tokio::test]
    async fn spawn_wait_result_et_erreurs() {
        let (_d, s) = store(&["sh", "-c", "printf rapport > {dir}/resultat.md"]);
        let p = Duration::from_millis(50);
        let r = run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"faux"}), p).await;
        assert!(!r.is_error, "{}", r.content);
        let id = val(&r)["id"].as_str().unwrap().to_string();
        let refus = run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"inconnue"}), p).await;
        assert!(refus.is_error && refus.content.contains("commande inconnue"));
        let w = run_with(&s, AGENTS_WAIT, json!({"ids":[id],"timeoutSecondes":20}), p).await;
        assert_eq!(val(&w)["termines"].as_array().unwrap().len(), 1, "{}", w.content);
        let res = run_with(&s, AGENTS_RESULT, json!({"id": id}), p).await;
        assert_eq!(val(&res)["resultat"], "rapport");
        let absent = run_with(&s, AGENTS_RESULT, json!({"id":"zzz"}), p).await;
        assert!(absent.is_error || val(&absent)["present"] == false);
    }

    #[tokio::test]
    async fn wait_expire() {
        let (_d, s) = store(&["sleep", "30"]);
        let p = Duration::from_millis(50);
        let id = val(&run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"faux"}), p).await)["id"].as_str().unwrap().to_string();
        let w = run_with(&s, AGENTS_WAIT, json!({"ids":[id.clone()],"timeoutSecondes":1}), p).await;
        assert_eq!(val(&w)["delaiAtteint"], true);
        let _ = s.stop(&id);
    }

    #[tokio::test]
    async fn result_tronque() {
        let (_d, s) = store(&["sh", "-c", "head -c 25000 /dev/zero | tr '\\0' a > {dir}/resultat.md"]);
        let p = Duration::from_millis(50);
        let id = val(&run_with(&s, AGENTS_SPAWN, json!({"brief":"b","commande":"faux"}), p).await)["id"].as_str().unwrap().to_string();
        run_with(&s, AGENTS_WAIT, json!({"ids":[id.clone()],"timeoutSecondes":20}), p).await;
        let r = val(&run_with(&s, AGENTS_RESULT, json!({"id": id}), p).await);
        assert!(r["resultat"].as_str().unwrap().ends_with("(tronqué)"));
    }
}
