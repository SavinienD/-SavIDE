use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use axecode_core::{
    ChatMessage, CreateSessionRequest, JournalEntryKind, ModelRef, Part, Role, RuntimeContext,
    SessionResult, SessionRuntime, SessionRuntimeFactory, TurnInput, TurnOutcome, TurnRequest,
    TurnSink,
};
use axecode_daemon::{Daemon, DaemonConfig};

/// Answers every message; "compact N" also records a compaction the way
/// `repl/compaction.rs` does (empty bounds); "go" runs a 400 ms python call.
struct Rt;

#[async_trait]
impl SessionRuntime for Rt {
    async fn run_turn(
        &self,
        request: TurnRequest,
        sink: Arc<dyn TurnSink>,
    ) -> SessionResult<TurnOutcome> {
        let text = match &request.input {
            TurnInput::User { message } => message.text(),
            _ => String::new(),
        };
        let say = |t: String| JournalEntryKind::Message {
            message: ChatMessage::assistant_text(t),
            usage: None,
            turn_id: None,
        };
        if text == "go" {
            sink.record(JournalEntryKind::Message {
                message: ChatMessage {
                    role: Role::Assistant,
                    parts: vec![Part::ToolCall {
                        id: "c1".into(),
                        name: "python".into(),
                        input: serde_json::json!({"code": "slow()"}),
                        meta: None,
                    }],
                },
                usage: None,
                turn_id: None,
            })
            .await?;
            tokio::time::sleep(Duration::from_millis(400)).await;
            sink.record(JournalEntryKind::ReplResult {
                call_id: "c1".into(),
                output: "done".into(),
                is_error: false,
                images: vec![],
                duration_ms: 400,
                turn_id: None,
            })
            .await?;
            sink.record(say("finished go".into())).await?;
        } else if let Some(n) = text.strip_prefix("compact ") {
            sink.record(say(format!("answer {n}"))).await?;
            sink.record(JournalEntryKind::Compaction {
                summary: format!("SUMMARY-{n}"),
                from_entry: String::new(),
                to_entry: String::new(),
                directive: None,
            })
            .await?;
        } else {
            sink.record(say(format!("reply to: {text}"))).await?;
        }
        Ok(TurnOutcome::default())
    }
}

struct F;

#[async_trait]
impl SessionRuntimeFactory for F {
    async fn create(&self, _c: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(Arc::new(Rt))
    }
}

fn daemon() -> (Arc<Daemon>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("axecode-loop-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = DaemonConfig::new(dir.clone());
    config.auto_shutdown = false;
    (Daemon::new(config, Arc::new(F)), dir)
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

async fn wait_text(d: &Daemon, id: &str, needle: &str) {
    for _ in 0..200 {
        let found = {
            let j = d.journal(id).unwrap();
            let j = j.lock().unwrap();
            serde_json::to_string(j.entries()).unwrap().contains(needle)
        };
        if found {
            tokio::time::sleep(Duration::from_millis(50)).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{needle} not reached");
}

fn describe(h: &[ChatMessage]) -> String {
    h.iter()
        .map(|m| {
            let parts: Vec<String> = m
                .parts
                .iter()
                .map(|p| match p {
                    Part::Text { text, .. } => format!("text({})", text.replace('\n', " ")),
                    Part::ToolCall { id, .. } => format!("tool_call({id})"),
                    Part::ToolResult {
                        tool_call_id,
                        content,
                        ..
                    } => format!("tool_result({tool_call_id}: {content})"),
                    _ => "other".into(),
                })
                .collect();
            format!("{:?}[{}]", m.role, parts.join(","))
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

#[tokio::test(flavor = "multi_thread")]
async fn nested_compactions_give_one_history() {
    let (d, dir) = daemon();
    let id = create(&d);
    for n in 1..=3 {
        d.send_user(&id, ChatMessage::user_text(format!("compact {n}")))
            .unwrap();
        wait_text(&d, &id, &format!("SUMMARY-{n}")).await;
    }
    for _ in 0..300 {
        let h = {
            let j = d.journal(&id).unwrap();
            let j = j.lock().unwrap();
            j.history()
        };
        assert_eq!(
            describe(&h),
            "User[text(<compacted_history> SUMMARY-3 </compacted_history>)]"
        );
    }
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn message_sent_during_a_turn_comes_after_it() {
    let (d, dir) = daemon();
    let id = create(&d);
    d.send_user(&id, ChatMessage::user_text("go")).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    d.send_user(&id, ChatMessage::user_text("change of plan"))
        .unwrap();
    wait_text(&d, &id, "reply to: change of plan").await;
    let h = {
        let j = d.journal(&id).unwrap();
        let j = j.lock().unwrap();
        j.history()
    };
    assert_eq!(
        describe(&h),
        "User[text(go)] | Assistant[tool_call(c1)] | User[tool_result(c1: done)] | \
         Assistant[text(finished go)] | User[text(change of plan)] | \
         Assistant[text(reply to: change of plan)]"
    );
    std::fs::remove_dir_all(dir).ok();
}
