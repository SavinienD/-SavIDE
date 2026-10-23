//! axe:compaction — when the loop compacts automatically.
//!
//! The trigger used to be "input tokens of the PREVIOUS call ≥ N % of the
//! window": it ignored what was added since (tool results, the answer) and
//! left no room for the answer itself (95 % of 200 k + 32 k of output does
//! not fit). Now: the request about to be sent is estimated, and the
//! threshold always keeps max(16 384, output budget) tokens free.

use axecode_core::{ChatMessage, ModelCapabilities, Part, ToolDescriptor};

/// Room always kept free for the answer (Prime Agent keeps 16 384 tokens).
pub(crate) const MIN_HEADROOM: u32 = 16_384;

/// Automatic compactions allowed in one turn (same cap as the agent loop).
pub(crate) const MAX_AUTO_COMPACTIONS_PER_TURN: usize = 3;

/// Characters counted for an image (same order as the providers' estimates).
const IMAGE_CHARS: u64 = 4_000;

/// Token count at which the loop compacts: `percent` of the window, never
/// closer to the window than max(16 384, output budget).
pub(crate) fn threshold(caps: &ModelCapabilities, percent: u8, output_budget: u32) -> u64 {
    let window = caps.context_window as u64;
    let by_percent = window * percent.min(100) as u64 / 100;
    let headroom = MIN_HEADROOM.max(output_budget) as u64;
    by_percent.min(window.saturating_sub(headroom))
}

/// Characters the provider will see: system prompt, transcript, tools.
pub(crate) fn request_chars(system: &str, history: &[ChatMessage], tools: &[ToolDescriptor]) -> u64 {
    let mut chars = system.chars().count() as u64;
    for message in history {
        for part in &message.parts {
            chars += match part {
                Part::Text { text, .. } | Part::Thinking { text, .. } => text.chars().count() as u64,
                Part::Image { .. } => IMAGE_CHARS,
                Part::ToolCall { name, input, .. } => {
                    (name.chars().count() + input.to_string().chars().count()) as u64
                }
                Part::ToolResult { content, images, .. } => {
                    content.chars().count() as u64 + images.len() as u64 * IMAGE_CHARS
                }
            };
        }
    }
    for tool in tools {
        chars += (tool.name.chars().count()
            + tool.description.chars().count()
            + tool.input_schema.to_string().chars().count()) as u64;
    }
    chars
}

/// Estimated input tokens for `chars` characters. `last` = (tokens billed,
/// characters sent) of the previous call: its ratio is reused when known.
/// Never below chars / 4 (conservative: compacting a bit early is cheap,
/// overflowing the window costs a failed call plus a compaction).
pub(crate) fn estimate_tokens(chars: u64, last: Option<(u64, u64)>) -> u64 {
    let floor = chars / 4;
    match last {
        Some((tokens, last_chars)) if tokens > 0 && last_chars > 0 => {
            (chars.saturating_mul(tokens) / last_chars).max(floor)
        }
        _ => floor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axecode_core::{EffortMode, ModelRef};

    fn caps(window: u32) -> ModelCapabilities {
        ModelCapabilities {
            model: ModelRef::new("axe-cloud", "claude-opus-5-5"),
            context_window: window,
            preferred_window: window / 10 * 9,
            max_output_tokens: 128_000,
            supports_thinking: true,
            visible_thinking: true,
            supports_tools: true,
            supports_images: true,
            effort_mode: EffortMode::Tier,
        }
    }

    #[test]
    fn percent_applies_when_it_leaves_room_for_the_answer() {
        assert_eq!(threshold(&caps(1_000_000), 95, 32_000), 950_000);
        assert_eq!(threshold(&caps(200_000), 50, 32_000), 100_000);
    }

    #[test]
    fn the_answer_always_fits_in_the_window() {
        // 95 % of 200 k = 190 k + 32 k of output would overflow.
        assert_eq!(threshold(&caps(200_000), 95, 32_000), 168_000);
        // Small output budget: Prime's 16 384 tokens of headroom.
        assert_eq!(threshold(&caps(200_000), 95, 4_096), 183_616);
        assert_eq!(threshold(&caps(10_000), 95, 32_000), 0);
    }

    #[test]
    fn estimate_reuses_the_measured_ratio_and_never_goes_below_a_quarter() {
        assert_eq!(estimate_tokens(400_000, None), 100_000);
        // Previous call: 30 k tokens for 90 k characters (1 token / 3 chars).
        assert_eq!(estimate_tokens(600_000, Some((30_000, 90_000))), 200_000);
        // A ratio below 1/4 is ignored (floor).
        assert_eq!(estimate_tokens(600_000, Some((10_000, 90_000))), 150_000);
        assert_eq!(estimate_tokens(600_000, Some((0, 90_000))), 150_000);
    }

    #[test]
    fn request_chars_counts_system_transcript_tool_results_and_tools() {
        let mut history = vec![ChatMessage::user_text("abcd")];
        history.push(ChatMessage {
            role: axecode_core::Role::User,
            parts: vec![Part::ToolResult {
                tool_call_id: "t1".into(),
                content: "x".repeat(20_000),
                images: Vec::new(),
                is_error: false,
                meta: None,
            }],
        });
        let tool = ToolDescriptor {
            name: "py".into(),
            description: "run".into(),
            input_schema: serde_json::json!({}),
        };
        // 6 (system) + 4 + 20 000 + 2 + 3 + 2 ("{}")
        assert_eq!(request_chars("system", &history, &[tool]), 20_017);
    }
}
