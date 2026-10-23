//! JSON-lines protocol between clients (IDE windows, CLI) and the daemon.
//!
//! Client → daemon: `{"id": 1, "method": "sessions.list", "params": {...}}`
//! Daemon → client: `{"id": 1, "result": ...}` or `{"id": 1, "error": "..."}`
//! Daemon → client (unsolicited): `{"event": "status", "sessionId": "...", "data": ...}`

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const LOCK_FILE: &str = "daemon.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Unsolicited event pushed to attached clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// `status` (session lifecycle, sent to every client), `entry` (a journal
    /// entry was appended), `stream` (transient delta), `daemon` (service
    /// state, e.g. shutting down).
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub data: Value,
}

/// Any line the daemon may write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ServerLine {
    Response(Response),
    Event(Event),
}

/// Contents of `daemon.json` in the data dir: proves a daemon is alive and
/// tells clients where to connect.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockInfo {
    pub pid: u32,
    pub endpoint: String,
    pub version: String,
    pub protocol: u32,
    pub started_at_ms: i64,
    /// axe:remote — network listen address when `--listen` is active.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
}

pub fn lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LOCK_FILE)
}

pub fn read_lock(data_dir: &Path) -> Option<LockInfo> {
    let raw = std::fs::read_to_string(lock_path(data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_lock(data_dir: &Path, info: &LockInfo) -> std::io::Result<()> {
    let path = lock_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(info).unwrap_or_default())?;
    std::fs::rename(tmp, path)
}

pub fn remove_lock(data_dir: &Path, pid: u32) {
    if read_lock(data_dir).is_some_and(|lock| lock.pid == pid) {
        let _ = std::fs::remove_file(lock_path(data_dir));
    }
}

/// Default endpoint for a data dir: a named pipe on Windows (scoped by a hash
/// of the data dir, i.e. per user), a unix socket inside the data dir elsewhere.
pub fn default_endpoint(data_dir: &Path) -> String {
    #[cfg(windows)]
    {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        data_dir.to_string_lossy().to_lowercase().hash(&mut hasher);
        format!(r"\\.\pipe\axecode-daemon-{:016x}", hasher.finish())
    }
    #[cfg(not(windows))]
    {
        data_dir.join("daemon.sock").to_string_lossy().to_string()
    }
}

/// Methods understood by the daemon (kept here so clients share the names).
pub mod methods {
    pub const HELLO: &str = "hello";
    pub const STATUS: &str = "status";
    pub const SHUTDOWN: &str = "shutdown";
    pub const SESSIONS_LIST: &str = "sessions.list";
    pub const SESSIONS_GET: &str = "sessions.get";
    pub const SESSIONS_CREATE: &str = "sessions.create";
    pub const SESSIONS_ENSURE: &str = "sessions.ensure";
    pub const SESSIONS_RELOCATE: &str = "sessions.relocate"; // axe:freechat
    pub const SESSIONS_ATTACH: &str = "sessions.attach";
    pub const SESSIONS_DETACH: &str = "sessions.detach";
    pub const SESSIONS_SEND: &str = "sessions.send";
    pub const SESSIONS_STOP: &str = "sessions.stop";
    pub const SESSIONS_HISTORY: &str = "sessions.history";
    pub const SESSIONS_TREE: &str = "sessions.tree";
    pub const SESSIONS_MOVE_LEAF: &str = "sessions.move_leaf";
    pub const SESSIONS_FORK: &str = "sessions.fork";
    pub const SESSIONS_SET_MODEL: &str = "sessions.set_model";
    pub const SESSIONS_UPDATE: &str = "sessions.update";
    pub const SESSIONS_RECORD: &str = "sessions.record";
    pub const SESSIONS_UNLOAD: &str = "sessions.unload";
    pub const SESSIONS_MESSAGE: &str = "sessions.message";
    // axe:e3 — archivage des conversations, puis suppression depuis l'archive seule.
    pub const SESSIONS_ARCHIVE: &str = "sessions.archive";
    pub const SESSIONS_DELETE: &str = "sessions.delete";
    pub const SESSIONS_RESTORE: &str = "sessions.restore";
}
