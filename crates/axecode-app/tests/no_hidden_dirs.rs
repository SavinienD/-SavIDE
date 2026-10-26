//! Consigne : ouvrir un projet vide, y mener une conversation et
//! écrire dans le harnais « projet » ne crée AUCUN dossier caché dans le
//! projet (tout va dans les données de l'appli).
//! Binaire de test à part : HOME et AXECODE_DATA_DIR redirigés.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::stream;
use serde_json::Value;
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplRuntime};
use axecode_core::{
    ChatMessage, CreateSessionRequest, EntryId, JournalEntryKind, ModelCapabilities, ModelRef,
    PartKind, Provider, ProviderRequest, ProviderStream, Result as CoreResult, RuntimeContext,
    SessionHost, SessionMeta, SessionResult, SessionRuntime, SessionStatus, StopReason,
    StreamEvent, TokenEstimate, TurnInput, TurnRequest, TurnSink, Usage,
};

struct Scripted {
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl Provider for Scripted {
    fn name(&self) -> &str {
        "scripted"
    }
    fn capabilities(&self, _model: &ModelRef) -> Option<ModelCapabilities> {
        None
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> CoreResult<TokenEstimate> {
        Ok(TokenEstimate { input_tokens: 0, exact: false })
    }
    async fn stream(&self, request: ProviderRequest) -> CoreResult<ProviderStream> {
        self.seen.lock().unwrap().push(format!("{request:?}"));
        let events = vec![
            StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
            StreamEvent::TextDelta { index: 0, delta: "ok".into() },
            StreamEvent::PartStop { index: 0 },
            StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage: Usage::default() },
        ];
        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver(Arc<Scripted>);
impl ProviderResolver for Resolver {
    fn provider(&self, _id: &str) -> Result<Arc<dyn Provider>, String> {
        Ok(self.0.clone())
    }
}

#[derive(Default)]
struct Sink {
    entries: Mutex<Vec<JournalEntryKind>>,
}
#[async_trait]
impl TurnSink for Sink {
    async fn record(&self, kind: JournalEntryKind) -> SessionResult<EntryId> {
        self.entries.lock().unwrap().push(kind);
        Ok(uuid::Uuid::new_v4().to_string())
    }
    async fn emit(&self, _event: Value) {}
    fn is_cancelled(&self) -> bool {
        false
    }
}

struct NoHost;
#[async_trait]
impl SessionHost for NoHost {
    async fn create_session(&self, _r: CreateSessionRequest) -> SessionResult<SessionMeta> {
        Err(axecode_core::SessionError::Runtime("no".into()))
    }
    async fn get_session(&self, id: &str) -> SessionResult<SessionMeta> {
        Err(axecode_core::SessionError::NotFound(id.into()))
    }
    async fn list_sessions(&self) -> Vec<SessionMeta> {
        vec![]
    }
    async fn send_user_message(&self, _id: &str, _t: String) -> SessionResult<EntryId> {
        Ok(String::new())
    }
    async fn post_peer_message(&self, _f: &str, _t: &str, _x: String) -> SessionResult<EntryId> {
        Ok(String::new())
    }
    async fn record(&self, _id: &str, _k: JournalEntryKind) -> SessionResult<EntryId> {
        Ok(String::new())
    }
    async fn stop_turn(&self, _id: &str) -> SessionResult<()> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_project_stays_free_of_hidden_folders() {
    let base = std::env::temp_dir().join(format!("axecode-no-hidden-{}", uuid::Uuid::new_v4()));
    let home = base.join("home");
    let data = base.join("donnees");
    let dir = base.join("ws");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    if let Some(real) = std::env::var_os("HOME") {
        if std::env::var_os("PYTHONUSERBASE").is_none() {
            std::env::set_var("PYTHONUSERBASE", std::path::Path::new(&real).join(".local"));
        }
    }
    std::env::set_var("HOME", &home);
    std::env::set_var(axecode_harness::datadir::DATA_ENV, &data);
    let hidden = |dir: &std::path::Path| -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with('.'))
            .collect()
    };

    // Harnais « projet » : écrit dans les données de l'appli.
    let store = axecode_harness::HarnessStore::open(&dir);
    assert!(store.paths().project_root.starts_with(&data));
    store
        .create(
            axecode_harness::Scope::Project,
            axecode_harness::EntryKind::Memory,
            axecode_harness::NewEntry { title: "t".into(), body: "b".into(), ..Default::default() },
        )
        .unwrap();
    assert_eq!(hidden(&dir), Vec::<String>::new());

    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping the turn: no python");
        let _ = std::fs::remove_dir_all(&base);
        return;
    }
    let meta = SessionMeta {
        id: "s1".into(),
        parent_id: None,
        name: "t".into(),
        workspace_id: dir.display().to_string(),
        model: ModelRef::new("scripted", "m"),
        system_prompt_extra: None,
        status: SessionStatus::Running,
        created_at_ms: 0,
        updated_at_ms: 0,
        children: vec![],
        leaf: None,
        entry_count: 0,
        archived: false,
        imported_from: None,
        scratch: false,
    };
    let provider = Arc::new(Scripted { seen: Mutex::new(vec![]) });
    let deps = Arc::new(ReplDeps { providers: Arc::new(Resolver(provider.clone())), resource_dirs: vec![], hooks: vec![] });
    let runtime = ReplRuntime::new(deps, RuntimeContext { data_dir: base.join("service"), session: meta.clone(), host: Arc::new(NoHost) });
    let sink = Arc::new(Sink::default());
    let message = ChatMessage::user_text("bonjour");
    let request = TurnRequest {
        turn_id: "t1".into(),
        session: meta,
        history: vec![message.clone()],
        input: TurnInput::User { message },
        peer_messages: vec![],
    };
    match runtime.run_turn(request, sink.clone()).await {
        Ok(outcome) => assert_eq!(outcome.final_text, "ok"),
        Err(err) if err.to_string().contains("kernel") => eprintln!("turn skipped: {err}"),
        Err(err) => panic!("{err}"),
    }
    runtime.shutdown().await;
    assert_eq!(hidden(&dir), Vec::<String>::new(), "dossier caché créé dans le projet");
    let _ = std::fs::remove_dir_all(&base);
}
