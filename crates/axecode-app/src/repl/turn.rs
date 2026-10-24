//! The single-tool turn loop.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::StreamExt;
use serde_json::{json, Value};
use axecode_core::{
    AppError, ChatMessage, JournalEntryKind, Part, PartKind, ProviderRequest, Role, SessionError,
    SessionResult, StopReason, StreamEvent, TurnInput, TurnOutcome, TurnRequest, TurnSink, Usage,
};

use super::{
    output, prompt,
    runtime::{lock, ReplRuntime},
};
use crate::agent::{repair_missing_tool_results, AssistantMessageBuilder};

/// Pauses before each new attempt after a transient error (network or stream
/// cut), in [`RETRY_UNIT`]s: 2 + 4 + 8 + 16 + 20 + 20 + 20 = 90 s, about
/// 1 min 30 for the network to come back (21/10/2026: a laptop leaving modern
/// standby killed two turns, one of 1 h 18, at the first cut).
const STREAM_BACKOFF: [u32; 7] = [2, 4, 8, 16, 20, 20, 20];
#[cfg(not(test))]
const RETRY_UNIT: Duration = Duration::from_secs(1);
#[cfg(test)]
const RETRY_UNIT: Duration = Duration::from_millis(10);
/// Stop is checked this often during a pause.
#[cfg(not(test))]
const CANCEL_POLL: Duration = Duration::from_millis(250);
#[cfg(test)]
const CANCEL_POLL: Duration = Duration::from_millis(2);
/// Time given to an interrupted cell before the kernel is killed.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

pub(crate) async fn run(
    runtime: &ReplRuntime,
    request: TurnRequest,
    sink: Arc<dyn TurnSink>,
) -> SessionResult<TurnOutcome> {
    let shared = runtime.shared.clone();
    *lock(&shared.sink) = Some(sink.clone());
    let result = run_inner(runtime, request, sink).await;
    *lock(&shared.sink) = None;
    result
}

async fn run_inner(
    runtime: &ReplRuntime,
    request: TurnRequest,
    sink: Arc<dyn TurnSink>,
) -> SessionResult<TurnOutcome> {
    let shared = runtime.shared.clone();
    {
        let mut session = lock(&shared.session);
        let model = session.model.clone();
        *session = request.session.clone();
        // A set_model() issued while idle wins over the snapshot in the request.
        if request.session.model != model && model.provider.is_empty() {
            session.model = model;
        }
    }
    let settings = runtime.settings();
    // Started up front: its module catalog goes into the system prompt.
    runtime.kernel().await?;
    shared.family.begin_turn(&request.peer_messages);

    let mut history = request.history.clone();
    repair_missing_tool_results(&mut history);
    // Heartbeats and wake-ups need a trailing user message.
    let wake_text = match &request.input {
        TurnInput::Heartbeat { text } => Some(format!("<heartbeat>\n{text}\n</heartbeat>")),
        TurnInput::Continue | TurnInput::Resume
            if history.last().map(|m| m.role) != Some(Role::User) =>
        {
            Some(if request.peer_messages.is_empty() {
                "<system_reminder>Continue the current task.</system_reminder>".to_string()
            } else {
                "<system_reminder>New peer messages arrived (see the system prompt).</system_reminder>"
                    .to_string()
            })
        }
        _ => None,
    };
    if let Some(text) = wake_text {
        let message = ChatMessage::user_text(text);
        sink.record(JournalEntryKind::Message {
            message: message.clone(),
            usage: None,
            turn_id: Some(request.turn_id.clone()),
        })
        .await?;
        history.push(message);
    }

    // axe:cache — `stable` blocks stay in the cached prefix for the whole
    // turn; `volatile` blocks (peer messages, goal/autonomous counters,
    // notices, the todo list below) go after the volatile marker.
    let mut reminders: Vec<String> = Vec::new();
    // axe:freechat — free conversation: no project, private scratch folder.
    if request.session.scratch {
        reminders.push(prompt::SCRATCH_REMINDER.to_string());
    }
    // axe:freechat end
    if let Ok(Some(layer)) = axecode_harness::refine::harness_layer(&shared.harness) {
        reminders.push(layer);
    }
    let mut volatile: Vec<String> = Vec::new();
    let sessions = shared.host.list_sessions().await;
    if let Some(block) = crate::rlm::render_peer_messages(&request.peer_messages, &sessions) {
        volatile.push(block);
    }
    for hook in &shared.deps.hooks {
        if let Some(block) = hook.reminder(&request.session, &request).await {
            volatile.push(block);
        }
    }
    // axe:bg-d — automatic status of the sub-agents at work, at the start of
    // the turn, then refreshed every SUBAGENTS_STATUS_EVERY during a long turn.
    let me_id = request.session.id.clone();
    let now_ms = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    };
    let mut subagents_block = crate::rlm::render_subagents_status(&me_id, &sessions, now_ms());
    let mut subagents_at = std::time::Instant::now();

    let mut usage_total = Usage::default();
    let mut final_text = String::new();
    let mut stop_reason = None;
    let mut retried_after_overflow = false;
    // axe:compaction — a summary that still exceeds the threshold must not
    // trigger a new (paid) compaction on every round.
    let mut auto_compactions = 0usize;
    for _round in 0..settings.max_rounds {
        if sink.is_cancelled() {
            return Err(SessionError::Cancelled);
        }
        let meta = shared.meta();
        let provider = shared
            .deps
            .providers
            .provider(&meta.model.provider)
            .map_err(SessionError::Runtime)?;
        if subagents_at.elapsed() >= crate::rlm::SUBAGENTS_STATUS_EVERY {
            let sessions = shared.host.list_sessions().await;
            subagents_block = crate::rlm::render_subagents_status(&me_id, &sessions, now_ms());
            subagents_at = std::time::Instant::now();
        }
        let todo_block = lock(&shared.todo).system_block();
        let mut blocks = volatile.clone();
        // axe:goal165 — live session state (goal…) read again for each request.
        for hook in &shared.deps.hooks {
            if let Some(block) = hook.live_reminder(&meta).await {
                blocks.push(block);
            }
        }
        if let Some(block) = &subagents_block {
            blocks.push(block.clone());
        }
        if let Some(todo) = todo_block {
            blocks.push(format!("<todo_list_state>\n{todo}\n</todo_list_state>"));
        }
        let (system, volatile_from) = prompt::system_prompt_split(
            &runtime.catalog_text(),
            meta.system_prompt_extra.as_deref(),
            &reminders,
            &blocks,
        );

        // Automatic or kernel-requested compaction.
        // axe:compaction — estimate the request about to be sent (not the
        // previous call) and always keep room for the answer.
        let caps = provider.capabilities(&meta.model);
        let max_output_tokens = settings
            .max_output_tokens_for(&meta.model.provider, &meta.model.name)
            .or_else(|| caps.as_ref().map(|c| c.max_output_tokens));
        let tools = vec![prompt::python_tool()];
        let mut sent_chars = super::budget::request_chars(&system, &history, &tools);
        let requested = lock(&shared.compact_request).take();
        let over_threshold = settings.compaction_threshold < 100
            && auto_compactions < super::budget::MAX_AUTO_COMPACTIONS_PER_TURN
            && caps.as_ref().is_some_and(|caps| {
                let mut probe = ProviderRequest::new(meta.model.clone(), Vec::new());
                probe.max_output_tokens = max_output_tokens;
                let limit = super::budget::threshold(
                    caps,
                    settings.compaction_threshold,
                    probe.output_token_budget(caps),
                );
                let estimate = super::budget::estimate_tokens(sent_chars, *lock(&shared.last_call_size));
                limit > 0 && estimate >= limit
            });
        if requested.is_some() || over_threshold {
            if requested.is_none() {
                auto_compactions += 1;
            }
            let directive = requested.flatten();
            match super::compaction::compact(&shared, provider.clone(), &system, &history, directive, &sink).await {
                Ok(new_history) => {
                    history = new_history;
                    sent_chars = super::budget::request_chars(&system, &history, &tools);
                }
                Err(err) => tracing::warn!(error = %err, "compaction failed"),
            }
        }

        let mut provider_request = ProviderRequest::new(meta.model.clone(), history.clone())
            .with_system(system)
            .with_tools(tools)
            .with_cache_key(meta.id.clone());
        if let Some(offset) = volatile_from {
            provider_request = provider_request.with_volatile_system_from(offset);
        }
        provider_request.effort = meta.model.effort;
        provider_request.max_output_tokens = max_output_tokens;

        let (assistant, usage, reason) = match stream_once(provider.as_ref(), provider_request, &sink).await {
            Ok(done) => done,
            Err(StreamFailure::Cancelled) => return Err(SessionError::Cancelled),
            // Over the context window: compact, then try once more.
            Err(StreamFailure::ContextLength(message)) if !retried_after_overflow => {
                tracing::warn!(error = %message, "context window exceeded, compacting");
                retried_after_overflow = true;
                *lock(&shared.compact_request) = Some(None);
                continue;
            }
            Err(StreamFailure::ContextLength(message) | StreamFailure::Provider(message)) => {
                sink.record(JournalEntryKind::Extension {
                    name: "turn_error".into(),
                    payload: json!({"error": message}),
                })
                .await?;
                sink.emit(json!({"type": "turn_error", "error": message})).await;
                if let Err(err) = shared.family.on_turn_failed(&message).await {
                    tracing::warn!(error = %err, "sub-agent error delivery failed");
                }
                return Ok(TurnOutcome {
                    final_text: message,
                    usage: usage_total,
                    stop_reason: Some(StopReason::Other),
                    wants_continuation: false,
                });
            }
        };
        retried_after_overflow = false;
        add_usage(&mut usage_total, &usage);
        let billed = usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
        *lock(&shared.last_input_tokens) = billed;
        if billed > 0 {
            *lock(&shared.last_call_size) = Some((billed as u64, sent_chars));
        }
        stop_reason = Some(reason);
        if !assistant.parts.is_empty() {
            sink.record(JournalEntryKind::Message {
                message: assistant.clone(),
                usage: Some(usage.clone()),
                turn_id: Some(request.turn_id.clone()),
            })
            .await?;
        }
        history.push(assistant.clone());

        let calls: Vec<(String, String, Value)> = assistant
            .parts
            .iter()
            .filter_map(|part| match part {
                Part::ToolCall { id, name, input, .. } => Some((id.clone(), name.clone(), input.clone())),
                _ => None,
            })
            .collect();
        if calls.is_empty() {
            final_text = assistant.text();
            break;
        }
        let mut results = Vec::new();
        for (call_id, name, input) in calls {
            let part = run_call(&shared, runtime, &sink, &request.turn_id, &call_id, &name, input, settings.output_cap_chars).await?;
            results.push(part);
        }
        history.push(ChatMessage { role: Role::User, parts: results });
    }

    let meta = shared.meta();
    for hook in &shared.deps.hooks {
        hook.turn_finished(&meta, &final_text).await;
    }
    if let Err(err) = shared.family.on_turn_finished(&final_text).await {
        tracing::warn!(error = %err, "sub-agent result delivery failed");
    }
    sink.emit(json!({"type": "turn_done"})).await;
    // axe:goal — hooks decide on autonomous continuation.
    let mut outcome = TurnOutcome {
        final_text,
        usage: usage_total,
        stop_reason,
        wants_continuation: false,
    };
    for hook in &shared.deps.hooks {
        if hook.wants_continuation(&meta, &outcome).await {
            outcome.wants_continuation = true;
        }
    }
    Ok(outcome)
    // axe:goal end
}

fn add_usage(total: &mut Usage, usage: &Usage) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.total_tokens += usage.total_tokens;
    total.reasoning_tokens += usage.reasoning_tokens;
    total.cache_read_tokens += usage.cache_read_tokens;
    total.cache_creation_tokens += usage.cache_creation_tokens;
}

#[allow(clippy::too_many_arguments)]
async fn run_call(
    shared: &Arc<super::runtime::Shared>,
    runtime: &ReplRuntime,
    sink: &Arc<dyn TurnSink>,
    turn_id: &str,
    call_id: &str,
    name: &str,
    input: Value,
    cap: usize,
) -> SessionResult<Part> {
    let code = input
        .get("code")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| input.as_str().map(str::to_string))
        .unwrap_or_default();
    if name != prompt::PYTHON_TOOL || code.trim().is_empty() {
        let content = if name != prompt::PYTHON_TOOL {
            format!("Unknown tool `{name}`. The only tool is `python(code)`; call modules from Python.")
        } else {
            "Empty code: pass Python source in the `code` argument.".to_string()
        };
        sink.record(JournalEntryKind::ReplResult {
            call_id: call_id.to_string(),
            output: content.clone(),
            is_error: true,
            images: vec![],
            duration_ms: 0,
            turn_id: Some(turn_id.to_string()),
        })
        .await?;
        return Ok(Part::ToolResult { tool_call_id: call_id.to_string(), content, images: vec![], is_error: true, meta: None });
    }
    // A kernel that died earlier is replaced here, at each call.
    let kernel = runtime.kernel().await?;
    let restart_note = runtime.take_restart_note();
    sink.emit(json!({"type": "repl_start", "callId": call_id, "code": code})).await;

    // Interrupt the kernel if the turn is cancelled mid-execution; kill it if
    // the code still runs after INTERRUPT_GRACE (blocked outside Python).
    let killed = Arc::new(AtomicBool::new(false));
    let watcher = {
        let sink = sink.clone();
        let kernel = kernel.clone();
        let killed = killed.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if sink.is_cancelled() {
                    kernel.interrupt().await;
                    break;
                }
            }
            tokio::time::sleep(INTERRUPT_GRACE).await;
            killed.store(true, Ordering::SeqCst);
            kernel.kill().await;
        })
    };
    let executed = kernel.exec(call_id, &code).await;
    watcher.abort();
    let result = match executed {
        Ok(result) => result,
        Err(_) if killed.load(Ordering::SeqCst) => axecode_repl::ExecResult {
            error: Some(format!(
                "stopped: the code ignored the interrupt for {} s, so the kernel and the programs it started were killed. The next call starts a new kernel and says which variables it restored.",
                INTERRUPT_GRACE.as_secs()
            )),
            ..Default::default()
        },
        Err(err) => axecode_repl::ExecResult {
            error: Some(format!("kernel failure: {err}. The next call starts a new kernel and says which variables it restored.")),
            ..Default::default()
        },
    };
    let mut content = output::render(&result, cap);
    if let Some(note) = restart_note {
        content = format!("[{note}]\n{content}");
    }
    let is_error = result.is_error();
    // Keep the todo list mirrored in the runtime for the system reminder.
    let _ = shared;
    sink.record(JournalEntryKind::ReplResult {
        call_id: call_id.to_string(),
        output: content.clone(),
        is_error,
        images: result.images.clone(),
        duration_ms: result.duration_ms,
        turn_id: Some(turn_id.to_string()),
    })
    .await?;
    sink.emit(json!({
        "type": "repl_done",
        "callId": call_id,
        "summary": output::summary(&result),
        "isError": is_error,
        "durationMs": result.duration_ms,
        "stdout": output::clip(&result.stdout, 200_000),
        "stderr": output::clip(&result.stderr, 50_000),
        "value": result.value,
        "error": result.error,
        "fileChanges": result.file_changes,
    }))
    .await;
    Ok(Part::ToolResult {
        tool_call_id: call_id.to_string(),
        content,
        images: result.images,
        is_error,
        meta: None,
    })
}

enum StreamFailure {
    Cancelled,
    /// The request does not fit in the model's context window.
    ContextLength(String),
    Provider(String),
}

fn retryable(err: &AppError) -> bool {
    matches!(
        err,
        AppError::Network(_) | AppError::Stream(_) | AppError::Decode(_) | AppError::RetryableStream { .. }
    )
}

/// Streams one model response, forwarding deltas. A transient error
/// ([`retryable`]) is retried after a pause ([`STREAM_BACKOFF`]), even once
/// part of the response was received: that part was neither journaled nor
/// executed, so it is dropped and the same request is sent again (the app,
/// if it already showed some of it, gets a `stream_retry` event to start the
/// message over). Stop ends the pauses.
async fn stream_once(
    provider: &dyn axecode_core::Provider,
    request: ProviderRequest,
    sink: &Arc<dyn TurnSink>,
) -> Result<(ChatMessage, Usage, StopReason), StreamFailure> {
    let mut pauses = STREAM_BACKOFF.iter().enumerate();
    loop {
        let mut builder = AssistantMessageBuilder::default();
        let mut usage = Usage::default();
        let mut reason = StopReason::EndTurn;
        // Deltas of this attempt already shown by the app.
        let mut shown = false;
        let outcome: Result<(), AppError> = async {
            let mut stream = provider.stream(request.clone()).await?;
            while let Some(event) = stream.next().await {
                if sink.is_cancelled() {
                    return Ok(());
                }
                match event? {
                    StreamEvent::PartStart { index, kind, tool } => {
                        builder.open(index, kind);
                        if let Some(tool) = tool {
                            builder.register_tool(index, tool.id, tool.name);
                        }
                    }
                    StreamEvent::TextDelta { index, delta } => {
                        builder.push_text(index, &delta);
                        shown = true;
                        sink.emit(json!({"type": "text_delta", "index": index, "delta": delta})).await;
                    }
                    StreamEvent::ThinkingDelta { index, delta } => {
                        builder.push_text(index, &delta);
                        shown = true;
                        sink.emit(json!({"type": "thinking_delta", "index": index, "delta": delta})).await;
                    }
                    StreamEvent::ToolJsonDelta { index, chunk } => builder.push_tool_json(index, &chunk),
                    StreamEvent::PartMeta { index, meta } => builder.push_meta(index, meta),
                    StreamEvent::PartStop { index } => {
                        if builder.kind(index) == Some(PartKind::Thinking) {
                            if let Some(ms) = builder.thinking_duration_ms(index) {
                                builder.insert_meta_field(index, "duration_ms", json!(ms));
                            }
                        }
                    }
                    StreamEvent::Usage { usage: u } => usage = u,
                    StreamEvent::MessageStop { stop_reason, usage: u } => {
                        reason = stop_reason;
                        if u.input_tokens > 0 || u.output_tokens > 0 {
                            usage = u;
                        }
                    }
                    StreamEvent::MessageStart { .. } => {}
                }
            }
            Ok(())
        }
        .await;
        if sink.is_cancelled() {
            return Err(StreamFailure::Cancelled);
        }
        let err = match outcome {
            Ok(()) => return Ok((builder.finish(), usage, reason)),
            Err(err) => err,
        };
        match pauses.next() {
            Some((retry, &units)) if retryable(&err) => {
                let delay = RETRY_UNIT * units;
                tracing::warn!(
                    error = %err,
                    retry = retry + 1,
                    ?delay,
                    "model stream failed, sending the request again"
                );
                if shown {
                    sink.emit(json!({
                        "type": "stream_retry",
                        "attempt": retry + 2,
                        "delayMs": delay.as_millis() as u64,
                    }))
                    .await;
                }
                if pause(delay, sink).await {
                    return Err(StreamFailure::Cancelled);
                }
            }
            _ if matches!(err, AppError::ContextLength(_)) => {
                return Err(StreamFailure::ContextLength(err.to_string()))
            }
            _ => return Err(StreamFailure::Provider(err.to_string())),
        }
    }
}

/// Sleeps `delay`, checking Stop every [`CANCEL_POLL`]; true if Stop came.
async fn pause(delay: Duration, sink: &Arc<dyn TurnSink>) -> bool {
    let deadline = tokio::time::Instant::now() + delay;
    loop {
        if sink.is_cancelled() {
            return true;
        }
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return false;
        }
        tokio::time::sleep(left.min(CANCEL_POLL)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::{Duration, Instant},
    };

    use async_trait::async_trait;
    use futures_util::stream;
    use serde_json::Value;
    use axecode_core::{
        AppError, EntryId, JournalEntryKind, ModelCapabilities, ModelRef, PartKind, Provider,
        ProviderRequest, ProviderStream, Result as CoreResult, SessionResult, StopReason,
        StreamEvent, TokenEstimate, TurnSink, Usage,
    };

    use super::{stream_once, StreamFailure, RETRY_UNIT, STREAM_BACKOFF};

    type Events = Vec<Result<StreamEvent, AppError>>;

    /// Fake model: answer `n` (from 0) is `script(n)`.
    struct Fake {
        calls: AtomicUsize,
        script: fn(usize) -> Events,
    }

    impl Fake {
        fn new(script: fn(usize) -> Events) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                script,
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Provider for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        fn capabilities(&self, _model: &ModelRef) -> Option<ModelCapabilities> {
            None
        }
        async fn estimate_tokens(&self, _request: ProviderRequest) -> CoreResult<TokenEstimate> {
            Ok(TokenEstimate {
                input_tokens: 0,
                exact: false,
            })
        }
        async fn stream(&self, _request: ProviderRequest) -> CoreResult<ProviderStream> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(stream::iter((self.script)(n))))
        }
    }

    #[derive(Default)]
    struct Sink {
        events: Mutex<Vec<Value>>,
        cancelled: AtomicBool,
    }

    #[async_trait]
    impl TurnSink for Sink {
        async fn record(&self, _kind: JournalEntryKind) -> SessionResult<EntryId> {
            Ok(EntryId::new())
        }
        async fn emit(&self, event: Value) {
            self.events.lock().unwrap().push(event);
        }
        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }
    }

    fn request() -> ProviderRequest {
        ProviderRequest::new(ModelRef::new("fake", "model"), Vec::new())
    }

    fn text(delta: &str) -> Events {
        vec![
            Ok(StreamEvent::PartStart {
                index: 0,
                kind: PartKind::Text,
                tool: None,
            }),
            Ok(StreamEvent::TextDelta {
                index: 0,
                delta: delta.into(),
            }),
        ]
    }

    /// 1st answer cut after a few words (as on 21/10/2026), 2nd complete.
    fn cut_then_complete(n: usize) -> Events {
        let mut events = text(if n == 0 { "partial " } else { "complete answer" });
        events.push(if n == 0 {
            Err(AppError::Stream(
                "Transport error: error decoding response body".into(),
            ))
        } else {
            Ok(StreamEvent::MessageStop {
                stop_reason: StopReason::EndTurn,
                usage: Usage::default(),
            })
        });
        events
    }

    fn network_down(_n: usize) -> Events {
        vec![Err(AppError::Network("connection reset".into()))]
    }

    fn refused(_n: usize) -> Events {
        vec![Err(AppError::Provider("invalid request".into()))]
    }

    #[tokio::test]
    async fn a_cut_mid_stream_is_retried_and_only_the_second_answer_counts() {
        let provider = Fake::new(cut_then_complete);
        let sink = Arc::new(Sink::default());
        let turn_sink: Arc<dyn TurnSink> = sink.clone();
        let Ok((message, _usage, reason)) = stream_once(&provider, request(), &turn_sink).await
        else {
            panic!("the second attempt should succeed");
        };
        assert_eq!(provider.calls(), 2);
        assert_eq!(message.text(), "complete answer");
        assert!(matches!(reason, StopReason::EndTurn));
        let events = sink.events.lock().unwrap().clone();
        let kinds: Vec<&str> = events.iter().filter_map(|e| e["type"].as_str()).collect();
        assert_eq!(kinds, ["text_delta", "stream_retry", "text_delta"]);
        assert_eq!(events[1]["attempt"], 2);
        assert_eq!(events[2]["delta"], "complete answer");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stop_during_a_pause_returns_cancelled() {
        let provider = Arc::new(Fake::new(network_down));
        let sink = Arc::new(Sink::default());
        let task = {
            let (provider, sink): (_, Arc<dyn TurnSink>) = (provider.clone(), sink.clone());
            tokio::spawn(async move {
                matches!(
                    stream_once(provider.as_ref(), request(), &sink).await,
                    Err(StreamFailure::Cancelled)
                )
            })
        };
        // Attempts 1 to 4 failed: inside the 4th pause (16 units), Stop.
        let started = Instant::now();
        while provider.calls() < 4 {
            assert!(started.elapsed() < Duration::from_secs(5), "attempts not made");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        tokio::time::sleep(RETRY_UNIT * 3).await;
        sink.cancelled.store(true, Ordering::SeqCst);
        let stopped = Instant::now();
        let cancelled = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("stream_once ended")
            .unwrap();
        assert!(cancelled, "Stop during the pause gives Cancelled");
        assert!(
            stopped.elapsed() < RETRY_UNIT * 6,
            "the pause was cut short ({:?})",
            stopped.elapsed()
        );
        assert_eq!(provider.calls(), 4, "no new attempt after Stop");
        assert!(sink.events.lock().unwrap().is_empty(), "nothing was shown");
    }

    #[tokio::test]
    async fn transient_errors_give_up_after_about_a_minute_and_a_half() {
        assert_eq!(STREAM_BACKOFF.iter().sum::<u32>(), 90);
        let provider = Fake::new(network_down);
        let sink: Arc<dyn TurnSink> = Arc::new(Sink::default());
        let started = Instant::now();
        let failure = stream_once(&provider, request(), &sink).await;
        assert!(matches!(failure, Err(StreamFailure::Provider(_))));
        assert_eq!(provider.calls(), 1 + STREAM_BACKOFF.len());
        assert!(started.elapsed() >= RETRY_UNIT * 90);
    }

    #[tokio::test]
    async fn other_errors_are_not_retried() {
        let provider = Fake::new(refused);
        let sink: Arc<dyn TurnSink> = Arc::new(Sink::default());
        let failure = stream_once(&provider, request(), &sink).await;
        assert!(matches!(failure, Err(StreamFailure::Provider(_))));
        assert_eq!(provider.calls(), 1);
    }
}
