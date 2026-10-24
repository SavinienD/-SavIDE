//! Single-tool REPL agent (chantier C): the model only has `python(code)`,
//! executed in a persistent IPython kernel per session.

mod budget;
mod compaction;
// axe:providers — providers declared in `<data_dir>/providers.json`.
pub mod declared;
mod host;
pub mod output;
pub mod prompt;
pub mod runtime;
pub mod settings;
mod turn;

use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use serde_json::Value;
use axecode_core::{Provider, RuntimeContext, SessionMeta, TurnOutcome, TurnRequest};

pub use declared::{declared_catalog, DeclaredProviderResolver};
pub use runtime::{ReplFactory, ReplRuntime};
pub use settings::{FunctionSetting, ModuleSetting, ReplSettings};

/// Resolves a provider id to a live provider (registry of the host app).
pub trait ProviderResolver: Send + Sync {
    fn provider(&self, provider_id: &str) -> Result<Arc<dyn Provider>, String>;
}

/// Extension point for other chantiers (goal, heartbeat, refine, ...):
/// contributes system-reminder blocks and serves kernel host calls.
#[async_trait]
pub trait TurnHook: Send + Sync {
    /// Block appended to the system reminder at the start of each turn.
    async fn reminder(&self, _session: &SessionMeta, _request: &TurnRequest) -> Option<String> {
        None
    }
    /// axe:goal165 — block re-computed for every request of the turn (live state:
    /// goal, autonomous, heartbeat), after the `reminder` blocks.
    async fn live_reminder(&self, _session: &SessionMeta) -> Option<String> {
        None
    }
    /// Whether this hook serves `method`.
    fn handles(&self, _method: &str) -> bool {
        false
    }
    async fn host_call(
        &self,
        _session: &SessionMeta,
        _method: &str,
        _params: Value,
    ) -> Result<Value, String> {
        Err("not handled".into())
    }
    /// Called after every turn with the final assistant text.
    async fn turn_finished(&self, _session: &SessionMeta, _final_text: &str) {}
    // axe:goal — session commands (/goal, /autonomous, /heartbeat, refine).
    /// Called once when a session runtime is created (host + data dir).
    fn bind(&self, _context: &RuntimeContext) {}
    /// Whether the daemon should run another turn right away (autonomous).
    async fn wants_continuation(&self, _session: &SessionMeta, _outcome: &TurnOutcome) -> bool {
        false
    }
    // axe:goal end
}

/// Shared dependencies of every REPL runtime of a process.
pub struct ReplDeps {
    pub providers: Arc<dyn ProviderResolver>,
    /// Tauri resource dirs (embedded python + kernel package); may be empty.
    pub resource_dirs: Vec<PathBuf>,
    pub hooks: Vec<Arc<dyn TurnHook>>,
}
