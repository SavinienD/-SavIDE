//! `SessionRuntime` implementation: one kernel + the single-tool loop.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use serde_json::{json, Value};
use axecode_core::{
    JournalEntry, JournalEntryKind, KernelSnapshot, ModelRef, RuntimeContext, SessionError,
    SessionHost, SessionMeta, SessionResult, SessionRuntime, SessionRuntimeFactory, TurnOutcome,
    TurnRequest, TurnSink,
};
use axecode_harness::HarnessStore;
use axecode_repl::{python, HostHandler, Kernel, KernelEvent, KernelSpec};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use super::{prompt, settings::ReplSettings, ReplDeps};
use crate::{rlm::FamilyHost, TodoListState};

/// The kernel has no console: programs it starts must fail instead of waiting
/// for an editor, a pager or a credential prompt.
const NON_INTERACTIVE_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("GIT_EDITOR", "true"),
    ("GIT_SEQUENCE_EDITOR", "true"),
    ("GIT_PAGER", "cat"),
    ("PAGER", "cat"),
];

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub struct ReplFactory {
    pub deps: Arc<ReplDeps>,
}

#[async_trait]
impl SessionRuntimeFactory for ReplFactory {
    async fn create(&self, context: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(ReplRuntime::new(self.deps.clone(), context))
    }

    // axe:voix — complétion simple, sans outil (nettoyage d'une dictée).
    async fn complete_text(
        &self,
        model: ModelRef,
        system: String,
        text: String,
    ) -> SessionResult<String> {
        use futures_util::StreamExt;
        let provider = self
            .deps
            .providers
            .provider(&model.provider)
            .map_err(SessionError::Runtime)?;
        let request = axecode_core::ProviderRequest::new(
            model,
            vec![axecode_core::ChatMessage::user_text(text)],
        )
        .with_system(system);
        let mut stream = provider
            .stream(request)
            .await
            .map_err(|err| SessionError::Runtime(err.to_string()))?;
        let mut out = String::new();
        while let Some(event) = stream.next().await {
            match event.map_err(|err| SessionError::Runtime(err.to_string()))? {
                axecode_core::StreamEvent::TextDelta { delta, .. } => out.push_str(&delta),
                axecode_core::StreamEvent::MessageStop { .. } => break,
                _ => {}
            }
        }
        Ok(out)
    }
}

/// State shared between the runtime and its kernel host handler.
pub(crate) struct Shared {
    pub deps: Arc<ReplDeps>,
    pub data_dir: PathBuf,
    pub session: Mutex<SessionMeta>,
    pub host: Arc<dyn SessionHost>,
    pub family: FamilyHost,
    pub harness: HarnessStore,
    pub todo: Mutex<TodoListState>,
    /// Sink of the turn in progress (for streaming kernel output).
    pub sink: Mutex<Option<Arc<dyn TurnSink>>>,
    /// Set by `compact.run()` from the kernel; consumed by the loop.
    pub compact_request: Mutex<Option<Option<String>>>,
    /// Input tokens of the last model call (auto-compaction trigger).
    pub last_input_tokens: Mutex<u32>,
    /// axe:compaction — (tokens billed, characters sent) of the last call:
    /// converts the next request's size into tokens.
    pub last_call_size: Mutex<Option<(u64, u64)>>,
    /// MCP servers, connected on first use by the `mcp` module.
    pub mcp: Mutex<Option<Arc<crate::McpToolRegistry>>>,
}

impl Shared {
    pub fn workspace(&self) -> PathBuf {
        PathBuf::from(&lock(&self.session).workspace_id)
    }

    pub fn meta(&self) -> SessionMeta {
        lock(&self.session).clone()
    }

    /// Every journal entry of the session (including compacted ranges).
    pub fn journal_entries(&self) -> Vec<JournalEntry> {
        let id = lock(&self.session).id.clone();
        let path = self.data_dir.join("sessions").join(format!("{id}.jsonl"));
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    pub(crate) async fn record(&self, kind: JournalEntryKind) -> Result<Value, String> {
        let sink = lock(&self.sink).clone();
        let id = match sink {
            Some(sink) => sink.record(kind).await,
            None => {
                let session = lock(&self.session).id.clone();
                self.host.record(&session, kind).await
            }
        };
        id.map(|id| json!({"entryId": id})).map_err(|e| e.to_string())
    }
}

struct RuntimeHost(Arc<Shared>);

#[async_trait]
impl HostHandler for RuntimeHost {
    async fn call(&self, method: &str, params: Value, _exec: Option<String>) -> Result<Value, String> {
        let shared = &self.0;
        if axecode_harness::host::handles(method) {
            // axe:freechat — free conversations have no project harness:
            // new entries go to the global scope, demotion is refused.
            let mut params = params;
            if lock(&shared.session).scratch {
                if method == "harness.demote" {
                    return Err("free conversation: there is no project harness".into());
                }
                if method == "harness.create" {
                    if let Some(object) = params.as_object_mut() {
                        object.insert("scope".into(), json!("global"));
                    }
                }
            }
            // axe:freechat end
            return axecode_harness::host::dispatch(&shared.harness, method, &params)
                .map_err(|e| e.to_string());
        }
        if FamilyHost::handles(method) {
            return shared.family.dispatch(method, &params).await.map_err(|e| e.to_string());
        }
        for hook in &shared.deps.hooks {
            if hook.handles(method) {
                return hook.host_call(&shared.meta(), method, params).await;
            }
        }
        super::host::dispatch(shared, method, params).await
    }
}

pub struct ReplRuntime {
    pub(crate) shared: Arc<Shared>,
    kernel: AsyncMutex<Option<Arc<Kernel>>>,
    /// Set when a dead kernel was replaced; shown with the next call result.
    restart_note: Mutex<Option<String>>,
    catalog: Mutex<String>,
    me: std::sync::Weak<ReplRuntime>,
}

impl ReplRuntime {
    pub fn new(deps: Arc<ReplDeps>, context: RuntimeContext) -> Arc<Self> {
        // axe:goal
        for hook in &deps.hooks {
            hook.bind(&context);
        }
        // axe:goal end
        // axe:providers — models declared in `<data_dir>/providers.json` are
        // resolved here; the host registry keeps serving every other provider.
        let deps = Arc::new(ReplDeps {
            providers: Arc::new(super::declared::DeclaredProviderResolver::load(
                deps.providers.clone(),
                &context.data_dir,
            )),
            resource_dirs: deps.resource_dirs.clone(),
            hooks: deps.hooks.clone(),
        });
        let workspace = PathBuf::from(&context.session.workspace_id);
        let profiles = crate::rlm::profiles_from_harness(&workspace);

        let family = FamilyHost::new(
            context.host.clone(),
            context.session.id.clone(),
            context.data_dir.clone(),
            profiles,
            None,
        );
        let shared = Arc::new(Shared {
            deps,
            data_dir: context.data_dir.clone(),
            session: Mutex::new(context.session),
            host: context.host,
            family,
            harness: HarnessStore::open(&workspace),
            todo: Mutex::new(TodoListState::default()),
            sink: Mutex::new(None),
            compact_request: Mutex::new(None),
            last_input_tokens: Mutex::new(0),
            last_call_size: Mutex::new(None),
            mcp: Mutex::new(None),
        });
        Arc::new_cyclic(|me| Self {
            shared,
            kernel: AsyncMutex::new(None),
            restart_note: Mutex::new(None),
            catalog: Mutex::new(String::new()),
            me: me.clone(),
        })
    }

    pub fn settings(&self) -> ReplSettings {
        ReplSettings::load(&self.shared.data_dir)
    }

    /// Returns the live kernel, starting (or restarting) it if needed. A new
    /// kernel gets the variables of the session's last snapshot.
    pub(crate) async fn kernel(&self) -> SessionResult<Arc<Kernel>> {
        let mut slot = self.kernel.lock().await;
        if let Some(kernel) = slot.as_ref().filter(|k| k.is_alive()) {
            return Ok(kernel.clone());
        }
        let dirs = &self.shared.deps.resource_dirs;
        let python = python::find_python(dirs)
            .ok_or_else(|| SessionError::Runtime("no Python interpreter found".into()))?;
        let package_dir = python::find_package_dir(dirs)
            .ok_or_else(|| SessionError::Runtime("axecode_kernel package not found".into()))?;
        let settings = self.settings();
        let sys_path = self
            .shared
            .harness
            .paths()
            .skills_paths()
            .into_iter()
            .map(|p| p.display().to_string())
            .collect();
        let meta = self.shared.meta();
        let spec = KernelSpec {
            python,
            package_dir,
            workspace: crate::workspace::os_path(&PathBuf::from(&meta.workspace_id)),
            session_id: meta.id.clone(),
            modules: settings.kernel_modules(),
            sys_path,
            env: NON_INTERACTIVE_ENV
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        };
        let (tx, rx) = mpsc::unbounded_channel();
        spawn_event_forwarder(self.shared.clone(), rx);
        let kernel = Kernel::start(spec, Arc::new(RuntimeHost(self.shared.clone())), tx).await?;
        let catalog = kernel.catalog(false).await.unwrap_or(json!([]));
        *lock(&self.catalog) = prompt::render_catalog(&catalog);
        let restored = self.restore_snapshot(&kernel, &meta.id).await;
        if slot.is_some() {
            *lock(&self.restart_note) = Some(format!("kernel restarted: {restored}"));
        }
        *slot = Some(kernel.clone());
        Ok(kernel)
    }

    /// Restores the session's last snapshot into `kernel`; says what happened.
    async fn restore_snapshot(&self, kernel: &Kernel, session_id: &str) -> String {
        let Some(bytes) = self.shared.host.kernel_snapshot(session_id).await else {
            return "no snapshot to restore, the variables are lost".into();
        };
        match kernel.restore_vars(&bytes).await {
            Ok(r) => {
                let mut text = format!(
                    "{} variable(s) restored from the last snapshot (end of the previous turn); \
                     changes made since then are lost",
                    r.restored.len()
                );
                if !r.failed.is_empty() {
                    text.push_str(&format!("; not restored: {}", r.failed.join(", ")));
                }
                text
            }
            Err(err) => {
                tracing::warn!(session = %session_id, error = %err, "kernel snapshot restore failed");
                format!("the snapshot could not be restored ({err}), the variables are lost")
            }
        }
    }

    /// Takes the note left by the last kernel restart, if any.
    pub(crate) fn take_restart_note(&self) -> Option<String> {
        lock(&self.restart_note).take()
    }

    pub(crate) fn catalog_text(&self) -> String {
        lock(&self.catalog).clone()
    }

    pub async fn current_kernel(&self) -> Option<Arc<Kernel>> {
        self.kernel.lock().await.clone()
    }
}

fn spawn_event_forwarder(shared: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<KernelEvent>) {
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let sink = lock(&shared.sink).clone();
            let Some(sink) = sink else { continue };
            let payload = match event {
                KernelEvent::Stream { exec_id, name, text } => {
                    json!({"type": "repl_stream", "callId": exec_id, "name": name, "text": text})
                }
                KernelEvent::FileChange { exec_id, path, before, after } => json!({
                    "type": "file_change", "callId": exec_id, "path": path,
                    "before": before, "after": after,
                }),
                KernelEvent::Exited { .. } => json!({"type": "kernel_exited"}),
            };
            sink.emit(payload).await;
        }
    });
}

/// Snapshot adapter: `SessionRuntime::kernel()` must be synchronous, so the
/// adapter resolves the live kernel lazily.
struct LazySnapshot(Arc<ReplRuntime>);

#[async_trait]
impl KernelSnapshot for LazySnapshot {
    async fn save(&self) -> SessionResult<Vec<u8>> {
        match self.0.current_kernel().await.filter(|k| k.is_alive()) {
            Some(kernel) => kernel.save().await,
            None => Err(SessionError::Runtime("kernel not running".into())),
        }
    }
    async fn restore(&self, bytes: &[u8]) -> SessionResult<()> {
        self.0.kernel().await?.restore(bytes).await
    }
}

#[async_trait]
impl SessionRuntime for ReplRuntime {
    async fn run_turn(&self, request: TurnRequest, sink: Arc<dyn TurnSink>) -> SessionResult<TurnOutcome> {
        super::turn::run(self, request, sink).await
    }

    fn kernel(&self) -> Option<Arc<dyn KernelSnapshot>> {
        let me = self.me.upgrade()?;
        Some(Arc::new(LazySnapshot(me)))
    }

    async fn set_model(&self, model: ModelRef) -> SessionResult<()> {
        lock(&self.shared.session).model = model;
        Ok(())
    }

    async fn shutdown(&self) {
        if let Some(kernel) = self.kernel.lock().await.take() {
            kernel.shutdown().await;
        }
    }

    /// Forced stop: no graceful shutdown, the kernel and every program it
    /// started are killed (the next turn restores the last snapshot).
    async fn abort(&self) {
        if let Some(kernel) = self.kernel.lock().await.take() {
            kernel.kill().await;
        }
    }
}
