//! bascule — bout à bout : le fournisseur de la session tombe, le tour se
//! finit chez le fournisseur de secours désigné (vrai noyau Python ; test
//! sauté quand aucun Python avec IPython n'est trouvé).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::stream;
use serde_json::{json, Value};
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplRuntime};
use axecode_core::{
    AppError, ChatMessage, CreateSessionRequest, EntryId, JournalEntryKind, ModelCapabilities,
    ModelRef, PartKind, Provider, ProviderRequest, ProviderStream, Result as CoreResult,
    RuntimeContext, SessionHost, SessionMeta, SessionResult, SessionRuntime, SessionStatus, StopReason,
    StreamEvent, TokenEstimate, ToolCallIntro, TurnInput, TurnRequest, TurnSink, Usage,
};

/// Provider en panne durable (HTTP 503 à chaque appel).
struct Down {
    calls: Mutex<usize>,
}

/// Secours : appelle python une fois, puis répond.
struct Backup {
    calls: Mutex<Vec<String>>,
}

fn caps(model: &ModelRef) -> ModelCapabilities {
    ModelCapabilities {
        model: model.clone(),
        context_window: 200_000,
        preferred_window: 180_000,
        max_output_tokens: 4_000,
        supports_thinking: false,
        visible_thinking: false,
        supports_tools: true,
        supports_images: false,
        effort_mode: axecode_core::EffortMode::None,
    }
}

#[async_trait]
impl Provider for Down {
    fn name(&self) -> &str {
        "down"
    }
    fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities> {
        Some(caps(model))
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> CoreResult<TokenEstimate> {
        Ok(TokenEstimate { input_tokens: 0, exact: false })
    }
    async fn stream(&self, _request: ProviderRequest) -> CoreResult<ProviderStream> {
        *self.calls.lock().unwrap() += 1;
        Err(AppError::Provider("HTTP 503 Service Unavailable: overloaded".into()))
    }
}

#[async_trait]
impl Provider for Backup {
    fn name(&self) -> &str {
        "backup"
    }
    fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities> {
        Some(caps(model))
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> CoreResult<TokenEstimate> {
        Ok(TokenEstimate { input_tokens: 0, exact: false })
    }
    async fn stream(&self, request: ProviderRequest) -> CoreResult<ProviderStream> {
        let n = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(request.model.provider.clone());
            calls.len()
        };
        let stop = StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage: Usage::default() };
        let events = if n == 1 {
            vec![
                StreamEvent::PartStart {
                    index: 0,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro { id: "c1".into(), name: "python".into() }),
                },
                StreamEvent::ToolJsonDelta { index: 0, chunk: json!({"code": "print(6 * 7)"}).to_string() },
                StreamEvent::PartStop { index: 0 },
                stop,
            ]
        } else {
            vec![
                StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
                StreamEvent::TextDelta { index: 0, delta: "fini sur le secours : 42".into() },
                StreamEvent::PartStop { index: 0 },
                stop,
            ]
        };
        Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver {
    down: Arc<Down>,
    backup: Arc<Backup>,
}

impl ProviderResolver for Resolver {
    fn provider(&self, id: &str) -> Result<Arc<dyn Provider>, String> {
        match id {
            "anthropic" => Ok(self.down.clone()),
            "anthropic~2" => Ok(self.backup.clone()),
            _ => Err(format!("provider `{id}` is not configured")),
        }
    }
}

#[derive(Default)]
struct Sink {
    entries: Mutex<Vec<JournalEntryKind>>,
    events: Mutex<Vec<Value>>,
}

#[async_trait]
impl TurnSink for Sink {
    async fn record(&self, kind: JournalEntryKind) -> SessionResult<EntryId> {
        self.entries.lock().unwrap().push(kind);
        Ok(uuid::Uuid::new_v4().to_string())
    }
    async fn emit(&self, event: Value) {
        self.events.lock().unwrap().push(event);
    }
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

struct Run {
    final_text: String,
    down_calls: usize,
    backup_calls: Vec<String>,
    sink: Arc<Sink>,
}

/// Un tour sur `anthropic/claude-opus-5-5` ; `bascule` = contenu de
/// `repl-settings.json` (None : pas de fichier). None si pas de noyau.
async fn turn(bascule: Option<Value>) -> Option<Run> {
    axecode_repl::python::find_python(&[])?;
    let dir = std::env::temp_dir().join(format!("axecode-bascule-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    if let Some(settings) = bascule {
        std::fs::write(dir.join("repl-settings.json"), serde_json::to_vec(&settings).unwrap()).unwrap();
    }
    let meta = SessionMeta {
        id: "s1".into(),
        parent_id: None,
        name: "t".into(),
        workspace_id: dir.display().to_string(),
        model: ModelRef::new("anthropic", "claude-opus-5-5"),
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
    let down = Arc::new(Down { calls: Mutex::new(0) });
    let backup = Arc::new(Backup { calls: Mutex::new(Vec::new()) });
    let resolver = Resolver { down: down.clone(), backup: backup.clone() };
    let deps = Arc::new(ReplDeps { providers: Arc::new(resolver), resource_dirs: vec![], hooks: vec![] });
    let runtime = ReplRuntime::new(deps, RuntimeContext { data_dir: dir.clone(), session: meta.clone(), host: Arc::new(NoHost) });
    let sink = Arc::new(Sink::default());
    let message = ChatMessage::user_text("calcule");
    let request = TurnRequest {
        turn_id: "t1".into(),
        session: meta,
        history: vec![message.clone()],
        input: TurnInput::User { message },
        peer_messages: vec![],
    };
    let outcome = match runtime.run_turn(request, sink.clone()).await {
        Ok(outcome) => outcome,
        Err(err) if err.to_string().contains("kernel") || err.to_string().contains("Python") => {
            eprintln!("skipping: {err}");
            return None;
        }
        Err(err) => panic!("{err}"),
    };
    runtime.shutdown().await;
    let down_calls = *down.calls.lock().unwrap();
    let backup_calls = backup.calls.lock().unwrap().clone();
    let _ = std::fs::remove_dir_all(&dir);
    Some(Run { final_text: outcome.final_text, down_calls, backup_calls, sink })
}

#[tokio::test(flavor = "multi_thread")]
async fn panne_du_premier_fournisseur_le_tour_finit_sur_le_second() {
    let settings = json!({"bascule": {"enabled": true, "secours": {"anthropic": ["anthropic~2"]}}});
    let Some(run) = turn(Some(settings)).await else { return };
    assert_eq!(run.final_text, "fini sur le secours : 42");
    // Une seule bascule : le 2e appel du tour part directement chez le secours.
    assert_eq!(run.down_calls, 1, "HTTP 5xx : pas de nouvel essai, bascule tout de suite");
    assert_eq!(run.backup_calls, ["anthropic~2", "anthropic~2"]);
    let events = run.sink.events.lock().unwrap().clone();
    let avis: Vec<&Value> = events.iter().filter(|e| e["type"] == "provider_failover").collect();
    assert_eq!(avis.len(), 1, "{events:?}");
    assert_eq!((avis[0]["from"].as_str(), avis[0]["to"].as_str()), (Some("anthropic"), Some("anthropic~2")));
    let entries = run.sink.entries.lock().unwrap();
    assert!(entries.iter().any(|e| matches!(e, JournalEntryKind::Extension { name, .. } if name == "bascule_fournisseur")));
    assert!(entries.iter().any(|e| matches!(e, JournalEntryKind::ReplResult { output, .. } if output.contains("42"))));
    // L'avis est relu à la réouverture : meta.bascule sur la première réponse du secours.
    let marked = entries.iter().filter(|e| matches!(e, JournalEntryKind::Message { message, .. }
        if format!("{:?}", message.parts.first()).contains("bascule"))).count();
    assert_eq!(marked, 1);
    assert!(!entries.iter().any(|e| matches!(e, JournalEntryKind::Extension { name, .. } if name == "turn_error")));
}

#[tokio::test(flavor = "multi_thread")]
async fn bascule_eteinte_le_tour_echoue_comme_avant() {
    // Secours désigné mais bascule éteinte, puis aucun réglage du tout.
    let off = json!({"bascule": {"enabled": false, "secours": {"anthropic": ["anthropic~2"]}}});
    for settings in [Some(off), None] {
        let Some(run) = turn(settings).await else { return };
        assert!(run.final_text.contains("503"), "{}", run.final_text);
        assert_eq!(run.down_calls, 1);
        assert!(run.backup_calls.is_empty(), "jamais de bascule non désignée");
        assert!(!run.sink.events.lock().unwrap().iter().any(|e| e["type"] == "provider_failover"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn secours_designe_pour_un_autre_fournisseur_ne_sert_pas() {
    let settings = json!({"bascule": {"enabled": true, "secours": {"openai": ["anthropic~2"]}}});
    let Some(run) = turn(Some(settings)).await else { return };
    assert!(run.final_text.contains("503"));
    assert!(run.backup_calls.is_empty());
}
