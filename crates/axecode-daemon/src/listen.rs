//! axe:remote — network listener (`serve --listen <host:port>`).
//!
//! Exposes the exact JSON-lines protocol of the local pipe over WebSocket:
//! one text frame = one line. Closed by default: when the address is not
//! loopback, credentials (see [`crate::auth`]) are mandatory and the
//! listener refuses to start without them. The `Host` header is checked
//! against IP literals, `localhost` and the `--allow-host` list (anti DNS
//! rebinding); browser `Origin`s are rejected unless allowed.

use std::{
    future::Future,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, OnceLock},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use tokio_tungstenite::{
    tungstenite::{http, Message},
    WebSocketStream,
};

use crate::{auth::AuthStore, transport::BoxStream, Daemon};

#[derive(Debug, Clone)]
pub struct ListenConfig {
    pub addr: SocketAddr,
    /// Extra host names accepted in the `Host` / `Origin` headers.
    pub allowed_hosts: Vec<String>,
}

impl ListenConfig {
    pub fn parse(addr: &str, allowed_hosts: Vec<String>) -> anyhow::Result<Self> {
        let addr: SocketAddr = addr
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid --listen address {addr}: {e}"))?;
        Ok(Self {
            addr,
            allowed_hosts: allowed_hosts
                .into_iter()
                .map(|h| h.trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty())
                .collect(),
        })
    }

    pub fn requires_auth(&self, store: &AuthStore) -> bool {
        !self.addr.ip().is_loopback() || store.has_credentials()
    }
}

/// Host part of a `Host` header or of an origin URL authority.
fn host_name(authority: &str) -> String {
    let authority = authority.trim().to_ascii_lowercase();
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or_default().to_string();
    }
    authority.split(':').next().unwrap_or_default().to_string()
}

fn host_allowed(host: &str, allowed: &[String]) -> bool {
    host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() || allowed.iter().any(|a| a == host)
}

/// Validates the configuration and binds the socket. Fails (closed by
/// default) when a non-loopback address has no credentials configured.
pub async fn bind(daemon: &Daemon, config: &ListenConfig) -> anyhow::Result<TcpListener> {
    let store = AuthStore::load(daemon.data_dir());
    if !config.addr.ip().is_loopback() && !store.has_credentials() {
        anyhow::bail!(
            "refusing to listen on {} without credentials: run `axecode --daemon set-password` or `axecode --daemon token` first",
            config.addr
        );
    }
    Ok(TcpListener::bind(config.addr).await?)
}

/// One HTTP request received on the listener (non-WebSocket paths).
#[derive(Debug, Clone, Default)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        header_of(&self.headers, name)
    }
}

#[derive(Debug, Clone, Default)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: body.as_bytes().to_vec(),
        }
    }
}

/// Handler for every non-`/ws`, non-`/healthz` HTTP request (the web UI of
/// the gateway). The Host check already happened; authentication of these
/// pages belongs to the handler.
pub trait HttpFallback: Send + Sync {
    fn handle(
        &self,
        daemon: Arc<Daemon>,
        request: HttpRequest,
        peer_is_loopback: bool,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send>>;

    /// Extra way to authorize the `/ws` upgrade (e.g. a session cookie).
    fn ws_authorized(&self, _headers: &[(String, String)]) -> bool {
        false
    }
}

static HTTP_FALLBACK: OnceLock<Arc<dyn HttpFallback>> = OnceLock::new();

pub fn set_http_fallback(handler: Arc<dyn HttpFallback>) {
    let _ = HTTP_FALLBACK.set(handler);
}

pub fn header_of<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

const MAX_HEADER: usize = 32 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;

struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    len: usize,
}

/// Peeks (without consuming) until the request head is complete.
async fn peek_head(tcp: &TcpStream) -> anyhow::Result<Head> {
    let mut buf = vec![0u8; MAX_HEADER];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let n = tokio::time::timeout_at(deadline, tcp.peek(&mut buf)).await??;
        anyhow::ensure!(n > 0, "connection closed");
        let mut storage = [httparse::EMPTY_HEADER; 64];
        let mut request = httparse::Request::new(&mut storage);
        if let httparse::Status::Complete(len) = request.parse(&buf[..n])? {
            return Ok(Head {
                method: request.method.unwrap_or("GET").to_string(),
                target: request.path.unwrap_or("/").to_string(),
                headers: request
                    .headers
                    .iter()
                    .map(|h| (h.name.to_string(), String::from_utf8_lossy(h.value).to_string()))
                    .collect(),
                len,
            });
        }
        anyhow::ensure!(n < MAX_HEADER, "request head too large");
        anyhow::ensure!(tokio::time::Instant::now() < deadline, "request head timeout");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn write_response(tcp: &mut TcpStream, response: HttpResponse) {
    let reason = http::StatusCode::from_u16(response.status)
        .ok()
        .and_then(|s| s.canonical_reason())
        .unwrap_or("");
    let mut head = format!("HTTP/1.1 {} {reason}\r\n", response.status);
    for (k, v) in &response.headers {
        if !k.eq_ignore_ascii_case("content-length") && !k.eq_ignore_ascii_case("connection") {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", response.body.len()));
    let _ = tcp.write_all(head.as_bytes()).await;
    let _ = tcp.write_all(&response.body).await;
    let _ = tcp.flush().await;
    let _ = tcp.shutdown().await;
}

/// Accept loop; runs until the task is aborted.
pub async fn serve(daemon: Arc<Daemon>, listener: TcpListener, config: ListenConfig) {
    let config = Arc::new(config);
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(err) => {
                tracing::warn!(error = %err, "listen accept failed");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let daemon = daemon.clone();
        let config = config.clone();
        tokio::spawn(async move {
            let _ = tcp.set_nodelay(true);
            if let Err(err) = handle_connection(daemon, tcp, peer, &config).await {
                tracing::debug!(%peer, error = %err, "remote connection ended");
            }
        });
    }
}

async fn handle_connection(
    daemon: Arc<Daemon>,
    mut tcp: TcpStream,
    peer: SocketAddr,
    config: &ListenConfig,
) -> anyhow::Result<()> {
    let head = peek_head(&tcp).await?;
    let header = |name: &str| header_of(&head.headers, name).unwrap_or("").to_string();
    let host = host_name(&header("host"));
    if !host_allowed(&host, &config.allowed_hosts) {
        tracing::warn!(%peer, %host, "remote request with a disallowed Host header");
        write_response(&mut tcp, HttpResponse::text(421, "host not allowed")).await;
        return Ok(());
    }
    let (path, query) = match head.target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (head.target.clone(), String::new()),
    };
    let fallback = HTTP_FALLBACK.get().cloned();
    let is_upgrade = header("upgrade").eq_ignore_ascii_case("websocket");
    if path == "/ws" && is_upgrade {
        let origin = header("origin");
        if !origin.is_empty() {
            let origin_host = host_name(origin.split("://").nth(1).unwrap_or(&origin));
            if origin_host != host && !config.allowed_hosts.iter().any(|a| *a == origin_host) {
                write_response(&mut tcp, HttpResponse::text(403, "origin not allowed")).await;
                return Ok(());
            }
        }
        // Reloaded per connection so new tokens / revocations apply at once.
        let store = AuthStore::load(daemon.data_dir());
        // Behind a local reverse proxy a loopback peer may be Internet traffic:
        // forwarded headers or a non-loopback Host always require credentials.
        let proxied = !header("x-forwarded-for").is_empty()
            || !header("forwarded").is_empty()
            || !(host == "localhost"
                || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
        let authorized = !(config.requires_auth(&store) || proxied)
            || store.verify_header(&header("authorization"))
            || fallback.as_ref().is_some_and(|f| f.ws_authorized(&head.headers));
        if !authorized {
            tracing::warn!(%peer, "remote client rejected: bad credentials");
            tokio::time::sleep(Duration::from_secs(1)).await; // slows down guessing
            write_response(&mut tcp, HttpResponse::text(401, "authentication required")).await;
            return Ok(());
        }
        let ws = tokio_tungstenite::accept_async(tcp).await?;
        tracing::info!(%peer, "remote client connected");
        crate::server::serve_client(daemon, bridge(ws)).await;
        tracing::info!(%peer, "remote client disconnected");
        return Ok(());
    }
    // Plain HTTP: consume the head, then the body.
    let mut discard = vec![0u8; head.len];
    tcp.read_exact(&mut discard).await?;
    let length: usize = header("content-length").trim().parse().unwrap_or(0);
    if length > MAX_BODY {
        write_response(&mut tcp, HttpResponse::text(413, "payload too large")).await;
        return Ok(());
    }
    let mut body = vec![0u8; length];
    tcp.read_exact(&mut body).await?;
    let response = if path == "/healthz" {
        HttpResponse::text(200, "ok")
    } else if let Some(fallback) = fallback {
        let request = HttpRequest {
            method: head.method.clone(),
            path,
            query,
            headers: head.headers.clone(),
            body,
        };
        fallback.handle(daemon, request, peer.ip().is_loopback()).await
    } else {
        HttpResponse::text(404, "not found")
    };
    write_response(&mut tcp, response).await;
    Ok(())
}

/// Turns a WebSocket into a line stream (one text frame per line) so that
/// the pipe code paths can be reused on both sides.
pub fn bridge<S>(ws: WebSocketStream<S>) -> BoxStream
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (local, remote) = tokio::io::duplex(1 << 20);
    let (read, mut write) = tokio::io::split(remote);
    let (mut ws_tx, mut ws_rx) = ws.split();
    tokio::spawn(async move {
        while let Some(Ok(message)) = ws_rx.next().await {
            match message {
                Message::Text(text) => {
                    let mut line = text.as_str().to_string();
                    if !line.ends_with('\n') {
                        line.push('\n');
                    }
                    if write.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = write.shutdown().await;
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if ws_tx.send(Message::Text(line.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_tx.close().await;
    });
    Box::pin(local)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_checks() {
        assert_eq!(host_name("example.com:9119"), "example.com");
        assert_eq!(host_name("[::1]:9119"), "::1");
        assert!(host_allowed("127.0.0.1", &[]));
        assert!(host_allowed("::1", &[]));
        assert!(host_allowed("localhost", &[]));
        assert!(!host_allowed("evil.example", &[]));
        assert!(host_allowed("axe.example", &["axe.example".into()]));
    }
}
