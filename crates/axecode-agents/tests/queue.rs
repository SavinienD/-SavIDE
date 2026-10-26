//! On-disk queue and supervisor tests. Every test uses a temporary workspace
//! and only fake commands declared in its own config (`/bin/sh`).

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::{json, Value};
use axecode_agents::{
    atomic_write, pid_alive, AgentStore, AgentsConfig, SpawnRequest, Statut, TaskState,
};

struct Fixture {
    base: PathBuf,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("axecode-agents-{}", uuid::Uuid::new_v4()));
        let root = base.join("work");
        std::fs::create_dir_all(&root).unwrap();
        Self { base, root }
    }

    fn config(&self, max: usize, delai_s: u64, commands: &[(&str, &[&str])]) -> AgentsConfig {
        let mut map = BTreeMap::new();
        for (key, argv) in commands {
            map.insert(
                key.to_string(),
                argv.iter().map(|arg| arg.to_string()).collect(),
            );
        }
        AgentsConfig {
            agents_max: max,
            agents_delai_s: delai_s,
            agents_modele: "test/modele".into(),
            agents_commandes: map,
        }
    }

    fn store(&self, config: AgentsConfig) -> AgentStore {
        AgentStore::open_at(&self.root, &self.root.join(".axecode/agents"), config).unwrap()
    }

    fn task_dir(&self, id: &str) -> PathBuf {
        self.root.join(".axecode/agents").join(id)
    }

    fn state(&self, id: &str) -> TaskState {
        let raw = std::fs::read_to_string(self.task_dir(id).join("etat.json")).unwrap();
        serde_json::from_str(&raw).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Stop anything still running before deleting the folder.
        let agents = self.root.join(".axecode/agents");
        if let Ok(entries) = std::fs::read_dir(&agents) {
            for entry in entries.flatten() {
                let raw = std::fs::read_to_string(entry.path().join("etat.json"));
                if let Ok(raw) = raw {
                    if let Ok(state) = serde_json::from_str::<TaskState>(&raw) {
                        if state.statut == Statut::EnCours {
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

fn request(brief: &str, commande: &str) -> SpawnRequest {
    SpawnRequest {
        brief: brief.to_string(),
        label: None,
        commande: Some(commande.to_string()),
        modele: None,
    }
}

async fn wait_until<F: Fn() -> bool>(what: &str, pred: F) {
    for _ in 0..300 {
        if pred() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("condition not reached: {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_writes_the_task_files_and_its_state() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        30,
        &[("test", &["/bin/sh", "-c", "echo started; sleep 30"])],
    ));
    let spawned = store
        .spawn(request("fais le travail\navec soin", "test"))
        .unwrap();
    assert_eq!(spawned.statut, Statut::EnCours);
    assert!(spawned.id.len() > 10);

    let dir = f.task_dir(&spawned.id);
    assert_eq!(
        std::fs::read_to_string(dir.join("tache.md")).unwrap(),
        "fais le travail\navec soin"
    );
    assert!(dir.join("journal.log").is_file());
    assert!(!dir.join("resultat.md").exists());
    // No leftover temporary file from the atomic writes.
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temporary files: {leftovers:?}");

    let state = f.state(&spawned.id);
    assert_eq!(state.id, spawned.id);
    assert_eq!(state.label, "fais le travail avec soin");
    assert_eq!(state.commande, "test");
    assert_eq!(state.modele, "test/modele");
    assert_eq!(state.statut, Statut::EnCours);
    assert!(state.pid.is_some());
    assert!(state.debut_ms.is_some());
    assert_eq!(state.fin_ms, None);
    assert_eq!(state.code_sortie, None);
    assert_eq!(state.journal, "journal.log");

    // The state on disk is exactly the frozen JSON shape.
    let raw: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("etat.json")).unwrap()).unwrap();
    for key in [
        "id",
        "label",
        "commande",
        "modele",
        "statut",
        "pid",
        "debutMs",
        "finMs",
        "codeSortie",
        "journal",
    ] {
        assert!(raw.get(key).is_some(), "missing {key} in etat.json");
    }
    assert_eq!(raw["statut"], "en_cours");

    // The default label is the first 40 characters of the brief.
    let long = "x".repeat(120);
    let spawned = store.spawn(request(&long, "test")).unwrap();
    assert_eq!(f.state(&spawned.id).label, "x".repeat(40));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_task_finishes_and_its_result_is_readable() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        30,
        &[(
            "quick",
            &[
                "/bin/sh",
                "-c",
                "echo bonjour; printf 'rapport final\\n' > resultat.md",
            ],
        )],
    ));
    let spawned = store.spawn(request("court", "quick")).unwrap();
    let id = spawned.id.clone();
    wait_until("termine", || {
        f.state(&id).statut == Statut::Termine
    })
    .await;
    let state = f.state(&id);
    assert_eq!(state.code_sortie, Some(0));
    assert!(state.fin_ms.is_some());

    let result = store.result(&id).unwrap();
    assert!(result.present);
    assert_eq!(result.resultat, "rapport final\n");
    let listed = store.list();
    let entry = listed.iter().find(|a| a.id == id).unwrap();
    assert_eq!(entry.statut, Statut::Termine);
    assert_eq!(entry.resume.as_deref(), Some("rapport final\n"));
    assert_eq!(entry.code_sortie, Some(0));
    assert!(entry.journal_taille > 0);

    let status = store.status(&id).unwrap();
    assert!(status.journal.contains("bonjour"));
    assert_eq!(status.statut, Statut::Termine);

    // A failing command becomes `erreur` with its exit code.
    let store = f.store(f.config(2, 30, &[("fail", &["/bin/sh", "-c", "exit 3"])]));
    let failed = store.spawn(request("echec", "fail")).unwrap();
    let failed_id = failed.id.clone();
    wait_until("erreur", || {
        f.state(&failed_id).statut == Statut::Erreur
    })
    .await;
    assert_eq!(f.state(&failed_id).code_sortie, Some(3));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn atomic_write_replaces_content_without_temporary_files() {
    let f = Fixture::new();
    let path = f.base.join("nested/etat.json");
    atomic_write(&path, b"{}").unwrap();
    atomic_write(&path, b"{\"ok\":true}").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"ok\":true}");
    let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["etat.json".to_string()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lingering_grandchild_does_not_delay_the_final_status() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        60,
        &[("fork", &["/bin/sh", "-c", "sleep 4321 & echo started"])],
    ));
    let spawned = store.spawn(request("orphelin", "fork")).unwrap();
    let id = spawned.id.clone();
    // The shell exits at once; its background child keeps stdout open.
    wait_until("termine", || {
        f.state(&id).statut == Statut::Termine
    })
    .await;
    assert_eq!(f.state(&id).code_sortie, Some(0));
    // Clean the grandchild up. The marker (4321 s) is unique to this test:
    // a `pkill -f "sleep 30"` here would kill the `sleep 30` of the queue
    // test running in parallel in the same process.
    let _ = std::process::Command::new("pkill")
        .args(["-f", "sleep 4321"])
        .output();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_kills_the_process_group_and_is_idempotent() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        60,
        &[("slow", &["/bin/sh", "-c", "sleep 30 & echo started; wait"])],
    ));
    let spawned = store.spawn(request("a arreter", "slow")).unwrap();
    let id = spawned.id.clone();
    wait_until("started", || {
        std::fs::read_to_string(f.task_dir(&id).join("journal.log"))
            .map(|text| text.contains("started"))
            .unwrap_or(false)
    })
    .await;
    let pid = f.state(&id).pid.expect("pid");

    let stopped = store.stop(&id).unwrap();
    assert_eq!(stopped.statut, Statut::Arrete);
    wait_until("process gone", || !pid_alive(pid)).await;
    assert_eq!(f.state(&id).statut, Statut::Arrete);

    // Idempotent: the second call keeps `arrete` and does not fail.
    assert_eq!(store.stop(&id).unwrap().statut, Statut::Arrete);
    assert_eq!(store.status(&id).unwrap().statut, Statut::Arrete);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_commands_and_empty_briefs_are_refused() {
    let f = Fixture::new();
    let store = f.store(f.config(2, 30, &[("test", &["/bin/sh", "-c", "true"])]));
    let error = store
        .spawn(request("ok", "rm -rf /"))
        .unwrap_err()
        .to_string();
    assert_eq!(error, "agents: commande inconnue");
    let error = store.spawn(request("   \n ", "test")).unwrap_err().to_string();
    assert_eq!(error, "agents: brief obligatoire");
    let error = store.spawn(request("ok", "absent")).unwrap_err().to_string();
    assert_eq!(error, "agents: commande inconnue");

    // Unknown ids, traversal and escaping symlinks are refused.
    for bad in ["2026-01-01-000000-abcdef", "../escape", "..", "a/b", ""] {
        assert_eq!(
            store.status(bad).unwrap_err().to_string(),
            "agents: tache inconnue",
            "{bad:?}"
        );
        assert_eq!(
            store.stop(bad).unwrap_err().to_string(),
            "agents: tache inconnue"
        );
        assert_eq!(
            store.result(bad).unwrap_err().to_string(),
            "agents: tache inconnue"
        );
    }

    // A symlink with a valid task name pointing outside the queue is refused.
    let outside = f.base.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(
        outside.join("etat.json"),
        serde_json::to_vec(&json!({
            "id": "2026-01-01-000000-aaaaaa", "label": "x", "commande": "test",
            "modele": "m", "statut": "termine", "pid": null, "debutMs": null,
            "finMs": null, "codeSortie": 0, "journal": "journal.log"
        }))
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, f.task_dir("2026-01-01-000000-aaaaaa")).unwrap();
    assert_eq!(
        store
            .status("2026-01-01-000000-aaaaaa")
            .unwrap_err()
            .to_string(),
        "agents: tache inconnue"
    );
    assert!(outside.join("etat.json").is_file());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn max_running_tasks_queues_the_next_one_then_starts_it() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        60,
        &[("slow", &["/bin/sh", "-c", "echo started; sleep 30"])],
    ));
    let first = store.spawn(request("un", "slow")).unwrap();
    let second = store.spawn(request("deux", "slow")).unwrap();
    let third = store.spawn(request("trois", "slow")).unwrap();
    assert_eq!(first.statut, Statut::EnCours);
    assert_eq!(second.statut, Statut::EnCours);
    assert_eq!(third.statut, Statut::EnAttente);
    assert_eq!(f.state(&third.id).statut, Statut::EnAttente);
    assert_eq!(f.state(&third.id).pid, None);

    // The third task waits in line: its command never ran yet.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let journal = std::fs::read_to_string(f.task_dir(&third.id).join("journal.log")).unwrap();
    assert_eq!(journal, "");
    let listed = store.list();
    assert_eq!(
        listed.iter().filter(|a| a.statut == Statut::EnCours).count(),
        2
    );

    // Freeing a slot lets the supervisor start the queued task.
    store.stop(&first.id).unwrap();
    store.supervise();
    wait_until("third started", || {
        f.state(&third.id).statut == Statut::EnCours
    })
    .await;
    assert!(f.state(&third.id).pid.is_some());
    assert_eq!(f.state(&third.id).debut_ms.is_some(), true);
    assert_eq!(store.list().iter().filter(|a| a.statut == Statut::EnCours).count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_stops_the_task_as_an_error() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        1,
        &[("slow", &["/bin/sh", "-c", "echo started; sleep 30"])],
    ));
    let spawned = store.spawn(request("trop long", "slow")).unwrap();
    let id = spawned.id.clone();
    wait_until("started", || {
        std::fs::read_to_string(f.task_dir(&id).join("journal.log"))
            .map(|text| text.contains("started"))
            .unwrap_or(false)
    })
    .await;
    let pid = f.state(&id).pid.expect("pid");

    // The background supervisor runs every 2 s; wait past the 1 s deadline.
    wait_until("deadline", || f.state(&id).statut == Statut::Erreur).await;
    let state = f.state(&id);
    assert_eq!(state.code_sortie, None);
    assert!(state.fin_ms.is_some());
    wait_until("process gone", || !pid_alive(pid)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_turns_ghost_running_tasks_into_errors() {
    let f = Fixture::new();
    // Hand-written state of a task whose process no longer exists.
    let id = "2026-01-01-000000-bbbbbb";
    let dir = f.task_dir(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("tache.md"), "brief").unwrap();
    std::fs::write(dir.join("journal.log"), "debut\n").unwrap();
    let state = json!({
        "id": id, "label": "fantome", "commande": "test", "modele": "test/modele",
        "statut": "en_cours", "pid": 999_999, "debutMs": 1, "finMs": null,
        "codeSortie": null, "journal": "journal.log"
    });
    std::fs::write(dir.join("etat.json"), serde_json::to_vec(&state).unwrap()).unwrap();

    let store = f.store(f.config(
        2,
        30,
        &[("test", &["/bin/sh", "-c", "true"])],
    ));
    let recovered = f.state(id);
    assert_eq!(recovered.statut, Statut::Erreur);
    assert_eq!(recovered.code_sortie, None);
    assert!(recovered.fin_ms.is_some());
    let status = store.status(id).unwrap();
    assert_eq!(status.statut, Statut::Erreur);
    assert!(status.journal.contains("debut"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn environment_is_minimal_and_brief_is_the_only_input() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        30,
        &[(
            "env",
            &[
                "/bin/sh",
                "-c",
                "printf '%s|%s|%s|%s' \"$TERM\" \"$PWD\" \"${SECRET_TOKEN:-absent}\" \"$(cat tache.md)\"",
            ],
        )],
    ));
    std::env::set_var("SECRET_TOKEN", "should-not-leak");
    let spawned = store.spawn(request("mon brief", "env")).unwrap();
    let id = spawned.id.clone();
    wait_until("termine", || {
        f.state(&id).statut == Statut::Termine
    })
    .await;
    let journal = std::fs::read_to_string(f.task_dir(&id).join("journal.log")).unwrap();
    assert!(journal.starts_with("dumb|"), "journal: {journal:?}");
    assert!(journal.ends_with("|absent|mon brief"), "journal: {journal:?}");
    assert!(journal.contains(f.task_dir(&id).to_string_lossy().as_ref()));
    assert!(!journal.contains("should-not-leak"));
    std::env::remove_var("SECRET_TOKEN");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn substitutions_use_the_task_folder_brief_and_model() {
    let f = Fixture::new();
    let store = f.store(f.config(
        2,
        30,
        &[(
            "sub",
            &["/bin/sh", "-c", "printf '%s\\n%s\\n%s' \"{dir}\" \"{brief}\" \"{modele}\""],
        )],
    ));
    let mut req = request("brief", "sub");
    req.modele = Some("fournisseur/modele".into());
    let spawned = store.spawn(req).unwrap();
    let id = spawned.id.clone();
    wait_until("termine", || {
        f.state(&id).statut == Statut::Termine
    })
    .await;
    let journal = std::fs::read_to_string(f.task_dir(&id).join("journal.log")).unwrap();
    let lines: Vec<&str> = journal.lines().collect();
    assert_eq!(lines[0], f.task_dir(&id).to_string_lossy());
    assert_eq!(lines[1], f.task_dir(&id).join("tache.md").to_string_lossy());
    assert_eq!(lines[2], "fournisseur/modele");
    assert!(Path::new(lines[0]).join("tache.md").is_file());
}

#[test]
fn config_defaults_are_the_frozen_ones() {
    let config = AgentsConfig::default();
    assert_eq!(config.agents_max, 2);
    assert_eq!(config.agents_delai_s, 1800);
    assert_eq!(config.agents_modele, "opencode/nemotron-3.5-super-vl-free");
    assert!(config.agents_commandes.contains_key("opencode"));
    let argv = &config.agents_commandes["opencode"];
    // Le binaire partage (root, 0755) et non l'ancien chemin prive : la maison du
    // compte d'administration est en 0700, donc invisible depuis un compte SavIDE.
    assert_eq!(argv[0], "/opt/axecode/bin/opencode");
    assert!(argv.iter().any(|a| a == "{dir}"));
    assert!(argv.iter().any(|a| a.contains("{brief}")));
    assert!(argv.iter().any(|a| a == "{modele}"));
    assert!(argv
        .iter()
        .any(|a| a.contains("aucun secret") && a.contains("aucun git push")));

    // A missing or malformed file falls back to the defaults.
    let base = std::env::temp_dir().join(format!("axecode-agents-cfg-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    assert_eq!(AgentsConfig::load(&base).agents_max, 2);
    std::fs::write(base.join(axecode_agents::config::CONFIG_FILE), "{ nope").unwrap();
    assert_eq!(AgentsConfig::load(&base).agents_max, 2);
    let _ = std::fs::remove_dir_all(&base);
}
