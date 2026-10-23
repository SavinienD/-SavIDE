//! Placeholder runtime used until the REPL runtime (chantier C) is wired in.

use std::sync::Arc;

use async_trait::async_trait;
use axecode_core::{
    ChatMessage, JournalEntryKind, RuntimeContext, SessionResult, SessionRuntime,
    SessionRuntimeFactory, TurnInput, TurnOutcome, TurnRequest, TurnSink,
};

pub struct EchoRuntime;

#[async_trait]
impl SessionRuntime for EchoRuntime {
    async fn run_turn(
        &self,
        request: TurnRequest,
        sink: Arc<dyn TurnSink>,
    ) -> SessionResult<TurnOutcome> {
        let text = match &request.input {
            TurnInput::User { message } => format!("echo: {}", message.text()),
            TurnInput::Heartbeat { text } => format!("heartbeat: {text}"),
            TurnInput::Resume => "resumed".to_string(),
            TurnInput::Continue => "continued".to_string(),
        };
        sink.record(JournalEntryKind::Message {
            message: ChatMessage::assistant_text(text.clone()),
            usage: None,
            turn_id: Some(request.turn_id),
        })
        .await?;
        Ok(TurnOutcome {
            final_text: text,
            ..Default::default()
        })
    }
}

pub struct EchoFactory;

#[async_trait]
impl SessionRuntimeFactory for EchoFactory {
    async fn create(&self, _context: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(Arc::new(EchoRuntime))
    }
}
