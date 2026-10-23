//! axe:shared-brain — preuve que les globales de l'espace Axe Cloud (miroir
//! `cloud_mirror`, commit eab706e) arrivent dans la requête envoyée au modèle
//! par un tour REPL : ReplRuntime::run_turn -> repl::turn (reminders) ->
//! refine::harness_layer -> cloud_mirror::merge_into.
//! Binaire de test à part : HOME y est redirigé vers un dossier temporaire.

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
async fn cloud_mirror_globals_reach_the_model_request() {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping: no python");
        return;
    }
    let base = std::env::temp_dir().join(format!("axecode-mirror-turn-{}", uuid::Uuid::new_v4()));
    let home = base.join("home");
    let dir = base.join("ws");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    // Seul test de ce binaire : redirige le global (~/.axecode) vers le dossier temporaire.
    // IPython peut vivre dans ~/.local (pip --user) : on garde ce site-packages.
    if let Some(real) = std::env::var_os("HOME") {
        if std::env::var_os("PYTHONUSERBASE").is_none() {
            std::env::set_var("PYTHONUSERBASE", std::path::Path::new(&real).join(".local"));
        }
    }
    std::env::set_var("HOME", &home);

    // Miroir de l'espace : une mémoire globale qui n'existe PAS dans le harnais local.
    let paths = axecode_harness::HarnessPaths::for_workspace(&dir);
    assert!(paths.root(axecode_harness::Scope::Global).starts_with(&home));
    let store = axecode_harness::HarnessStore::new(paths.clone());
    let mut remote = store
        .create(
            axecode_harness::Scope::Global,
            axecode_harness::EntryKind::Memory,
            axecode_harness::NewEntry {
                title: "tmp".into(),
                body: "tmp".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store.delete(&remote.meta.id).unwrap();
    remote.meta.id = "mem_espace_cloud".into();
    remote.meta.title = "Regle-partagee-espace-XYZ".into();
    remote.body = "Corps-venu-du-cloud-XYZ".into();
    axecode_harness::cloud_mirror::write(&paths, "axe-cloud", vec![remote]).unwrap();
    assert!(store.load_all().unwrap().iter().all(|e| e.meta.title != "Regle-partagee-espace-XYZ"));

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
    let runtime = ReplRuntime::new(deps, RuntimeContext { data_dir: base.clone(), session: meta.clone(), host: Arc::new(NoHost) });
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
        Err(err) if err.to_string().contains("kernel") => {
            eprintln!("skipping: {err}");
            return;
        }
        Err(err) => panic!("{err}"),
    }
    let seen = provider.seen.lock().unwrap().clone();
    assert!(!seen.is_empty());
    assert!(
        seen[0].contains("Regle-partagee-espace-XYZ") && seen[0].contains("Corps-venu-du-cloud-XYZ"),
        "la globale du miroir cloud n'est pas dans la requete du modele"
    );
    runtime.shutdown().await;
    let _ = std::fs::remove_dir_all(&base);
}
