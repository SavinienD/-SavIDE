use async_trait::async_trait;

use crate::{
    error::Result,
    message::ChatMessage,
    model::{Effort, ModelCapabilities, ModelRef},
    stream::ProviderStream,
    tool::ToolDescriptor,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceTier {
    Fast,
    Flex,
}

/// Default response budget used when the caller did not request one explicitly.
///
/// Several providers count requested output tokens against the model context window.
/// Using the advertised maximum output by default can make otherwise-small prompts
/// overflow on large-output models, so the implicit budget stays conservative.
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 32_000;

#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub model: ModelRef,
    pub system_prompt: Option<String>,
    pub transcript: Vec<ChatMessage>,
    pub tools: Vec<ToolDescriptor>,
    pub max_output_tokens: Option<u32>,
    pub effort: Option<Effort>,
    pub temperature: Option<f32>,
    pub cache_key: Option<String>,
    pub cache_stable_message_count: Option<usize>,
    pub service_tier: Option<ServiceTier>,
    /// axe:cache — byte offset in `system_prompt` where per-request state
    /// starts (todo list, goal budget, peer messages, notices). Everything
    /// before it stays the same for the whole session. Providers with prompt
    /// caching send the tail outside the cached prefix (see
    /// [`ProviderRequest::system_parts`]); the others send `system_prompt` as is.
    pub volatile_system_from: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
pub struct TokenEstimate {
    pub input_tokens: u32,
    pub exact: bool,
}

impl ProviderRequest {
    pub fn new(model: ModelRef, transcript: Vec<ChatMessage>) -> Self {
        Self {
            model,
            system_prompt: None,
            transcript,
            tools: Vec::new(),
            max_output_tokens: None,
            effort: None,
            temperature: None,
            cache_key: None,
            cache_stable_message_count: None,
            service_tier: None,
            volatile_system_from: None,
        }
    }

    pub fn with_system(mut self, value: impl Into<String>) -> Self {
        self.system_prompt = Some(value.into());
        self
    }

    pub fn with_tools(mut self, tools: Vec<ToolDescriptor>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_effort(mut self, effort: Effort) -> Self {
        self.effort = Some(effort);
        self
    }

    pub fn with_cache_key(mut self, value: impl Into<String>) -> Self {
        let value = value.into();
        if !value.trim().is_empty() {
            self.cache_key = Some(value);
        }
        self
    }

    pub fn with_cache_stable_message_count(mut self, value: usize) -> Self {
        self.cache_stable_message_count = Some(value);
        self
    }

    pub fn with_service_tier(mut self, value: ServiceTier) -> Self {
        self.service_tier = Some(value);
        self
    }

    /// axe:cache — marks `system_prompt[offset..]` as per-request state.
    pub fn with_volatile_system_from(mut self, offset: usize) -> Self {
        self.volatile_system_from = Some(offset);
        self
    }

    /// axe:cache — `(stable, volatile)` parts of the system prompt. `volatile`
    /// is `None` when there is no marker, nothing after it, or a bad offset.
    pub fn system_parts(&self) -> (Option<&str>, Option<&str>) {
        let Some(system) = self.system_prompt.as_deref() else {
            return (None, None);
        };
        match self.volatile_system_from {
            Some(at) if at < system.len() && system.is_char_boundary(at) => {
                let (stable, volatile) = system.split_at(at);
                let volatile = volatile.trim();
                (Some(stable), (!volatile.is_empty()).then_some(volatile))
            }
            _ => (Some(system), None),
        }
    }

    pub fn effective_effort(&self) -> Option<Effort> {
        self.effort.or(self.model.effort)
    }

    pub fn output_token_budget(&self, caps: &ModelCapabilities) -> u32 {
        let requested = self
            .max_output_tokens
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
            .max(1);
        requested
            .min(caps.max_output_tokens.max(1))
            .min(caps.context_window.max(1))
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities>;
    async fn estimate_tokens(&self, request: ProviderRequest) -> Result<TokenEstimate>;
    async fn stream(&self, request: ProviderRequest) -> Result<ProviderStream>;
}
