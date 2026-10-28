use std::{sync::Arc, time::Duration};

use serde_json::{json, Value};
use axecode_daemon::{
    client::DaemonClient, journal::Journal, server, stub::EchoFactory, Daemon, DaemonConfig,
};

fn tmp() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("axecode-daemon-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn wait_for<F: Fn(&Value) -> bool>(client: &DaemonClient, id: &str, pred: F) -> Value {
    for _ in 0..100 {
        let history = client
            .call("sessions.history", json!({"sessionId": id}))
            .await
            .unwrap();
        if pred(&history) {
            return history;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("condition not reached");
}

#[tokio::test(flavor = "multi_thread")]
async fn create_send_echo_and_reload() {
    let data_dir = tmp();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    let daemon = Daemon::new(config.clone(), Arc::new(EchoFactory));
    let handle = tokio::spawn(server::run(daemon.clone()));
    tokio::time::sleep(Duration::from_millis(150)).await;

    let client = DaemonClient::connect(&config.endpoint, None).await.unwrap();
    let status = client.call("hello", json!({"client": "test"})).await.unwrap();
    assert_eq!(status["sessions"]["total"], 0);

    let meta = client
        .call(
            "sessions.create",
            json!({"name": "s1", "workspaceId": "ws", "model": {"provider": "anthropic", "name": "m"}}),
        )
        .await
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_string();
    client
        .call("sessions.send", json!({"sessionId": id, "text": "bonjour"}))
        .await
        .unwrap();
    let history = wait_for(&client, &id, |h| h.as_array().is_some_and(|a| a.len() == 2)).await;
    assert!(history.to_string().contains("echo: bonjour"));

    let tree = client.call("sessions.tree", json!({"sessionId": id})).await.unwrap();
    assert!(tree["entries"].as_array().unwrap().len() >= 3);

    client.call("shutdown", json!({"force": true})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    // Journal survives the daemon; a new daemon indexes it as inactive.
    let journal = Journal::open(&data_dir, &id).unwrap();
    assert_eq!(journal.history().len(), 2);
    let daemon = Daemon::new(config, Arc::new(EchoFactory));
    let metas = daemon.list_metas();
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].status, axecode_core::SessionStatus::Inactive);
}

// axe:freechat — a session without folder gets a private scratch folder and
// can later move to a project folder.
#[tokio::test(flavor = "multi_thread")]
async fn free_conversation_gets_scratch_folder_and_relocates() {
    let data_dir = tmp();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    let daemon = Daemon::new(config.clone(), Arc::new(EchoFactory));
    let meta = daemon
        .create(
            serde_json::from_value(json!({
                "name": "libre", "workspaceId": "", "model": {"provider": "anthropic", "name": "m"}
            }))
            .unwrap(),
        )
        .unwrap();
    assert!(meta.scratch);
    let scratch = std::path::PathBuf::from(&meta.workspace_id);
    assert!(scratch.is_dir());
    assert!(scratch.ends_with(&meta.id));

    let project = tmp();
    let moved = daemon
        .relocate(&meta.id, project.display().to_string(), Some("rules".into()))
        .await
        .unwrap();
    assert!(!moved.scratch);
    assert_eq!(moved.workspace_id, project.display().to_string());
    assert_eq!(moved.system_prompt_extra.as_deref(), Some("rules"));

    // The move survives a restart (rebuilt from the journal).
    let daemon = Daemon::new(config, Arc::new(EchoFactory));
    let metas = daemon.list_metas();
    assert_eq!(metas[0].workspace_id, project.display().to_string());
    assert!(!metas[0].scratch);
}


// axe:journal-archive — le journal d'une conversation archivée (non sous-agent) se lit
// en lecture seule sans la rétablir ; un identifiant inconnu reste introuvable.
#[tokio::test(flavor = "multi_thread")]
async fn journal_lisible_apres_archivage() {
    let data_dir = tmp();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    let daemon = Daemon::new(config.clone(), Arc::new(EchoFactory));
    let handle = tokio::spawn(server::run(daemon.clone()));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let client = DaemonClient::connect(&config.endpoint, None).await.unwrap();
    let meta = client
        .call(
            "sessions.create",
            json!({"name": "bg", "workspaceId": "ws", "model": {"provider": "anthropic", "name": "m"}}),
        )
        .await
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_string();
    client.call("sessions.send", json!({"sessionId": id, "text": "bonjour"})).await.unwrap();
    wait_for(&client, &id, |h| h.as_array().is_some_and(|a| a.len() == 2)).await;
    client.call("sessions.archive", json!({"sessionId": id})).await.unwrap();

    let tree = client.call("sessions.tree", json!({"sessionId": id})).await.unwrap();
    assert!(tree["entries"].as_array().unwrap().len() >= 3, "{tree}");
    let history = client.call("sessions.history", json!({"sessionId": id})).await.unwrap();
    assert!(history.to_string().contains("echo: bonjour"));
    // Lecture seule : toujours archivée, pas rétablie.
    assert!(daemon.meta(&id).is_err());
    assert!(axecode_daemon::journal::archive_exists(&data_dir, &id));
    let err = client.call("sessions.tree", json!({"sessionId": "inconnu-123"})).await.unwrap_err();
    assert!(err.to_string().contains("not found"), "{err}");

    client.call("shutdown", json!({"force": true})).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
}

// axe:file-demon — la file part en fin de tour, dans l'ordre, une seule fois,
// sans aucun client qui regarde la conversation.
#[tokio::test(flavor = "multi_thread")]
async fn file_demon_part_en_fin_de_tour() {
    let data_dir = tmp();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    let daemon = Daemon::new(config.clone(), Arc::new(EchoFactory));
    let handle = tokio::spawn(server::run(daemon.clone()));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let client = DaemonClient::connect(&config.endpoint, None).await.unwrap();
    let meta = client
        .call("sessions.create", json!({"name": "a", "workspaceId": "wsA", "model": {"provider": "anthropic", "name": "m"}}))
        .await
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_string();
    for (i, t) in ["un", "deux", "trois"].iter().enumerate() {
        client
            .call("queue.push", json!({"sessionId": id, "item": {"id": format!("q{i}"), "text": t,
                "message": {"role": "user", "parts": [{"type": "text", "text": t}]}}}))
            .await
            .unwrap();
    }
    let history = wait_for(&client, &id, |h| h.as_array().is_some_and(|a| a.len() == 6)).await;
    let users: Vec<String> = history.as_array().unwrap().iter()
        .filter(|m| m["role"] == "user")
        .map(|m| m["parts"][0]["text"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(users, vec!["un", "deux", "trois"]);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let h = client.call("sessions.history", json!({"sessionId": id})).await.unwrap();
    assert_eq!(h.as_array().unwrap().len(), 6, "rien n'est parti deux fois");
    let q = client.call("queue.list", json!({"sessionId": id})).await.unwrap();
    assert_eq!(q, json!([]));
    client.call("shutdown", json!({"force": true})).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
}

// axe:reveil-demarrage — une session avec heartbeat est retrouvée au démarrage.
#[tokio::test(flavor = "multi_thread")]
async fn heartbeat_rearme_au_demarrage() {
    let data_dir = tmp();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    let daemon = Daemon::new(config.clone(), Arc::new(EchoFactory));
    let a = daemon.create(serde_json::from_value(json!({"name": "a", "workspaceId": "ws", "model": {"provider": "anthropic", "name": "m"}})).unwrap()).unwrap();
    let b = daemon.create(serde_json::from_value(json!({"name": "b", "workspaceId": "ws", "model": {"provider": "anthropic", "name": "m"}})).unwrap()).unwrap();
    let st = data_dir.join("session_state");
    std::fs::create_dir_all(&st).unwrap();
    std::fs::write(st.join(format!("{}.json", a.id)), r#"{"heartbeat":{"interval_ms":60000,"message":"x"}}"#).unwrap();
    std::fs::write(st.join(format!("{}.json", b.id)), r#"{"heartbeat":null}"#).unwrap();
    std::fs::write(st.join("inconnue.json"), r#"{"heartbeat":{"interval_ms":60000,"message":"x"}}"#).unwrap();
    let daemon = Daemon::new(config, Arc::new(EchoFactory));
    assert_eq!(daemon.sessions_a_rearmer(), vec![a.id.clone()]);
}

// axe:file-pause — après un Stop, la file attend « Reprendre la file ».
#[tokio::test(flavor = "multi_thread")]
async fn file_en_pause_apres_stop() {
    use axecode_daemon::queue_rpc;
    let data_dir = tmp();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    let daemon = Daemon::new(config.clone(), Arc::new(EchoFactory));
    let a = daemon.create(serde_json::from_value(json!({"name": "a", "workspaceId": "ws", "model": {"provider": "anthropic", "name": "m"}})).unwrap()).unwrap();
    let qd = data_dir.join("queues");
    std::fs::create_dir_all(&qd).unwrap();
    std::fs::write(qd.join(format!("{}.json", a.id)),
        json!([{"id": "q0", "text": "un", "message": {"role": "user", "parts": [{"type": "text", "text": "un"}]}}]).to_string()).unwrap();
    daemon.stop(&a.id).unwrap();
    queue_rpc::pause_after_stop(&daemon, &a.id);
    queue_rpc::dispatch_next(&daemon, &a.id);
    let st = queue_rpc::dispatch(&daemon, "queue.state", &json!({"sessionId": a.id})).unwrap();
    assert_eq!(st["paused"], json!(true));
    assert_eq!(st["items"].as_array().unwrap().len(), 1, "rien n'est parti pendant la pause");
    queue_rpc::dispatch(&daemon, "queue.resume", &json!({"sessionId": a.id})).unwrap();
    let st = queue_rpc::dispatch(&daemon, "queue.state", &json!({"sessionId": a.id})).unwrap();
    assert_eq!(st["paused"], json!(false));
    assert_eq!(st["items"], json!([]), "reprise : le message est parti");
    assert!(!qd.join(format!("{}.paused", a.id)).exists());
}

