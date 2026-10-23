//! Compaction for REPL sessions: summarise the branch with the model and
//! journal a `Compaction` entry. Kernel variables are kept.

use std::sync::Arc;

use serde_json::json;
use axecode_core::{ChatMessage, JournalEntryKind, Provider, TurnSink};
use tokio::sync::mpsc;

use super::runtime::{lock, Shared};

pub(crate) async fn compact(
    shared: &Arc<Shared>,
    provider: Arc<dyn Provider>,
    system: &str,
    history: &[ChatMessage],
    directive: Option<String>,
    sink: &Arc<dyn TurnSink>,
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
    let summary = output.summary.trim().to_string();
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
