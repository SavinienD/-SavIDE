//! Commandes slash de session (/goal, /heartbeat, /autonomous, /compact) servies
//! par le vrai démon avec le crochet `SessionCommandsHook` : chaque commande proposée
//! dans l'autocomplétion de l'IDE doit agir sur l'état de la session.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplFactory};
use axecode_app::session_commands::SessionCommandsHook;
use axecode_core::{
    ChatMessage, CreateSessionRequest, ModelRef, PartKind, Provider,
    ProviderRequest, ProviderStream, StopReason, StreamEvent, TokenEstimate, Usage,
};
use axecode_daemon::{Daemon, DaemonConfig};

struct Echo {
    /// Texte du dernier prompt système vu (pour vérifier les rappels).
    systems: Mutex<VecDeque<String>>,
}

#[async_trait]
impl Provider for Echo {
    fn name(&self) -> &str {
        "fake"
    }
    fn capabilities(&self, _m: &ModelRef) -> Option<axecode_core::ModelCapabilities> {
        None
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> axecode_core::Result<TokenEstimate> {
        Ok(TokenEstimate { input_tokens: 10, exact: false })
    }
    async fn stream(&self, request: ProviderRequest) -> axecode_core::Result<ProviderStream> {
        self.systems.lock().unwrap().push_back(
            request.system_prompt.clone().unwrap_or_default()
                + &serde_json::to_string(&request.transcript).unwrap_or_default(),
        );
        let usage = Usage { input_tokens: 10, output_tokens: 5, ..Default::default() };
        let events = vec![
            StreamEvent::MessageStart { model: "fake".into() },
            StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
            StreamEvent::TextDelta { index: 0, delta: "ok".into() },
            StreamEvent::PartStop { index: 0 },
            StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage },
        ];
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver(Arc<Echo>);
impl ProviderResolver for Resolver {
    fn provider(&self, _id: &str) -> Result<Arc<dyn Provider>, String> {
        Ok(self.0.clone())
    }
}

struct Banc {
    daemon: Arc<Daemon>,
    hook: Arc<SessionCommandsHook>,
    provider: Arc<Echo>,
    id: String,
    base: std::path::PathBuf,
}

impl Drop for Banc {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.base).ok();
    }
}

fn banc() -> Option<Banc> {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping: no Python with IPython");
        return None;
    }
    let base = std::env::temp_dir().join(format!("axecode-slash-{}", uuid::Uuid::new_v4()));
    let ws = base.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let provider = Arc::new(Echo { systems: Mutex::new(VecDeque::new()) });
    let resolver: Arc<dyn ProviderResolver> = Arc::new(Resolver(provider.clone()));
    let hook = SessionCommandsHook::new(resolver.clone());
    let deps = Arc::new(ReplDeps { providers: resolver, resource_dirs: vec![], hooks: vec![hook.clone()] });
    let mut config = DaemonConfig::new(base.join("data"));
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
    Some(Banc { daemon, hook, provider, id, base })
}

impl Banc {
    fn idle(&self) -> bool {
        self.daemon.list_metas().iter().all(|m| m.status != axecode_core::SessionStatus::Running)
    }
    async fn send(&self, text: &str) {
        let before = self.provider.systems.lock().unwrap().len();
        self.daemon.send_user(&self.id, ChatMessage::user_text(text)).unwrap();
        for _ in 0..600 {
            if self.provider.systems.lock().unwrap().len() > before && self.idle() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let j = self.daemon.journal(&self.id).unwrap();
        let dump = serde_json::to_string(j.lock().unwrap().entries()).unwrap();
        panic!("le tour `{text}` ne s'est pas terminé : {}", &dump[dump.len().saturating_sub(3000)..]);
    }
    fn last_prompt(&self) -> String {
        self.provider.systems.lock().unwrap().back().cloned().unwrap_or_default()
    }
    fn journal_has(&self, needle: &str) -> bool {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        serde_json::to_string(j.entries()).unwrap().contains(needle)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn heartbeat_et_goal_par_commande_slash() {
    let Some(b) = banc() else { return };

    b.send("/heartbeat 1m coucou").await;
    let hb = b.hook.state(&b.id).heartbeat.expect("/heartbeat 1m coucou doit poser un heartbeat");
    assert_eq!(hb.interval_ms, 60_000);
    assert_eq!(hb.message, "coucou");
    assert!(b.last_prompt().contains("installed a heartbeat"), "le modèle doit être prévenu");

    b.send("/heartbeat off").await;
    assert!(b.hook.state(&b.id).heartbeat.is_none(), "/heartbeat off doit l'arrêter");

    b.send("/goal finir le lot 3").await;
    let g = b.hook.state(&b.id).goal.expect("goal posé");
    assert_eq!((g.text.as_str(), g.status.as_str()), ("finir le lot 3", "active"));

    b.send("/goal pause").await;
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "paused");
    b.send("/goal resume").await;
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "active");
    b.send("/goal done").await;
    let g = b.hook.state(&b.id).goal.expect("/goal done garde l'objectif");
    assert_eq!((g.text.as_str(), g.status.as_str()), ("finir le lot 3", "complete"));
    b.send("/goal clear").await;
    assert!(b.hook.state(&b.id).goal.is_none(), "/goal clear doit l'effacer");

    b.send("/autonomous --max-turns 1 relis").await;
    b.send("/autonomous stop").await;
    let a = b.hook.state(&b.id).autonomous.expect("autonomous");
    assert_eq!(a.status, "stopped");

    b.send("/compact garder les décisions").await;
    assert!(b.last_prompt().contains("compact.run"), "/compact doit demander compact.run");
}

/// Le heartbeat se déclenche (intervalle minimal 5 s) et son message est journalisé
/// comme message utilisateur balisé `<heartbeat>` (affiché par l'IDE en « réveil »).
#[tokio::test(flavor = "multi_thread")]
async fn heartbeat_se_declenche() {
    let Some(b) = banc() else { return };
    b.send("/heartbeat 5s coucou").await;
    for _ in 0..300 {
        if b.journal_has("\\ncoucou\\n</heartbeat>") && b.idle() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(b.journal_has("\\ncoucou\\n</heartbeat>"), "le réveil doit arriver dans le journal");
}

/// L'IDE arrête le heartbeat et met le goal en pause par `sessions.commands_set` :
/// le crochet le voit tout de suite (plus de réveil).
#[tokio::test(flavor = "multi_thread")]
async fn l_ide_arrete_heartbeat_et_goal() {
    let Some(b) = banc() else { return };
    b.send("/goal finir le lot 3").await;
    b.send("/heartbeat 5s coucou").await;
    let vue = b.daemon.dispatch(0, "sessions.commands_state", serde_json::json!({"sessionId": b.id})).await.unwrap();
    assert_eq!(vue["heartbeat"]["message"], "coucou");
    assert_eq!(vue["goal"]["status"], "active");
    b.daemon.dispatch(0, "sessions.commands_set", serde_json::json!({"sessionId": b.id, "op": "heartbeat_off"})).await.unwrap();
    let vue = b.daemon.dispatch(0, "sessions.commands_set", serde_json::json!({"sessionId": b.id, "op": "goal_pause"})).await.unwrap();
    assert!(vue["heartbeat"].is_null());
    assert_eq!(vue["goal"]["status"], "paused");
    assert!(b.hook.state(&b.id).heartbeat.is_none(), "le crochet relit l'état");
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "paused");
    tokio::time::sleep(Duration::from_millis(6_500)).await;
    assert!(!b.journal_has("\ncoucou\n</heartbeat>"), "plus aucun réveil après l'arrêt");
}
