//! Supervised workers: one tokio task per busy session.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures_util::FutureExt;
use serde_json::{json, Value};
use axecode_core::{
    EntryId, JournalEntryKind, RuntimeContext, SessionError, SessionHost, SessionResult,
    SessionRuntime, SessionStatus, TurnInput, TurnRequest, TurnSink,
};

use crate::{
    daemon::{lock, Daemon, MAX_WORKER_RESTARTS},
    journal,
    util::new_id,
};

/// How often a running turn checks whether Stop was requested.
const STOP_POLL: Duration = Duration::from_millis(100);
/// Upper bound for `SessionRuntime::abort` (killing a kernel).
const ABORT_TIMEOUT: Duration = Duration::from_secs(5);

/// Sink handed to the runtime: journals immediately, streams to clients.
pub struct DaemonSink {
    daemon: Arc<Daemon>,
    session_id: String,
    turn_id: String,
    cancel: Arc<AtomicBool>,
}

#[async_trait]
impl TurnSink for DaemonSink {
    async fn record(&self, kind: JournalEntryKind) -> SessionResult<EntryId> {
        // Runtimes do not know entry ids: a compaction with empty bounds
        // covers the whole current branch (root excluded) up to the leaf.
        let kind = match kind {
            JournalEntryKind::Compaction { summary, from_entry, to_entry, directive }
                if from_entry.is_empty() || to_entry.is_empty() =>
            {
                let journal = self.daemon.journal(&self.session_id)?;
                let journal = lock(&journal);
                let path = journal.path_to_leaf();
                let first = path
                    .iter()
                    .find(|e| {
                        !matches!(
                            e.kind,
                            JournalEntryKind::SessionCreated { .. } | JournalEntryKind::Fork { .. }
                        )
                    })
                    .map(|e| e.id.clone());
                let last = path.last().map(|e| e.id.clone());
                match (first, last) {
                    (Some(from_entry), Some(to_entry)) => JournalEntryKind::Compaction {
                        summary,
                        from_entry,
                        to_entry,
                        directive,
                    },
                    _ => return Err(SessionError::Journal("nothing to compact".into())),
                }
            }
            other => other,
        };
        self.daemon.append(&self.session_id, kind)
    }

    async fn emit(&self, event: Value) {
        self.daemon.broadcast(
            "stream",
            Some(&self.session_id),
            json!({"turnId": self.turn_id, "event": event}),
        );
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

impl Daemon {
    /// Queues a turn and starts a worker if none is running.
    pub fn enqueue(&self, id: &str, input: TurnInput) {
        let start = {
            let mut sessions = lock(&self.sessions);
            let Some(slot) = sessions.get_mut(id) else {
                return;
            };
            slot.queue.push_back(input);
            slot.last_active = Instant::now();
            if slot.cancel.is_some() {
                None
            } else {
                let cancel = Arc::new(AtomicBool::new(false));
                slot.cancel = Some(cancel.clone());
                Some(cancel)
            }
        };
        if let Some(cancel) = start {
            let daemon = self.arc();
            let id = id.to_string();
            tokio::spawn(async move { daemon.run_worker(id, cancel).await });
        }
    }

    async fn runtime_for(&self, id: &str) -> SessionResult<Arc<dyn SessionRuntime>> {
        if let Some(runtime) = lock(&self.sessions).get(id).and_then(|s| s.runtime.clone()) {
            return Ok(runtime);
        }
        let meta = self.meta(id)?;
        let host: Arc<dyn SessionHost> = self.arc();
        let runtime = self
            .factory
            .create(RuntimeContext {
                data_dir: self.config.data_dir.clone(),
                session: meta,
                host,
            })
            .await?;
        if let Some(slot) = lock(&self.sessions).get_mut(id) {
            slot.runtime = Some(runtime.clone());
        }
        Ok(runtime)
    }

    async fn save_snapshot(&self, id: &str, runtime: &Arc<dyn SessionRuntime>) {
        let Some(kernel) = runtime.kernel() else {
            return;
        };
        // A snapshot that never returns kept the session "running" for good
        // (SCRAPPING, 20/10/2026): past the deadline the kernel is dropped;
        // the snapshot file on disk stays the last valid one.
        let limit = self.config.snapshot_timeout;
        let Ok(saved) = tokio::time::timeout(limit, kernel.save()).await else {
            tracing::warn!(
                session = %id,
                timeout_ms = limit.as_millis() as u64,
                "kernel snapshot timed out: kernel killed, the next turn restarts from the journal and the last valid snapshot"
            );
            // Forgotten only if the slot still holds it (`unload` took it).
            if let Some(slot) = lock(&self.sessions).get_mut(id) {
                if slot.runtime.as_ref().is_some_and(|r| Arc::ptr_eq(r, runtime)) {
                    slot.runtime = None;
                }
            }
            abort_runtime(id, runtime).await;
            return;
        };
        match saved {
            Ok(bytes) => {
                let path = journal::snapshot_path(&self.config.data_dir, id);
                let tmp = path.with_extension("snapshot.tmp");
                if std::fs::write(&tmp, &bytes).is_ok() {
                    let _ = std::fs::rename(&tmp, &path);
                }
            }
            Err(err) => tracing::warn!(session = %id, error = %err, "kernel snapshot failed"),
        }
    }

    fn next_input(&self, id: &str) -> Option<TurnInput> {
        loop {
            let held = {
                let mut sessions = lock(&self.sessions);
                let slot = sessions.get_mut(id)?;
                if slot.held.is_empty() {
                    let next = slot.queue.pop_front();
                    if next.is_none() {
                        slot.cancel = None;
                    }
                    return next;
                }
                std::mem::take(&mut slot.held)
            };
            // Sent during the turn that just ended: journaled after it.
            for message in held {
                if let Err(err) = self.journal_user(id, message) {
                    tracing::warn!(session = %id, error = %err, "held user message lost");
                }
            }
        }
    }

    async fn run_worker(self: Arc<Self>, id: String, cancel: Arc<AtomicBool>) {
        self.set_status(&id, SessionStatus::Running);
        let mut restarts = 0u32;
        let mut pending: Option<TurnInput> = None;
        loop {
            if cancel.swap(false, Ordering::SeqCst) {
                // Stop requested: drop everything queued (continuations,
                // wake-ups). User messages sent during the turn (held) are
                // never lost: `next_input` journals them, then they are
                // answered, as after a turn that returned `Cancelled`.
                pending = None;
                if let Some(slot) = lock(&self.sessions).get_mut(&id) {
                    slot.queue.clear();
                }
            }
            let input = match pending.take().or_else(|| self.next_input(&id)) {
                Some(input) => input,
                None => break,
            };
            let attempt = self.clone().run_or_abandon(&id, input, &cancel).await;
            match attempt {
                Ok(Ok(wants_more)) => {
                    restarts = 0;
                    if wants_more && !cancel.load(Ordering::SeqCst) {
                        pending = Some(TurnInput::Continue);
                    }
                }
                Ok(Err(SessionError::Cancelled)) => {
                    cancel.store(false, Ordering::SeqCst);
                }
                Ok(Err(_)) | Err(_) if restarts < MAX_WORKER_RESTARTS && !cancel.load(Ordering::SeqCst) => {
                    restarts += 1;
                    tracing::warn!(session = %id, restarts, "worker failed, restarting from journal + snapshot");
                    self.drop_runtime(&id).await;
                    let _ = err_note(&self, &id, restarts);
                    pending = Some(TurnInput::Resume);
                }
                Ok(Err(err)) => {
                    let _ = self.append(
                        &id,
                        JournalEntryKind::Extension {
                            name: "turn_error".into(),
                            payload: json!({"error": err.to_string()}),
                        },
                    );
                    cancel.store(false, Ordering::SeqCst);
                }
                Err(_) => {
                    let _ = self.append(
                        &id,
                        JournalEntryKind::Extension {
                            name: "turn_error".into(),
                            payload: json!({"error": "worker crashed repeatedly"}),
                        },
                    );
                    self.drop_runtime(&id).await;
                }
            }
        }
        self.set_status(&id, SessionStatus::Idle);
    }

    /// Runs one turn (end-of-turn snapshot included) against Stop: once
    /// `cancel` is raised the turn gets `stop_grace` to end by itself; past
    /// it the turn future is abandoned and the runtime killed (kernel and the
    /// programs it started), as if the turn had returned `Cancelled`. A turn
    /// or a snapshot that never returns can no longer keep a session running.
    async fn run_or_abandon(
        self: Arc<Self>,
        id: &str,
        input: TurnInput,
        cancel: &Arc<AtomicBool>,
    ) -> std::thread::Result<SessionResult<bool>> {
        let mut turn = Box::pin(
            std::panic::AssertUnwindSafe(self.clone().run_one(id, input, cancel.clone()))
                .catch_unwind(),
        );
        let grace = self.config.stop_grace;
        let finished = tokio::select! {
            biased;
            attempt = &mut turn => Some(attempt),
            () = stop_requested_then(cancel, grace) => None,
        };
        if let Some(attempt) = finished {
            return attempt;
        }
        drop(turn);
        let grace_ms = grace.as_millis() as u64;
        tracing::warn!(
            session = %id,
            grace_ms,
            "turn ignored Stop: abandoned, kernel and the programs it started killed"
        );
        self.kill_runtime(id).await;
        let _ = self.append(
            id,
            JournalEntryKind::Extension {
                name: "turn_stopped".into(),
                payload: json!({"forced": true, "graceMs": grace_ms}),
            },
        );
        Ok(Err(SessionError::Cancelled))
    }

    /// Runs one turn. Returns whether the runtime wants a continuation.
    async fn run_one(self: Arc<Self>, id: &str, input: TurnInput, cancel: Arc<AtomicBool>) -> SessionResult<bool> {
        let runtime = self.runtime_for(id).await?;
        let journal = self.journal(id)?;
        let (history, peer_messages) = {
            let journal = lock(&journal);
            (journal.history(), journal.pending_peer_messages())
        };
        if !peer_messages.is_empty() {
            self.append(
                id,
                JournalEntryKind::PeerDelivered {
                    entry_ids: peer_messages.iter().map(|m| m.entry_id.clone()).collect(),
                },
            )?;
        }
        let turn_id = new_id();
        let request = TurnRequest {
            turn_id: turn_id.clone(),
            session: self.meta(id)?,
            history,
            input,
            peer_messages,
        };
        let sink = Arc::new(DaemonSink {
            daemon: self.clone(),
            session_id: id.to_string(),
            turn_id,
            cancel,
        });
        let outcome = runtime.run_turn(request, sink).await;
        self.save_snapshot(id, &runtime).await;
        Ok(outcome?.wants_continuation)
    }

    /// Kills the session's runtime at once (kernel and the programs it
    /// started) and forgets it: the next turn starts a new one from the
    /// journal and the last valid snapshot.
    pub(crate) async fn kill_runtime(&self, id: &str) {
        let runtime = lock(&self.sessions).get_mut(id).and_then(|s| s.runtime.take());
        if let Some(runtime) = runtime {
            abort_runtime(id, &runtime).await;
        }
    }

    pub(crate) async fn drop_runtime(&self, id: &str) {
        let runtime = lock(&self.sessions).get_mut(id).and_then(|s| s.runtime.take());
        if let Some(runtime) = runtime {
            runtime.shutdown().await;
        }
    }

    /// Unloads a session (journal + runtime) if it is not running.
    pub async fn unload(&self, id: &str) {
        let runtime = {
            let mut sessions = lock(&self.sessions);
            let Some(slot) = sessions.get_mut(id) else {
                return;
            };
            if slot.cancel.is_some() {
                return;
            }
            slot.journal = None;
            slot.runtime.take()
        };
        if let Some(runtime) = runtime {
            self.save_snapshot(id, &runtime).await;
            runtime.shutdown().await;
        }
        let last_active = lock(&self.sessions).get(id).map(|s| s.last_active);
        self.set_status(id, SessionStatus::Inactive);
        // axe:menage — unloading is not activity: the archive delay of a
        // finished sub-agent keeps counting from its last turn.
        if let (Some(at), Some(slot)) = (last_active, lock(&self.sessions).get_mut(id)) {
            slot.last_active = at;
        }
    }

    /// Sessions idle for longer than their window: `subagent_idle_unload`
    /// for sub-agents (sessions with a parent, axe:menage), `idle_unload`
    /// for the others.
    pub(crate) fn stale_sessions(&self) -> Vec<String> {
        let (window, subagent_window) = (self.config.idle_unload, self.config.subagent_idle_unload);
        lock(&self.sessions)
            .iter()
            .filter(|(_, s)| {
                let window = if s.meta.parent_id.is_some() {
                    subagent_window
                } else {
                    window
                };
                s.cancel.is_none()
                    && s.meta.status == SessionStatus::Idle
                    && s.last_active.elapsed() >= window
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// axe:menage — one pass of the maintenance loop (every 15 s): unloads
    /// the runtimes left idle for too long, archives finished sub-agents,
    /// compresses old archives (first pass, then once a day).
    pub async fn housekeeping(&self) {
        for id in self.stale_sessions() {
            self.unload(&id).await;
        }
        self.archive_finished_subagents().await;
        self.compress_archives_if_due().await;
    }

    pub(crate) fn any_running(&self) -> bool {
        lock(&self.sessions).values().any(|s| s.cancel.is_some())
    }
}

/// Completes `grace` after Stop (`cancel`) is raised.
async fn stop_requested_then(cancel: &AtomicBool, grace: Duration) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(STOP_POLL).await;
    }
    tokio::time::sleep(grace).await;
}

/// `SessionRuntime::abort`, bounded: the worker must never hang on it.
async fn abort_runtime(id: &str, runtime: &Arc<dyn SessionRuntime>) {
    if tokio::time::timeout(ABORT_TIMEOUT, runtime.abort()).await.is_err() {
        tracing::warn!(session = %id, "runtime abort timed out");
    }
}

fn err_note(daemon: &Daemon, id: &str, restarts: u32) -> SessionResult<EntryId> {
    daemon.append(
        id,
        JournalEntryKind::Extension {
            name: "worker_restart".into(),
            payload: json!({"attempt": restarts}),
        },
    )
}
