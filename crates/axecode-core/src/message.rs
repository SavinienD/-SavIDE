use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub parts: Vec<Part>,
}

impl ChatMessage {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            parts: vec![Part::Text {
                text: text.into(),
                meta: None,
            }],
        }
    }

    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            parts: vec![Part::Text {
                text: text.into(),
                meta: None,
            }],
        }
    }

    pub fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                Part::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Part {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    Image {
        media_type: String,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    Thinking {
        #[serde(default)]
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    ToolResult {
        tool_call_id: String,
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ToolResultImage>,
        #[serde(default)]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResultImage {
    /// The Python kernel historically sent `mediaType`: both spellings are
    /// read, and a missing type falls back to PNG instead of failing the
    /// whole exec reply ("missing field media_type").
    #[serde(alias = "mediaType", default = "default_image_media_type")]
    pub media_type: String,
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

fn default_image_media_type() -> String {
    "image/png".into()
}

#[cfg(test)]
mod tool_result_image_tests {
    use super::ToolResultImage;

    #[test]
    fn reads_snake_camel_and_missing_media_type() {
        let snake: ToolResultImage =
            serde_json::from_str(r#"{"media_type":"image/jpeg","data":"AA=="}"#).unwrap();
        assert_eq!(snake.media_type, "image/jpeg");
        let camel: ToolResultImage =
            serde_json::from_str(r#"{"mediaType":"image/gif","data":"AA==","path":null}"#).unwrap();
        assert_eq!(camel.media_type, "image/gif");
        let missing: ToolResultImage = serde_json::from_str(r#"{"data":"AA=="}"#).unwrap();
        assert_eq!(missing.media_type, "image/png");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
    Cancelled,
    Other,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
    pub reasoning_tokens: u32,
    pub cache_read_tokens: u32,
    pub cache_creation_tokens: u32,
}
