//! axe:voix — `voice.*` de bout en bout sur un service réel (runtime d'écho),
//! avec un faux serveur whisper.cpp : chaîne de repli, multipart, tâche de fond.

use std::{sync::Arc, time::Duration};

use serde_json::{json, Value};
use axecode_daemon::{client::DaemonClient, server, stub::EchoFactory, Daemon, DaemonConfig};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// Faux `/inference` : lit une requête HTTP complète, vérifie le multipart et
/// répond comme whisper-server (un segment par ligne).
async fn fake_whisper(requests: usize) -> (u16, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let mut seen = Vec::new();
        for _ in 0..requests {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end]
                    .lines()
                    .find_map(|l| {
                        let l = l.to_ascii_lowercase();
                        l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if buf.len() >= head_end + 4 + length {
                    break;
                }
            }
        }
        seen.push(String::from_utf8_lossy(&buf).to_string());
        let body = r#"{"text":" Bonjour, crée un worktree.\n Sous-titres réalisés para la communauté d'Amara.org\n"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.ok();
        }
        seen
    });
    (port, handle)
}

#[tokio::test(flavor = "multi_thread")]
async fn voice_transcribe_falls_back_and_returns_the_text() {
    let (port, mock) = fake_whisper(2).await;
    // 1er moteur : port fermé (repli attendu), 2e : le faux whisper.
    std::env::set_var(
        "AXE_VOIX_WHISPER",
        format!("http://127.0.0.1:9/inference|mort;http://127.0.0.1:{port}/inference|faux whisper"),
    );
    let data_dir = std::env::temp_dir().join(format!("axecode-voice-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let mut config = DaemonConfig::new(data_dir.clone());
    config.auto_shutdown = false;
    let daemon = Daemon::new(config.clone(), Arc::new(EchoFactory));
    let handle = tokio::spawn(server::run(daemon.clone()));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let client = DaemonClient::connect(&config.endpoint, None).await.unwrap();

    async fn run(client: &DaemonClient, params: Value) -> Value {
        let started = client.call("voice.transcribe", params).await.unwrap();
        let job = started["jobId"].as_str().unwrap().to_string();
        let mut result = Value::Null;
        for _ in 0..200 {
            result = client.call("voice.result", json!({"jobId": job})).await.unwrap();
            if result["status"] != "pending" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        result
    }
    // 1) mode rapide : fenêtre réduite (2 s -> plancher de 512 trames)
    let result = run(
        &client,
        json!({"audio": "T1BVUw==", "mime": "audio/webm;codecs=opus", "durationMs": 2000, "prompt": "Grafana", "fast": true}),
    )
    .await;
    assert_eq!(result["status"], "done", "{result}");
    assert_eq!(result["text"], "Bonjour, crée un worktree.");
    assert_eq!(result["model"], "faux whisper");
    assert_eq!(result["audioCtx"], 512);
    assert!(result["fallbacks"][0].as_str().unwrap().starts_with("mort : "), "{result}");

    // 2) par défaut : fenêtre complète (aucun audio_ctx envoyé)
    let full = run(&client, json!({"audio": "T1BVUw==", "durationMs": 2000})).await;
    assert_eq!(full["status"], "done", "{full}");
    assert_eq!(full["audioCtx"], Value::Null);

    let mut requests = mock.await.unwrap();
    let default_request = requests.remove(1);
    assert!(!default_request.contains("audio_ctx"));
    assert!(default_request.contains("Content-Type: audio/webm\r\n"));
    let request = requests.remove(0);
    assert!(request.starts_with("POST /inference HTTP/1.1"));
    assert!(request.contains("name=\"language\"\r\n\r\nfr\r\n"));
    assert!(request.contains("name=\"audio_ctx\"\r\n\r\n512\r\n"));
    assert!(request.contains("worktree, un commit"), "amorce absente");
    assert!(request.contains("Autres termes : Grafana."));
    assert!(request.contains("filename=\"dictee.webm\"\r\nContent-Type: audio/webm;codecs=opus\r\n\r\nOPUS\r\n"));

    // tâche inconnue, nettoyage sans fournisseur (runtime d'écho), méthode inconnue
    assert!(client.call("voice.result", json!({"jobId": "absent"})).await.is_err());
    let clean = client
        .call("voice.clean", json!({"text": "fais un commit", "provider": "openai", "model": "x"}))
        .await
        .unwrap_err();
    assert!(clean.contains("unavailable"), "{clean}");
    assert!(client.call("voice.nope", json!({})).await.unwrap_err().contains("unknown method"));

    client.call("shutdown", json!({"force": true})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), handle).await.ok();
}
