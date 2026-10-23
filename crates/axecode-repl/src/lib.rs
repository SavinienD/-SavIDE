//! Persistent IPython kernel driven over JSON-lines (see
//! `python/axecode_kernel/__main__.py` for the protocol).
//!
//! One `Kernel` = one Python child process. Host calls emitted by the kernel
//! (`{"type":"host_call","method":...}`) are routed to a [`HostHandler`]
//! provided by the caller (the session runtime), and answered with
//! `host_result` lines.

pub mod process;
pub mod python;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use axecode_core::{KernelSnapshot, SessionError, SessionResult, ToolResultImage};
use tokio::{
    process::{Child, ChildStdin},
    sync::{oneshot, Mutex as AsyncMutex},
};

/// Handles kernel → host calls (`bridge.call(method, params)` in Python).
#[async_trait]
pub trait HostHandler: Send + Sync {
    async fn call(&self, method: &str, params: Value, exec_id: Option<String>) -> Result<Value, String>;
}

/// Transient kernel output, forwarded while an execution runs.
#[derive(Debug, Clone)]
pub enum KernelEvent {
    Stream { exec_id: String, name: String, text: String },
    FileChange { exec_id: Option<String>, path: String, before: Option<String>, after: Option<String> },
    Exited { code: Option<i32> },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub after: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecResult {
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub stdout_total: usize,
    #[serde(default)]
    pub stderr_total: usize,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub images: Vec<ToolResultImage>,
    #[serde(default)]
    pub file_changes: Vec<FileChange>,
    #[serde(default)]
    pub duration_ms: u64,
}

impl ExecResult {
    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
}

/// Outcome of a snapshot restore: variables put back and names that failed.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Restored {
    #[serde(default)]
    pub restored: Vec<String>,
    #[serde(default)]
    pub failed: Vec<String>,
}

/// How to start the kernel process.
#[derive(Debug, Clone)]
pub struct KernelSpec {
    /// Python interpreter (embedded sidecar or system python).
    pub python: PathBuf,
    /// Directory containing the `axecode_kernel` package.
    pub package_dir: PathBuf,
    pub workspace: PathBuf,
    pub session_id: String,
    /// Module/function configuration (Settings > Outils).
    pub modules: Value,
    pub sys_path: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub(crate) type Waiters = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub struct Kernel {
    pub(crate) stdin: AsyncMutex<ChildStdin>,
    pub(crate) child: AsyncMutex<Child>,
    pub(crate) waiters: Waiters,
    /// Serialises executions (the kernel runs one command at a time).
    pub(crate) exec_lock: AsyncMutex<()>,
    pub(crate) alive: Arc<std::sync::atomic::AtomicBool>,
    pub info: Value,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) fn err(msg: impl Into<String>) -> SessionError {
    SessionError::Runtime(msg.into())
}

impl Kernel {
    pub fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Sends a command with a fresh id and waits for the reply carrying it.
    pub(crate) async fn request(&self, mut message: Value) -> SessionResult<Value> {
        if !self.is_alive() {
            return Err(err("kernel process is not running"));
        }
        let id = match message.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                message["id"] = Value::String(id.clone());
                id
            }
        };
        let (tx, rx) = oneshot::channel();
        lock(&self.waiters).insert(id.clone(), tx);
        if let Err(e) = self.write_line(&message.to_string()).await {
            lock(&self.waiters).remove(&id);
            return Err(err(format!("kernel write failed: {e}")));
        }
        let reply = rx.await.map_err(|_| err("kernel closed"))?;
        if reply.get("type").and_then(Value::as_str) == Some("dead") {
            return Err(err("kernel process exited"));
        }
        Ok(reply)
    }

    /// Executes code; `exec_id` tags stream events and host calls.
    pub async fn exec(&self, exec_id: &str, code: &str) -> SessionResult<ExecResult> {
        let _guard = self.exec_lock.lock().await;
        let reply = self
            .request(json!({"type": "exec", "id": exec_id, "code": code}))
            .await?;
        serde_json::from_value(reply).map_err(|e| err(format!("bad exec reply: {e}")))
    }

    /// Interrupts the running execution (KeyboardInterrupt in the kernel).
    pub async fn interrupt(&self) {
        let _ = self.write_line(r#"{"type":"interrupt"}"#).await;
    }

    async fn command(&self, message: Value) -> SessionResult<Value> {
        let _guard = self.exec_lock.lock().await;
        let reply = self.request(message).await?;
        if reply.get("ok") == Some(&Value::Bool(false)) {
            let msg = reply.get("error").and_then(Value::as_str).unwrap_or("kernel error");
            return Err(err(msg.to_string()));
        }
        Ok(reply)
    }

    /// Module catalog (name, doc, functions with signature/doc/enabled).
    pub async fn catalog(&self, include_disabled: bool) -> SessionResult<Value> {
        let reply = self
            .command(json!({"type": "catalog", "all": include_disabled}))
            .await?;
        Ok(reply.get("modules").cloned().unwrap_or(json!([])))
    }

    /// Re-applies the module configuration and extra sys.path entries.
    pub async fn configure(&self, modules: Value, sys_path: Vec<String>) -> SessionResult<()> {
        self.command(json!({"type": "configure", "modules": modules, "sys_path": sys_path}))
            .await
            .map(|_| ())
    }

    /// Drops user variables not listed in `keep`; returns removed names.
    pub async fn collect(&self, keep: Vec<String>) -> SessionResult<Vec<String>> {
        let reply = self.command(json!({"type": "gc", "keep": keep})).await?;
        Ok(serde_json::from_value(reply.get("removed").cloned().unwrap_or(json!([])))
            .unwrap_or_default())
    }

    /// Kills the kernel at once with every program it started (Windows:
    /// `taskkill /T`; elsewhere its process group, see `start`): for code that
    /// ignores `interrupt` because it is blocked outside Python (a child
    /// process, a socket), and for turns abandoned by Stop.
    pub async fn kill(&self) {
        let mut child = self.child.lock().await;
        #[cfg(windows)]
        {
            if let Some(pid) = child.id() {
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status()
                    .await;
            }
        }
        #[cfg(unix)]
        {
            if let Some(pid) = child.id() {
                // The kernel leads its own process group: shell sessions and
                // subprocesses it started go with it.
                let _ = tokio::process::Command::new("kill")
                    .args(["-KILL", "--", &format!("-{pid}")])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
        }
        let _ = child.kill().await;
    }

    /// Restores a snapshot made by `save`.
    pub async fn restore_vars(&self, bytes: &[u8]) -> SessionResult<Restored> {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let reply = self
            .command(json!({"type": "restore", "data": data}))
            .await?;
        serde_json::from_value(reply).map_err(|e| err(format!("bad restore reply: {e}")))
    }

    pub async fn shutdown(&self) {
        let _ = self.write_line(r#"{"type":"shutdown"}"#).await;
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}

#[async_trait]
impl KernelSnapshot for Kernel {
    async fn save(&self) -> SessionResult<Vec<u8>> {
        let reply = self.command(json!({"type": "snapshot"})).await?;
        let data = reply.get("data").and_then(Value::as_str).unwrap_or("");
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| err(format!("bad snapshot: {e}")))
    }

    async fn restore(&self, bytes: &[u8]) -> SessionResult<()> {
        self.restore_vars(bytes).await.map(|_| ())
    }
}
