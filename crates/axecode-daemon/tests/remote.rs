// axe:remote — WebSocket listener: auth, Host check, healthz, same protocol.

use std::{sync::Arc, time::Duration};

use serde_json::{json, Value};
use axecode_daemon::{
    auth::AuthStore, client::DaemonClient, listen::ListenConfig, server, stub::EchoFactory, Daemon,
    DaemonConfig,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn raw_http(port: u16, request: &str) -> String {
    let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(request.as_bytes()).await.unwrap();
    let mut out = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), tcp.read_to_string(&mut out)).await;
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_listener_requires_auth() {
    let data_dir = std::env::temp_dir().join(format!("axecode-remote-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let mut store = AuthStore::default();
    store.set_password("alice", "secret-pass").unwrap();
    let (_, token) = store.create_token("test");
    store.save(&data_dir).unwrap();

    let port = free_port();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    config.listen = Some(ListenConfig::parse(&format!("127.0.0.1:{port}"), vec![]).unwrap());
    let daemon = Daemon::new(config, Arc::new(EchoFactory));
    let handle = tokio::spawn(server::run(daemon.clone()));
    tokio::time::sleep(Duration::from_millis(200)).await;

    let url = format!("ws://127.0.0.1:{port}/ws");
    let health = raw_http(port, "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    let rebinding = raw_http(port, "GET /healthz HTTP/1.1\r\nHost: evil.example\r\n\r\n").await;
    assert!(rebinding.starts_with("HTTP/1.1 421"), "{rebinding}");

    let denied = DaemonClient::connect_ws(&url, None, None).await;
    assert!(denied.err().unwrap_or_default().contains("401"));
    let wrong = DaemonClient::connect_ws(&url, Some("Bearer axs_wrong"), None).await;
    assert!(wrong.is_err());

    let client = DaemonClient::connect_ws(&url, Some(&format!("Bearer {token}")), None)
        .await
        .unwrap();
    let status: Value = client.call("hello", json!({"client": "remote-test"})).await.unwrap();
    assert_eq!(status["sessions"]["total"], 0);

    use base64::Engine;
    let basic = base64::engine::general_purpose::STANDARD.encode("alice:secret-pass");
    let client2 = DaemonClient::connect_ws(&url, Some(&format!("Basic {basic}")), None)
        .await
        .unwrap();
    let meta = client2
        .call(
            "sessions.create",
            json!({"name": "r1", "workspaceId": "ws", "model": {"provider": "anthropic", "name": "m"}}),
        )
        .await
        .unwrap();
    assert!(meta["id"].is_string());

    daemon.request_shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    let _ = std::fs::remove_dir_all(&data_dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn public_listener_refuses_without_credentials() {
    let data_dir = std::env::temp_dir().join(format!("axecode-remote-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    config.listen = Some(ListenConfig::parse("0.0.0.0:0", vec![]).unwrap());
    let daemon = Daemon::new(config, Arc::new(EchoFactory));
    let result = tokio::time::timeout(Duration::from_secs(5), server::run(daemon)).await;
    let err = result.expect("must fail fast").expect_err("must refuse");
    assert!(err.to_string().contains("credentials"));
    let _ = std::fs::remove_dir_all(&data_dir);
}
