use std::time::Duration;

use futures::StreamExt;
use serde_json::json;
use axecode_core::{ChatMessage, ModelRef, Part, Provider, ProviderRequest, Role, StreamEvent, ToolDescriptor, Effort};
use axecode_gemini_web::{GeminiWebProvider, PROVIDER_ID};

async fn run(provider: &GeminiWebProvider, transcript: Vec<ChatMessage>, model: &str) -> ChatMessage {
    let tool = ToolDescriptor { name: "python".into(), description: "Run Python code in a persistent kernel.".into(), input_schema: json!({"type":"object"}) };
    let request = ProviderRequest::new(ModelRef::new(PROVIDER_ID, model).with_effort(Effort::Low), transcript)
        .with_system("You are a coding agent working on the user's machine. Answer in French.")
        .with_tools(vec![tool])
        .with_cache_key("live-test-session");
    let t0 = std::time::Instant::now();
    let mut stream = provider.stream(request).await.expect("stream");
    let mut parts: Vec<Part> = Vec::new();
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event.expect("event") {
            StreamEvent::TextDelta { delta, .. } => { print!("{delta}"); text.push_str(&delta); }
            StreamEvent::ThinkingDelta { delta, .. } => print!("[think]{delta}"),
            StreamEvent::PartStart { tool: Some(t), .. } => { println!("\n[tool_call {} {}]", t.name, t.id); parts.push(Part::ToolCall { id: t.id, name: t.name, input: json!({}), meta: None }); }
            StreamEvent::ToolJsonDelta { chunk, .. } => { println!("[input] {chunk}"); if let Some(Part::ToolCall { input, .. }) = parts.last_mut() { *input = serde_json::from_str(&chunk).unwrap(); } }
            StreamEvent::MessageStop { stop_reason, usage } => println!("\n[stop {stop_reason:?} in={} out={} after {:?}]", usage.input_tokens, usage.output_tokens, t0.elapsed()),
            _ => {}
        }
    }
    if !text.is_empty() { parts.insert(0, Part::Text { text, meta: None }); }
    ChatMessage { role: Role::Assistant, parts }
}

#[tokio::main]
async fn main() {
    tracing_subscriber_init();
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "login" => { let s = axecode_gemini_web::login(Duration::from_secs(300)).await.expect("login"); println!("{}", serde_json::to_string_pretty(&s).unwrap()); }
        "status" => { let s = axecode_gemini_web::status(true).await; println!("{}", serde_json::to_string_pretty(&s).unwrap()); }
        "refresh" => { let jar = axecode_gemini_web::browser::refresh_cookies().await.expect("refresh"); println!("refreshed: {:?}", jar.cookies.keys().collect::<Vec<_>>()); }
        _ => {
            let model = std::env::args().nth(2).unwrap_or_else(|| "gemini-argon".into());
            let provider = GeminiWebProvider::from_default_sources().expect("provider");
            let mut transcript = vec![ChatMessage::user_text("Combien y a-t-il de fichiers .rs dans le dossier crates ? Utilise l'outil python.")];
            let reply = run(&provider, transcript.clone(), &model).await;
            transcript.push(reply.clone());
            let call_id = reply.parts.iter().find_map(|p| match p { Part::ToolCall { id, .. } => Some(id.clone()), _ => None });
            if let Some(id) = call_id {
                transcript.push(ChatMessage { role: Role::User, parts: vec![Part::ToolResult { tool_call_id: id, content: "127\n[12 ms]".into(), images: vec![], is_error: false, meta: None }] });
                let _ = run(&provider, transcript, &model).await;
            }
        }
    }
}

fn tracing_subscriber_init() {}
