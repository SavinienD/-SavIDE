//! moteur-local — a daemon that accepts connections but answers nothing is
//! replaced, and a daemon that cannot start says why (macOS, 0.1.76: every
//! message failed with « daemon request sessions.ensure timed out »).
#![cfg(unix)]

use std::path::Path;

use axecode_daemon::{client, protocol};
use serde_json::json;

fn data_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("adm-{tag}-{}", &uuid::Uuid::new_v4().to_string()[..8]));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_lock(dir: &Path, pid: u32, endpoint: &str) {
    std::fs::write(
        protocol::lock_path(dir),
        serde_json::to_string(&protocol::LockInfo {
            pid,
            endpoint: endpoint.into(),
            version: "0.0.0".into(),
            protocol: protocol::PROTOCOL_VERSION,
            started_at_ms: 0,
            listen: None,
        })
        .unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn a_stuck_daemon_is_replaced() {
    let dir = data_dir("stuck");
    let endpoint = protocol::default_endpoint(&dir);
    // Accepts (backlog) but never reads nor answers.
    let _stuck = std::os::unix::net::UnixListener::bind(&endpoint).unwrap();
    // A pid that is not a daemon: it must not be killed.
    let mut bystander = std::process::Command::new("sleep").arg("30").spawn().unwrap();
    write_lock(&dir, bystander.id(), &endpoint);
    let binary = Path::new(env!("CARGO_BIN_EXE_axecode-daemon"));
    let started = std::time::Instant::now();
    let client = client::ensure_daemon(&dir, binary, &[], None).await.expect("replaced");
    assert!(started.elapsed() < std::time::Duration::from_secs(40));
    let status = client.call("status", json!({})).await.unwrap();
    assert!(status.get("version").is_some(), "{status}");
    assert_ne!(protocol::read_lock(&dir).unwrap().pid, bystander.id());
    assert!(bystander.try_wait().unwrap().is_none(), "a foreign process was killed");
    let _ = client.call("shutdown", json!({"force": true})).await;
    let _ = bystander.kill();
    let _ = bystander.wait();
}

#[tokio::test]
async fn a_daemon_that_cannot_start_says_why() {
    let dir = data_dir("dead");
    let error = match client::ensure_daemon(&dir, Path::new("/bin/false"), &[], None).await {
        Ok(_) => panic!("no daemon can answer"),
        Err(error) => error,
    };
    assert!(error.starts_with("le moteur local n'a pas démarré : le processus s'est arrêté au démarrage (code 1)"), "{error}");
    assert!(error.contains("daemon.log"), "{error}");
    let error = match client::ensure_daemon(&dir, Path::new("/nonexistent/daemon"), &[], None).await {
        Ok(_) => panic!("no binary"),
        Err(error) => error,
    };
    assert!(error.starts_with("le moteur local n'a pas démarré : impossible de lancer"), "{error}");
}
