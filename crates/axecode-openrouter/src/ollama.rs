//! axe:ollama — native Ollama `/api/chat` (NDJSON stream).
//!
//! Ollama's OpenAI route (`/v1/chat/completions`) cannot set the context
//! size: the server then keeps its default (2 048 to 4 096 tokens on most
//! PCs) and silently cuts the start of the prompt (system prompt, tools,
//! instructions). The native route accepts `options.num_ctx`, so Axecode's
//! whole prompt reaches the model. The request is built by the shared adapter
//! (OpenAI shape) and converted here; each NDJSON line is turned back into an
//! OpenAI-like chunk and fed to the shared parser.

use std::collections::HashMap;

use futures::{stream::Stream, StreamExt};
use serde_json::{json, Map, Value};

use axecode_core::{AppError, ProviderStream, StreamEvent};

use crate::stream::{error_field_message, idle_error, idle_guard, BodyError, EventParser, StreamLimits};
use crate::wire::{ChatChoice, ChatChunk, ChatDelta, ToolCallDelta, ToolCallFunctionDelta, UsageBody};

/// Converts an OpenAI `/chat/completions` body into an Ollama `/api/chat` body.
pub(crate) fn native_body(openai: Value, num_ctx: u32) -> Value {
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut messages = Vec::new();
    for message in openai["messages"].as_array().cloned().unwrap_or_default() {
        let role = message["role"].as_str().unwrap_or("user").to_string();
        let mut out = Map::new();
        out.insert("role".into(), json!(role));
        let (text, images) = split_content(&message["content"]);
        out.insert("content".into(), json!(text));
        if !images.is_empty() {
            out.insert("images".into(), json!(images));
        }
        if let Some(calls) = message["tool_calls"].as_array() {
            let calls: Vec<Value> = calls
                .iter()
                .map(|call| {
                    let name = call["function"]["name"].as_str().unwrap_or_default().to_string();
                    if let Some(id) = call["id"].as_str() {
                        tool_names.insert(id.to_string(), name.clone());
                    }
                    let raw = call["function"]["arguments"].as_str().unwrap_or("{}");
                    let arguments: Value =
                        serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
                    json!({ "function": { "name": name, "arguments": arguments } })
                })
                .collect();
            if !calls.is_empty() {
                out.insert("tool_calls".into(), json!(calls));
            }
        }
        if role == "tool" {
            if let Some(name) = message["tool_call_id"].as_str().and_then(|id| tool_names.get(id)) {
                out.insert("tool_name".into(), json!(name));
            }
        }
        messages.push(Value::Object(out));
    }

    let mut options = Map::new();
    options.insert("num_ctx".into(), json!(num_ctx));
    if let Some(max) = openai["max_tokens"].as_u64() {
        options.insert("num_predict".into(), json!(max));
    }
    if let Some(temperature) = openai.get("temperature").filter(|v| !v.is_null()) {
        options.insert("temperature".into(), temperature.clone());
    }
    let mut body = json!({
        "model": openai["model"],
        "messages": messages,
        "stream": true,
        "options": options,
    });
    if let Some(tools) = openai["tools"].as_array().filter(|tools| !tools.is_empty()) {
        body["tools"] = json!(tools);
    }
    body
}

/// Text of an OpenAI content (string or blocks) and its base64 images.
fn split_content(content: &Value) -> (String, Vec<String>) {
    match content {
        Value::String(text) => (text.clone(), Vec::new()),
        Value::Array(blocks) => {
            let mut text = String::new();
            let mut images = Vec::new();
            for block in blocks {
                if let Some(value) = block["text"].as_str() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(value);
                } else if let Some(url) = block["image_url"]["url"].as_str() {
                    // Ollama wants the bare base64, without the data: prefix.
                    let data = url.split_once("base64,").map(|(_, d)| d).unwrap_or(url);
                    images.push(data.to_string());
                }
            }
            (text, images)
        }
        _ => (String::new(), Vec::new()),
    }
}

/// Context size sent as `num_ctx`: the model window configured in Axecode
/// (32 768 by default for a local model), kept within sane bounds.
pub(crate) fn num_ctx_for(context_window: u32) -> u32 {
    context_window.clamp(4_096, 262_144)
}

/// French message for an Ollama / local-server error.
pub fn humanize_local_error(label: &str, model: &str, message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("does not support tools") {
        return format!(
            "{label} : le modèle « {model} » ne gère pas les outils (appels de fonctions), \
             indispensables à Axecode. Choisissez un modèle compatible (par exemple qwen2.5, \
             qwen3, llama3.1, mistral-nemo)."
        );
    }
    if lower.contains("does not support thinking") {
        return format!("{label} : le modèle « {model} » ne gère pas la réflexion. ({message})");
    }
    if lower.contains("not found") && (lower.contains("model") || lower.contains("pull")) {
        return format!(
            "{label} : le modèle « {model} » n'est pas installé. Installez-le avec \
             `ollama pull {model}` ou choisissez-en un autre dans Réglages > Fournisseurs."
        );
    }
    if lower.contains("requires more system memory") || lower.contains("out of memory") {
        return format!(
            "{label} : pas assez de mémoire pour charger « {model} ». Choisissez un modèle \
             plus petit. ({message})"
        );
    }
    format!("{label} a renvoyé une erreur : {message}")
}

/// Turns Ollama's NDJSON stream into Axecode events.
pub(crate) fn map_ndjson_stream<S, E>(body: S, model: String, limits: StreamLimits) -> ProviderStream
where
    S: Stream<Item = std::result::Result<bytes::Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let state = NdjsonState {
        source: Box::pin(idle_guard(body, limits.idle_timeout)),
        buffer: Vec::new(),
        parser: EventParser::new(model.clone()),
        pending: Vec::new(),
        finished: false,
        saw_line: false,
        tool_calls: 0,
        model,
        label: limits.label,
    };
    futures::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(next) = state.pending.pop() {
                return Some((Ok(next), state));
            }
            if state.finished {
                return None;
            }
            if let Some(pos) = state.buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = state.buffer.drain(..=pos).collect();
                if let Err(err) = state.handle_line(&line) {
                    state.finished = true;
                    return Some((Err(err), state));
                }
                continue;
            }
            match state.source.next().await {
                Some(Ok(bytes)) => state.buffer.extend_from_slice(&bytes),
                Some(Err(BodyError::Idle { secs })) => {
                    state.finished = true;
                    return Some((Err(idle_error(&state.label, secs)), state));
                }
                Some(Err(BodyError::Transport(message))) => {
                    state.finished = true;
                    return Some((Err(AppError::Stream(message)), state));
                }
                None => {
                    // Last line without a trailing newline.
                    if !state.buffer.is_empty() {
                        let line = std::mem::take(&mut state.buffer);
                        if let Err(err) = state.handle_line(&line) {
                            state.finished = true;
                            return Some((Err(err), state));
                        }
                        continue;
                    }
                    state.finished = true;
                    if !state.saw_line {
                        return Some((
                            Err(AppError::Stream(format!(
                                "{} a fermé la connexion sans rien répondre",
                                state.label
                            ))),
                            state,
                        ));
                    }
                    let mut produced = state.parser.finish();
                    produced.reverse();
                    state.pending = produced;
                }
            }
        }
    })
    .boxed()
}

struct NdjsonState {
    source: std::pin::Pin<Box<dyn Stream<Item = std::result::Result<bytes::Bytes, BodyError>> + Send>>,
    buffer: Vec<u8>,
    parser: EventParser,
    pending: Vec<StreamEvent>,
    finished: bool,
    saw_line: bool,
    tool_calls: usize,
    model: String,
    label: String,
}

impl NdjsonState {
    fn handle_line(&mut self, raw: &[u8]) -> std::result::Result<(), AppError> {
        let text = String::from_utf8_lossy(raw);
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        self.saw_line = true;
        let value: Value = serde_json::from_str(text)
            .map_err(|err| AppError::Decode(format!("ligne Ollama illisible : {err}")))?;
        if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
            let message = error_field_message(error).unwrap_or_else(|| error.to_string());
            return Err(AppError::Provider(humanize_local_error(&self.label, &self.model, &message)));
        }
        let chunk = self.to_chunk(&value);
        let mut produced = self.parser.push(chunk);
        if value["done"].as_bool() == Some(true) {
            produced.extend(self.parser.finish());
            self.finished = true;
        }
        produced.reverse();
        // Events still pending come out before the new ones.
        produced.extend(std::mem::take(&mut self.pending));
        self.pending = produced;
        Ok(())
    }

    fn to_chunk(&mut self, value: &Value) -> ChatChunk {
        let message = &value["message"];
        let mut delta = ChatDelta {
            content: message["content"].as_str().map(str::to_string),
            reasoning: message["thinking"].as_str().map(str::to_string),
            ..Default::default()
        };
        for call in message["tool_calls"].as_array().cloned().unwrap_or_default() {
            let index = self.tool_calls;
            self.tool_calls += 1;
            let arguments = match &call["function"]["arguments"] {
                Value::String(raw) => raw.clone(),
                Value::Null => "{}".to_string(),
                other => other.to_string(),
            };
            delta.tool_calls.push(ToolCallDelta {
                index: Some(index),
                id: call["id"].as_str().map(str::to_string),
                function: Some(ToolCallFunctionDelta {
                    name: call["function"]["name"].as_str().map(str::to_string),
                    arguments: Some(arguments),
                }),
            });
        }
        let done = value["done"].as_bool() == Some(true);
        let finish_reason = done.then(|| {
            if self.tool_calls > 0 {
                "tool_calls".to_string()
            } else {
                match value["done_reason"].as_str().unwrap_or("stop") {
                    "length" => "length".to_string(),
                    _ => "stop".to_string(),
                }
            }
        });
        let usage = done.then(|| {
            let prompt = value["prompt_eval_count"].as_u64().unwrap_or(0) as u32;
            let completion = value["eval_count"].as_u64().unwrap_or(0) as u32;
            UsageBody {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: prompt.saturating_add(completion),
                ..Default::default()
            }
        });
        ChatChunk {
            model: value["model"].as_str().map(str::to_string),
            choices: vec![ChatChoice {
                delta,
                finish_reason,
                usage: None,
                error: None,
            }],
            usage,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures::StreamExt;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use axecode_core::{
        AppError, ChatMessage, ModelRef, PartKind, Provider, ProviderRequest, StopReason,
        StreamEvent, ToolDescriptor,
    };

    use crate::{model_info, Dialect, OpenRouterConfig, OpenRouterProvider};

    const API_CHAT: &str = include_str!("../testdata/ollama/api_chat.ndjson");
    const API_TOOL: &str = include_str!("../testdata/ollama/api_tool.ndjson");
    const V1_TEXT: &str = include_str!("../testdata/ollama/v1_text.sse");
    const V1_TOOL: &str = include_str!("../testdata/ollama/v1_tool.sse");
    const MODEL: &str = "qwen2.5:0.5b";

    /// What the fake server does with the request.
    #[derive(Clone)]
    enum Reply {
        /// Status, content type, body, then close.
        Full(u16, &'static str, String),
        /// Headers and `first`, then silence (connection kept open).
        Stall(String),
        /// Accepts the request and never answers.
        Mute,
    }

    /// Fake Ollama: one connection per call, returns its URL and the
    /// (path, JSON body) of every request received.
    async fn fake_ollama(reply: Reply) -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let reply = reply.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut data = Vec::new();
                    let mut buf = [0u8; 8192];
                    let (head_end, length) = loop {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        data.extend_from_slice(&buf[..n]);
                        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&data[..pos]).to_ascii_lowercase();
                            let length = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (pos + 4, length);
                        }
                    };
                    while data.len() < head_end + length {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        data.extend_from_slice(&buf[..n]);
                    }
                    let head = String::from_utf8_lossy(&data[..head_end]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let body = serde_json::from_slice(&data[head_end..]).unwrap_or(Value::Null);
                    log.lock().unwrap().push((path, body));
                    match reply {
                        Reply::Full(status, kind, body) => {
                            let text = format!(
                                "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\nconnection: close\r\n\r\n{body}"
                            );
                            let _ = socket.write_all(text.as_bytes()).await;
                            let _ = socket.shutdown().await;
                        }
                        Reply::Stall(first) => {
                            let text = format!(
                                "HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\nconnection: close\r\n\r\n{first}"
                            );
                            let _ = socket.write_all(text.as_bytes()).await;
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                        Reply::Mute => tokio::time::sleep(Duration::from_secs(30)).await,
                    }
                });
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    fn provider(base: &str, native: bool, tweak: impl FnOnce(&mut OpenRouterConfig)) -> OpenRouterProvider {
        let mut caps = model_info::capabilities_from_parts(MODEL, 32_768, 4_096, false, false, true);
        caps.model = ModelRef::new("ollama", MODEL);
        let mut config =
            OpenRouterConfig::compatible("ollama", format!("{base}/v1"), "", vec![caps], Dialect::Plain);
        if native {
            config = config.with_ollama_native();
        }
        tweak(&mut config);
        OpenRouterProvider::new(config).unwrap()
    }

    fn request() -> ProviderRequest {
        ProviderRequest::new(ModelRef::new("ollama", MODEL), vec![ChatMessage::user_text("Dis bonjour")])
            .with_system("Tu es Axecode.")
            .with_tools(vec![ToolDescriptor {
                name: "ls".into(),
                description: "list files".into(),
                input_schema: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
            }])
    }

    /// Runs one turn: (text, tool calls (name, json), stop reason, error).
    async fn run(p: &OpenRouterProvider) -> (String, Vec<(String, String)>, Option<StopReason>, Option<AppError>) {
        let mut text = String::new();
        let mut tools: Vec<(String, String)> = Vec::new();
        let mut stop = None;
        let stream = match p.stream(request()).await {
            Ok(stream) => stream,
            Err(err) => return (text, tools, stop, Some(err)),
        };
        let mut stream = Box::pin(stream);
        let outcome = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(event) = stream.next().await {
                match event {
                    Ok(StreamEvent::TextDelta { delta, .. }) => text.push_str(&delta),
                    Ok(StreamEvent::PartStart { kind: PartKind::ToolCall, tool: Some(tool), .. }) => {
                        tools.push((tool.name, String::new()))
                    }
                    Ok(StreamEvent::ToolJsonDelta { chunk, .. }) => {
                        if let Some(last) = tools.last_mut() {
                            last.1.push_str(&chunk);
                        }
                    }
                    Ok(StreamEvent::MessageStop { stop_reason, .. }) => stop = Some(stop_reason),
                    Ok(_) => {}
                    Err(err) => return Some(err),
                }
            }
            None
        })
        .await
        .expect("the turn must end (no endless typing indicator)");
        (text, tools, stop, outcome)
    }

    #[tokio::test]
    async fn native_ndjson_text_ends_the_turn_and_sends_the_context_size() {
        let (base, seen) = fake_ollama(Reply::Full(200, "application/x-ndjson", API_CHAT.into())).await;
        let (text, tools, stop, err) = run(&provider(&base, true, |_| {})).await;
        assert!(err.is_none(), "{err:?}");
        assert!(text.starts_with("Bonjour"), "{text}");
        assert!(tools.is_empty());
        assert_eq!(stop, Some(StopReason::EndTurn));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "/api/chat");
        let body = &seen[0].1;
        assert_eq!(body["options"]["num_ctx"], json!(32_768));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["messages"][0]["role"], json!("system"));
        assert_eq!(body["messages"][0]["content"], json!("Tu es Axecode."));
        assert_eq!(body["tools"][0]["function"]["name"], json!("ls"));
    }

    #[tokio::test]
    async fn native_ndjson_tool_call_is_parsed() {
        let (base, _) = fake_ollama(Reply::Full(200, "application/x-ndjson", API_TOOL.into())).await;
        let (_, tools, stop, err) = run(&provider(&base, true, |_| {})).await;
        assert!(err.is_none(), "{err:?}");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "ls");
        let args: Value = serde_json::from_str(&tools[0].1).unwrap();
        assert_eq!(args, json!({"path": ""}));
        assert_eq!(stop, Some(StopReason::ToolUse));
    }

    #[tokio::test]
    async fn v1_sse_text_and_tool_call_end_the_turn() {
        let (base, seen) = fake_ollama(Reply::Full(200, "text/event-stream", V1_TEXT.into())).await;
        let (text, _, stop, err) = run(&provider(&base, false, |_| {})).await;
        assert!(err.is_none(), "{err:?}");
        assert!(text.starts_with("Bonjour"), "{text}");
        assert_eq!(stop, Some(StopReason::EndTurn));
        assert_eq!(seen.lock().unwrap()[0].0, "/v1/chat/completions");

        let (base, _) = fake_ollama(Reply::Full(200, "text/event-stream", V1_TOOL.into())).await;
        let (_, tools, stop, err) = run(&provider(&base, false, |_| {})).await;
        assert!(err.is_none(), "{err:?}");
        assert_eq!(tools[0].0, "ls");
        assert_eq!(stop, Some(StopReason::ToolUse));
    }

    #[tokio::test]
    async fn missing_model_is_reported_in_french() {
        let body = r#"{"error":"model 'qwen2.5:0.5b' not found"}"#.to_string();
        let (base, _) = fake_ollama(Reply::Full(404, "application/json", body)).await;
        let (_, _, _, err) = run(&provider(&base, true, |_| {})).await;
        let err = err.expect("error");
        assert!(matches!(err, AppError::InvalidRequest(_)), "{err:?}");
        assert!(err.to_string().contains("n'est pas installé"), "{err}");
        assert!(err.to_string().contains("ollama pull qwen2.5:0.5b"), "{err}");

        // Same through /v1 (OpenAI-shaped error).
        let body = r#"{"error":{"message":"model 'qwen2.5:0.5b' not found","type":"not_found_error","param":null,"code":null}}"#.to_string();
        let (base, _) = fake_ollama(Reply::Full(404, "application/json", body)).await;
        let (_, _, _, err) = run(&provider(&base, false, |_| {})).await;
        assert!(err.expect("error").to_string().contains("n'est pas installé"));
    }

    #[tokio::test]
    async fn model_without_tools_is_reported_in_french() {
        let body = r#"{"error":"registry.ollama.ai/library/gemma2:2b does not support tools"}"#.to_string();
        let (base, _) = fake_ollama(Reply::Full(400, "application/json", body)).await;
        let (_, _, _, err) = run(&provider(&base, true, |_| {})).await;
        let err = err.expect("error");
        assert!(err.to_string().contains("ne gère pas les outils"), "{err}");
    }

    #[tokio::test]
    async fn error_line_in_the_stream_ends_the_turn() {
        let body = format!(
            "{}\n{{\"error\":\"model runner has unexpectedly stopped\"}}\n",
            API_CHAT.lines().next().unwrap()
        );
        let (base, _) = fake_ollama(Reply::Full(200, "application/x-ndjson", body)).await;
        let (text, _, _, err) = run(&provider(&base, true, |_| {})).await;
        assert_eq!(text, "Bonjour");
        let err = err.expect("error");
        assert!(matches!(err, AppError::Provider(_)), "{err:?}");
        assert!(err.to_string().contains("Ollama a renvoyé une erreur"), "{err}");
    }

    #[tokio::test]
    async fn silence_during_the_answer_ends_the_turn_with_a_clear_error() {
        let first = format!("{}\n", API_CHAT.lines().next().unwrap());
        for native in [true, false] {
            let first = if native { first.clone() } else { V1_TEXT.split("\n\n").next().unwrap().to_string() + "\n\n" };
            let (base, _) = fake_ollama(Reply::Stall(first)).await;
            let p = provider(&base, native, |c| c.idle_timeout = Duration::from_millis(500));
            let (text, _, _, err) = run(&p).await;
            assert!(text.starts_with("Bonjour"), "{text}");
            let err = err.expect("error");
            // Not retryable: a retry would make the user wait as long again.
            assert!(matches!(err, AppError::Provider(_)), "{err:?}");
            assert!(err.to_string().contains("Ollama n'a rien envoyé depuis"), "{err}");
        }
    }

    #[tokio::test]
    async fn no_answer_at_all_ends_the_turn() {
        let (base, _) = fake_ollama(Reply::Mute).await;
        let p = provider(&base, true, |c| c.first_response_timeout = Some(Duration::from_secs(1)));
        let (_, _, _, err) = run(&p).await;
        let err = err.expect("error");
        assert!(matches!(err, AppError::Provider(_)), "{err:?}");
        assert!(err.to_string().contains("n'a pas commencé à répondre"), "{err}");
    }

    #[tokio::test]
    async fn stopped_server_is_reported_at_once() {
        // A port with nobody listening.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (_, _, _, err) = run(&provider(&base, true, |_| {})).await;
        let err = err.expect("error");
        assert!(matches!(err, AppError::Provider(_)), "{err:?}");
        assert!(err.to_string().contains("Ollama ne répond pas"), "{err}");
    }

    #[test]
    fn native_body_converts_history_images_and_tool_results() {
        let openai = json!({
            "model": MODEL,
            "max_tokens": 4096,
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": [
                    {"type": "text", "text": "regarde"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "ls", "arguments": "{\"path\":\".\"}"}}
                ]},
                {"role": "tool", "content": "a.txt", "tool_call_id": "call_1"}
            ],
            "tools": [{"type": "function", "function": {"name": "ls", "description": "d", "parameters": {}}}],
            "stream": true
        });
        let body = super::native_body(openai, 32_768);
        assert_eq!(body["options"], json!({"num_ctx": 32_768, "num_predict": 4096}));
        assert_eq!(body["messages"][1]["content"], json!("regarde"));
        assert_eq!(body["messages"][1]["images"], json!(["AAAA"]));
        assert_eq!(body["messages"][2]["tool_calls"][0]["function"]["arguments"], json!({"path": "."}));
        assert_eq!(body["messages"][3]["tool_name"], json!("ls"));
        assert!(body.get("stream_options").is_none());
    }

    /// Real server: `AXE_OLLAMA_URL=http://127.0.0.1:11434 cargo test -p axecode-openrouter real_ollama -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn real_ollama_reads_the_whole_long_prompt() {
        let Ok(base) = std::env::var("AXE_OLLAMA_URL") else { return };
        let p = provider(&base, true, |_| {});
        let long = "Règle : réponds toujours en français, poliment et brièvement.\n".repeat(400);
        let req = request().with_system(format!("{long}\nTu es Axecode."));
        let mut stream = Box::pin(p.stream(req).await.expect("stream"));
        let (mut text, mut input) = (String::new(), 0);
        while let Some(event) = stream.next().await {
            match event.expect("event") {
                StreamEvent::TextDelta { delta, .. } => text.push_str(&delta),
                StreamEvent::MessageStop { usage, .. } => input = usage.input_tokens,
                _ => {}
            }
        }
        eprintln!("input_tokens={input} text={text:?}");
        assert!(input > 4_096, "prompt cut by Ollama: {input} tokens");
    }
}
