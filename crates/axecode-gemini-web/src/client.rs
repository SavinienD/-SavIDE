//! `Provider` implementation over the Gemini web app.

use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures::{channel::mpsc, StreamExt};
use serde_json::{json, Value};
use axecode_core::{
    AppError, ChatMessage, Effort, EffortMode, ModelCapabilities, ModelRef, Part, PartKind, Provider,
    ProviderRequest, ProviderStream, Result, Role, StopReason, StreamEvent, TokenEstimate,
    ToolCallIntro, Usage,
};

use crate::{
    browser,
    cookies::{now_ms, CookieJar},
    host::{self, BrowserHost, ReadyPage},
    prompt,
    protocol::{self, ChatPointer, FrameParser, UserStatus, WebModel},
};

pub const PROVIDER_ID: &str = "gemini-web";
pub const DEFAULT_MODEL: &str = "gemini-argon";
const CONTEXT_WINDOW: u32 = 1_000_000;
const MAX_OUTPUT: u32 = 65_536;
const STATUS_TTL: Duration = Duration::from_secs(30 * 60);
const CHUNK_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone)]
struct ChatState {
    pointer: ChatPointer,
    model: String,
    sent: usize,
    prefix_hash: u64,
    system: String,
    chars: usize,
}

pub struct GeminiWebProvider {
    host: Arc<BrowserHost>,
    status: tokio::sync::Mutex<Option<(UserStatus, Instant)>>,
    reqid: AtomicU64,
    client_session: String,
    chats: Arc<StdMutex<HashMap<String, ChatState>>>,
}

fn not_connected() -> AppError {
    AppError::Auth("Gemini web : pas connecté. Settings > Providers > Gemini (app web) > Se connecter.".into())
}

impl GeminiWebProvider {
    /// Available once the sign-in flow saved a session.
    pub fn from_default_sources() -> Result<Self> {
        CookieJar::load_default().filter(CookieJar::is_logged_in).ok_or_else(not_connected)?;
        Ok(Self::new())
    }

    pub fn new() -> Self {
        Self {
            host: BrowserHost::new(),
            status: tokio::sync::Mutex::new(None),
            reqid: AtomicU64::new(rand::random_range(10_000..99_999)),
            client_session: uuid::Uuid::new_v4().to_string().to_uppercase(),
            chats: Default::default(),
        }
    }

    fn next_reqid(&self) -> u64 {
        self.reqid.fetch_add(100_000, Ordering::SeqCst) + 100_000
    }

    async fn user_status(&self, page: &ReadyPage, force: bool) -> Result<UserStatus> {
        let mut cached = self.status.lock().await;
        if !force {
            if let Some((status, at)) = cached.as_ref() {
                if at.elapsed() < STATUS_TTL {
                    return Ok(status.clone());
                }
            }
        }
        let path = host::rpc_path(
            protocol::BATCH_URL,
            &page.tokens,
            self.next_reqid(),
            &[("rpcids", protocol::RPC_USER_STATUS), ("source-path", "/app")],
        );
        let headers = vec![
            (protocol::MODEL_HEADER.to_string(), protocol::batch_model_header(&self.client_session)),
            ("x-goog-ext-73010989-jspb".to_string(), "[0]".to_string()),
        ];
        let (status, body) = page
            .post(&path, &headers, &protocol::batch_form(protocol::RPC_USER_STATUS, "[]", &page.tokens.at))
            .await?;
        if status != 200 {
            return Err(AppError::Provider(format!("Gemini web : statut du compte illisible (HTTP {status}).")));
        }
        let frames = FrameParser::default().feed(&body);
        let parsed = protocol::rpc_bodies(&frames, protocol::RPC_USER_STATUS)
            .into_iter()
            .next()
            .map(|b| protocol::parse_user_status(&b))
            .ok_or_else(|| AppError::Provider("Gemini web : statut du compte absent de la réponse.".into()))?;
        if parsed.status_code == Some(1016) || parsed.models.is_empty() {
            return Err(AppError::Auth(
                "Gemini web : la session Google n'est plus valide. Settings > Providers > Gemini (app web) > Se connecter.".into(),
            ));
        }
        *cached = Some((parsed.clone(), Instant::now()));
        Ok(parsed)
    }

    /// Models offered to the signed-in account (validates the session).
    pub async fn models(&self) -> Result<Vec<WebModel>> {
        let page = self.host.page().await?;
        Ok(self.user_status(&page, true).await?.models)
    }
}

fn thinking_level(effort: Option<Effort>) -> i64 {
    match effort {
        Some(Effort::High | Effort::Xhigh | Effort::Max) | None => 2,
        _ => 1,
    }
}

fn hash_rendered(rendered: &[String]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    rendered.hash(&mut hasher);
    hasher.finish()
}

fn resolve_model<'a>(models: &'a [WebModel], name: &str) -> Result<&'a WebModel> {
    let wanted = name.trim().to_lowercase();
    models
        .iter()
        .find(|m| m.slug == wanted || m.id == wanted)
        .or_else(|| models.iter().find(|m| protocol::slugify(&m.label) == wanted))
        .ok_or_else(|| {
            let offered: Vec<String> = models.iter().map(|m| format!("{} ({})", m.slug, m.label)).collect();
            AppError::InvalidRequest(format!(
                "Gemini web : le modèle {name} n'est pas proposé à ce compte. Modèles disponibles : {}",
                offered.join(", ")
            ))
        })
}

#[async_trait]
impl Provider for GeminiWebProvider {
    fn name(&self) -> &str {
        PROVIDER_ID
    }

    fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities> {
        if model.provider != PROVIDER_ID {
            return None;
        }
        Some(ModelCapabilities {
            model: model.clone(),
            context_window: CONTEXT_WINDOW,
            preferred_window: CONTEXT_WINDOW / 10 * 9,
            max_output_tokens: MAX_OUTPUT,
            supports_thinking: true,
            visible_thinking: true,
            supports_tools: true,
            supports_images: false,
            effort_mode: EffortMode::Tier,
        })
    }

    async fn estimate_tokens(&self, request: ProviderRequest) -> Result<TokenEstimate> {
        let text = prompt::opening_prompt(request.system_prompt.as_deref(), &request.tools, &request.transcript);
        Ok(TokenEstimate { input_tokens: (text.len() / 4) as u32, exact: false })
    }

    async fn stream(&self, request: ProviderRequest) -> Result<ProviderStream> {
        if request.model.provider != PROVIDER_ID {
            return Err(AppError::InvalidRequest(format!("{PROVIDER_ID} cannot serve {}", request.model.provider)));
        }
        let rendered: Vec<String> = request.transcript.iter().map(prompt::render_message).collect();
        let system = request.system_prompt.clone().unwrap_or_default();
        let key = request.cache_key.clone();
        let thinking = thinking_level(request.effective_effort());
        let has_tools = !request.tools.is_empty();
        let default_tool = request.tools.first().map(|t| t.name.clone()).unwrap_or_else(|| "python".into());

        let page = self.host.page().await?;
        let status = self.user_status(&page, false).await?;
        let model = resolve_model(&status.models, &request.model.name)?.clone();
        let existing = key.as_ref().and_then(|k| self.chats.lock().ok()?.get(k).cloned()).filter(|chat| {
            chat.model == model.slug && chat.sent < rendered.len() && hash_rendered(&rendered[..chat.sent]) == chat.prefix_hash
        });
        let (pointer, prompt_text, previous_chars) = match &existing {
            Some(chat) => {
                let update = prompt::system_diff(&chat.system, &system);
                (
                    chat.pointer.clone(),
                    prompt::followup_prompt(&request.transcript[chat.sent..], Some(&update), has_tools),
                    chat.chars,
                )
            }
            None => (
                ChatPointer::default(),
                prompt::opening_prompt(request.system_prompt.as_deref(), &request.tools, &request.transcript),
                0,
            ),
        };
        let (extra_headers, freq) = protocol::generate_payload(&protocol::GenerateRequest {
            prompt: &prompt_text,
            language: &page.tokens.language,
            pointer: &pointer,
            model: &model,
            capacity: status.capacity,
            thinking,
            client_session: &self.client_session,
            temporary: true,
        });
        let path = host::rpc_path(protocol::GENERATE_URL, &page.tokens, self.next_reqid(), &[]);
        let form = vec![("at".to_string(), page.tokens.at.clone()), ("f.req".to_string(), freq)];
        let mut chunks = page.post_stream(&path, &extra_headers, &form).await?;
        let first = tokio::time::timeout(Duration::from_secs(90), chunks.recv())
            .await
            .map_err(|_| AppError::Network("Gemini web : pas de réponse de Google en 90 s.".into()))?;
        match first {
            Some(first) => {
                if let Some(error) = first.get("error").and_then(Value::as_str) {
                    return Err(AppError::Network(format!("Gemini web : requête échouée : {error}")));
                }
                let code = first.get("status").and_then(Value::as_u64).unwrap_or(0);
                if code != 200 {
                    // Tokens may be stale: reload the page next time.
                    *self.status.lock().await = None;
                    return Err(match code {
                        429 => AppError::RateLimit("Gemini web : trop de requêtes (429).".into()),
                        401 | 403 => AppError::Auth(
                            "Gemini web : session refusée. Settings > Providers > Gemini (app web) > Se connecter.".into(),
                        ),
                        400 => AppError::RetryableStream { message: "Gemini web : requête refusée (400), nouvel essai.".into(), delay_ms: Some(1000) },
                        other => AppError::Provider(format!("Gemini web : HTTP {other}.")),
                    });
                }
            }
            None => return Err(AppError::Network("Gemini web : navigateur fermé pendant la requête.".into())),
        }

        let (tx, rx) = mpsc::unbounded::<Result<StreamEvent>>();
        let chats = self.chats.clone();
        let model_label = model.label.clone();
        let model_slug = model.slug.clone();
        tokio::spawn(async move {
            let send = |event: Result<StreamEvent>| {
                let _ = tx.unbounded_send(event);
            };
            send(Ok(StreamEvent::MessageStart { model: model_slug.clone() }));
            let mut parser = FrameParser::default();
            let mut full_text = String::new();
            let mut emitted = String::new();
            let mut thoughts_emitted = String::new();
            let mut thoughts_all = String::new();
            let mut next_index = 0usize;
            let mut thinking_index: Option<usize> = None;
            let mut text_index: Option<usize> = None;
            let mut pointer = pointer;
            loop {
                let message = match tokio::time::timeout(CHUNK_TIMEOUT, chunks.recv()).await {
                    Ok(Some(message)) => message,
                    Ok(None) => {
                        send(Err(AppError::Stream("Gemini web : navigateur fermé pendant la réponse.".into())));
                        return;
                    }
                    Err(_) => {
                        send(Err(AppError::Stream("Gemini web : réponse interrompue (aucune donnée depuis 10 min).".into())));
                        return;
                    }
                };
                if let Some(error) = message.get("error").and_then(Value::as_str) {
                    send(Err(AppError::Stream(format!("Gemini web : flux interrompu : {error}"))));
                    return;
                }
                if message.get("done").is_some() {
                    break;
                }
                let Some(text) = message.get("chunk").and_then(Value::as_str) else { continue };
                for part in parser.feed(&text) {
                    let update = protocol::frame_update(&part);
                    if let Some(code) = update.error_code {
                        let message = protocol::error_message(code, &model_label);
                        send(Err(match code {
                            1037 | 1060 => AppError::RateLimit(message),
                            1013 => AppError::RetryableStream { message, delay_ms: Some(2000) },
                            _ => AppError::Provider(message),
                        }));
                        return;
                    }
                    if let Some(cid) = update.cid {
                        pointer.cid = cid;
                    }
                    if let Some(rid) = update.rid {
                        pointer.rid = rid;
                    }
                    if let Some(rcid) = update.rcid {
                        pointer.rcid = rcid;
                    }
                    if let Some(thoughts) = update.thoughts {
                        if thoughts.starts_with(&thoughts_emitted) && thoughts.len() > thoughts_emitted.len() && text_index.is_none() {
                            let index = *thinking_index.get_or_insert_with(|| {
                                let i = next_index;
                                next_index += 1;
                                send(Ok(StreamEvent::PartStart { index: i, kind: PartKind::Thinking, tool: None }));
                                i
                            });
                            send(Ok(StreamEvent::ThinkingDelta { index, delta: thoughts[thoughts_emitted.len()..].to_string() }));
                            thoughts_emitted = thoughts.clone();
                        }
                        thoughts_all = thoughts;
                    }
                    if let Some(text) = update.text {
                        let clean = protocol::clean_partial(&text);
                        let visible = &clean[..prompt::visible_len(clean)];
                        if visible.starts_with(emitted.as_str()) && visible.len() > emitted.len() {
                            if let Some(index) = thinking_index.take() {
                                send(Ok(StreamEvent::PartStop { index }));
                            }
                            let index = *text_index.get_or_insert_with(|| {
                                let i = next_index;
                                next_index += 1;
                                send(Ok(StreamEvent::PartStart { index: i, kind: PartKind::Text, tool: None }));
                                i
                            });
                            send(Ok(StreamEvent::TextDelta { index, delta: visible[emitted.len()..].to_string() }));
                            emitted = visible.to_string();
                        }
                        full_text = text;
                    }
                }
            }
            if full_text.trim().is_empty() {
                send(Err(AppError::RetryableStream {
                    message: "Gemini web : réponse vide (refus ou erreur passagère de Google).".into(),
                    delay_ms: Some(1500),
                }));
                return;
            }
            let (visible, calls) = prompt::parse_reply(&full_text, &default_tool);
            if visible.starts_with(emitted.as_str()) && visible.len() > emitted.len() {
                if let Some(index) = thinking_index.take() {
                    send(Ok(StreamEvent::PartStop { index }));
                }
                let index = *text_index.get_or_insert_with(|| {
                    let i = next_index;
                    next_index += 1;
                    send(Ok(StreamEvent::PartStart { index: i, kind: PartKind::Text, tool: None }));
                    i
                });
                send(Ok(StreamEvent::TextDelta { index, delta: visible[emitted.len()..].to_string() }));
                emitted = visible.clone();
            }
            if let Some(index) = thinking_index.take() {
                send(Ok(StreamEvent::PartStop { index }));
            }
            if let Some(index) = text_index.take() {
                send(Ok(StreamEvent::PartStop { index }));
            }
            let mut assistant_parts: Vec<Part> = Vec::new();
            if !emitted.is_empty() {
                assistant_parts.push(Part::Text { text: emitted.clone(), meta: None });
            }
            for call in &calls {
                let index = next_index;
                next_index += 1;
                let id = format!("gweb_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
                let input = json!({ "code": call.code });
                send(Ok(StreamEvent::PartStart {
                    index,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro { id: id.clone(), name: call.name.clone() }),
                }));
                send(Ok(StreamEvent::ToolJsonDelta { index, chunk: input.to_string() }));
                send(Ok(StreamEvent::PartStop { index }));
                assistant_parts.push(Part::ToolCall { id, name: call.name.clone(), input, meta: None });
            }
            let chars = previous_chars + prompt_text.len() + full_text.len() + thoughts_all.len();
            if let Some(key) = key {
                let assistant = ChatMessage { role: Role::Assistant, parts: assistant_parts };
                let mut all = rendered.clone();
                all.push(prompt::render_message(&assistant));
                if let Ok(mut chats) = chats.lock() {
                    chats.insert(
                        key,
                        ChatState {
                            pointer,
                            model: model_slug,
                            sent: all.len(),
                            prefix_hash: hash_rendered(&all),
                            system,
                            chars,
                        },
                    );
                }
            }
            let usage = Usage {
                input_tokens: ((previous_chars + prompt_text.len()) / 4) as u32,
                output_tokens: ((full_text.len() + thoughts_all.len()) / 4) as u32,
                total_tokens: (chars / 4) as u32,
                reasoning_tokens: (thoughts_all.len() / 4) as u32,
                ..Usage::default()
            };
            send(Ok(StreamEvent::MessageStop {
                stop_reason: if calls.is_empty() { StopReason::EndTurn } else { StopReason::ToolUse },
                usage,
            }));
        });
        Ok(rx.boxed())
    }
}

/// Connection state shown in Settings.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiWebStatus {
    pub connected: bool,
    pub browser_found: bool,
    pub browser_path: Option<String>,
    pub updated_ms: Option<i64>,
    pub models: Vec<GeminiWebModelInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiWebModelInfo {
    pub id: String,
    pub label: String,
    pub description: String,
}

/// Offline status, or online check (`verify`) that lists the account models.
pub async fn status(verify: bool) -> GeminiWebStatus {
    let jar = CookieJar::load_default();
    let browser = browser::find_browser();
    let mut status = GeminiWebStatus {
        connected: jar.as_ref().is_some_and(CookieJar::is_logged_in),
        browser_found: browser.is_some(),
        browser_path: browser.map(|p| p.display().to_string()),
        updated_ms: jar.as_ref().map(|j| j.updated_ms),
        models: Vec::new(),
        error: None,
    };
    if verify && status.connected {
        match GeminiWebProvider::from_default_sources() {
            Ok(provider) => match provider.models().await {
                Ok(models) => {
                    status.models = models
                        .into_iter()
                        .map(|m| GeminiWebModelInfo { id: m.slug, label: m.label, description: m.description })
                        .collect();
                }
                Err(err) => {
                    status.error = Some(err.to_string());
                }
            },
            Err(err) => status.error = Some(err.to_string()),
        }
    }
    status
}

/// Interactive sign-in in the dedicated browser profile, then saves the jar.
pub async fn login(timeout: Duration) -> Result<GeminiWebStatus> {
    let mut jar = browser::login(timeout).await?;
    jar.last_rotation_ms = now_ms();
    jar.save_default()?;
    Ok(status(true).await)
}

pub fn logout() -> Result<()> {
    browser::logout()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_mapping() {
        assert_eq!(thinking_level(Some(Effort::Low)), 1);
        assert_eq!(thinking_level(Some(Effort::High)), 2);
        assert_eq!(thinking_level(None), 2);
    }

    #[test]
    fn model_resolution() {
        let models = vec![WebModel { id: "95a4".into(), slug: "gemini-argon".into(), label: "4 Argon".into(), description: String::new(), number: 8 }];
        assert_eq!(resolve_model(&models, "gemini-argon").unwrap().id, "95a4");
        assert_eq!(resolve_model(&models, "gemini-4-argon").unwrap().id, "95a4");
        assert!(resolve_model(&models, "gemini-zz").is_err());
    }
}
