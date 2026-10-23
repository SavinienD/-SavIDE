//! axe:menage — finished sub-agents do not take room for nothing.
//!
//! * A sub-agent (session with a parent) frees its runtime and Python kernel
//!   `subagent_idle_unload` after its last turn (2 min by default, see
//!   `Daemon::stale_sessions`); the other sessions keep `idle_unload`.
//! * Finished for longer than `subagent_archive_after` (1 h by default), it
//!   goes to the archive like a conversation archived by hand.
//! * The runtimes still see the archived sub-agents
//!   (`SessionHost::list_sessions`), and any request on one of them restores
//!   it first, quietly: a parent can always follow up, wait or read them.
//! * Archived files untouched for `archive_compress_after` (7 days) are
//!   compressed (`<id>.jsonl.gz`, `<id>.snapshot.gz`) at startup, then once a
//!   day; every reader of the archive reads both forms.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use axecode_core::{SessionMeta, SessionStatus};

use crate::{
    daemon::{lock, Daemon, DaemonConfig, Slot},
    journal,
    util::now_ms,
};

/// Compression pass of the archives: at startup, then once a day.
pub const COMPRESS_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// Form kept in the index: enough for the family view, no system prompt.
pub(crate) fn index_entry(mut meta: SessionMeta) -> SessionMeta {
    meta.archived = true;
    meta.status = SessionStatus::Inactive;
    meta.children.clear();
    meta.system_prompt_extra = None;
    meta
}

fn visible(root: Option<&Path>, meta: &SessionMeta) -> bool {
    let Some(root) = root else {
        return false;
    };
    PathBuf::from(&meta.workspace_id)
        .canonicalize()
        .is_ok_and(|path| path.is_dir() && path.starts_with(root))
}

/// Archived sub-agents found on disk at startup (first entries only: the
/// startup does not read every archive in full).
pub(crate) fn index_archived_subagents(config: &DaemonConfig) -> HashMap<String, SessionMeta> {
    let root = config
        .workspace_root
        .as_ref()
        .and_then(|r| r.canonicalize().ok());
    let mut index = HashMap::new();
    for id in journal::list_archived_ids(&config.data_dir) {
        let Some(meta) = journal::archived_head(&config.data_dir, &id) else {
            tracing::warn!(session = %id, "unreadable archive");
            continue;
        };
        if meta.parent_id.is_none() {
            continue;
        }
        if config.workspace_root.is_some() && !visible(root.as_deref(), &meta) {
            continue;
        }
        index.insert(id, index_entry(meta));
    }
    index
}

impl Daemon {
    /// Sessions seen by the runtimes: the active ones, then the archived
    /// sub-agents (a parent keeps seeing its sub-agents once archived).
    pub(crate) fn host_sessions(&self) -> Vec<SessionMeta> {
        let mut metas = self.list_metas();
        let active: HashSet<String> = metas.iter().map(|m| m.id.clone()).collect();
        let mut archived: Vec<SessionMeta> = lock(&self.archived_subagents)
            .values()
            .filter(|m| !active.contains(&m.id))
            .cloned()
            .collect();
        archived.sort_by_key(|m| std::cmp::Reverse(m.updated_at_ms));
        metas.extend(archived);
        metas
    }

    /// Restores `id` first when it is an archived sub-agent, quietly (no
    /// event: its parent never notices the archive). Archived parents come
    /// back first, so that the family links survive. True when restored.
    pub fn wake_archived(&self, id: &str) -> bool {
        if crate::sessions::valid_session_id(id).is_err() {
            return false;
        }
        let active = lock(&self.sessions).contains_key(id);
        if active {
            return false;
        }
        let _archive = lock(&self.archive_lock);
        // `id`, then its archived ancestors, up to the first active one.
        let mut chain: Vec<String> = Vec::new();
        let mut current = id.to_string();
        while chain.len() < 32 && !chain.contains(&current) {
            let active = lock(&self.sessions).contains_key(&current);
            if active {
                break;
            }
            let Some(parent) = self.archived_subagent_parent(&current) else {
                break;
            };
            chain.push(current);
            current = parent;
        }
        for one in chain.iter().rev() {
            match self.restore_archived_locked(one) {
                Ok(_) => tracing::info!(session = %one, "archived sub-agent restored for a request"),
                Err(err) => {
                    tracing::warn!(session = %one, error = %err, "archived sub-agent not restored")
                }
            }
        }
        let restored = lock(&self.sessions).contains_key(id);
        restored
    }

    /// Parent of an archived sub-agent; `None` when `id` is not one.
    fn archived_subagent_parent(&self, id: &str) -> Option<String> {
        let indexed = lock(&self.archived_subagents)
            .get(id)
            .and_then(|meta| meta.parent_id.clone());
        // Not indexed (unreadable at startup...): the archive itself decides.
        indexed.or_else(|| journal::archived_parent(&self.config.data_dir, id))
    }

    /// How long a session has been left alone. A session not touched since
    /// the daemon started is idle since its last journal entry: a restart
    /// does not keep a finished sub-agent one more hour.
    fn idle_for(&self, slot: &Slot) -> Duration {
        if slot.last_active == self.boot {
            Duration::from_millis(u64::try_from(now_ms() - slot.meta.updated_at_ms).unwrap_or(0))
        } else {
            slot.last_active.elapsed()
        }
    }

    /// A sub-agent with nothing left to do: no turn, nothing queued, and no
    /// active sub-agent of its own (those are archived first).
    fn finished(slot: &Slot) -> bool {
        slot.meta.parent_id.is_some()
            && slot.cancel.is_none()
            && slot.queue.is_empty()
            && slot.held.is_empty()
            && slot.meta.status != SessionStatus::Running
            && slot.meta.children.is_empty()
    }

    /// Sub-agents finished for longer than `subagent_archive_after`.
    pub(crate) fn finished_subagents(&self) -> Vec<String> {
        let window = self.config.subagent_archive_after;
        lock(&self.sessions)
            .values()
            .filter(|slot| Self::finished(slot) && self.idle_for(slot) >= window)
            .map(|slot| slot.meta.id.clone())
            .collect()
    }

    /// Compresses the archived files older than `archive_compress_after`,
    /// one at a time under `archive_lock`. An original is removed only once
    /// its compressed copy has been checked; every failure is logged and
    /// leaves the original in place.
    pub fn compress_old_archives(&self) -> journal::CompressReport {
        let data_dir = &self.config.data_dir;
        {
            let _archive = lock(&self.archive_lock);
            journal::remove_stale_tmp(data_dir);
        }
        let mut report = journal::CompressReport::default();
        for path in journal::archives_to_compress(data_dir, self.config.archive_compress_after) {
            let _archive = lock(&self.archive_lock);
            if !path.exists() {
                continue; // restored or deleted meanwhile
            }
            match journal::compress_archive_file(&path) {
                Ok(gz) => report.compressed.push(gz),
                Err(err) => {
                    tracing::warn!(file = %path.display(), error = %err, "archive not compressed (original kept)");
                    report.errors.push(format!("{}: {err}", path.display()));
                }
            }
        }
        if !report.compressed.is_empty() {
            tracing::info!(files = report.compressed.len(), "old archives compressed");
        }
        report
    }

    /// Runs the compression pass when it is due (first pass, then daily),
    /// off the async threads.
    pub(crate) async fn compress_archives_if_due(&self) {
        let due = {
            let mut last = lock(&self.last_compress);
            let due = match *last {
                Some(at) => at.elapsed() >= COMPRESS_EVERY,
                None => true,
            };
            if due {
                *last = Some(Instant::now());
            }
            due
        };
        if due {
            let daemon = self.arc();
            if let Err(err) = tokio::task::spawn_blocking(move || daemon.compress_old_archives()).await {
                tracing::warn!(error = %err, "archive compression pass failed");
            }
        }
    }

    /// Archives the finished sub-agents: runtime unloaded first (kernel
    /// snapshot saved), then journal and snapshot moved to the archive.
    pub(crate) async fn archive_finished_subagents(&self) {
        for id in self.finished_subagents() {
            self.unload(&id).await;
            // A message may have arrived meanwhile.
            let still = lock(&self.sessions)
                .get(&id)
                .is_some_and(|slot| Self::finished(slot) && slot.runtime.is_none());
            if !still {
                continue;
            }
            // File moves and journal reads: off the async threads.
            let daemon = self.arc();
            let one = id.clone();
            match tokio::task::spawn_blocking(move || daemon.archive_one(&one)).await {
                Ok(Ok(_)) => tracing::info!(session = %id, "finished sub-agent archived"),
                Ok(Err(err)) => {
                    tracing::warn!(session = %id, error = %err, "finished sub-agent not archived")
                }
                Err(err) => {
                    tracing::warn!(session = %id, error = %err, "finished sub-agent not archived")
                }
            }
        }
    }
}
