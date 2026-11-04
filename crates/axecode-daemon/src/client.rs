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

    // remote
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
    // remote end

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
        self.call_timeout(method, params, REQUEST_TIMEOUT).await
    }

    /// [`Self::call`] with an explicit deadline.
    pub async fn call_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
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
        match tokio::time::timeout(timeout, rx).await {
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

/// Deadline of an ordinary request.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A running daemon answers `status` at once: past this delay it is stuck
/// (it accepts connections but serves nothing) and is replaced.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// A daemon just started (first launch: migration, journals) gets longer.
pub const START_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether `error` is a request deadline (the daemon did not answer).
pub fn is_timeout(error: &str) -> bool {
    error.starts_with("daemon request ") && error.ends_with(" timed out")
}

/// Log file of the daemon in `data_dir`.
pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("daemon.log")
}

/// User-facing error when the local engine cannot be reached.
pub fn not_started(data_dir: &Path, reason: &str) -> String {
    format!(
        "le moteur local n'a pas démarré : {reason} (journal : {})",
        log_path(data_dir).display()
    )
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
///
/// An existing daemon must answer `status` within [`PROBE_TIMEOUT`]: one that
/// accepts the connection but serves nothing (stuck, or left behind by an app
/// that moved) made every request time out after 60 s; it is stopped and
/// replaced. A new daemon must answer within [`START_TIMEOUT`], otherwise the
/// error says why ([`not_started`]) instead of a later request deadline.
pub async fn ensure_daemon(
    data_dir: &Path,
    binary: &Path,
    prefix_args: &[&str],
    events: Option<mpsc::UnboundedSender<Event>>,
) -> Result<DaemonClient, String> {
    if let Some(lock) = protocol::read_lock(data_dir) {
        if let Ok(client) = DaemonClient::connect(&lock.endpoint, events.clone()).await {
            match client.call_timeout("status", Value::Null, PROBE_TIMEOUT).await {
                Ok(_) => return Ok(client),
                Err(error) => {
                    tracing::warn!(pid = lock.pid, %error, "the daemon does not answer: replacing it");
                    drop(client);
                    stop_stuck(lock.pid);
                    protocol::remove_lock(data_dir, lock.pid);
                }
            }
        }
    }
    let mut child = spawn_detached(binary, prefix_args, data_dir)
        .map_err(|e| not_started(data_dir, &format!("impossible de lancer {} ({e})", binary.display())))?;
    let endpoint = protocol::default_endpoint(data_dir);
    let started = std::time::Instant::now();
    let mut exited: Option<std::process::ExitStatus> = None;
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if exited.is_none() {
            exited = child.try_wait().ok().flatten();
        }
        // A daemon that exits with success found another one already running
        // (two windows at once): keep trying to reach that one.
        if let Some(status) = exited.filter(|s| !s.success()) {
            return Err(not_started(
                data_dir,
                &format!("le processus s'est arrêté au démarrage ({})", describe_exit(status)),
            ));
        }
        let target = protocol::read_lock(data_dir)
            .map(|lock| lock.endpoint)
            .unwrap_or_else(|| endpoint.clone());
        if let Ok(client) = DaemonClient::connect(&target, events.clone()).await {
            let left = START_TIMEOUT.saturating_sub(started.elapsed()).max(PROBE_TIMEOUT);
            return match client.call_timeout("status", Value::Null, left).await {
                Ok(_) => Ok(client),
                Err(error) => Err(not_started(
                    data_dir,
                    &format!("il accepte la connexion mais ne répond pas ({error})"),
                )),
            };
        }
        if started.elapsed() >= START_TIMEOUT {
            return Err(not_started(
                data_dir,
                &format!("aucune réponse après {} s", START_TIMEOUT.as_secs()),
            ));
        }
    }
}

/// Human description of an exit status (signal number on unix: 9 = killed,
/// e.g. by the system refusing the executable).
fn describe_exit(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return format!("signal {signal}");
        }
    }
    match status.code() {
        Some(code) => format!("code {code}"),
        None => "code inconnu".into(),
    }
}

/// Stops a daemon that no longer answers (its sessions are recovered from
/// their journals by the next one). Never ourselves.
fn stop_stuck(pid: u32) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    #[cfg(unix)]
    {
        // Only a daemon: the pid of a stale lock may belong to anything now.
        let command = __nw_std("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        if !is_daemon_command(&command) {
            return;
        }
        let _ = __nw_std("kill")
            .args(["-9", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = __nw_std("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Whether a process command line is a daemon (`<app> --daemon serve` or
/// the standalone `axecode-daemon serve`).
pub fn is_daemon_command(command: &str) -> bool {
    let command = command.trim();
    command.contains(" serve")
        && (command.contains("--daemon") || command.contains("axecode-daemon"))
}

/// Starts the daemon binary detached from the current process so it
/// survives the IDE. Its stderr goes to `logs/daemon-stderr.log` (a crash
/// or a startup error before the log is open would be lost otherwise).
pub fn spawn_detached(
    binary: &Path,
    prefix_args: &[&str],
    data_dir: &Path,
) -> std::io::Result<std::process::Child> {
    let stderr = log_path(data_dir)
        .parent()
        .and_then(|dir| std::fs::create_dir_all(dir).ok().map(|_| dir.join("daemon-stderr.log")))
        .and_then(|path| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok()
        })
        .map(std::process::Stdio::from)
        .unwrap_or_else(std::process::Stdio::null);
    let mut command = __nw_std(binary);
    command
        .args(prefix_args)
        .arg("serve")
        .arg("--data-dir")
        .arg(data_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(stderr);
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
    command.spawn()
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

/// 0.1.75 : aucun lancement de processus n'ouvre de fenetre console sous Windows.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_daemon_command_lines() {
        assert!(is_daemon_command(
            "/Applications/SavIDE.app/Contents/MacOS/SavIDE --daemon serve --data-dir /Users/a/Library/Application Support/fr.savide.savide\n"
        ));
        assert!(is_daemon_command("/usr/local/bin/axecode-daemon serve --foreground"));
        assert!(!is_daemon_command("/Applications/SavIDE.app/Contents/MacOS/SavIDE"));
        assert!(!is_daemon_command("/usr/bin/python3 -m axecode_kernel"));
        assert!(!is_daemon_command(""));
    }

    #[test]
    fn timeout_errors_are_recognised() {
        assert!(is_timeout("daemon request sessions.ensure timed out"));
        assert!(!is_timeout("daemon connection closed"));
        assert!(!is_timeout("git command timed out"));
    }

    #[test]
    fn not_started_names_the_reason_and_the_log() {
        let message = not_started(Path::new("/data"), "aucune réponse après 30 s");
        assert!(message.starts_with("le moteur local n'a pas démarré : aucune réponse après 30 s"));
        assert!(message.contains("daemon.log"));
    }
}
