// axe:daemon — shared contracts between the background service (axecode-daemon),
// the REPL runtime (chantier C) and the agents layer (chantier E).
//
// Everything here is provider-agnostic and serialisable: the daemon owns the
// sessions and their append-only journals, the runtime executes turns.

use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{ChatMessage, ModelRef, StopReason, ToolResultImage, Usage};

/// Opaque session identifier (UUID v4 as a string).
pub type SessionId = String;
/// Opaque journal entry identifier (UUID v4 as a string).
pub type EntryId = String;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("io error: {0}")]
    Io(String),
    #[error("journal error: {0}")]
    Journal(String),
    #[error("session not found: {0}")]
    NotFound(SessionId),
    #[error("session busy: {0}")]
    Busy(SessionId),
    #[error("runtime error: {0}")]
    Runtime(String),
    #[error("turn cancelled")]
    Cancelled,
    #[error("protocol error: {0}")]
    Protocol(String),
}

impl From<std::io::Error> for SessionError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<serde_json::Error> for SessionError {
    fn from(value: serde_json::Error) -> Self {
        Self::Journal(value.to_string())
    }
}

pub type SessionResult<T> = std::result::Result<T, SessionError>;

/// Lifecycle of a session inside the daemon.
///
/// `running` → a turn is in progress; `idle` → loaded in memory (kernel alive)
/// but nothing running; `inactive` → unloaded after the inactivity window,
/// reloaded on demand from the journal + the last kernel snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Running,
    Idle,
    Inactive,
}

/// Mutable metadata of a session, kept in the daemon index and rebuildable
/// from the journal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<SessionId>,
    pub name: String,
    pub workspace_id: String,
    pub model: ModelRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_extra: Option<String>,
    pub status: SessionStatus,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub children: Vec<SessionId>,
    /// Current leaf of the journal tree (where the next entry attaches).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leaf: Option<EntryId>,
    #[serde(default)]
    pub entry_count: usize,
    /// Set when the session was explicitly stopped by the user; archived
    /// sessions can still be read and resumed.
    #[serde(default)]
    pub archived: bool,
    /// Legacy conversation id when the session was imported from SQLite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_from: Option<String>,
    /// axe:freechat — free conversation (no project folder): the workspace is
    /// a private scratch folder `<data>/scratch/<session-id>/`. Derived from
    /// the workspace path when the metadata is rebuilt.
    #[serde(default)]
    pub scratch: bool,
}

/// One line of the append-only JSONL journal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: EntryId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<EntryId>,
    pub ts: i64,
    #[serde(flatten)]
    pub kind: JournalEntryKind,
}

/// Payload of a journal entry. Every kind is written the moment it happens,
/// never at the end of a turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JournalEntryKind {
    /// Root entry of a session journal.
    SessionCreated {
        name: String,
        workspace_id: String,
        model: ModelRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<SessionId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        system_prompt_extra: Option<String>,
    },
    /// Root entry of a session cloned/forked from another session at a
    /// given entry; the history before `source_entry` is inherited.
    Fork {
        source_session: SessionId,
        source_entry: EntryId,
    },
    /// A chat message (user or assistant), with usage when known.
    Message {
        message: ChatMessage,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    /// The model asked the kernel to execute code.
    ReplCall {
        call_id: String,
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    /// Result of a REPL execution.
    ReplResult {
        call_id: String,
        output: String,
        #[serde(default)]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ToolResultImage>,
        #[serde(default)]
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    /// The session switched model.
    ModelSwitch { from: ModelRef, to: ModelRef },
    /// A compaction replaced the entries between `from_entry` and `to_entry`
    /// (inclusive, along the linear path) with `summary`.
    Compaction {
        summary: String,
        from_entry: EntryId,
        to_entry: EntryId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        directive: Option<String>,
    },
    /// A harness refinement was applied (or rolled back) during this session.
    Refinement {
        refinement_id: String,
        trigger: String,
        evidence: String,
        result: String,
        #[serde(default)]
        rolled_back: bool,
    },
    /// Message received from another agent session (nuclear family only).
    PeerMessage {
        from_session: SessionId,
        text: String,
    },
    /// Acknowledges delivery of peer messages (drained into a turn).
    PeerDelivered { entry_ids: Vec<EntryId> },
    /// Moves the leaf pointer: used for branches, undo and `/tree` navigation.
    Pointer {
        leaf: EntryId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Session metadata change (rename, archive, ...).
    Meta {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archived: Option<bool>,
        /// axe:freechat — the session moved to another folder (a free
        /// conversation opened in a project).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        /// axe:freechat — replaces the extra system prompt (project rules of
        /// the new folder).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        system_prompt_extra: Option<String>,
    },
    /// Free-form entry for other chantiers (goal, heartbeat, todo, ...).
    Extension { name: String, payload: Value },
}

/// Read-only view of a session journal for `/tree`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalTree {
    pub session_id: SessionId,
    pub leaf: Option<EntryId>,
    pub entries: Vec<JournalEntry>,
    /// Named leaves (labels given to `Pointer` entries), oldest first.
    pub branches: Vec<JournalBranch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalBranch {
    pub leaf: EntryId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub ts: i64,
}

/// A peer message waiting to be delivered at the start of the next turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMessage {
    pub entry_id: EntryId,
    pub from_session: SessionId,
    pub text: String,
    pub ts: i64,
}

/// What triggers a turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnInput {
    /// A new user message (already journaled by the daemon before the turn).
    User { message: ChatMessage },
    /// Resume after a crash / restart: the transcript already ends with the
    /// partial assistant work, the runtime must continue from there.
    Resume,
    /// Autonomous continuation (`/autonomous`, `/goal`).
    Continue,
    /// Periodic `/heartbeat` prompt.
    Heartbeat { text: String },
}

/// Everything a runtime needs to run one turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub turn_id: String,
    pub session: SessionMeta,
    /// Linear transcript rebuilt from the journal (compactions applied).
    pub history: Vec<ChatMessage>,
    pub input: TurnInput,
    /// Peer messages drained for this turn (to inject in the system reminder).
    #[serde(default)]
    pub peer_messages: Vec<PeerMessage>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnOutcome {
    pub final_text: String,
    #[serde(default)]
    pub usage: Usage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    /// Set by the runtime when it wants another turn right away
    /// (autonomous mode); the daemon decides according to budgets.
    #[serde(default)]
    pub wants_continuation: bool,
}

/// Sink given to the runtime for the duration of a turn. `record` appends to
/// the journal immediately; `emit` sends transient stream events (deltas) to
/// attached clients without journaling them.
#[async_trait]
pub trait TurnSink: Send + Sync {
    async fn record(&self, kind: JournalEntryKind) -> SessionResult<EntryId>;
    async fn emit(&self, event: Value);
    fn is_cancelled(&self) -> bool;
}

/// Snapshot/restore of a kernel state (implemented by chantier C on the
/// IPython kernel). Bytes are opaque to the daemon.
#[async_trait]
pub trait KernelSnapshot: Send + Sync {
    async fn save(&self) -> SessionResult<Vec<u8>>;
    async fn restore(&self, bytes: &[u8]) -> SessionResult<()>;
}

/// Executes turns inside a session worker. One runtime per loaded session.
#[async_trait]
pub trait SessionRuntime: Send + Sync {
    async fn run_turn(&self, request: TurnRequest, sink: Arc<dyn TurnSink>)
        -> SessionResult<TurnOutcome>;

    /// Kernel to snapshot after each turn (a new kernel restores it).
    fn kernel(&self) -> Option<Arc<dyn KernelSnapshot>> {
        None
    }

    /// Change the model used by subsequent turns.
    async fn set_model(&self, _model: ModelRef) -> SessionResult<()> {
        Ok(())
    }

    /// Called before the worker process exits.
    async fn shutdown(&self) {}

    /// Called when the daemon abandons a turn (Stop past its grace period, an
    /// end-of-turn snapshot past its deadline): stop at once, killing the
    /// kernel and the programs it started. Defaults to `shutdown`.
    async fn abort(&self) {
        self.shutdown().await
    }
}

/// Parameters to create a session (root or child).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub name: String,
    pub workspace_id: String,
    pub model: ModelRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_extra: Option<String>,
    /// When set, journaled as the first user message and a turn is started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_message: Option<String>,
}

/// Services the daemon offers to the runtimes it hosts (sub-agents,
/// messaging, session control). Implemented by the daemon.
#[async_trait]
pub trait SessionHost: Send + Sync {
    async fn create_session(&self, request: CreateSessionRequest) -> SessionResult<SessionMeta>;
    async fn get_session(&self, session_id: &str) -> SessionResult<SessionMeta>;
    async fn list_sessions(&self) -> Vec<SessionMeta>;
    /// Journals a user message in `session_id` and schedules a turn (held
    /// until the end of the running turn, if any).
    async fn send_user_message(&self, session_id: &str, text: String) -> SessionResult<EntryId>;
    /// Journals a peer message in `to`; delivered at the start of its next
    /// turn (a turn is scheduled if the target is idle).
    async fn post_peer_message(&self, from: &str, to: &str, text: String)
        -> SessionResult<EntryId>;
    /// Appends an arbitrary entry to a session journal.
    async fn record(&self, session_id: &str, kind: JournalEntryKind) -> SessionResult<EntryId>;
    /// Cancels the running turn of a session, if any.
    async fn stop_turn(&self, session_id: &str) -> SessionResult<()>;
    /// Last kernel snapshot saved for `session_id` (end of its last turn).
    async fn kernel_snapshot(&self, _session_id: &str) -> Option<Vec<u8>> {
        None
    }
}

/// Context handed to a runtime factory when a worker boots a session.
#[derive(Clone)]
pub struct RuntimeContext {
    pub data_dir: PathBuf,
    pub session: SessionMeta,
    pub host: Arc<dyn SessionHost>,
}

impl std::fmt::Debug for RuntimeContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeContext")
            .field("data_dir", &self.data_dir)
            .field("session", &self.session.id)
            .finish()
    }
}

/// Builds runtimes; the daemon binary is wired with one factory.
#[async_trait]
pub trait SessionRuntimeFactory: Send + Sync {
    async fn create(&self, context: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>>;

    /// axe:voix — one-shot text completion without tools (clean-up of a
    /// dictation, `voice.clean`). Factories without providers refuse.
    async fn complete_text(
        &self,
        _model: ModelRef,
        _system: String,
        _text: String,
    ) -> SessionResult<String> {
        Err(SessionError::Runtime(
            "text completion unavailable in this service".into(),
        ))
    }
}
