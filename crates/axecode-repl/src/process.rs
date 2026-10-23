//! Kernel process lifecycle and reader task.

use std::{process::Stdio, sync::Arc, time::Duration};

use serde_json::{json, Value};
use axecode_core::SessionResult;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, Mutex as AsyncMutex},
};

use crate::{err, lock, HostHandler, Kernel, KernelEvent, KernelSpec, Waiters};

impl Kernel {
    /// Spawns the kernel, waits for `ready`, sends `init`.
    pub async fn start(
        spec: KernelSpec,
        host: Arc<dyn HostHandler>,
        events: mpsc::UnboundedSender<KernelEvent>,
    ) -> SessionResult<Arc<Self>> {
        let mut command = Command::new(&spec.python);
        command
            .arg("-u")
            .arg("-m")
            .arg("axecode_kernel")
            .current_dir(&spec.workspace)
            .env("PYTHONPATH", &spec.package_dir)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .env("AXECODE_WORKSPACE", &spec.workspace)
            .env("AXECODE_SESSION_ID", &spec.session_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            // Own process group: `kill` ends the kernel and every program it
            // started (shell sessions, subprocesses) with one signal.
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| {
            err(format!("cannot start python kernel ({}): {e}", spec.python.display()))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| err("kernel stdin unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| err("kernel stdout unavailable"))?;
        let stderr = child.stderr.take().ok_or_else(|| err("kernel stderr unavailable"))?;

        let waiters: Waiters = Arc::default();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (ready_tx, ready_rx) = oneshot::channel::<Value>();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

        // stderr: kernel diagnostics → tracing (never part of the protocol).
        // Read raw bytes: child programs may write non-UTF-8 text (Windows
        // code pages), and stopping here would fill the pipe and block the
        // kernel on its next write.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf);
                        tracing::debug!(target: "axecode_kernel", "{}", line.trim_end());
                    }
                }
            }
        });

        tokio::spawn(read_loop(
            stdout,
            waiters.clone(),
            events,
            alive.clone(),
            out_tx,
            host,
            ready_tx,
        ));

        let ready = tokio::time::timeout(Duration::from_secs(60), ready_rx)
            .await
            .map_err(|_| err("python kernel did not start within 60 s"))?
            .map_err(|_| err("python kernel exited during startup (is IPython installed?)"))?;

        let kernel = Arc::new(Self {
            stdin: AsyncMutex::new(stdin),
            child: AsyncMutex::new(child),
            waiters,
            exec_lock: AsyncMutex::new(()),
            alive,
            info: ready,
        });

        // Writer for host_result lines (must not wait on exec_lock).
        {
            let weak = Arc::downgrade(&kernel);
            tokio::spawn(async move {
                while let Some(line) = out_rx.recv().await {
                    let Some(kernel) = weak.upgrade() else { break };
                    if kernel.write_line(&line).await.is_err() {
                        break;
                    }
                }
            });
        }

        let init = kernel
            .request(json!({
                "type": "init",
                "workspace": spec.workspace,
                "session_id": spec.session_id,
                "modules": spec.modules,
                "sys_path": spec.sys_path,
            }))
            .await?;
        if init.get("ok") != Some(&Value::Bool(true)) {
            return Err(err(format!("kernel init failed: {init}")));
        }
        Ok(kernel)
    }

    pub(crate) async fn write_line(&self, line: &str) -> std::io::Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await
    }
}

async fn read_loop(
    stdout: tokio::process::ChildStdout,
    waiters: Waiters,
    events: mpsc::UnboundedSender<KernelEvent>,
    alive: Arc<std::sync::atomic::AtomicBool>,
    out_tx: mpsc::UnboundedSender<String>,
    host: Arc<dyn HostHandler>,
    ready_tx: oneshot::Sender<Value>,
) {
    let mut ready_tx = Some(ready_tx);
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            tracing::debug!(target: "axecode_kernel", "non-protocol line: {line}");
            continue;
        };
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        let id = message.get("id").and_then(Value::as_str).map(str::to_string);
        match kind {
            "ready" => {
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(message);
                }
            }
            "stream" => {
                let _ = events.send(KernelEvent::Stream {
                    exec_id: id.unwrap_or_default(),
                    name: str_field(&message, "name"),
                    text: str_field(&message, "text"),
                });
            }
            "file_change" => {
                let _ = events.send(KernelEvent::FileChange {
                    exec_id: id,
                    path: str_field(&message, "path"),
                    before: opt_field(&message, "before"),
                    after: opt_field(&message, "after"),
                });
            }
            "host_call" => {
                let host = host.clone();
                let out_tx = out_tx.clone();
                tokio::spawn(async move {
                    let call_id = message.get("call_id").cloned().unwrap_or(Value::Null);
                    let method = str_field(&message, "method");
                    let params = message.get("params").cloned().unwrap_or(json!({}));
                    let exec_id = opt_field(&message, "exec_id");
                    let reply = match host.call(&method, params, exec_id).await {
                        Ok(result) => {
                            json!({"type": "host_result", "call_id": call_id, "ok": true, "result": result})
                        }
                        Err(error) => {
                            json!({"type": "host_result", "call_id": call_id, "ok": false, "error": error})
                        }
                    };
                    let _ = out_tx.send(reply.to_string());
                });
            }
            _ => {
                if let Some(id) = id {
                    if let Some(waiter) = lock(&waiters).remove(&id) {
                        let _ = waiter.send(message);
                    }
                }
            }
        }
    }
    alive.store(false, std::sync::atomic::Ordering::SeqCst);
    for (_, waiter) in lock(&waiters).drain() {
        let _ = waiter.send(json!({"type": "dead", "ok": false, "error": "kernel process exited"}));
    }
    let _ = events.send(KernelEvent::Exited { code: None });
}

pub(crate) fn str_field(message: &Value, key: &str) -> String {
    message.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn opt_field(message: &Value, key: &str) -> Option<String> {
    message.get(key).and_then(Value::as_str).map(str::to_string)
}
