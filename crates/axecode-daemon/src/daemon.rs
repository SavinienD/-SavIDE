//! Daemon core: owns sessions, their journals and runtimes; serves clients.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use axecode_core::{
    ChatMessage, SessionMeta, SessionRuntime, SessionRuntimeFactory, SessionStatus, TurnInput,
};
use tokio::sync::{mpsc, Notify};

use crate::{
    journal::{self, Journal},
    protocol::{Event, ServerLine},
    util::now_ms,
};

pub const DEFAULT_IDLE_UNLOAD: Duration = Duration::from_secs(30 * 60);
/// axe:menage — a finished sub-agent (session with a parent) frees its kernel
/// after 2 minutes; the other sessions keep [`DEFAULT_IDLE_UNLOAD`].
pub const DEFAULT_SUBAGENT_IDLE_UNLOAD: Duration = Duration::from_secs(2 * 60);
/// axe:menage — a sub-agent finished for longer than this goes to the archive.
pub const DEFAULT_SUBAGENT_ARCHIVE_AFTER: Duration = Duration::from_secs(60 * 60);
/// axe:menage — archived files untouched for this long are compressed (`.gz`).
pub const DEFAULT_ARCHIVE_COMPRESS_AFTER: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(60);
/// End-of-turn kernel snapshot deadline: past it the kernel is dropped and the
/// next turn starts from the journal and the last valid snapshot.
pub const DEFAULT_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
/// Time a turn gets to end by itself after Stop (end-of-turn snapshot
/// included); past it the turn is abandoned and its runtime killed.
pub const DEFAULT_STOP_GRACE: Duration = Duration::from_secs(8);
/// How many times a crashed worker is restarted for the same turn.
pub(crate) const MAX_WORKER_RESTARTS: u32 = 3;

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub data_dir: PathBuf,
    pub endpoint: String,
    pub version: String,
    pub idle_unload: Duration,
    /// axe:menage — idle window before a sub-agent's runtime is unloaded.
    pub subagent_idle_unload: Duration,
    /// axe:menage — idle time after which a finished sub-agent is archived.
    pub subagent_archive_after: Duration,
    /// axe:menage — age after which an archived file is compressed.
    pub archive_compress_after: Duration,
    pub shutdown_grace: Duration,
    /// See [`DEFAULT_SNAPSHOT_TIMEOUT`].
    pub snapshot_timeout: Duration,
    /// See [`DEFAULT_STOP_GRACE`].
    pub stop_grace: Duration,
    /// When false the daemon never exits on its own (tests, `--foreground`).
    pub auto_shutdown: bool,
    /// V2 L2: fixed per-user workspace root; None keeps local compatibility.
    pub workspace_root: Option<PathBuf>,
    /// V2 L4: service-wide shared space (Git repository); None disables `share.*`.
    pub shared_root: Option<PathBuf>,
    /// axe:remote — WebSocket listener (`--listen`), off by default.
    pub listen: Option<crate::listen::ListenConfig>,
}

impl DaemonConfig {
    pub fn new(data_dir: PathBuf) -> Self {
        let endpoint = crate::protocol::default_endpoint(&data_dir);
        Self {
            data_dir,
            endpoint,
            version: env!("CARGO_PKG_VERSION").to_string(),
            idle_unload: DEFAULT_IDLE_UNLOAD,
            subagent_idle_unload: DEFAULT_SUBAGENT_IDLE_UNLOAD, // axe:menage
            subagent_archive_after: DEFAULT_SUBAGENT_ARCHIVE_AFTER, // axe:menage
            archive_compress_after: DEFAULT_ARCHIVE_COMPRESS_AFTER, // axe:menage
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
            snapshot_timeout: DEFAULT_SNAPSHOT_TIMEOUT,
            stop_grace: DEFAULT_STOP_GRACE,
            auto_shutdown: true,
            workspace_root: None,
            shared_root: None, // v2-l4
            listen: None, // axe:remote
        }
    }
}

pub(crate) struct Slot {
    pub meta: SessionMeta,
    pub journal: Option<Arc<Mutex<Journal>>>,
    pub runtime: Option<Arc<dyn SessionRuntime>>,
    /// Some while a worker drives this session.
    pub cancel: Option<Arc<AtomicBool>>,
    pub queue: VecDeque<TurnInput>,
    /// User messages sent during a turn, journaled when it ends.
    pub held: Vec<ChatMessage>,
    pub last_active: Instant,
}

pub(crate) struct Client {
    pub name: String,
    pub tx: mpsc::UnboundedSender<String>,
    /// Session ids this client follows; `*` follows every session.
    pub attached: HashSet<String>,
}

pub struct Daemon {
    pub(crate) config: DaemonConfig,
    me: Weak<Daemon>,
    pub(crate) factory: Arc<dyn SessionRuntimeFactory>,
    pub(crate) sessions: Mutex<HashMap<String, Slot>>,
    pub(crate) clients: Mutex<HashMap<u64, Client>>,
    /// V2 L3: terminals (PTY) owned by this service.
    pub(crate) terminals: Mutex<HashMap<String, crate::term_rpc::Term>>,
    next_client: AtomicU64,
    pub(crate) shutdown: Notify,
    pub(crate) shutting_down: AtomicBool,
    started_at_ms: i64,
    pub(crate) last_activity: Mutex<Instant>,
    /// axe:eveil — Windows kept awake while a session runs.
    pub(crate) keep_awake: crate::keep_awake::KeepAwake,
    /// axe:menage — archived sub-agents (sessions with a parent), by id. The
    /// runtimes still see them (`SessionHost::list_sessions`), and a request
    /// on one of them restores it first: a parent never notices the archive.
    pub(crate) archived_subagents: Mutex<HashMap<String, SessionMeta>>,
    /// axe:menage — serialises the moves in and out of the archive folder.
    pub(crate) archive_lock: Mutex<()>,
    /// axe:menage — `Slot::last_active` of the sessions loaded at startup and
    /// not touched since: their last activity is the journal's.
    pub(crate) boot: Instant,
    /// axe:menage — last compression pass of the archives (startup, then daily).
    pub(crate) last_compress: Mutex<Option<Instant>>,
    /// axe:file-demon — files d'attente des messages, par session.
    pub(crate) queues: crate::queue_rpc::QueuesState,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl Daemon {
    /// Builds the daemon and indexes every journal on disk.
    pub fn new(config: DaemonConfig, factory: Arc<dyn SessionRuntimeFactory>) -> Arc<Self> {
        Self::with_keep_awake(config, factory, crate::keep_awake::KeepAwake::system())
    }

    /// axe:eveil — [`Daemon::new`] with the keep-awake requests sent to
    /// `keep_awake` (a test recorder; `new` uses [`KeepAwake::system`]).
    ///
    /// [`KeepAwake::system`]: crate::keep_awake::KeepAwake::system
    pub fn with_keep_awake(
        config: DaemonConfig,
        factory: Arc<dyn SessionRuntimeFactory>,
        keep_awake: crate::keep_awake::KeepAwake,
    ) -> Arc<Self> {
        let boot = Instant::now();
        let mut sessions = HashMap::new();
        for id in journal::list_journal_ids(&config.data_dir) {
            match Journal::open(&config.data_dir, &id) {
                Ok(journal) => {
                    if let Some(mut meta) = journal.rebuild_meta() {
                        if let Some(root) = config.workspace_root.as_ref() {
                            let allowed = root
                                .canonicalize()
                                .ok()
                                .zip(PathBuf::from(&meta.workspace_id).canonicalize().ok())
                                .is_some_and(|(root, path)| {
                                    path.is_dir() && path.starts_with(root)
                                });
                            if !allowed {
                                continue;
                            }
                            // Rebuild links only from the visible journal set below.
                            meta.children.clear();
                        }
                        sessions.insert(
                            id,
                            Slot {
                                meta,
                                journal: None,
                                runtime: None,
                                cancel: None,
                                queue: VecDeque::new(),
                                held: Vec::new(),
                                last_active: boot, // axe:menage — untouched since the start
                            },
                        );
                    }
                }
                Err(err) => tracing::warn!(session = %id, error = %err, "unreadable journal"),
            }
        }
        if config.workspace_root.is_some() {
            let visible: HashSet<String> = sessions.keys().cloned().collect();
            for slot in sessions.values_mut() {
                if slot
                    .meta
                    .parent_id
                    .as_ref()
                    .is_some_and(|id| !visible.contains(id))
                {
                    slot.meta.parent_id = None;
                }
            }
        }
        // Children lists are derived from parent ids.
        let links: Vec<(String, String)> = sessions
            .values()
            .filter_map(|s| s.meta.parent_id.clone().map(|p| (p, s.meta.id.clone())))
            .collect();
        for (parent, child) in links {
            if let Some(slot) = sessions.get_mut(&parent) {
                slot.meta.children.push(child);
            }
        }
        let archived_subagents = crate::menage::index_archived_subagents(&config);
        Arc::new_cyclic(|me| Self {
            config,
            me: me.clone(),
            factory,
            sessions: Mutex::new(sessions),
            clients: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
            next_client: AtomicU64::new(1),
            shutdown: Notify::new(),
            shutting_down: AtomicBool::new(false),
            started_at_ms: now_ms(),
            last_activity: Mutex::new(Instant::now()),
            keep_awake,
            archived_subagents: Mutex::new(archived_subagents), // axe:menage
            archive_lock: Mutex::new(()),                         // axe:menage
            boot,                                                 // axe:menage
            last_compress: Mutex::new(None),                      // axe:menage
            queues: Mutex::new(Default::default()),               // axe:file-demon
        })
    }

    pub(crate) fn arc(&self) -> Arc<Daemon> {
        self.me.upgrade().expect("daemon dropped")
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.config.data_dir
    }

    pub(crate) fn touch(&self) {
        *lock(&self.last_activity) = Instant::now();
    }

    // ----- clients -------------------------------------------------------

    pub(crate) fn add_client(&self, name: String, tx: mpsc::UnboundedSender<String>) -> u64 {
        let id = self.next_client.fetch_add(1, Ordering::Relaxed);
        lock(&self.clients).insert(
            id,
            Client {
                name,
                tx,
                attached: HashSet::new(),
            },
        );
        self.touch();
        id
    }

    pub(crate) fn remove_client(&self, id: u64) {
        lock(&self.clients).remove(&id);
        crate::term_rpc::client_gone(self, id);
        self.touch();
    }

    pub(crate) fn set_client_name(&self, id: u64, name: String) {
        if let Some(client) = lock(&self.clients).get_mut(&id) {
            client.name = name;
        }
    }

    pub(crate) fn attach(&self, client: u64, session: &str, attach: bool) {
        if let Some(c) = lock(&self.clients).get_mut(&client) {
            if attach {
                c.attached.insert(session.to_string());
            } else {
                c.attached.remove(session);
            }
        }
    }

    /// Sends an event to every client (`session_id = None` or `status`
    /// events) or to the clients attached to that session.
    pub(crate) fn broadcast(&self, event: &str, session_id: Option<&str>, data: Value) {
        if let (Some(configured), Some(id)) = (&self.config.workspace_root, session_id) {
            let allowed = self
                .meta(id)
                .ok()
                .and_then(|meta| {
                    configured
                        .canonicalize()
                        .ok()
                        .zip(PathBuf::from(meta.workspace_id).canonicalize().ok())
                })
                .is_some_and(|(root, path)| path.is_dir() && path.starts_with(root));
            if !allowed {
                return;
            }
        }
        let line = ServerLine::Event(Event {
            event: event.to_string(),
            session_id: session_id.map(str::to_string),
            data,
        });
        let Ok(mut text) = serde_json::to_string(&line) else {
            return;
        };
        text.push('\n');
        let to_all = session_id.is_none() || event == "status" || event == "daemon";
        for client in lock(&self.clients).values() {
            let follows = to_all
                || client.attached.contains("*")
                || session_id.is_some_and(|id| client.attached.contains(id));
            if follows {
                let _ = client.tx.send(text.clone());
            }
        }
    }

    pub fn status_json(&self) -> Value {
        let sessions = lock(&self.sessions);
        let count = |status: SessionStatus| {
            sessions
                .values()
                .filter(|s| s.meta.status == status)
                .count()
        };
        let clients: Vec<Value> = lock(&self.clients)
            .iter()
            .map(|(id, c)| json!({"id": id, "name": c.name, "attached": c.attached}))
            .collect();
        json!({
            "pid": std::process::id(),
            "version": self.config.version,
            "protocol": crate::protocol::PROTOCOL_VERSION,
            "endpoint": self.config.endpoint,
            "listen": self.config.listen.as_ref().map(|l| l.addr.to_string()), // axe:remote
            "dataDir": self.config.data_dir,
            "startedAtMs": self.started_at_ms,
            "clients": clients,
            "sessions": {
                "total": sessions.len(),
                "running": count(SessionStatus::Running),
                "idle": count(SessionStatus::Idle),
                "inactive": count(SessionStatus::Inactive),
            },
        })
    }
}
