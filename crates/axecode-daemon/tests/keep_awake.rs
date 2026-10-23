//! axe:eveil — a real turn (fake runtime) asks the keep-awake to hold while
//! it runs and to release once the session is idle again (21/10/2026: the
//! hold was never re-applied after a modern standby; the sink is injected
//! here to see the requests the daemon actually sends).

use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use axecode_core::{
    ChatMessage, CreateSessionRequest, JournalEntryKind, ModelRef, RuntimeContext, SessionResult,
    SessionRuntime, SessionRuntimeFactory, SessionStatus, TurnOutcome, TurnRequest, TurnSink,
};
use axecode_daemon::{
    keep_awake::{Awake, KeepAwake},
    Daemon, DaemonConfig,
};

#[derive(Default)]
struct Gate {
    turns: AtomicUsize,
    open: AtomicBool,
}

/// The turn waits for the gate, then replies.
struct Rt(Arc<Gate>);

#[async_trait]
impl SessionRuntime for Rt {
    async fn run_turn(
        &self,
        _request: TurnRequest,
        sink: Arc<dyn TurnSink>,
    ) -> SessionResult<TurnOutcome> {
        self.0.turns.fetch_add(1, Ordering::SeqCst);
        while !self.0.open.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        sink.record(JournalEntryKind::Message {
            message: ChatMessage::assistant_text("done"),
            usage: None,
            turn_id: None,
        })
        .await?;
        Ok(TurnOutcome::default())
    }

    async fn shutdown(&self) {}
}

struct F(Arc<Gate>);

#[async_trait]
impl SessionRuntimeFactory for F {
    async fn create(&self, _c: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(Arc::new(Rt(self.0.clone())))
    }
}

async fn wait_until(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{what} not reached"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_holds_then_releases() {
    let dir = std::env::temp_dir().join(format!("keep-awake-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = DaemonConfig::new(dir.clone());
    config.auto_shutdown = false;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = seen.clone();
    let keep_awake = KeepAwake::with_sink(Box::new(move |request| {
        recorder.lock().unwrap().push(request);
    }));
    let gate = Arc::new(Gate::default());
    let d = Daemon::with_keep_awake(config, Arc::new(F(gate.clone())), keep_awake);

    let id = d
        .create(CreateSessionRequest {
            name: "t".into(),
            workspace_id: "ws".into(),
            model: ModelRef::new("x", "y"),
            parent_id: None,
            system_prompt_extra: None,
            initial_message: None,
        })
        .unwrap()
        .id;
    assert!(
        seen.lock().unwrap().is_empty(),
        "nothing asked before a turn"
    );

    d.send_user(&id, ChatMessage::user_text("hello")).unwrap();
    wait_until("turn started", || gate.turns.load(Ordering::SeqCst) == 1).await;
    assert_eq!(d.meta(&id).unwrap().status, SessionStatus::Running);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Awake::Hold],
        "held during the turn"
    );

    gate.open.store(true, Ordering::SeqCst);
    wait_until("session idle", || {
        d.meta(&id).unwrap().status == SessionStatus::Idle
    })
    .await;
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Awake::Hold, Awake::Release],
        "released once idle"
    );
    let journal = d.journal(&id).unwrap();
    let text = serde_json::to_string(journal.lock().unwrap().entries()).unwrap();
    assert!(text.contains("done"), "the turn ran to the end");
    let _ = std::fs::remove_dir_all(dir);
}
