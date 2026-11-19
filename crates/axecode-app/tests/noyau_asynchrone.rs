//! axe:uh-d2 — noyau asynchrone (réglage `kernelAsync`) avec le vrai démon,
//! le vrai noyau et le crochet des commandes : une commande lancée par
//! `shell.start` réveille la session à sa fin, comme `guet.commande`.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplFactory};
use axecode_app::session_commands::SessionCommandsHook;
use axecode_core::{
    ChatMessage, CreateSessionRequest, JournalEntryKind, ModelRef, PartKind, Provider,
    ProviderRequest, ProviderStream, StopReason, StreamEvent, TokenEstimate, ToolCallIntro, Usage,
};
use axecode_daemon::{Daemon, DaemonConfig};

enum Pas {
    Code(&'static str),
    Texte(&'static str),
}

#[derive(Default)]
struct Script {
    pas: Mutex<VecDeque<Pas>>,
    n: Mutex<usize>,
}

#[async_trait]
impl Provider for Script {
    fn name(&self) -> &str {
        "fake"
    }
    fn capabilities(&self, _m: &ModelRef) -> Option<axecode_core::ModelCapabilities> {
        None
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> axecode_core::Result<TokenEstimate> {
        Ok(TokenEstimate { input_tokens: 10, exact: false })
    }
    async fn stream(&self, _request: ProviderRequest) -> axecode_core::Result<ProviderStream> {
        let n = {
            let mut n = self.n.lock().unwrap();
            *n += 1;
            *n
        };
        let pas = self.pas.lock().unwrap().pop_front().unwrap_or(Pas::Texte("rien"));
        let usage = Usage { input_tokens: 10, output_tokens: 5, ..Default::default() };
        let events = match pas {
            Pas::Texte(t) => vec![
                StreamEvent::MessageStart { model: "fake".into() },
                StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
                StreamEvent::TextDelta { index: 0, delta: t.to_string() },
                StreamEvent::PartStop { index: 0 },
                StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage },
            ],
            Pas::Code(code) => vec![
                StreamEvent::MessageStart { model: "fake".into() },
                StreamEvent::PartStart {
                    index: 0,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro { id: format!("c{n}"), name: "python".into() }),
                },
                StreamEvent::ToolJsonDelta { index: 0, chunk: serde_json::json!({ "code": code }).to_string() },
                StreamEvent::PartStop { index: 0 },
                StreamEvent::MessageStop { stop_reason: StopReason::ToolUse, usage },
            ],
        };
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver(Arc<Script>);
impl ProviderResolver for Resolver {
    fn provider(&self, _id: &str) -> Result<Arc<dyn Provider>, String> {
        Ok(self.0.clone())
    }
}

struct Banc {
    daemon: Arc<Daemon>,
    id: String,
    base: std::path::PathBuf,
}
impl Drop for Banc {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.base).ok();
    }
}

fn banc(pas: Vec<Pas>) -> Option<Banc> {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping: no Python with IPython");
        return None;
    }
    let base = std::env::temp_dir().join(format!("axecode-async-{}", uuid::Uuid::new_v4()));
    let ws = base.join("ws");
    let data = base.join("data");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    // Le réglage, comme l'écrirait l'IDE.
    std::fs::write(data.join("repl-settings.json"), r#"{"kernelAsync": true}"#).unwrap();
    let ia = Arc::new(Script { pas: Mutex::new(pas.into()), ..Default::default() });
    let resolver: Arc<dyn ProviderResolver> = Arc::new(Resolver(ia));
    let hook = SessionCommandsHook::new(resolver.clone());
    let deps = Arc::new(ReplDeps { providers: resolver, resource_dirs: vec![], hooks: vec![hook] });
    let mut config = DaemonConfig::new(data);
    config.auto_shutdown = false;
    let daemon = Daemon::new(config, Arc::new(ReplFactory { deps }));
    let id = daemon
        .create(CreateSessionRequest {
            name: "t".into(),
            workspace_id: ws.display().to_string(),
            model: ModelRef::new("fake", "m"),
            parent_id: None,
            system_prompt_extra: None,
            initial_message: None,
        })
        .unwrap()
        .id;
    Some(Banc { daemon, id, base })
}

impl Banc {
    fn entrees(&self) -> Vec<JournalEntryKind> {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        j.entries().iter().map(|e| e.kind.clone()).collect()
    }
    fn messages_utilisateur(&self) -> Vec<String> {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        j.history()
            .iter()
            .filter(|m| m.role == axecode_core::Role::User)
            .map(|m| m.text())
            .collect()
    }
    fn sorties(&self) -> Vec<String> {
        self.entrees()
            .into_iter()
            .filter_map(|k| match k {
                JournalEntryKind::ReplResult { output, .. } => Some(output),
                _ => None,
            })
            .collect()
    }
    async fn attendre(&self, quoi: &str, ok: impl Fn(&Banc) -> bool) {
        for _ in 0..400 {
            if ok(self) && self.daemon.list_metas().iter().all(|m| m.status != axecode_core::SessionStatus::Running) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("{quoi} : {:?}", self.entrees());
    }
}

/// La fin d'une commande de fond (`shell.start`) réveille la session par un
/// message `<guet …>` ; une tâche asyncio lancée au tour 1 tourne encore au tour 2.
#[tokio::test(flavor = "multi_thread")]
async fn commande_de_fond_reveille_la_session() {
    let Some(b) = banc(vec![
        Pas::Code(
            "import asyncio\ntics = []\nasync def tic():\n    while True:\n        tics.append(1)\n        await asyncio.sleep(0.05)\ntache = asyncio.create_task(tic())\nh = shell.start('sleep 1; echo fini-fond; exit 4')\nprint(type(h).__name__)",
        ),
        Pas::Texte("T1 fini"),
        // Tour lancé par le réveil.
        Pas::Code("print(len(tics) > 5, tache.done(), h.poll()['exit_code'])"),
        Pas::Texte("réveil vu"),
    ]) else {
        return;
    };
    b.daemon.send_user(&b.id, ChatMessage::user_text("lance")).unwrap();
    b.attendre("le réveil n'arrive pas", |b| b.messages_utilisateur().iter().any(|m| m.contains("<guet "))
        && b.sorties().len() >= 2)
        .await;
    let sorties = b.sorties();
    assert!(sorties[0].contains("Commande"), "{sorties:?}");
    let reveil = b.messages_utilisateur().into_iter().find(|m| m.contains("<guet ")).unwrap();
    assert!(reveil.contains("statut=\"termine\""), "{reveil}");
    assert!(reveil.contains("Commande de fond `sleep 1; echo fini-fond; exit 4` (shell.start) : terminée"), "{reveil}");
    assert!(reveil.contains("(code de sortie 4)") && reveil.contains("fini-fond"), "{reveil}");
    assert!(sorties[1].contains("True False 4"), "{sorties:?}");
}
