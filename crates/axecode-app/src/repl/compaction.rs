//! Compaction for REPL sessions: summarise the branch with the model and
//! journal a `Compaction` entry. Kernel variables are kept, and the model is
//! told which names are still defined (axe:uh-d1, `axecode_repl::etat`).

use std::{sync::Arc, time::Duration};

use serde_json::json;
use axecode_core::{ChatMessage, JournalEntryKind, Provider, TurnSink};
use tokio::sync::mpsc;

use super::runtime::{lock, Shared};

/// How long the namespace listing may take: a stuck kernel degrades the
/// notice (no names) rather than hanging the compaction.
const NAMES_TIMEOUT: Duration = Duration::from_secs(5);

/// The `[python-state]` notice, or `None` when no kernel is running (nothing
/// was defined in this conversation yet, or the kernel died: the next call
/// restarts it and says what came back).
async fn kernel_notice(kernel: Option<Arc<axecode_repl::Kernel>>) -> Option<String> {
    let kernel = kernel.filter(|k| k.is_alive())?;
    let names = match tokio::time::timeout(NAMES_TIMEOUT, kernel.names()).await {
        Ok(Ok(ns)) => Some(ns),
        Ok(Err(err)) => {
            tracing::warn!(error = %err, "kernel names after compaction");
            None
        }
        Err(_) => None,
    };
    Some(axecode_repl::etat::notice_after_compaction(names.as_ref()))
}

pub(crate) async fn compact(
    shared: &Arc<Shared>,
    provider: Arc<dyn Provider>,
    system: &str,
    history: &[ChatMessage],
    directive: Option<String>,
    sink: &Arc<dyn TurnSink>,
    kernel: Option<Arc<axecode_repl::Kernel>>,
) -> anyhow::Result<Vec<ChatMessage>> {
    sink.emit(json!({"type": "compaction_start", "directive": directive})).await;
    let meta = shared.meta();
    let (_cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
    let output = crate::compact_conversation_history(
        provider,
        meta.model.clone(),
        system.to_string(),
        history.to_vec(),
        Some(meta.id.clone()),
        0,
        None,
        directive.clone(),
        &mut cmd_rx,
        None,
    )
    .await?;
    let mut summary = output.summary.trim().to_string();
    // Kept in the journaled summary so that a history rebuilt from the
    // journal (next turn, reload) carries the notice too.
    if let Some(notice) = kernel_notice(kernel).await {
        summary = format!("{summary}\n\n{notice}");
    }
    // Empty bounds: the daemon sink resolves them to the whole branch.
    sink.record(JournalEntryKind::Compaction {
        summary: summary.clone(),
        from_entry: String::new(),
        to_entry: String::new(),
        directive,
    })
    .await?;
    *lock(&shared.last_input_tokens) = 0;
    sink.emit(json!({"type": "compaction_done", "summary": summary})).await;
    Ok(vec![ChatMessage::user_text(format!(
        "<compacted_history>\n{summary}\n</compacted_history>"
    ))])
}
