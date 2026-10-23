//! REPL sessions run by the real daemon: scripted provider, real IPython
//! kernel (skipped when no Python with IPython is available).

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde_json::json;
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplFactory};
use axecode_core::{
    AppError, ChatMessage, CreateSessionRequest, EffortMode, JournalEntryKind, ModelCapabilities,
    ModelRef,
    PartKind, Provider, ProviderRequest, ProviderStream, StopReason, StreamEvent, TokenEstimate,
    ToolCallIntro, Usage,
};
use axecode_daemon::{Daemon, DaemonConfig};

enum Step {
    Code(&'static str),
    Text(&'static str),
    TooLong,
}

struct Scripted {
    steps: Mutex<VecDeque<Step>>,
    /// axe:compaction — declared context window (None = unknown model).
    window: Option<u32>,
    /// (request has tools, characters sent) of every call.
    seen: Mutex<Vec<(bool, usize)>>,
}

#[async_trait]
impl Provider for Scripted {
    fn name(&self) -> &str {
        "fake"
    }
    fn capabilities(&self, m: &ModelRef) -> Option<ModelCapabilities> {
        self.window.map(|window| ModelCapabilities {
            model: m.clone(),
            context_window: window,
            preferred_window: window,
            max_output_tokens: 4_096,
            supports_thinking: false,
            visible_thinking: false,
            supports_tools: true,
            supports_images: false,
            effort_mode: EffortMode::None,
        })
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> axecode_core::Result<TokenEstimate> {
        Ok(TokenEstimate {
            input_tokens: 10,
            exact: false,
        })
    }
    async fn stream(&self, request: ProviderRequest) -> axecode_core::Result<ProviderStream> {
        self.seen.lock().unwrap().push((
            !request.tools.is_empty(),
            request.system_prompt.as_deref().map_or(0, str::len)
                + serde_json::to_string(&request.transcript).map_or(0, |s| s.len()),
        ));
        // Sub-agents always hit a refusal; the script drives the parent.
        if request
            .system_prompt
            .as_deref()
            .unwrap_or("")
            .contains("You are the sub-agent")
        {
            return Err(AppError::RateLimit("429 simulated quota exhausted".into()));
        }
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Step::Text("(script exhausted)"));
        let usage = Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Default::default()
        };
        let mut events = vec![StreamEvent::MessageStart {
            model: "fake".into(),
        }];
        match step {
            Step::TooLong => return Err(AppError::ContextLength("prompt is too long".into())),
            Step::Code(code) => events.extend([
                StreamEvent::PartStart {
                    index: 0,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro {
                        id: format!("call_{}", uuid::Uuid::new_v4().simple()),
                        name: "python".into(),
                    }),
                },
                StreamEvent::ToolJsonDelta {
                    index: 0,
                    chunk: json!({ "code": code }).to_string(),
                },
                StreamEvent::PartStop { index: 0 },
                StreamEvent::MessageStop {
                    stop_reason: StopReason::ToolUse,
                    usage,
                },
            ]),
            Step::Text(text) => events.extend([
                StreamEvent::PartStart {
                    index: 0,
                    kind: PartKind::Text,
                    tool: None,
                },
                StreamEvent::TextDelta {
                    index: 0,
                    delta: text.into(),
                },
                StreamEvent::PartStop { index: 0 },
                StreamEvent::MessageStop {
                    stop_reason: StopReason::EndTurn,
                    usage,
                },
            ]),
        }
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver(Arc<Scripted>);
impl ProviderResolver for Resolver {
    fn provider(&self, _id: &str) -> Result<Arc<dyn Provider>, String> {
        Ok(self.0.clone())
    }
}

struct Session {
    daemon: Arc<Daemon>,
    id: String,
    base: std::path::PathBuf,
}

impl Drop for Session {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.base).ok();
    }
}

fn setup(steps: Vec<Step>) -> Option<Session> {
    setup_with(steps, None).map(|(session, _)| session)
}

fn setup_with(steps: Vec<Step>, window: Option<u32>) -> Option<(Session, Arc<Scripted>)> {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping: no Python with IPython");
        return None;
    }
    let base = std::env::temp_dir().join(format!("axecode-repl-daemon-{}", uuid::Uuid::new_v4()));
    let ws = base.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let provider = Arc::new(Scripted {
        steps: Mutex::new(steps.into()),
        window,
        seen: Mutex::new(Vec::new()),
    });
    let deps = Arc::new(ReplDeps {
        providers: Arc::new(Resolver(provider.clone())),
        resource_dirs: vec![],
        hooks: vec![],
    });
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
    Some((Session { daemon, id, base }, provider))
}

impl Session {
    async fn turn(&self, text: &str, expect_final: &str) {
        self.daemon
            .send_user(&self.id, ChatMessage::user_text(text))
            .unwrap();
        for _ in 0..600 {
            let done = {
                let j = self.daemon.journal(&self.id).unwrap();
                let j = j.lock().unwrap();
                serde_json::to_string(j.entries())
                    .unwrap()
                    .contains(expect_final)
            };
            if done
                && self
                    .daemon
                    .list_metas()
                    .iter()
                    .all(|m| m.status != axecode_core::SessionStatus::Running)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("turn `{text}` did not finish");
    }

    /// Waits until a python call whose code contains `needle` is running.
    async fn wait_running_call(&self, needle: &str) {
        for _ in 0..200 {
            let started = {
                let j = self.daemon.journal(&self.id).unwrap();
                let j = j.lock().unwrap();
                j.entries().iter().any(|e| {
                    matches!(&e.kind, JournalEntryKind::Message { message, .. }
                        if format!("{:?}", message.parts).contains(needle))
                })
            };
            if started {
                tokio::time::sleep(Duration::from_millis(500)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("call with `{needle}` never started");
    }

    fn repl_outputs(&self) -> Vec<String> {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        j.entries()
            .iter()
            .filter_map(|e| match &e.kind {
                JournalEntryKind::ReplResult { output, .. } => Some(output.clone()),
                _ => None,
            })
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn compaction_keeps_kernel_variables() {
    let Some(s) = setup(vec![
        Step::Code(
            "data_rows = list(range(5))\ndef parse_ticket(t):\n    return t.strip()\nclient_cfg = {'url': 'x'}\ncompact.run()\nprint('ok')",
        ),
        Step::Text("Summary: the rows of the export were loaded and a ticket parser helper exists."),
        Step::Code("pass"),
        Step::Code("print([n for n in ('data_rows', 'parse_ticket', 'client_cfg') if n in globals()])"),
        Step::Text("C done"),
    ]) else {
        return;
    };
    s.turn("load the export", "C done").await;
    let outputs = s.repl_outputs();
    assert!(
        outputs
            .last()
            .unwrap()
            .contains("['data_rows', 'parse_ticket', 'client_cfg']"),
        "{outputs:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn dead_kernel_is_replaced_and_restored_in_the_same_turn() {
    let Some(s) = setup(vec![
        Step::Code("x = 41\nbig = bytes(17 * 1024 * 1024)\nprint('x set')"),
        Step::Text("T1 done"),
        Step::Code("import os\nos._exit(3)"),
        Step::Code("print('x =', x)"),
        Step::Text("T2 done"),
        Step::Code("print('x =', x)"),
        Step::Text("T3 done"),
    ]) else {
        return;
    };
    s.turn("t1", "T1 done").await;
    s.turn("t2", "T2 done").await;
    s.turn("t3", "T3 done").await;
    let outputs = s.repl_outputs();
    assert!(outputs[1].contains("kernel failure"), "{outputs:?}");
    assert!(!outputs[1].contains("restored from"), "{outputs:?}");
    assert!(
        outputs[2].starts_with("[kernel restarted: 1 variable(s) restored from the last snapshot"),
        "{outputs:?}"
    );
    assert!(outputs[2].contains("; not restored: big]"), "{outputs:?}");
    assert!(outputs[2].contains("x = 41"), "{outputs:?}");
    assert!(outputs[3].starts_with("x = 41"), "{outputs:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_kills_the_kernel_and_the_next_call_restores() {
    let Some(s) = setup(vec![
        Step::Code("x = 41"),
        Step::Text("T1 done"),
        // Blocked in a child process: the interrupt is ignored, Stop kills.
        Step::Code(
            "import subprocess, sys\nsubprocess.run([sys.executable, '-c', 'import time; time.sleep(60)'])",
        ),
        Step::Code("print('x =', x)"),
        Step::Text("T3 done"),
    ]) else {
        return;
    };
    s.turn("t1", "T1 done").await;
    s.daemon
        .send_user(&s.id, ChatMessage::user_text("t2"))
        .unwrap();
    s.wait_running_call("sleep").await;
    s.daemon.stop(&s.id).unwrap();
    s.turn("t3", "T3 done").await;
    let outputs = s.repl_outputs();
    assert!(
        outputs[1].contains("stopped: the code ignored the interrupt"),
        "{outputs:?}"
    );
    assert!(
        outputs[2].starts_with("[kernel restarted: 1 variable(s) restored from the last snapshot"),
        "{outputs:?}"
    );
    assert!(outputs[2].contains("x = 41"), "{outputs:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn reloaded_session_gets_its_variables_back() {
    let Some(s) = setup(vec![
        Step::Code("x = 41"),
        Step::Text("T1 done"),
        Step::Code("print('x =', x)"),
        Step::Text("T2 done"),
    ]) else {
        return;
    };
    s.turn("t1", "T1 done").await;
    s.daemon.unload(&s.id).await;
    s.turn("t2", "T2 done").await;
    let outputs = s.repl_outputs();
    assert!(outputs[1].starts_with("x = 41"), "{outputs:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_sub_agent_tells_its_parent() {
    let Some(s) = setup(vec![
        Step::Code(
            "import time\nh = rlm('summarise the README', name='kid')\nt = time.time()\nr = rlm.wait(h, timeout=60)\nprint('wait', r['error'], time.time() - t < 20)\nprint([c['status'] for c in rlm.list_subagents()])",
        ),
        Step::Text("P done"),
    ]) else {
        return;
    };
    s.turn("start a child", "P done").await;
    let outputs = s.repl_outputs();
    assert!(outputs[0].contains("wait True True"), "{outputs:?}");
    assert!(outputs[0].contains("['error']"), "{outputs:?}");
    let j = s.daemon.journal(&s.id).unwrap();
    let j = j.lock().unwrap();
    let peer = j.entries().iter().find_map(|e| match &e.kind {
        JournalEntryKind::PeerMessage { text, .. } => Some(text.clone()),
        _ => None,
    });
    let peer = peer.expect("no peer message from the sub-agent");
    assert!(
        peer.starts_with("[sub-agent error] `kid` stopped on an error"),
        "{peer}"
    );
    assert!(peer.contains("429"), "{peer}");
}

#[tokio::test(flavor = "multi_thread")]
async fn context_overflow_compacts_and_retries() {
    let Some(s) = setup(vec![
        Step::Code("x = 1"),
        Step::TooLong,
        Step::Text("Summary: x was set."),
        Step::Text("D done"),
    ]) else {
        return;
    };
    s.turn("start", "D done").await;
    let j = s.daemon.journal(&s.id).unwrap();
    let j = j.lock().unwrap();
    let entries = serde_json::to_string(j.entries()).unwrap();
    assert!(!entries.contains("turn_error"), "{entries}");
    let h = j.history();
    assert_eq!(h.len(), 2, "{h:?}");
    assert!(h[0].text().contains("Summary: x was set."), "{h:?}");
    assert_eq!(h[1].text(), "D done");
}

/// axe:compaction — the request about to be sent is measured: two 20 000-char
/// tool outputs push it past `window − 16 384` and the loop compacts BEFORE
/// sending (the provider never refuses). The old trigger (input tokens of the
/// previous call, 10 here) never fired.
#[tokio::test(flavor = "multi_thread")]
async fn compacts_before_the_request_that_would_not_fit() {
    // Threshold = 27 384 − 16 384 = 11 000 tokens: the 2nd request (system +
    // one output, ≤ 10 000 tokens) fits, the 3rd (two outputs, ≥ 12 000) does not.
    let Some((s, provider)) = setup_with(
        vec![
            Step::Code("print('a' * 30000)"),
            Step::Code("print('b' * 30000)"),
            Step::Text("Summary: two long prints."),
            Step::Text("E done"),
        ],
        Some(27_384),
    ) else {
        return;
    };
    s.turn("start", "E done").await;
    let seen = provider.seen.lock().unwrap().clone();
    let tools: Vec<bool> = seen.iter().map(|(tools, _)| *tools).collect();
    // 3rd call = the compaction request (no tools), then the real call.
    assert_eq!(tools, vec![true, true, false, true], "{seen:?}");
    assert!(seen[3].1 < seen[1].1, "{seen:?}");
    let j = s.daemon.journal(&s.id).unwrap();
    let j = j.lock().unwrap();
    let h = j.history();
    assert!(h[0].text().contains("Summary: two long prints."), "{h:?}");
    assert_eq!(h.last().unwrap().text(), "E done");
}
