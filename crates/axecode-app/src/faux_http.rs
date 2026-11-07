//! Faux serveur HTTP des tests : aucun appel réel vers une API payante.
#![cfg(test)]

use std::sync::{Arc, Mutex};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Debug, Clone)]
pub struct Requete {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Requete {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub struct Reponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl Reponse {
    pub fn json(value: serde_json::Value) -> Self {
        Self { status: 200, content_type: "application/json".into(), body: value.to_string().into_bytes() }
    }
    pub fn sse(events: &[serde_json::Value]) -> Self {
        let body = events.iter().map(|e| format!("data: {e}\n\n")).collect::<String>();
        Self { status: 200, content_type: "text/event-stream".into(), body: body.into_bytes() }
    }
    pub fn bytes(content_type: &str, body: &[u8]) -> Self {
        Self { status: 200, content_type: content_type.into(), body: body.to_vec() }
    }
    pub fn status(status: u16, body: &str) -> Self {
        Self { status, content_type: "application/json".into(), body: body.as_bytes().to_vec() }
    }
}

pub struct FauxServeur {
    pub base: String,
    pub requetes: Arc<Mutex<Vec<Requete>>>,
}

impl FauxServeur {
    pub fn requetes(&self) -> Vec<Requete> {
        self.requetes.lock().unwrap().clone()
    }
}

/// Lance le serveur ; `repondre` reçoit chaque requête et son numéro (0, 1, …).
pub async fn lancer<F>(repondre: F) -> FauxServeur
where
    F: Fn(&Requete, usize) -> Reponse + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requetes = Arc::new(Mutex::new(Vec::new()));
    let journal = requetes.clone();
    let repondre = Arc::new(repondre);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let journal = journal.clone();
            let repondre = repondre.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head_end, content_length) = loop {
                    let Ok(n) = socket.read(&mut chunk).await else { return };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                        let len = head
                            .lines()
                            .find_map(|l| {
                                let (k, v) = l.split_once(':')?;
                                k.trim().eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        break (pos + 4, len);
                    }
                };
                while buf.len() < head_end + content_length {
                    let Ok(n) = socket.read(&mut chunk).await else { return };
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end - 4]).to_string();
                let mut lines = head.lines();
                let first = lines.next().unwrap_or_default().to_string();
                let mut parts = first.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let headers = lines
                    .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
                    .collect();
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                let requete = Requete { method, path, headers, body };
                let index = {
                    let mut j = journal.lock().unwrap();
                    j.push(requete.clone());
                    j.len() - 1
                };
                let reponse = repondre(&requete, index);
                let header = format!(
                    "HTTP/1.1 {} OK\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    reponse.status,
                    reponse.content_type,
                    reponse.body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(&reponse.body).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    FauxServeur { base, requetes }
}

/// Fichier de compte ChatGPT (OAuth) de test.
pub fn compte_chatgpt(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("openai-auth.json");
    std::fs::write(
        &path,
        r#"{"provider":"openai","authMode":"oauth","tokens":{"accessToken":"jeton-test","refreshToken":"r","accountId":"compte-test","expiresAtMs":99999999999999}}"#,
    )
    .unwrap();
    path
}
