use axecode_core::{EffortMode, ModelCapabilities, ModelRef};

pub const MODEL_ID: &str = "claude-opus-5-5";
pub const MODEL_WINDOW: u32 = 1_000_000;
pub const MODEL_MAX_OUTPUT: u32 = 128_000;

struct AnthropicModelInfo {
    id: &'static str,
    context_window: u32,
    preferred_window: u32,
    max_output_tokens: u32,
}

const MODELS: &[AnthropicModelInfo] = &[
    AnthropicModelInfo {
        id: "claude-opus-5-5",
        context_window: 1_000_000,
        preferred_window: 900_000,
        max_output_tokens: 128_000,
    },
    AnthropicModelInfo {
        id: "claude-fable-5-1",
        context_window: 1_000_000,
        preferred_window: 900_000,
        max_output_tokens: 128_000,
    },
    AnthropicModelInfo {
        id: "claude-fable-5",
        context_window: 1_000_000,
        preferred_window: 900_000,
        max_output_tokens: 128_000,
    },
    AnthropicModelInfo {
        id: "claude-sonnet-5-5",
        context_window: 1_000_000,
        preferred_window: 900_000,
        max_output_tokens: 128_000,
    },
    AnthropicModelInfo {
        id: "claude-sonnet-5",
        context_window: 1_000_000,
        preferred_window: 900_000,
        max_output_tokens: 128_000,
    },
    AnthropicModelInfo {
        id: "claude-haiku-5-5",
        context_window: 1_000_000,
        preferred_window: 900_000,
        max_output_tokens: 128_000,
    },
];

fn model_info(model_id: &str) -> &'static AnthropicModelInfo {
    MODELS
        .iter()
        .find(|info| info.id == model_id)
        .unwrap_or(&MODELS[0])
}

/// axe:compaction — Anthropic-compatible endpoints (the Axe Cloud meter, model
/// discovery) declare 200 000 tokens; a known Claude model keeps its real
/// window (Prime Agent runs Opus 5.5 past 800 k without any beta). Only
/// raises the window; user overrides are applied after.
pub fn apply_known_window(caps: &mut ModelCapabilities) {
    if let Some(info) = MODELS.iter().find(|info| info.id == caps.model.name) {
        if info.context_window > caps.context_window {
            caps.context_window = info.context_window;
            caps.preferred_window = info.preferred_window;
        }
    }
}

pub fn capabilities(model: &ModelRef) -> ModelCapabilities {
    let info = model_info(&model.name);
    ModelCapabilities {
        model: model.clone(),
        context_window: info.context_window,
        preferred_window: info.preferred_window,
        max_output_tokens: info.max_output_tokens,
        supports_thinking: true,
        visible_thinking: true,
        supports_tools: true,
        supports_images: true,
        effort_mode: EffortMode::Tier,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compat(name: &str, window: u32) -> ModelCapabilities {
        let mut caps = capabilities(&ModelRef::new("axe-cloud", name));
        caps.context_window = window;
        caps.preferred_window = window / 10 * 9;
        caps
    }

    #[test]
    fn known_claude_model_gets_its_real_window_on_a_compatible_endpoint() {
        let mut caps = compat("claude-opus-5-5", 200_000);
        apply_known_window(&mut caps);
        assert_eq!((caps.context_window, caps.preferred_window), (1_000_000, 900_000));
    }

    #[test]
    fn unknown_model_and_larger_windows_are_left_alone() {
        let mut other = compat("mistral-large", 128_000);
        apply_known_window(&mut other);
        assert_eq!(other.context_window, 128_000);
        let mut bigger = compat("claude-opus-5-5", 2_000_000);
        apply_known_window(&mut bigger);
        assert_eq!(bigger.context_window, 2_000_000);
    }
}
