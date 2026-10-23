//! End-to-end test of the REPL loop with a scripted provider and a real
//! kernel (skipped when no Python with IPython is available).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::stream;
use serde_json::{json, Value};
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplRuntime};
use axecode_core::{
    ChatMessage, CreateSessionRequest, EntryId, JournalEntryKind, ModelCapabilities, ModelRef,
    PartKind, Provider, ProviderRequest, ProviderStream, Result as CoreResult, RuntimeContext,
    SessionHost, SessionMeta, SessionResult, SessionRuntime, SessionStatus, StopReason,
    StreamEvent, TokenEstimate, ToolCallIntro, TurnInput, TurnRequest, TurnSink, Usage,
};

struct Scripted {
    calls: Mutex<usize>,
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
        let n = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        let stop = StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage: Usage::default() };
        let events = if n == 1 {
            assert!(request.system_prompt.unwrap().contains("python"));
            vec![
                StreamEvent::PartStart {
                    index: 0,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro { id: "c1".into(), name: "python".into() }),
                },
                StreamEvent::ToolJsonDelta { index: 0, chunk: json!({"code": "y = 6 * 7\nprint(y)"}).to_string() },
                StreamEvent::PartStop { index: 0 },
                stop,
            ]
        } else {
            let last = request.transcript.last().unwrap();
            assert!(format!("{last:?}").contains("42"), "{last:?}");
            vec![
                StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
                StreamEvent::TextDelta { index: 0, delta: "done: 42".into() },
                StreamEvent::PartStop { index: 0 },
                stop,
            ]
        };
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
async fn python_tool_roundtrip() {
    if axecode_repl::python::find_python(&[]).is_none() {
        return;
    }
    let dir = std::env::temp_dir().join(format!("axecode-repl-loop-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
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
    let provider = Arc::new(Scripted { calls: Mutex::new(0) });
    let deps = Arc::new(ReplDeps { providers: Arc::new(Resolver(provider)), resource_dirs: vec![], hooks: vec![] });
    let runtime = ReplRuntime::new(deps, RuntimeContext { data_dir: dir.clone(), session: meta.clone(), host: Arc::new(NoHost) });
    let sink = Arc::new(Sink::default());
    let message = ChatMessage::user_text("compute");
    let request = TurnRequest {
        turn_id: "t1".into(),
        session: meta,
        history: vec![message.clone()],
        input: TurnInput::User { message },
        peer_messages: vec![],
    };
    let outcome = match runtime.run_turn(request, sink.clone()).await {
        Ok(outcome) => outcome,
        Err(err) if err.to_string().contains("kernel") => {
            eprintln!("skipping: {err}");
            return;
        }
        Err(err) => panic!("{err}"),
    };
    assert_eq!(outcome.final_text, "done: 42");
    let entries = sink.entries.lock().unwrap();
    assert!(entries.iter().any(|e| matches!(e, JournalEntryKind::ReplResult { output, .. } if output.contains("42"))));
    // Snapshot through the SessionRuntime trait.
    let snapshot = SessionRuntime::kernel(runtime.as_ref()).unwrap();
    assert!(!snapshot.save().await.unwrap().is_empty());
    runtime.shutdown().await;
}
