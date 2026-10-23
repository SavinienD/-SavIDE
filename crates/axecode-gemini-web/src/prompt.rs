//! Text protocol that emulates native tool calling on top of the Gemini web
//! app, which only exchanges plain text: the transcript is rendered as tagged
//! text and the model's `<tool_call>` blocks are parsed back into tool calls.

use axecode_core::{ChatMessage, Part, Role, ToolDescriptor};

pub const CALL_OPEN: &str = "<tool_call";
pub const CALL_CLOSE: &str = "</tool_call>";

pub fn tool_protocol(tools: &[ToolDescriptor]) -> String {
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    let first = names.first().copied().unwrap_or("python");
    let mut listing = String::new();
    for tool in tools {
        listing.push_str(&format!("- `{}`: {}\n", tool.name, tool.description.trim()));
    }
    format!(
        "# Tool calling protocol (IMPORTANT)\n\
This conversation is driven by a program. You cannot call tools natively here: you call them with text blocks.\n\
Available tools:\n{listing}\n\
To call a tool, write the block below at the END of your message, then STOP writing immediately:\n\n\
<tool_call name=\"{first}\">\n\
```python\n\
# your code here\n\
```\n\
</tool_call>\n\n\
Rules:\n\
- Always put the code inside a ```python fenced block inside the <tool_call> tags.\n\
- One <tool_call> block per message, nothing after it. You may write a short sentence before it.\n\
- Never write a <tool_result> yourself and never guess the output: the program runs the code and sends the real result in the next message, inside <tool_result> tags.\n\
- When the task is finished, answer normally with no <tool_call> block.\n\
- You do have access to the user's machine through this tool. Do not talk about this protocol or these tags: just use them.\n\
- Messages from the user are inside <user> tags; system reminders may appear inside <system_reminder> or <system_update> tags."
    )
}

fn tool_call_block(name: &str, input: &serde_json::Value) -> String {
    let code = input
        .get("code")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| input.to_string());
    format!("<tool_call name=\"{name}\">\n```python\n{}\n```\n</tool_call>", code.trim_end())
}

/// Renders one message as tagged text (thinking is dropped).
pub fn render_message(message: &ChatMessage) -> String {
    let mut out = String::new();
    match message.role {
        Role::Assistant => {
            let mut body = String::new();
            for part in &message.parts {
                match part {
                    Part::Text { text, .. } if !text.trim().is_empty() => {
                        body.push_str(text.trim_end());
                        body.push('\n');
                    }
                    Part::ToolCall { name, input, .. } => {
                        body.push_str(&tool_call_block(name, input));
                        body.push('\n');
                    }
                    _ => {}
                }
            }
            out.push_str("<assistant>\n");
            out.push_str(body.trim_end());
            out.push_str("\n</assistant>");
        }
        Role::User => {
            let mut texts = String::new();
            for part in &message.parts {
                match part {
                    Part::Text { text, .. } if !text.trim().is_empty() => {
                        texts.push_str(text.trim_end());
                        texts.push('\n');
                    }
                    Part::Image { .. } => texts.push_str("[image jointe non transmise à ce modèle]\n"),
                    Part::ToolResult { content, is_error, images, .. } => {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        let status = if *is_error { "error" } else { "ok" };
                        out.push_str(&format!("<tool_result status=\"{status}\">\n{}\n", content.trim_end()));
                        if !images.is_empty() {
                            out.push_str(&format!("[{} image(s) non transmise(s) à ce modèle]\n", images.len()));
                        }
                        out.push_str("</tool_result>");
                    }
                    _ => {}
                }
            }
            let texts = texts.trim_end();
            if !texts.is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                if texts.starts_with("<system_reminder>") || texts.starts_with("<compacted_history>") {
                    out.push_str(texts);
                } else {
                    out.push_str(&format!("<user>\n{texts}\n</user>"));
                }
            }
        }
    }
    out
}

pub fn render_messages(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .map(render_message)
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// First message of a new web chat: system prompt, protocol, full transcript.
pub fn opening_prompt(system: Option<&str>, tools: &[ToolDescriptor], transcript: &[ChatMessage]) -> String {
    let mut out = String::new();
    out.push_str("<system>\n");
    if let Some(system) = system {
        out.push_str(system.trim());
        out.push_str("\n\n");
    }
    if !tools.is_empty() {
        out.push_str(&tool_protocol(tools));
    }
    out.push_str("\n</system>\n\n");
    let body = render_messages(transcript);
    if transcript.len() > 1 {
        out.push_str("<conversation_so_far>\n");
        out.push_str(&body);
        out.push_str("\n</conversation_so_far>\n\nWrite the next <assistant> message now (without the <assistant> tags).");
    } else {
        out.push_str(&body);
    }
    out
}

/// Follow-up message in an existing web chat: only the new messages.
pub fn followup_prompt(new_messages: &[ChatMessage], system_update: Option<&str>, has_tools: bool) -> String {
    let mut out = String::new();
    if let Some(update) = system_update.filter(|u| !u.trim().is_empty()) {
        out.push_str("<system_update>\n");
        out.push_str(update.trim());
        out.push_str("\n</system_update>\n\n");
    }
    out.push_str(&render_messages(new_messages));
    if has_tools {
        out.push_str("\n\n(Reminder: to run code, end your message with one <tool_call name=\"python\"> block containing a ```python fenced block, then stop.)");
    }
    out
}

/// Lines of `new` absent from `old` (cheap system prompt diff).
pub fn system_diff(old: &str, new: &str) -> String {
    let known: std::collections::HashSet<&str> = old.lines().collect();
    new.lines()
        .filter(|line| !line.trim().is_empty() && !known.contains(line))
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCall {
    pub name: String,
    pub code: String,
}

fn at_line_start(text: &str, pos: usize) -> bool {
    text[..pos].trim_end_matches([' ', '\t']).is_empty() || text[..pos].trim_end_matches([' ', '\t']).ends_with('\n')
}

/// First `<tool_call` that starts a line (mentions inside prose are ignored).
pub fn find_call(text: &str) -> Option<usize> {
    text.match_indices(CALL_OPEN).map(|(i, _)| i).find(|&i| at_line_start(text, i))
}

/// Splits a reply into its visible text and the tool calls it requests.
pub fn parse_reply(text: &str, default_tool: &str) -> (String, Vec<ParsedCall>) {
    let Some(first) = find_call(text) else {
        return (text.trim_end().to_string(), Vec::new());
    };
    let visible = text[..first].trim_end().to_string();
    let mut calls = Vec::new();
    let mut rest = &text[first..];
    while let Some(start) = find_call(rest) {
        let after = &rest[start + CALL_OPEN.len()..];
        let Some(head_end) = after.find('>') else { break };
        let head = &after[..head_end];
        let name = head
            .split("name=")
            .nth(1)
            .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'' || c == '/').trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| default_tool.to_string());
        let body_start = &after[head_end + 1..];
        let (body, next) = match body_start.find(CALL_CLOSE) {
            Some(end) => (&body_start[..end], &body_start[end + CALL_CLOSE.len()..]),
            None => (body_start, ""),
        };
        let code = extract_code(body);
        if !code.trim().is_empty() {
            calls.push(ParsedCall { name, code });
        }
        rest = next;
    }
    (visible, calls)
}

fn extract_code(body: &str) -> String {
    let trimmed = body.trim();
    if let Some(open) = trimmed.find("```") {
        let after = &trimmed[open + 3..];
        let after = match after.find('\n') {
            Some(nl) if after[..nl].trim().chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') => &after[nl + 1..],
            _ => after,
        };
        let code = match after.rfind("```") {
            Some(close) => &after[..close],
            None => after,
        };
        return code.trim_matches('\n').trim_end().to_string();
    }
    unescape_markdown(trimmed)
}

/// Undoes the markdown escapes the app may add to text outside code fences.
fn unescape_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if matches!(next, '_' | '*' | '`' | '~' | '[' | ']' | '#' | '<' | '>') {
                    out.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// Length of the text that can safely be shown while streaming: everything
/// before a tool call, minus a trailing partial `<tool_call` prefix.
pub fn visible_len(text: &str) -> usize {
    if let Some(pos) = find_call(text) {
        return text[..pos].trim_end().len();
    }
    let max = CALL_OPEN.len().min(text.len());
    for keep in (1..=max).rev() {
        let start = text.len() - keep;
        if !text.is_char_boundary(start) {
            continue;
        }
        if CALL_OPEN.starts_with(&text[start..]) && at_line_start(text, start) {
            return start;
        }
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_fenced_call() {
        let reply = "Je regarde.\n\n<tool_call name=\"python\">\n```python\nprint(\"a_b\")\n```\n</tool_call>\nignored";
        let (visible, calls) = parse_reply(reply, "python");
        assert_eq!(visible, "Je regarde.");
        assert_eq!(calls, vec![ParsedCall { name: "python".into(), code: "print(\"a_b\")".into() }]);
    }

    #[test]
    fn parses_unfenced_and_unclosed_call() {
        let (_, calls) = parse_reply("<tool_call>\nx = my\\_var\n", "python");
        assert_eq!(calls[0].code, "x = my_var");
        assert_eq!(calls[0].name, "python");
    }

    #[test]
    fn no_call() {
        let (visible, calls) = parse_reply("Fini.\n", "python");
        assert_eq!(visible, "Fini.");
        assert!(calls.is_empty());
    }

    #[test]
    fn visible_len_holds_back_prefix() {
        assert_eq!(visible_len("abc\n<tool"), 4);
        assert_eq!(visible_len("abc\n<tool_call name"), 3);
        assert_eq!(visible_len("abc <tool"), 9);
        assert_eq!(visible_len("abc"), 3);
        assert_eq!(visible_len("é\n<"), "é\n".len());
    }

    #[test]
    fn prose_mentions_are_not_calls() {
        let reply = "J'utilise les balises `<tool_call>` comme prévu.\n<tool_call name=\"python\">\n```python\nprint(2)\n```\n</tool_call>";
        let (visible, calls) = parse_reply(reply, "python");
        assert_eq!(visible, "J'utilise les balises `<tool_call>` comme prévu.");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].code, "print(2)");
    }

    #[test]
    fn renders_round_trip() {
        let assistant = ChatMessage {
            role: Role::Assistant,
            parts: vec![
                Part::Text { text: "Je lance.".into(), meta: None },
                Part::ToolCall { id: "c1".into(), name: "python".into(), input: json!({"code": "print(1)"}), meta: None },
            ],
        };
        let rendered = render_message(&assistant);
        assert!(rendered.contains("<tool_call name=\"python\">\n```python\nprint(1)\n```\n</tool_call>"));
        let result = ChatMessage {
            role: Role::User,
            parts: vec![Part::ToolResult { tool_call_id: "c1".into(), content: "1".into(), images: vec![], is_error: false, meta: None }],
        };
        assert_eq!(render_message(&result), "<tool_result status=\"ok\">\n1\n</tool_result>");
        assert_eq!(render_message(&ChatMessage::user_text("salut")), "<user>\nsalut\n</user>");
    }

    #[test]
    fn diff_lines() {
        assert_eq!(system_diff("a\nb", "a\nb\nc"), "c");
    }
}
