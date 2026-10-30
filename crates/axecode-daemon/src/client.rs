//! Client side of the daemon protocol (used by the IDE and tests).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

use crate::{
    protocol::{self, Event, Request, ServerLine},
    transport,
};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// A connected client. Cheap to clone.
#[derive(Clone)]
pub struct DaemonClient {
    next_id: Arc<AtomicU64>,
    pending: Pending,
    tx: mpsc::UnboundedSender<String>,
    pub endpoint: String,
}

impl DaemonClient {
    /// Connects to `endpoint`; daemon events are forwarded to `events`.
    pub async fn connect(
        endpoint: &str,
        events: Option<mpsc::UnboundedSender<Event>>,
    ) -> std::io::Result<Self> {
        let stream = transport::connect(endpoint).await?;
        Ok(Self::from_stream(stream, endpoint, events))
    }

    // axe:remote
    /// Connects to a remote daemon over WebSocket (`ws://` or `wss://`,
    /// path `/ws`). `authorization` is a full header value
    /// (`Bearer …` or `Basic …`).
    pub async fn connect_ws(
        url: &str,
        authorization: Option<&str>,
        events: Option<mpsc::UnboundedSender<Event>>,
    ) -> Result<Self, String> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.into_client_request().map_err(|e| e.to_string())?;
        if let Some(auth) = authorization.filter(|a| !a.is_empty()) {
            let value = auth.parse().map_err(|_| "invalid authorization header".to_string())?;
            request.headers_mut().insert("authorization", value);
        }
        let connect = tokio_tungstenite::connect_async(request);
        let (ws, _) = tokio::time::timeout(Duration::from_secs(15), connect)
            .await
            .map_err(|_| "connection timed out".to_string())?
            .map_err(|e| match e {
                tokio_tungstenite::tungstenite::Error::Http(response) => {
                    format!("HTTP {}", response.status())
                }
                other => other.to_string(),
            })?;
        Ok(Self::from_stream(crate::listen::bridge(ws), url, events))
    }
    // axe:remote end

    fn from_stream(
        stream: transport::BoxStream,
        endpoint: &str,
        events: Option<mpsc::UnboundedSender<Event>>,
    ) -> Self {
        let (read, mut write) = tokio::io::split(stream);
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = write.flush().await;
            }
        });
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<ServerLine>(&line) {
                    Ok(ServerLine::Response(response)) => {
                        let waiter = reader_pending
                            .lock()
                            .ok()
                            .and_then(|mut p| p.remove(&response.id));
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(match response.error {
                                Some(err) => Err(err),
                                None => Ok(response.result.unwrap_or(Value::Null)),
                            });
                        }
                    }
                    Ok(ServerLine::Event(event)) => {
                        if let Some(events) = &events {
                            let _ = events.send(event);
                        }
                    }
                    Err(err) => tracing::warn!(error = %err, "invalid daemon line"),
                }
            }
            // Connection closed: fail every pending request.
            if let Ok(mut pending) = reader_pending.lock() {
                for (_, waiter) in pending.drain() {
                    let _ = waiter.send(Err("daemon connection closed".into()));
                }
            }
        });
        Self {
            next_id: Arc::new(AtomicU64::new(1)),
            pending,
            tx,
            endpoint: endpoint.to_string(),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "poisoned".to_string())?
            .insert(id, tx);
        let mut line = serde_json::to_string(&Request {
            id,
            method: method.to_string(),
            params,
        })
        .map_err(|e| e.to_string())?;
        line.push('\n');
        self.tx
            .send(line)
            .map_err(|_| "daemon connection closed".to_string())?;
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("daemon connection closed".into()),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(format!("daemon request {method} timed out"))
            }
        }
    }
}

/// Tries to connect to the daemon advertised in `data_dir`.
pub async fn connect_existing(
    data_dir: &Path,
    events: Option<mpsc::UnboundedSender<Event>>,
) -> Option<DaemonClient> {
    let lock = protocol::read_lock(data_dir)?;
    DaemonClient::connect(&lock.endpoint, events).await.ok()
}

/// Connects to the daemon, spawning `binary` (detached) if none answers.
pub async fn ensure_daemon(
    data_dir: &Path,
    binary: &Path,
    prefix_args: &[&str],
    events: Option<mpsc::UnboundedSender<Event>>,
) -> Result<DaemonClient, String> {
    if let Some(client) = connect_existing(data_dir, events.clone()).await {
        return Ok(client);
    }
    spawn_detached(binary, prefix_args, data_dir).map_err(|e| format!("cannot start daemon: {e}"))?;
    let endpoint = protocol::default_endpoint(data_dir);
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(client) = DaemonClient::connect(&endpoint, events.clone()).await {
            return Ok(client);
        }
    }
    Err("daemon did not start within 10 s".into())
}

/// Starts the daemon binary detached from the current process so it
/// survives the IDE.
pub fn spawn_detached(binary: &Path, prefix_args: &[&str], data_dir: &Path) -> std::io::Result<()> {
    let mut command = __nw_std(binary);
    command
        .args(prefix_args)
        .arg("serve")
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(|_| ())
}

/// Default location of the daemon binary next to the current executable.
pub fn sibling_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "axecode-daemon.exe" } else { "axecode-daemon" };
    let candidate = dir.join(name);
    if candidate.exists() {
        return Some(candidate);
    }
    // Tauri sidecars carry the target triple in their name.
    std::fs::read_dir(dir).ok()?.find_map(|entry| {
        let path = entry.ok()?.path();
        let file = path.file_name()?.to_string_lossy().to_string();
        (file.starts_with("axecode-daemon-") && (!cfg!(windows) || file.ends_with(".exe")))
            .then_some(path)
    })
}

/// axe:0.1.75 : aucun lancement de processus n'ouvre de fenetre console sous Windows.
#[allow(dead_code)]
fn __nw_std<S: AsRef<std::ffi::OsStr>>(p: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(p);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}
