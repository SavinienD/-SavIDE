//! rlm186 — `rlm.query` et `rlm.query_lot` de bout en bout : vrai noyau Python,
//! fournisseur scripté (aucun appel réseau). Ignoré sans Python avec IPython
//! (voir AXECODE_PYTHON).

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

/// Le tour de la session (avec l'outil python) et les appels uniques (sans outil).
#[derive(Default)]
struct Scripte {
    tours: Mutex<usize>,
    appels_uniques: Mutex<Vec<(Option<String>, String, Option<u32>)>>,
}

fn texte(events: Vec<StreamEvent>) -> CoreResult<ProviderStream> {
    Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
}

fn reponse(t: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
        StreamEvent::TextDelta { index: 0, delta: t.into() },
        StreamEvent::PartStop { index: 0 },
        StreamEvent::MessageStop {
            stop_reason: StopReason::EndTurn,
            usage: Usage { input_tokens: 7, output_tokens: 1, ..Default::default() },
        },
    ]
}

#[async_trait]
impl Provider for Scripte {
    fn name(&self) -> &str {
        "scripte"
    }
    fn capabilities(&self, _model: &ModelRef) -> Option<ModelCapabilities> {
        None
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> CoreResult<TokenEstimate> {
        Ok(TokenEstimate { input_tokens: 0, exact: false })
    }
    async fn stream(&self, request: ProviderRequest) -> CoreResult<ProviderStream> {
        if request.tools.is_empty() {
            // Appel unique : un seul message, aucun outil, pas de prompt de session.
            assert_eq!(request.transcript.len(), 1);
            let question = request.transcript[0].text();
            self.appels_uniques.lock().unwrap().push((
                request.system_prompt.clone(),
                question.clone(),
                request.max_output_tokens,
            ));
            return texte(reponse(&match question.as_str() {
                "Combien font 2+2 ?" => "4".to_string(),
                autre => autre.to_uppercase(),
            }));
        }
        let n = {
            let mut tours = self.tours.lock().unwrap();
            *tours += 1;
            *tours
        };
        if n == 1 {
            let code = "r = rlm.query('Combien font 2+2 ?', systeme='Chiffre seul.')\nl = rlm.query_lot(['a', 'b', 'c'], parallele=2)\nprint('RES', r, l, l.erreurs)";
            return texte(vec![
                StreamEvent::PartStart {
                    index: 0,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro { id: "c1".into(), name: "python".into() }),
                },
                StreamEvent::ToolJsonDelta { index: 0, chunk: json!({ "code": code }).to_string() },
                StreamEvent::PartStop { index: 0 },
                StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage: Usage::default() },
            ]);
        }
        texte(reponse("fini"))
    }
}

struct Resolver(Arc<Scripte>);
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
async fn query_et_query_lot_depuis_le_noyau() {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("ignoré : pas de Python");
        return;
    }
    let dir = std::env::temp_dir().join(format!("axecode-rlm-appel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let meta = SessionMeta {
        id: "s1".into(),
        parent_id: None,
        name: "t".into(),
        workspace_id: dir.display().to_string(),
        model: ModelRef::new("scripte", "m"),
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
    let fournisseur = Arc::new(Scripte::default());
    let deps = Arc::new(ReplDeps { providers: Arc::new(Resolver(fournisseur.clone())), resource_dirs: vec![], hooks: vec![] });
    let runtime = ReplRuntime::new(deps, RuntimeContext { data_dir: dir.clone(), session: meta.clone(), host: Arc::new(NoHost) });
    let sink = Arc::new(Sink::default());
    let message = ChatMessage::user_text("lis le document");
    let request = TurnRequest {
        turn_id: "t1".into(),
        session: meta,
        history: vec![message.clone()],
        input: TurnInput::User { message },
        peer_messages: vec![],
    };
    let outcome = runtime.run_turn(request, sink.clone()).await.expect("tour");
    assert_eq!(outcome.final_text, "fini");
    let sortie = sink
        .entries
        .lock()
        .unwrap()
        .iter()
        .find_map(|e| match e {
            JournalEntryKind::ReplResult { output, .. } => Some(output.clone()),
            _ => None,
        })
        .expect("résultat python");
    assert!(sortie.contains("RES 4 ['A', 'B', 'C'] []"), "{sortie}");
    let appels = fournisseur.appels_uniques.lock().unwrap().clone();
    assert_eq!(appels.len(), 4, "{appels:?}");
    assert_eq!(appels[0], (Some("Chiffre seul.".into()), "Combien font 2+2 ?".into(), Some(4_000)));
    assert!(appels[1..].iter().all(|(s, _, p)| s.is_none() && *p == Some(4_000)), "{appels:?}");
    runtime.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}
