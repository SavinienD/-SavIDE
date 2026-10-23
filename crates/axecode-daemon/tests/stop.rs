//! Stop and the end-of-turn snapshot never leave a session "running" for good
//! (SCRAPPING, 20/10/2026: the kernel snapshot never returned and Stop had no
//! effect).

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use serde_json::json;
use axecode_core::{
    ChatMessage, CreateSessionRequest, JournalEntryKind, KernelSnapshot, ModelRef,
    RuntimeContext, SessionError, SessionResult, SessionRuntime, SessionRuntimeFactory,
    SessionStatus, TurnInput, TurnOutcome, TurnRequest, TurnSink,
};
use axecode_daemon::{Daemon, DaemonConfig};

/// Default Stop grace period (`DaemonConfig::stop_grace`).
const GRACE: Duration = Duration::from_secs(8);

#[derive(Default)]
struct Counters {
    created: AtomicUsize,
    turns: AtomicUsize,
    shutdowns: AtomicUsize,
    aborts: AtomicUsize,
}

/// "hang": the turn never returns; "polite": the turn returns `Cancelled` as
/// soon as Stop is raised; "slow": ignores Stop for 300 ms, then replies;
/// anything else gets "reply to: <text>". With
/// `stuck_snapshot` the end-of-turn kernel snapshot never returns.
struct Rt {
    counters: Arc<Counters>,
    stuck_snapshot: bool,
}

struct StuckSnapshot;

#[async_trait]
impl KernelSnapshot for StuckSnapshot {
    async fn save(&self) -> SessionResult<Vec<u8>> {
        std::future::pending().await
    }
    async fn restore(&self, _bytes: &[u8]) -> SessionResult<()> {
        Ok(())
    }
}

#[async_trait]
impl SessionRuntime for Rt {
    async fn run_turn(
        &self,
        request: TurnRequest,
        sink: Arc<dyn TurnSink>,
    ) -> SessionResult<TurnOutcome> {
        self.counters.turns.fetch_add(1, Ordering::SeqCst);
        let text = match &request.input {
            TurnInput::User { message } => message.text(),
            _ => String::new(),
        };
        match text.as_str() {
            "hang" => std::future::pending::<()>().await,
            "polite" => {
                while !sink.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                return Err(SessionError::Cancelled);
            }
            "slow" => tokio::time::sleep(Duration::from_millis(300)).await,
            _ => {}
        }
        sink.record(JournalEntryKind::Message {
            message: ChatMessage::assistant_text(format!("reply to: {text}")),
            usage: None,
            turn_id: None,
        })
        .await?;
        Ok(TurnOutcome::default())
    }

    fn kernel(&self) -> Option<Arc<dyn KernelSnapshot>> {
        if self.stuck_snapshot {
            Some(Arc::new(StuckSnapshot))
        } else {
            None
        }
    }

    async fn shutdown(&self) {
        self.counters.shutdowns.fetch_add(1, Ordering::SeqCst);
    }

    async fn abort(&self) {
        self.counters.aborts.fetch_add(1, Ordering::SeqCst);
    }
}

struct F {
    counters: Arc<Counters>,
    stuck_snapshot: bool,
}

#[async_trait]
impl SessionRuntimeFactory for F {
    async fn create(&self, _c: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        self.counters.created.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(Rt {
            counters: self.counters.clone(),
            stuck_snapshot: self.stuck_snapshot,
        }))
    }
}

fn daemon(
    stuck_snapshot: bool,
    configure: impl FnOnce(&mut DaemonConfig),
) -> (Arc<Daemon>, Arc<Counters>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("axecode-stop-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = DaemonConfig::new(dir.clone());
    config.auto_shutdown = false;
    configure(&mut config);
    let counters = Arc::new(Counters::default());
    let factory = F {
        counters: counters.clone(),
        stuck_snapshot,
    };
    (Daemon::new(config, Arc::new(factory)), counters, dir)
}

fn create(d: &Daemon) -> String {
    d.create(CreateSessionRequest {
        name: "t".into(),
        workspace_id: "ws".into(),
        model: ModelRef::new("x", "y"),
        parent_id: None,
        system_prompt_extra: None,
        initial_message: None,
    })
    .unwrap()
    .id
}

fn journal_text(d: &Daemon, id: &str) -> String {
    let j = d.journal(id).unwrap();
    let j = j.lock().unwrap();
    serde_json::to_string(j.entries()).unwrap()
}

async fn wait_text(d: &Daemon, id: &str, needle: &str) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        if journal_text(d, id).contains(needle) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{needle} not reached");
}

/// Waits for `status`; returns how long it took.
async fn wait_status(d: &Daemon, id: &str, status: SessionStatus, limit: Duration) -> Duration {
    let started = Instant::now();
    while started.elapsed() < limit {
        if d.meta(id).unwrap().status == status {
            return started.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "{status:?} not reached within {limit:?} (still {:?})",
        d.meta(id).unwrap().status
    );
}

async fn wait_turns(counters: &Counters, turns: usize) {
    let started = Instant::now();
    while counters.turns.load(Ordering::SeqCst) < turns {
        assert!(started.elapsed() < Duration::from_secs(5), "turn not started");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The Stop button of the app: the `sessions.stop` RPC.
async fn stop(d: &Daemon, id: &str) {
    d.dispatch(0, "sessions.stop", json!({"sessionId": id}))
        .await
        .unwrap();
}

#[test]
fn default_deadlines() {
    let config = DaemonConfig::new(std::env::temp_dir());
    assert_eq!(config.snapshot_timeout, Duration::from_secs(30));
    assert_eq!(config.stop_grace, GRACE);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_abandons_a_turn_that_never_returns() {
    let (d, counters, dir) = daemon(false, |_| {});
    let id = create(&d);
    d.send_user(&id, ChatMessage::user_text("hang")).unwrap();
    wait_turns(&counters, 1).await;
    // Sent during the turn: held, and it must survive the forced stop.
    d.send_user(&id, ChatMessage::user_text("change of plan")).unwrap();
    assert!(!journal_text(&d, &id).contains("change of plan"), "not held during the turn");
    let started = Instant::now();
    stop(&d, &id).await;
    wait_status(&d, &id, SessionStatus::Idle, GRACE + Duration::from_secs(2)).await;
    let elapsed = started.elapsed();
    assert!(elapsed >= GRACE, "turn abandoned before its grace period: {elapsed:?}");
    assert_eq!(counters.aborts.load(Ordering::SeqCst), 1, "runtime not killed");
    let text = journal_text(&d, &id);
    assert!(text.contains("turn_stopped"), "forced stop not journaled: {text}");
    assert!(text.contains("\"change of plan\""), "held message lost: {text}");
    assert!(text.contains("reply to: change of plan"), "held message not answered: {text}");

    // The session works again, with a new runtime.
    d.send_user(&id, ChatMessage::user_text("again")).unwrap();
    wait_text(&d, &id, "reply to: again").await;
    wait_status(&d, &id, SessionStatus::Idle, Duration::from_secs(5)).await;
    assert_eq!(counters.created.load(Ordering::SeqCst), 2);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_abandons_a_snapshot_that_never_returns() {
    // Default deadlines: Stop (8 s) comes before the snapshot deadline (30 s).
    let (d, counters, dir) = daemon(true, |_| {});
    let id = create(&d);
    d.send_user(&id, ChatMessage::user_text("hello")).unwrap();
    wait_text(&d, &id, "reply to: hello").await;
    // The reply is journaled; the worker now waits for the snapshot.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(d.meta(&id).unwrap().status, SessionStatus::Running);
    let started = Instant::now();
    stop(&d, &id).await;
    wait_status(&d, &id, SessionStatus::Idle, GRACE + Duration::from_secs(2)).await;
    assert!(started.elapsed() >= GRACE);
    assert_eq!(counters.aborts.load(Ordering::SeqCst), 1, "runtime not killed");
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_that_honours_stop_keeps_its_kernel() {
    let (d, counters, dir) = daemon(false, |_| {});
    let id = create(&d);
    d.send_user(&id, ChatMessage::user_text("polite")).unwrap();
    wait_status(&d, &id, SessionStatus::Running, Duration::from_secs(5)).await;
    stop(&d, &id).await;
    wait_status(&d, &id, SessionStatus::Idle, Duration::from_secs(2)).await;
    assert_eq!(counters.aborts.load(Ordering::SeqCst), 0, "kernel killed for nothing");
    assert!(!journal_text(&d, &id).contains("turn_stopped"));
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn stuck_snapshot_times_out_and_kills_the_kernel() {
    let (d, counters, dir) = daemon(true, |c| c.snapshot_timeout = Duration::from_millis(300));
    let id = create(&d);
    d.send_user(&id, ChatMessage::user_text("hello")).unwrap();
    wait_text(&d, &id, "reply to: hello").await;
    // No Stop: the snapshot deadline alone ends the turn.
    wait_status(&d, &id, SessionStatus::Idle, Duration::from_secs(5)).await;
    assert_eq!(counters.aborts.load(Ordering::SeqCst), 1, "stuck kernel not killed");

    // The next turn starts a new runtime (journal + last valid snapshot).
    d.send_user(&id, ChatMessage::user_text("again")).unwrap();
    wait_text(&d, &id, "reply to: again").await;
    wait_status(&d, &id, SessionStatus::Idle, Duration::from_secs(5)).await;
    assert_eq!(counters.created.load(Ordering::SeqCst), 2);
    std::fs::remove_dir_all(dir).ok();
}

/// "Enter twice" in the app: Stop, then the message is sent while the turn
/// still ends by itself. It is held, then journaled and answered.
#[tokio::test(flavor = "multi_thread")]
async fn a_message_held_when_stop_comes_is_journaled_and_answered() {
    let (d, counters, dir) = daemon(false, |_| {});
    let id = create(&d);
    d.send_user(&id, ChatMessage::user_text("slow")).unwrap();
    wait_turns(&counters, 1).await;
    stop(&d, &id).await;
    d.send_user(&id, ChatMessage::user_text("later")).unwrap();
    assert!(!journal_text(&d, &id).contains("later"), "not held during the turn");
    wait_text(&d, &id, "reply to: later").await;
    wait_status(&d, &id, SessionStatus::Idle, Duration::from_secs(5)).await;
    assert_eq!(counters.aborts.load(Ordering::SeqCst), 0, "kernel killed for nothing");
    std::fs::remove_dir_all(dir).ok();
}

/// The cloud path: the app stops a turn of the VM daemon through its
/// WebSocket listener (`cancel_repl_turn` -> `sessions.stop`), as in the app.
#[tokio::test(flavor = "multi_thread")]
async fn stop_over_the_websocket_listener() {
    use axecode_daemon::{auth::AuthStore, client::DaemonClient, listen::ListenConfig, server};

    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut token = String::new();
    let (d, counters, dir) = daemon(false, |c| {
        std::fs::create_dir_all(&c.data_dir).unwrap();
        let mut store = AuthStore::default();
        store.set_password("alice", "secret-pass").unwrap();
        let (_, created) = store.create_token("test");
        store.save(&c.data_dir).unwrap();
        token = created.to_string();
        c.listen = Some(ListenConfig::parse(&format!("127.0.0.1:{port}"), vec![]).unwrap());
    });
    let handle = tokio::spawn(server::run(d.clone()));
    tokio::time::sleep(Duration::from_millis(200)).await;

    let url = format!("ws://127.0.0.1:{port}/ws");
    let client = DaemonClient::connect_ws(&url, Some(&format!("Bearer {token}")), None)
        .await
        .unwrap();
    client.call("hello", json!({"client": "stop-test"})).await.unwrap();
    let meta = client
        .call(
            "sessions.create",
            json!({"name": "cloud", "workspaceId": "ws", "model": {"provider": "x", "name": "y"}}),
        )
        .await
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_string();
    client
        .call("sessions.send", json!({"sessionId": id, "text": "hang"}))
        .await
        .unwrap();
    wait_turns(&counters, 1).await;
    let started = Instant::now();
    client
        .call("sessions.stop", json!({"sessionId": id}))
        .await
        .unwrap();
    wait_status(&d, &id, SessionStatus::Idle, GRACE + Duration::from_secs(2)).await;
    assert!(started.elapsed() >= GRACE);
    assert_eq!(counters.aborts.load(Ordering::SeqCst), 1, "runtime not killed");

    client.call("shutdown", json!({"force": true})).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    std::fs::remove_dir_all(dir).ok();
}
