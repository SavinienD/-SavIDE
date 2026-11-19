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
/// bascule — with backup providers, retries on one provider before going
/// to the next one (pauses 2 + 4 + 8 units).
const FAILOVER_RETRIES_PER_PROVIDER: usize = 3;
/// bascule — with backup providers, retries of one model call across the
/// whole chain (a switch counts as one): at most 9 attempts in all.
const FAILOVER_MAX_TOTAL_RETRIES: usize = 8;

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
    *lock(&shared.compact_calls) = 0;
    // compact169 — `/compact [directive]` tapé par l'utilisateur : la compaction
    // est faite ici, directement, sans demander à l'IA d'appeler compact.run().
    let slash_compact: Option<Option<String>> = match &request.input {
        TurnInput::User { message } => {
            let text = message.text();
            let text = text.trim();
            text.strip_prefix("/compact")
                .filter(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
                .map(|rest| Some(rest.trim().to_string()).filter(|d| !d.is_empty()))
        }
        _ => None,
    };
    if slash_compact.is_some() {
        *lock(&shared.compact_calls) = 1;
    }

    let mut history = request.history.clone();
    if slash_compact.is_some() {
        // La commande elle-même n'a rien à résumer.
        if history.last().map(|m| m.role) == Some(Role::User) {
            history.pop();
        }
    }
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

    // cache — `stable` blocks stay in the cached prefix for the whole
    // turn; `volatile` blocks (peer messages, goal/autonomous counters,
    // notices, the todo list below) go after the volatile marker.
    let mut reminders: Vec<String> = Vec::new();
    // freechat — free conversation: no project, private scratch folder.
    if request.session.scratch {
        reminders.push(prompt::SCRATCH_REMINDER.to_string());
    }
    // freechat end
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
    // bg-d — automatic status of the sub-agents at work, at the start of
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
    // compaction — a summary that still exceeds the threshold must not
    // trigger a new (paid) compaction on every round.
    let mut auto_compactions = 0usize;
    // bascule — backup that answered last in this turn: the next rounds
    // start there (the outage is probably not over); the next turn starts
    // again from the session's own provider.
    let mut sticky_provider: Option<String> = None;
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
        // goal165 — live session state (goal…) read again for each request.
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
        // compaction — estimate the request about to be sent (not the
        // previous call) and always keep room for the answer.
        let caps = provider.capabilities(&meta.model);
        let max_output_tokens = settings
            .max_output_tokens_for(&meta.model.provider, &meta.model.name)
            .or_else(|| caps.as_ref().map(|c| c.max_output_tokens));
        let tools = vec![prompt::python_tool()];
        let mut sent_chars = super::budget::request_chars(&system, &history, &tools);
        let requested = match &slash_compact {
            Some(directive) => Some(directive.clone()),
            None => lock(&shared.compact_request).take(),
        };
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
            let resultat = if slash_compact.is_some() && history.is_empty() {
                Err(anyhow::anyhow!("la conversation n'a pas d'historique à compacter"))
            } else {
                super::compaction::compact(&shared, provider.clone(), &system, &history, directive, &sink, runtime.current_kernel().await).await
            };
            match resultat {
                Ok(new_history) => {
                    history = new_history;
                    sent_chars = super::budget::request_chars(&system, &history, &tools);
                    if slash_compact.is_some() {
                        final_text = "Conversation compactée.".to_string();
                        break;
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, "compaction failed");
                    if slash_compact.is_some() {
                        let message = format!("Compaction impossible : {err}");
                        sink.emit(json!({"type": "turn_error", "error": message})).await;
                        final_text = message;
                        break;
                    }
                }
            }
        }

        let (sent_system, sent_history) =
            stable_request(&mut lock(&shared.stable_prefix), &system, volatile_from, &reminders, &history);
        // bascule — reasoning signed by another provider is dropped per
        // provider of the chain (see `stream_chain`).
        let mut provider_request = ProviderRequest::new(meta.model.clone(), sent_history)
            .with_system(sent_system)
            .with_tools(tools)
            .with_cache_key(meta.id.clone());
        provider_request.effort = meta.model.effort;
        provider_request.max_output_tokens = max_output_tokens;

        let debut_appel_ms = now_ms();
        // bascule — the session's provider first (or the backup already
        // used in this turn), then the backups designated for it.
        let chain = failover_chain(&shared.deps.providers, &meta.model, provider.clone(), &settings);
        let start = sticky_provider
            .as_deref()
            .and_then(|id| chain.iter().position(|(known, _)| known == id))
            .unwrap_or(0);
        let (assistant, usage, reason, used) = match stream_chain(&chain, start, provider_request, &sink).await {
            Ok(done) => done,
            Err(StreamFailure::Cancelled) => return Err(SessionError::Cancelled),
            // Over the context window: compact, then try once more.
            Err(StreamFailure::ContextLength(message)) if !retried_after_overflow => {
                tracing::warn!(error = %message, "context window exceeded, compacting");
                retried_after_overflow = true;
                *lock(&shared.compact_request) = Some(None);
                continue;
            }
            Err(StreamFailure::ContextLength(message) | StreamFailure::Provider(message) | StreamFailure::Down(message)) => {
                sink.record(JournalEntryKind::Extension {
                    name: "turn_error".into(),
                    payload: json!({"error": message}),
                })
                .await?;
                sink.emit(json!({"type": "turn_error", "error": message})).await;
                if let Err(err) = shared.family.on_turn_failed(&message).await {
                    tracing::warn!(error = %err, "sub-agent error delivery failed");
                }
                let meta = shared.meta();
                let used = (usage_total.input_tokens + usage_total.output_tokens) as u64;
                for hook in &shared.deps.hooks {
                    hook.turn_failed(&meta, &message, used).await;
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
        let (provider, call_model, switched) = match used {
            Some(Used { index, from }) => {
                let (id, backup) = chain[index].clone();
                sticky_provider = Some(id.clone());
                let model = axecode_core::ModelRef { provider: id, ..meta.model.clone() };
                (backup, model, from)
            }
            None => {
                sticky_provider = None;
                (provider, meta.model.clone(), None)
            }
        };
        add_usage(&mut usage_total, &usage);
        // Jauge du contexte et minuteur du cache de l'en-tête du chat (dernier appel).
        let appel = super::dernier_appel::noter_appel(
            &meta.id,
            &call_model,
            &usage,
            caps.as_ref(),
            settings.compaction_threshold,
            max_output_tokens,
            provider.prompt_cache_ttl_secs(&meta.model),
            debut_appel_ms,
            now_ms(),
        );
        sink.emit(json!({"type": "contexte", "appel": appel})).await;
        let billed = usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
        *lock(&shared.last_input_tokens) = billed;
        if billed > 0 {
            *lock(&shared.last_call_size) = Some((billed as u64, sent_chars));
        }
        stop_reason = Some(reason);
        let mut assistant = assistant;
        tag_signed_parts(&mut assistant, &origin_of(&call_model));
        if let Some(from) = switched {
            mark_failover(&mut assistant, &from, &call_model.provider);
        }
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
    // goal — hooks decide on autonomous continuation.
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
    // goal end
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
    // « Demander avant d'agir » : la cellule attend l'accord de l'utilisateur.
    if let Some(refus) = crate::agent::approbation::avant_cellule(
        &shared.data_dir, shared.host.as_ref(), &shared.meta(), sink, turn_id, call_id, &code,
    )
    .await?
    {
        return Ok(refus);
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
    /// bascule — the provider is down or out of quota (retries spent,
    /// plan limit, HTTP 5xx): a designated backup may take over.
    Down(String),
}

/// bascule — an error that says the provider (not the request) is the
/// problem: another provider serving the same model can answer.
fn provider_down(err: &AppError) -> bool {
    retryable(err)
        || matches!(err, AppError::RateLimit(_))
        || matches!(err, AppError::Provider(message) if is_http_5xx(message))
}

fn is_http_5xx(message: &str) -> bool {
    message
        .strip_prefix("HTTP ")
        .is_some_and(|rest| rest.starts_with('5') && rest.as_bytes().get(1).is_some_and(u8::is_ascii_digit))
}

/// bascule — retries left for one model call.
struct RetryBudget {
    /// Retries on one provider.
    per_provider: usize,
    /// Retries left for the whole chain.
    left: usize,
}

impl RetryBudget {
    /// Without backups: the historical behaviour ([`STREAM_BACKOFF`]).
    fn single() -> Self {
        Self { per_provider: STREAM_BACKOFF.len(), left: STREAM_BACKOFF.len() }
    }

    fn chain() -> Self {
        Self { per_provider: FAILOVER_RETRIES_PER_PROVIDER, left: FAILOVER_MAX_TOTAL_RETRIES }
    }
}

/// bascule — the chain of one model call: `(provider id, provider)`, the
/// session's provider first, then the live backups the user designated for it
/// that serve the same model (`capabilities` known). Failover off or no
/// backup: the session's provider alone.
fn failover_chain(
    resolver: &Arc<dyn super::ProviderResolver>,
    model: &axecode_core::ModelRef,
    primary: Arc<dyn axecode_core::Provider>,
    settings: &super::ReplSettings,
) -> Vec<(String, Arc<dyn axecode_core::Provider>)> {
    let mut chain = vec![(model.provider.clone(), primary)];
    for id in settings.bascule.secours_pour(&model.provider) {
        let Ok(backup) = resolver.provider(&id) else {
            tracing::warn!(provider = %id, "backup provider unavailable, skipped");
            continue;
        };
        let same_model = axecode_core::ModelRef { provider: id.clone(), ..model.clone() };
        if backup.capabilities(&same_model).is_none() {
            tracing::warn!(provider = %id, model = %model.name, "backup provider does not serve this model, skipped");
            continue;
        }
        chain.push((id, backup));
    }
    chain
}

/// bascule — which link of the chain answered, when it is not the first one tried.
#[derive(Debug, Clone, PartialEq)]
struct Used {
    index: usize,
    /// Provider it took over from in this call (`None`: no switch in this call).
    from: Option<String>,
}

/// bascule — one model call through the failover chain: retries on the
/// current provider ([`stream_attempts`]), then the next backup when the
/// provider is down ([`StreamFailure::Down`]), within one retry budget for
/// the whole call. Each switch is announced in the conversation (event
/// `provider_failover` + journal entry `bascule_fournisseur`). Returns which
/// link answered (`None`: the session's own provider).
async fn stream_chain(
    chain: &[(String, Arc<dyn axecode_core::Provider>)],
    start: usize,
    request: ProviderRequest,
    sink: &Arc<dyn TurnSink>,
) -> Result<(ChatMessage, Usage, StopReason, Option<Used>), StreamFailure> {
    let mut budget = if chain.len() > 1 { RetryBudget::chain() } else { RetryBudget::single() };
    let mut index = start.min(chain.len().saturating_sub(1));
    let mut from: Option<String> = None;
    loop {
        let (id, provider) = &chain[index];
        let mut sent = request.clone();
        sent.model.provider = id.clone();
        sent.transcript = without_foreign_signed_parts(sent.transcript, &origin_of(&sent.model));
        match stream_attempts(provider.as_ref(), sent, sink, &mut budget).await {
            Ok((message, usage, reason)) => {
                let used = (index > 0).then(|| Used { index, from: from.clone() });
                return Ok((message, usage, reason, used));
            }
            Err(StreamFailure::Down(error)) if index + 1 < chain.len() && budget.left > 0 => {
                budget.left -= 1;
                let next = &chain[index + 1].0;
                let reason = if error.starts_with("rate limited") { "limite" } else { "panne" };
                tracing::warn!(from = %id, to = %next, %error, "provider down, failing over");
                sink.emit(json!({
                    "type": "provider_failover",
                    "from": id,
                    "to": next,
                    "model": request.model.name,
                    "reason": reason,
                }))
                .await;
                let _ = sink
                    .record(JournalEntryKind::Extension {
                        name: "bascule_fournisseur".into(),
                        payload: json!({
                            "from": id,
                            "to": next,
                            "model": request.model.name,
                            "reason": reason,
                            "error": error.chars().take(300).collect::<String>(),
                        }),
                    })
                    .await;
                from = Some(id.clone());
                index += 1;
            }
            Err(failure) => return Err(failure),
        }
    }
}

/// bascule — the first part of the message that answered after a switch
/// carries `meta.bascule = {de, vers}`: the conversation shows the notice
/// again when it is reopened.
fn mark_failover(message: &mut ChatMessage, from: &str, to: &str) {
    let notice = json!({"de": from, "vers": to});
    let Some(part) = message.parts.first_mut() else {
        return;
    };
    let meta = match part {
        Part::Text { meta, .. }
        | Part::Image { meta, .. }
        | Part::Thinking { meta, .. }
        | Part::ToolCall { meta, .. }
        | Part::ToolResult { meta, .. } => meta,
    };
    let mut value = meta.take().unwrap_or_else(|| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert("bascule".into(), notice);
    }
    *meta = Some(value);
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
#[cfg(test)]
async fn stream_once(
    provider: &dyn axecode_core::Provider,
    request: ProviderRequest,
    sink: &Arc<dyn TurnSink>,
) -> Result<(ChatMessage, Usage, StopReason), StreamFailure> {
    stream_attempts(provider, request, sink, &mut RetryBudget::single()).await
}

/// [`stream_once`] within a retry budget (bascule): at most
/// `budget.per_provider` retries here, each one taken from `budget.left`.
async fn stream_attempts(
    provider: &dyn axecode_core::Provider,
    request: ProviderRequest,
    sink: &Arc<dyn TurnSink>,
    budget: &mut RetryBudget,
) -> Result<(ChatMessage, Usage, StopReason), StreamFailure> {
    let mut pauses = STREAM_BACKOFF.iter().take(budget.per_provider).enumerate();
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
        match pauses.next().filter(|_| budget.left > 0) {
            Some((retry, &units)) if retryable(&err) => {
                budget.left -= 1;
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
            _ if provider_down(&err) => return Err(StreamFailure::Down(err.to_string())),
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

/// Keeps every request of a conversation on the same prefix: replayed
/// thinking blocks are only accepted while the system prompt and the earlier
/// messages are byte-identical to when they were produced.
///
/// * The system prompt is frozen at its first value; if the stable part later
///   changes (harness edited during the conversation), the new layer is sent
///   as session state instead.
/// * Session state (todo, goal, peer messages...) is attached to the user
///   message it was sent with, and that same text is sent again with that
///   message on every later request.
pub(crate) fn stable_request(
    prefix: &mut super::runtime::StablePrefix,
    system: &str,
    volatile_from: Option<usize>,
    reminders: &[String],
    history: &[ChatMessage],
) -> (String, Vec<ChatMessage>) {
    let (stable, volatile) = match volatile_from {
        Some(at) if at <= system.len() && system.is_char_boundary(at) => {
            (&system[..at], system[at..].trim())
        }
        _ => (system, ""),
    };
    let mut state = volatile.to_string();
    let frozen = prefix.system.get_or_insert_with(|| stable.to_string()).clone();
    if frozen != stable {
        let layer = reminders
            .iter()
            .map(|block| block.trim())
            .filter(|block| !block.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !layer.is_empty() {
            state = format!("{layer}\n\n{state}").trim().to_string();
        }
    }
    // Entries past the end of the history (compaction, edit) are forgotten.
    let len = history.len();
    prefix.states.retain(|(index, _)| *index < len);
    if let Some(last) = len.checked_sub(1) {
        let is_user = history[last].role == Role::User;
        let known = prefix.states.iter().any(|(index, _)| *index == last);
        let unchanged = prefix.states.last().is_some_and(|(_, text)| *text == state);
        if is_user && !known && !state.is_empty() && !unchanged {
            prefix.states.push((last, state));
        }
    }
    let mut sent = history.to_vec();
    for (index, text) in &prefix.states {
        if let Some(message) = sent.get_mut(*index) {
            if message.role == Role::User {
                message.parts.push(Part::Text {
                    text: text.clone(),
                    meta: None,
                });
            }
        }
    }
    (frozen, sent)
}

/// Provider and model that produced a reasoning block.
fn origin_of(model: &axecode_core::ModelRef) -> String {
    format!("{}/{}", model.provider, model.name)
}

/// Marks reasoning blocks with the model that produced them: their
/// signature or encrypted content is only valid for that model.
fn tag_signed_parts(message: &mut ChatMessage, origin: &str) {
    for part in &mut message.parts {
        if let Part::Thinking { meta, .. } = part {
            let mut value = meta.take().unwrap_or_else(|| json!({}));
            if let Some(object) = value.as_object_mut() {
                object.entry("origin").or_insert_with(|| json!(origin));
            }
            *meta = Some(value);
        }
    }
}

/// Drops the reasoning blocks produced by another provider or model (the
/// answers themselves stay), so a conversation can switch models.
pub(crate) fn without_foreign_signed_parts(mut history: Vec<ChatMessage>, origin: &str) -> Vec<ChatMessage> {
    for message in &mut history {
        message.parts.retain(|part| match part {
            Part::Thinking { meta, .. } => meta
                .as_ref()
                .and_then(|meta| meta.get("origin"))
                .and_then(Value::as_str)
                .map_or(true, |from| from == origin),
            _ => true,
        });
    }
    history.retain(|message| !message.parts.is_empty());
    history
}

#[cfg(test)]
mod model_switch_tests {
    use super::*;
    use axecode_core::ModelRef;

    /// same model, other Claude account (`anthropic~2`): the signed
    /// reasoning of the first account is not sent to the second one (its signature
    /// would be refused), the answers stay; back on the first account it is kept.
    #[test]
    fn switching_account_drops_reasoning_signed_by_the_other_account() {
        let first = origin_of(&ModelRef::new("anthropic", "claude-opus-5-5"));
        let second = origin_of(&ModelRef::new("anthropic~2", "claude-opus-5-5"));
        assert_ne!(first, second);
        let mut answer = ChatMessage {
            role: Role::Assistant,
            parts: vec![
                Part::Thinking { text: "why".into(), meta: Some(json!({"provider": "anthropic", "signature": "s"})) },
                Part::Text { text: "answer".into(), meta: None },
            ],
        };
        tag_signed_parts(&mut answer, &first);
        let history = vec![ChatMessage::user_text("q1"), answer, ChatMessage::user_text("q2")];
        let other = without_foreign_signed_parts(history.clone(), &second);
        assert_eq!(other[1].parts.len(), 1);
        assert!(matches!(&other[1].parts[0], Part::Text { text, .. } if text == "answer"));
        assert_eq!(without_foreign_signed_parts(history, &first)[1].parts.len(), 2);
    }

    #[test]
    fn switching_model_drops_reasoning_of_the_previous_one() {
        let opus = origin_of(&ModelRef::new("anthropic", "claude-opus-5-5"));
        let gpt = origin_of(&ModelRef::new("openai", "gpt-5"));
        let mut answer = ChatMessage {
            role: Role::Assistant,
            parts: vec![
                Part::Thinking {
                    text: "why".into(),
                    meta: Some(json!({"provider": "anthropic", "signature": "s"})),
                },
                Part::Text { text: "answer".into(), meta: None },
            ],
        };
        tag_signed_parts(&mut answer, &opus);
        let history = vec![ChatMessage::user_text("q1"), answer, ChatMessage::user_text("q2")];

        let same = without_foreign_signed_parts(history.clone(), &opus);
        assert_eq!(same[1].parts.len(), 2, "same model keeps its reasoning");

        let other = without_foreign_signed_parts(history, &gpt);
        assert_eq!(other.len(), 3);
        assert_eq!(other[1].parts.len(), 1);
        assert!(matches!(&other[1].parts[0], Part::Text { text, .. } if text == "answer"));
    }
}

#[cfg(test)]
mod stable_prefix_tests {
    use super::*;
    use crate::repl::prompt;

    fn split(todo: &str, layer: &str) -> (String, Option<usize>, Vec<String>) {
        let reminders = vec![layer.to_string()];
        let state = vec![format!("<todo_list_state>\n{todo}\n</todo_list_state>")];
        let (system, at) = prompt::system_prompt_split("\n## files\n", None, &reminders, &state);
        (system, at, reminders)
    }

    #[test]
    fn two_turns_keep_the_system_prompt_and_earlier_messages_identical() {
        let mut prefix = super::super::runtime::StablePrefix::default();
        let mut history = vec![ChatMessage::user_text("first")];
        let (system, at, reminders) = split("- 1 [pending] a", "## Notes\n- old");
        let (system_1, sent_1) = stable_request(&mut prefix, &system, at, &reminders, &history);

        history.push(ChatMessage {
            role: Role::Assistant,
            parts: vec![Part::Text { text: "answer".into(), meta: None }],
        });
        history.push(ChatMessage::user_text("second"));
        // Todo state and harness layer both changed between the two turns.
        let (system, at, reminders) = split("- 1 [done] a", "## Notes\n- new");
        let (system_2, sent_2) = stable_request(&mut prefix, &system, at, &reminders, &history);

        assert_eq!(system_1.as_bytes(), system_2.as_bytes());
        assert!(!system_1.contains("todo_list_state"));
        let json = |m: &ChatMessage| serde_json::to_string(m).unwrap();
        assert_eq!(json(&sent_1[0]), json(&sent_2[0]), "earlier user message must not change");
        assert!(json(&sent_1[0]).contains("[pending]"));
        let last = json(sent_2.last().unwrap());
        assert!(last.contains("[done]") && last.contains("- new"));
        // A third request of the same turn (tool round) changes nothing earlier.
        let (_, sent_3) = stable_request(&mut prefix, &system, at, &reminders, &history);
        assert_eq!(json(&sent_2[2]), json(&sent_3[2]));
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
        /// Provider id of each request received (bascule).
        seen: Mutex<Vec<String>>,
        /// `capabilities` answers (the provider serves the model).
        serves: bool,
    }

    impl Fake {
        fn new(script: fn(usize) -> Events) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                script,
                seen: Mutex::new(Vec::new()),
                serves: false,
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
        fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities> {
            self.serves.then(|| ModelCapabilities {
                model: model.clone(),
                context_window: 1_000,
                preferred_window: 900,
                max_output_tokens: 100,
                supports_thinking: false,
                visible_thinking: false,
                supports_tools: true,
                supports_images: false,
                effort_mode: axecode_core::EffortMode::None,
            })
        }
        async fn estimate_tokens(&self, _request: ProviderRequest) -> CoreResult<TokenEstimate> {
            Ok(TokenEstimate {
                input_tokens: 0,
                exact: false,
            })
        }
        async fn stream(&self, request: ProviderRequest) -> CoreResult<ProviderStream> {
            self.seen.lock().unwrap().push(request.model.provider.clone());
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(stream::iter((self.script)(n))))
        }
    }

    #[derive(Default)]
    struct Sink {
        events: Mutex<Vec<Value>>,
        records: Mutex<Vec<JournalEntryKind>>,
        cancelled: AtomicBool,
    }

    #[async_trait]
    impl TurnSink for Sink {
        async fn record(&self, kind: JournalEntryKind) -> SessionResult<EntryId> {
            self.records.lock().unwrap().push(kind);
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
        assert!(matches!(failure, Err(StreamFailure::Down(_))));
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

    // ---- bascule — provider failover ----

    use super::{
        failover_chain, is_http_5xx, mark_failover, stream_chain, Used, FAILOVER_MAX_TOTAL_RETRIES,
        FAILOVER_RETRIES_PER_PROVIDER,
    };
    use crate::repl::{settings::BasculeSettings, ProviderResolver, ReplSettings};
    use axecode_core::ChatMessage;

    fn ok_answer(_n: usize) -> Events {
        let mut events = text("answer from the backup");
        events.push(Ok(StreamEvent::MessageStop {
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
        }));
        events
    }

    fn plan_limit(_n: usize) -> Events {
        vec![Err(AppError::RateLimit("usage limit reached for this plan".into()))]
    }

    fn chain(links: &[(&str, &Arc<Fake>)]) -> Vec<(String, Arc<dyn Provider>)> {
        links
            .iter()
            .map(|(id, fake)| (id.to_string(), (*fake).clone() as Arc<dyn Provider>))
            .collect()
    }

    fn failovers(sink: &Sink) -> Vec<Value> {
        sink.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "provider_failover")
            .cloned()
            .collect()
    }

    fn journal_notices(sink: &Sink) -> usize {
        sink.records
            .lock()
            .unwrap()
            .iter()
            .filter(|k| matches!(k, JournalEntryKind::Extension { name, .. } if name == "bascule_fournisseur"))
            .count()
    }

    #[tokio::test]
    async fn bascule_transient_outage_stays_on_the_first_provider() {
        let (first, second) = (Arc::new(Fake::new(cut_then_complete)), Arc::new(Fake::new(ok_answer)));
        let sink = Arc::new(Sink::default());
        let turn_sink: Arc<dyn TurnSink> = sink.clone();
        let links = chain(&[("anthropic", &first), ("anthropic~2", &second)]);
        let Ok((message, _, _, used)) = stream_chain(&links, 0, request(), &turn_sink).await else {
            panic!("the retry on the first provider should succeed");
        };
        assert_eq!(message.text(), "complete answer");
        assert_eq!(used, None);
        assert_eq!((first.calls(), second.calls()), (2, 0));
        assert!(failovers(&sink).is_empty());
    }

    #[tokio::test]
    async fn bascule_lasting_outage_finishes_on_the_backup() {
        let (first, second) = (Arc::new(Fake::new(network_down)), Arc::new(Fake::new(ok_answer)));
        let sink = Arc::new(Sink::default());
        let turn_sink: Arc<dyn TurnSink> = sink.clone();
        let links = chain(&[("anthropic", &first), ("anthropic~2", &second)]);
        let Ok((message, _, _, used)) = stream_chain(&links, 0, request(), &turn_sink).await else {
            panic!("the backup should answer");
        };
        assert_eq!(message.text(), "answer from the backup");
        assert_eq!(used, Some(Used { index: 1, from: Some("anthropic".into()) }));
        assert_eq!(first.calls(), 1 + FAILOVER_RETRIES_PER_PROVIDER, "3 retries, not the 7 of the single provider");
        assert_eq!(second.calls(), 1);
        assert_eq!(*second.seen.lock().unwrap(), ["anthropic~2"], "the request names the backup");
        let notices = failovers(&sink);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0]["from"], "anthropic");
        assert_eq!(notices[0]["to"], "anthropic~2");
        assert_eq!(notices[0]["reason"], "panne");
        assert_eq!(journal_notices(&sink), 1);
    }

    #[tokio::test]
    async fn bascule_plan_limit_switches_at_once() {
        let (first, second) = (Arc::new(Fake::new(plan_limit)), Arc::new(Fake::new(ok_answer)));
        let sink = Arc::new(Sink::default());
        let turn_sink: Arc<dyn TurnSink> = sink.clone();
        let links = chain(&[("anthropic", &first), ("axe-cloud", &second)]);
        let Ok((_, _, _, used)) = stream_chain(&links, 0, request(), &turn_sink).await else {
            panic!("the backup should answer");
        };
        assert_eq!(used.map(|u| u.index), Some(1));
        assert_eq!((first.calls(), second.calls()), (1, 1), "a plan limit is not retried");
        assert_eq!(failovers(&sink)[0]["reason"], "limite");
    }

    #[tokio::test]
    async fn bascule_off_keeps_the_old_behaviour() {
        // Plan limit, no backup: the turn fails as before (then waits for the quota).
        let first = Arc::new(Fake::new(plan_limit));
        let sink = Arc::new(Sink::default());
        let turn_sink: Arc<dyn TurnSink> = sink.clone();
        let links = chain(&[("anthropic", &first)]);
        let failure = stream_chain(&links, 0, request(), &turn_sink).await;
        assert!(matches!(failure, Err(StreamFailure::Down(ref m)) if m.contains("usage limit")));
        assert_eq!(first.calls(), 1);
        // Network down, no backup: still the 7 retries of STREAM_BACKOFF.
        let down = Arc::new(Fake::new(network_down));
        let links = chain(&[("anthropic", &down)]);
        assert!(stream_chain(&links, 0, request(), &turn_sink).await.is_err());
        assert_eq!(down.calls(), 1 + STREAM_BACKOFF.len());
        assert!(failovers(&sink).is_empty());
        assert_eq!(journal_notices(&sink), 0);
    }

    #[tokio::test]
    async fn bascule_total_attempts_are_bounded() {
        let fakes: Vec<Arc<Fake>> = (0..4).map(|_| Arc::new(Fake::new(network_down))).collect();
        let sink = Arc::new(Sink::default());
        let turn_sink: Arc<dyn TurnSink> = sink.clone();
        let links = chain(&[("a", &fakes[0]), ("b", &fakes[1]), ("c", &fakes[2]), ("d", &fakes[3])]);
        let failure = stream_chain(&links, 0, request(), &turn_sink).await;
        assert!(matches!(failure, Err(StreamFailure::Down(_))));
        let calls: Vec<usize> = fakes.iter().map(|f| f.calls()).collect();
        assert_eq!(calls, [4, 4, 1, 0]);
        assert_eq!(calls.iter().sum::<usize>(), 1 + FAILOVER_MAX_TOTAL_RETRIES);
    }

    #[tokio::test]
    async fn bascule_request_errors_never_fail_over() {
        let (first, second) = (Arc::new(Fake::new(refused)), Arc::new(Fake::new(ok_answer)));
        let sink = Arc::new(Sink::default());
        let turn_sink: Arc<dyn TurnSink> = sink.clone();
        let links = chain(&[("anthropic", &first), ("anthropic~2", &second)]);
        let failure = stream_chain(&links, 0, request(), &turn_sink).await;
        assert!(matches!(failure, Err(StreamFailure::Provider(_))));
        assert_eq!((first.calls(), second.calls()), (1, 0));
    }

    #[tokio::test]
    async fn bascule_next_rounds_start_on_the_backup() {
        let (first, second) = (Arc::new(Fake::new(network_down)), Arc::new(Fake::new(ok_answer)));
        let sink: Arc<dyn TurnSink> = Arc::new(Sink::default());
        let links = chain(&[("anthropic", &first), ("anthropic~2", &second)]);
        let Ok((_, _, _, used)) = stream_chain(&links, 1, request(), &sink).await else {
            panic!("the backup should answer");
        };
        assert_eq!(used, Some(Used { index: 1, from: None }), "no new switch, no new notice");
        assert_eq!((first.calls(), second.calls()), (0, 1));
    }

    struct Resolver(Vec<(String, Arc<Fake>)>);

    impl ProviderResolver for Resolver {
        fn provider(&self, id: &str) -> Result<Arc<dyn Provider>, String> {
            self.0
                .iter()
                .find(|(known, _)| known == id)
                .map(|(_, fake)| fake.clone() as Arc<dyn Provider>)
                .ok_or_else(|| format!("provider `{id}` is not configured"))
        }
    }

    #[test]
    fn bascule_chain_holds_only_designated_backups_serving_the_model() {
        let serving = |serves| Arc::new(Fake { serves, ..Fake::new(ok_answer) });
        let resolver: Arc<dyn ProviderResolver> = Arc::new(Resolver(vec![
            ("anthropic~2".into(), serving(true)),
            ("other-model".into(), serving(false)),
            ("axe-cloud".into(), serving(true)),
        ]));
        let model = ModelRef::new("anthropic", "claude-opus-5-5");
        let primary: Arc<dyn Provider> = Arc::new(Fake::new(ok_answer));
        let ids = |settings: &ReplSettings| -> Vec<String> {
            failover_chain(&resolver, &model, primary.clone(), settings)
                .into_iter()
                .map(|(id, _)| id)
                .collect()
        };
        let mut settings = ReplSettings::default();
        assert_eq!(ids(&settings), ["anthropic"], "off by default");
        settings.bascule = BasculeSettings {
            enabled: true,
            secours: [
                ("anthropic".to_string(), vec!["missing".into(), "other-model".into(), "anthropic~2".into()]),
                // A company key designated for ANOTHER provider never backs this one.
                ("openai".to_string(), vec!["axe-cloud".into()]),
            ]
            .into_iter()
            .collect(),
        };
        assert_eq!(ids(&settings), ["anthropic", "anthropic~2"]);
        settings.bascule.enabled = false;
        assert_eq!(ids(&settings), ["anthropic"]);
    }

    #[test]
    fn bascule_notice_and_error_classes() {
        let mut message = ChatMessage {
            role: axecode_core::Role::Assistant,
            parts: vec![axecode_core::Part::Text { text: "ok".into(), meta: None }],
        };
        mark_failover(&mut message, "anthropic", "anthropic~2");
        let axecode_core::Part::Text { meta: Some(meta), .. } = &message.parts[0] else {
            panic!("meta expected");
        };
        assert_eq!(meta["bascule"], serde_json::json!({"de": "anthropic", "vers": "anthropic~2"}));
        assert!(is_http_5xx("HTTP 529 <unknown status code>: overloaded"));
        assert!(is_http_5xx("HTTP 503 Service Unavailable: x"));
        assert!(!is_http_5xx("HTTP 400 Bad Request: x"));
        assert!(!is_http_5xx("HTTP 5"));
        assert!(!is_http_5xx("invalid request"));
    }
}
