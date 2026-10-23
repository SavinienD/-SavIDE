// axe:providers — user-configurable provider instances and model catalogs.
//
// These types are shared between the desktop app (persistence + IPC), the
// provider crates (which build a `Provider` from a `ProviderConfig`) and the
// frontend (serialized as camelCase JSON).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::model::{EffortMode, ModelCapabilities, ModelRef};

/// Wire family / vendor of a configurable provider instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// Any endpoint speaking the OpenAI `/chat/completions` protocol.
    OpenAiCompatible,
    /// Any endpoint speaking the Anthropic `/v1/messages` protocol.
    AnthropicCompatible,
    Mistral,
    DeepSeek,
    Xai,
    Groq,
    /// Prime Intellect inference (OpenAI-compatible).
    Prime,
    /// Local Ollama server (auto-detected).
    Ollama,
    /// Local LM Studio server (auto-detected).
    LmStudio,
}

impl ProviderKind {
    pub const ALL: &'static [ProviderKind] = &[
        ProviderKind::OpenAiCompatible,
        ProviderKind::AnthropicCompatible,
        ProviderKind::Mistral,
        ProviderKind::DeepSeek,
        ProviderKind::Xai,
        ProviderKind::Groq,
        ProviderKind::Prime,
        ProviderKind::Ollama,
        ProviderKind::LmStudio,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "OpenAI-compatible",
            Self::AnthropicCompatible => "Anthropic-compatible",
            Self::Mistral => "Mistral",
            Self::DeepSeek => "DeepSeek",
            Self::Xai => "xAI",
            Self::Groq => "Groq",
            Self::Prime => "Prime Inference",
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
        }
    }

    /// Native adapters and local servers are single-instance; their provider
    /// id is fixed so model refs stay stable across reconfiguration.
    pub fn builtin_id(self) -> Option<&'static str> {
        match self {
            Self::OpenAiCompatible | Self::AnthropicCompatible => None,
            Self::Mistral => Some("mistral"),
            Self::DeepSeek => Some("deepseek"),
            Self::Xai => Some("xai"),
            Self::Groq => Some("groq"),
            Self::Prime => Some("prime"),
            Self::Ollama => Some("ollama"),
            Self::LmStudio => Some("lmstudio"),
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "",
            Self::AnthropicCompatible => "https://api.anthropic.com",
            Self::Mistral => "https://api.mistral.ai/v1",
            Self::DeepSeek => "https://api.deepseek.com",
            Self::Xai => "https://api.x.ai/v1",
            Self::Groq => "https://api.groq.com/openai/v1",
            Self::Prime => "https://api.pinference.ai/api/v1",
            Self::Ollama => "http://localhost:11434",
            Self::LmStudio => "http://localhost:1234/v1",
        }
    }

    pub fn is_local(self) -> bool {
        matches!(self, Self::Ollama | Self::LmStudio)
    }

    pub fn requires_api_key(self) -> bool {
        !self.is_local() && !matches!(self, Self::OpenAiCompatible | Self::AnthropicCompatible)
    }

    pub fn uses_anthropic_wire(self) -> bool {
        matches!(self, Self::AnthropicCompatible)
    }
}

fn default_true() -> bool {
    true
}

fn default_context_window() -> u32 {
    128_000
}

fn default_max_output_tokens() -> u32 {
    16_384
}

/// A model exposed by a configurable provider, with declared capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDefinition {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_context_window")]
    pub context_window: u32,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32,
    #[serde(default = "default_true")]
    pub supports_tools: bool,
    #[serde(default)]
    pub supports_reasoning: bool,
    #[serde(default)]
    pub supports_vision: bool,
}

impl ModelDefinition {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: String::new(),
            context_window: default_context_window(),
            max_output_tokens: default_max_output_tokens(),
            supports_tools: true,
            supports_reasoning: false,
            supports_vision: false,
        }
    }

    pub fn display_label(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.id
        } else {
            &self.label
        }
    }

    /// Trim identifiers and clamp token budgets; returns `None` when the id is empty.
    pub fn normalized(mut self) -> Option<Self> {
        self.id = self.id.trim().to_string();
        if self.id.is_empty() {
            return None;
        }
        self.label = self.label.trim().to_string();
        self.context_window = self.context_window.max(1);
        self.max_output_tokens = self.max_output_tokens.max(1).min(self.context_window);
        Some(self)
    }

    pub fn capabilities(&self, provider_id: &str) -> ModelCapabilities {
        let context_window = self.context_window.max(1);
        ModelCapabilities {
            model: ModelRef::new(provider_id, self.id.clone()),
            context_window,
            preferred_window: preferred_window(context_window),
            max_output_tokens: self.max_output_tokens.max(1).min(context_window),
            supports_thinking: self.supports_reasoning,
            visible_thinking: self.supports_reasoning,
            supports_tools: self.supports_tools,
            supports_images: self.supports_vision,
            effort_mode: if self.supports_reasoning {
                EffortMode::Tier
            } else {
                EffortMode::None
            },
        }
    }
}

pub fn preferred_window(context_window: u32) -> u32 {
    ((context_window as u64 * 9) / 10)
        .max(1)
        .min(u32::MAX as u64) as u32
}

/// One configured provider instance. API keys are stored separately and never
/// travel inside this struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ModelDefinition>,
}

impl ProviderConfig {
    pub fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            self.name = self.kind.label().to_string();
        }
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        if self.base_url.is_empty() {
            self.base_url = self.kind.default_base_url().to_string();
        }
        let mut seen = std::collections::HashSet::new();
        self.models = self
            .models
            .drain(..)
            .filter_map(ModelDefinition::normalized)
            .filter(|model| seen.insert(model.id.clone()))
            .collect();
        self
    }

    pub fn model(&self, id: &str) -> Option<&ModelDefinition> {
        self.models.iter().find(|model| model.id == id)
    }
}

/// Per-model overrides applied on top of whatever a provider advertises.
/// Keyed by `"{provider}:{model}"` in [`ProviderSettings::model_overrides`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
}

impl ModelOverride {
    pub fn is_empty(&self) -> bool {
        self.context_window.is_none() && self.max_output_tokens.is_none()
    }

    pub fn apply(&self, caps: &mut ModelCapabilities) {
        if let Some(window) = self.context_window.filter(|value| *value > 0) {
            caps.context_window = window;
            caps.preferred_window = preferred_window(window);
        }
        if let Some(output) = self.max_output_tokens.filter(|value| *value > 0) {
            caps.max_output_tokens = output;
        }
        caps.max_output_tokens = caps.max_output_tokens.max(1).min(caps.context_window.max(1));
    }
}

pub fn model_override_key(model: &ModelRef) -> String {
    format!("{}:{}", model.provider, model.name)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub model_overrides: HashMap<String, ModelOverride>,
}

impl ProviderSettings {
    pub fn normalized(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        self.providers = self
            .providers
            .drain(..)
            .map(ProviderConfig::normalized)
            .filter(|provider| !provider.id.is_empty() && seen.insert(provider.id.clone()))
            .collect();
        self.model_overrides.retain(|_, value| !value.is_empty());
        self
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.iter().find(|provider| provider.id == id)
    }

    pub fn override_for(&self, model: &ModelRef) -> Option<&ModelOverride> {
        self.model_overrides.get(&model_override_key(model))
    }
}

/// Flattened entry for the unified model selector.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub provider_id: String,
    pub provider_label: String,
    pub provider_kind: ProviderKind,
    pub model_id: String,
    pub label: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub supports_tools: bool,
    pub supports_reasoning: bool,
    pub supports_vision: bool,
    pub local: bool,
}

impl ModelCatalogEntry {
    pub fn from_definition(provider: &ProviderConfig, model: &ModelDefinition) -> Self {
        Self {
            provider_id: provider.id.clone(),
            provider_label: provider.name.clone(),
            provider_kind: provider.kind,
            model_id: model.id.clone(),
            label: model.display_label().to_string(),
            context_window: model.context_window,
            max_output_tokens: model.max_output_tokens,
            supports_tools: model.supports_tools,
            supports_reasoning: model.supports_reasoning,
            supports_vision: model.supports_vision,
            local: provider.kind.is_local(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_drops_empty_and_duplicate_models() {
        let config = ProviderConfig {
            id: " custom-1 ".into(),
            name: "".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://example.com/v1/".into(),
            enabled: true,
            models: vec![
                ModelDefinition::new("a"),
                ModelDefinition::new(" "),
                ModelDefinition::new("a"),
            ],
        }
        .normalized();
        assert_eq!(config.id, "custom-1");
        assert_eq!(config.name, "OpenAI-compatible");
        assert_eq!(config.base_url, "https://example.com/v1");
        assert_eq!(config.models.len(), 1);
    }

    #[test]
    fn override_clamps_output_to_window() {
        let mut caps = ModelDefinition::new("m").capabilities("p");
        ModelOverride {
            context_window: Some(8_000),
            max_output_tokens: None,
        }
        .apply(&mut caps);
        assert_eq!(caps.context_window, 8_000);
        assert_eq!(caps.max_output_tokens, 8_000);
        assert_eq!(caps.preferred_window, 7_200);
    }
}
