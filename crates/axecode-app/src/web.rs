use std::{env, path::PathBuf, time::Duration};

use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use kuchikiki::{traits::TendrilSink, NodeData, NodeRef};
use reqwest::{
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Url,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use axecode_core::ToolDescriptor;

use crate::openai_compte::{self, OpenAiRoute};
use crate::store::WebSearchProvider;
use crate::tool_names;
use crate::tool_run::ToolRunResult;

const LINKUP_SEARCH_URL: &str = "https://api.linkup.so/v1/search";
const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp";
const EXA_DEFAULT_NUM_RESULTS: u8 = 8;
/// Modèle des recherches OpenAI (clé API ou abonnement ChatGPT), comme les images.
const OPENAI_WEB_SEARCH_MODEL: &str = "gpt-6-astra";
const OPENAI_WEB_SEARCH_DEFAULT_RESULTS: u8 = 6;
const USER_AGENT: &str = "axecode/0.1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
const WEBSEARCH_RESPONSE_LIMIT: usize = 256 * 1024;
const WEBFETCH_RESPONSE_LIMIT: usize = 512 * 1024;
const TOOL_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct WebSearchTool {
    http: reqwest::Client,
    provider: WebSearchProvider,
    api_key: Option<String>,
    /// Clé API OpenAI des réglages (sinon `OPENAI_API_KEY`) : mode Automatique.
    openai_api_key: Option<String>,
    /// Abonnement ChatGPT choisi plutôt que la clé (même case que les images).
    openai_prefer_subscription: bool,
    /// Tests : fichier du compte ChatGPT et adresses des API remplacés.
    openai_auth_path: Option<PathBuf>,
    openai_api_url: String,
    chatgpt_url: String,
    exa_url: String,
}

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebSearchTool {
    pub fn new() -> Self {
        Self::with_api_key(None)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        Self::with_settings(WebSearchProvider::LinkUp, api_key)
    }

    pub fn with_settings(provider: WebSearchProvider, api_key: Option<String>) -> Self {
        Self {
            http: web_client(),
            provider,
            api_key: api_key
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty()),
            openai_api_key: None,
            openai_prefer_subscription: false,
            openai_auth_path: None,
            openai_api_url: openai_compte::OPENAI_API_RESPONSES_URL.into(),
            chatgpt_url: openai_compte::CHATGPT_RESPONSES_URL.into(),
            exa_url: EXA_MCP_URL.into(),
        }
    }

    /// Outil configuré d'après les réglages (fournisseur, clés LinkUp et OpenAI).
    pub fn from_settings(settings: &crate::store::ToolSettings) -> Self {
        Self::with_settings(settings.web_search_provider, settings.linkup_api_key())
            .with_openai_api_key(settings.openai_image_api_key())
            .with_openai_prefer_subscription(settings.openai_image_use_subscription)
    }

    /// Case « Utiliser l'abonnement ChatGPT plutôt que la clé » (recherche et images).
    pub fn with_openai_prefer_subscription(mut self, prefer: bool) -> Self {
        self.openai_prefer_subscription = prefer;
        self
    }

    /// Clé API OpenAI des réglages (mode Automatique : clé, sinon abonnement ChatGPT, sinon Exa).
    pub fn with_openai_api_key(mut self, key: Option<String>) -> Self {
        self.openai_api_key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        self
    }

    #[cfg(test)]
    fn with_test_endpoints(mut self, auth_path: PathBuf, openai_api: String, chatgpt: String, exa: String) -> Self {
        self.openai_auth_path = Some(auth_path);
        self.openai_api_url = openai_api;
        self.chatgpt_url = chatgpt;
        self.exa_url = exa;
        self
    }

    /// Fournisseur réellement utilisé par le mode Automatique, en clair.
    pub fn auto_route(&self) -> OpenAiRoute {
        openai_compte::openai_route(
            self.openai_api_key.as_deref(),
            self.openai_auth_path.as_deref(),
            self.openai_prefer_subscription,
        )
    }

    pub fn descriptor(&self) -> ToolDescriptor {
        match self.provider {
            WebSearchProvider::LinkUp => ToolDescriptor {
                name: tool_names::WEB_SEARCH.into(),
                description: "Use this for web search, documentation check or fresh information."
                    .into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "q": {
                            "type": "string",
                            "description": "The search question, ask a real question, not a bot query."
                        },
                        "depth": {
                            "type": "string",
                            "enum": ["standard", "deep"],
                            "description": "Use `standard` for a simple direct answer, `deep` for complex research with multiple sources."
                        }
                    },
                    "required": ["q", "depth"],
                    "additionalProperties": false
                }),
            },
            WebSearchProvider::Auto | WebSearchProvider::Exa => ToolDescriptor {
                name: tool_names::WEB_SEARCH.into(),
                description: "Use this for web search, documentation check or fresh information."
                    .into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query."
                        },
                        "numResults": {
                            "type": "number",
                            "description": "Number of search results to return. Defaults to 8."
                        },
                        "contextMaxCharacters": {
                            "type": "number",
                            "description": "Maximum characters for context optimized for LLMs. Defaults to Exa's standard value."
                        }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }),
            },
        }
    }

    pub async fn run(&self, input: Value) -> ToolRunResult {
        match self.search(input).await {
            Ok(output) => ToolRunResult::ok(output, Vec::new()),
            Err(err) => ToolRunResult::err(err.to_string(), Vec::new()),
        }
    }

    async fn search(&self, input: Value) -> Result<String> {
        match self.provider {
            WebSearchProvider::LinkUp => self.search_linkup(input).await,
            WebSearchProvider::Exa => self.search_classic(input).await,
            WebSearchProvider::Auto => self.search_auto(input).await,
        }
    }

    /// Automatique : clé API OpenAI, sinon abonnement ChatGPT (outil `web_search`
    /// de l'API Responses) ; sans compte OpenAI ou en cas d'échec, Exa (gratuit).
    async fn search_auto(&self, input: Value) -> Result<String> {
        let route = self.auto_route();
        if matches!(route, OpenAiRoute::None) {
            return self.search_classic(input).await;
        }
        match self.search_openai(&route, input.clone()).await {
            Ok(text) => Ok(text),
            Err(err) => {
                let exa = self.search_classic(input).await?;
                Ok(format!(
                    "(Recherche OpenAI ({}) indisponible : {} — résultats Exa.)\n\n{exa}",
                    route.label(),
                    clip_chars(&err.to_string(), 300).0
                ))
            }
        }
    }

    async fn search_openai(&self, route: &OpenAiRoute, input: Value) -> Result<String> {
        let parsed: ExaSearchInput = serde_json::from_value(input)
            .map_err(|err| anyhow::anyhow!("invalid web_search input: {err}"))?;
        let query = parsed.query.trim();
        if query.is_empty() {
            bail!("query is required");
        }
        let count = parsed.num_results.unwrap_or(OPENAI_WEB_SEARCH_DEFAULT_RESULTS).clamp(1, 20);
        let instructions = format!(
            "Search the web for the user's query, then answer briefly in the language of the query. \
             Then list up to {count} sources you actually used, one per line: `- title — URL — one-line summary`. \
             Always call web_search first; never answer from memory alone."
        );
        let subscription = matches!(route, OpenAiRoute::Subscription(_));
        let body = json!({
            "model": OPENAI_WEB_SEARCH_MODEL,
            "instructions": instructions,
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": query}]}],
            "tools": [{"type": "web_search"}],
            "tool_choice": "auto",
            "stream": subscription,
            "store": false,
        });
        let request = match route {
            OpenAiRoute::ApiKey(key) => self
                .http
                .post(&self.openai_api_url)
                .header(AUTHORIZATION, format!("Bearer {key}"))
                .header(ACCEPT, "application/json"),
            OpenAiRoute::Subscription(credential) => {
                let bearer = credential.bearer(&self.http).await?;
                let mut request = self
                    .http
                    .post(&self.chatgpt_url)
                    .header(AUTHORIZATION, format!("Bearer {}", bearer.token))
                    .header("openai-beta", "responses=experimental")
                    .header(ACCEPT, "text/event-stream");
                if let Some(account) = bearer.account_id.as_deref() {
                    request = request.header("chatgpt-account-id", account);
                }
                request
            }
            OpenAiRoute::None => bail!("{}", openai_compte::AUCUN_COMPTE_OPENAI),
        };
        let response = request
            .header(CONTENT_TYPE, "application/json")
            .timeout(Duration::from_secs(120))
            .json(&body)
            .send()
            .await
            .context("OpenAI web_search request failed")?;
        let status = response.status();
        if !status.is_success() {
            if subscription {
                if let Some(message) = openai_compte::subscription_refused(status.as_u16()) {
                    bail!("{message}");
                }
            }
            let (text, _) = collect_response_text(response, 8 * 1024).await?;
            bail!("OpenAI web_search ({status}) : {}", clip_chars(&text, 500).0);
        }
        let items = if subscription {
            openai_compte::responses_stream_output(response).await?
        } else {
            let (text, _) = collect_response_text(response, WEBSEARCH_RESPONSE_LIMIT).await?;
            let value: Value = serde_json::from_str(&text).context("invalid OpenAI response")?;
            value.get("output").and_then(Value::as_array).cloned().unwrap_or_default()
        };
        let output = format_openai_web_search(&items, route.label());
        if output.trim().is_empty() {
            bail!("OpenAI n'a renvoyé aucun texte");
        }
        Ok(clip_with_notice(output, TOOL_OUTPUT_LIMIT))
    }

    async fn search_linkup(&self, input: Value) -> Result<String> {
        let parsed: WebSearchInput = serde_json::from_value(input)
            .map_err(|err| anyhow::anyhow!("invalid web_search input: {err}"))?;
        let q = parsed.q.trim();
        if q.is_empty() {
            bail!("q is required");
        }
        let api_key = load_linkup_api_key(self.api_key.as_deref())?;

        let response = self
            .http
            .post(LINKUP_SEARCH_URL)
            .header(AUTHORIZATION, format!("Bearer {api_key}"))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .json(&json!({
                "q": q,
                "depth": parsed.depth.as_str(),
                "outputType": "sourcedAnswer",
                "includeInlineCitations": "true"
            }))
            .send()
            .await
            .context("Linkup request failed")?;

        let status = response.status();
        let (body, truncated) = collect_response_text(response, WEBSEARCH_RESPONSE_LIMIT).await?;
        if !status.is_success() {
            bail!(
                "Linkup request failed ({status}): {}",
                clip_chars(&body, 2_000).0
            );
        }

        let mut output = match serde_json::from_str::<Value>(&body) {
            Ok(value) => format_linkup_response(&value),
            Err(_) => body,
        };

        if truncated {
            output.push_str("\n\n[Response truncated]");
        }

        Ok(clip_with_notice(output, TOOL_OUTPUT_LIMIT))
    }

    async fn search_classic(&self, input: Value) -> Result<String> {
        let parsed: ExaSearchInput = serde_json::from_value(input)
            .map_err(|err| anyhow::anyhow!("invalid web_search input: {err}"))?;
        let query = parsed.query.trim();
        if query.is_empty() {
            bail!("query is required");
        }

        let body = exa_web_search_body(&parsed, query);
        let response = self
            .http
            .post(&self.exa_url)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .context("Exa web_search request failed")?;
        let status = response.status();
        let (body, truncated) = collect_response_text(response, WEBSEARCH_RESPONSE_LIMIT).await?;
        if !status.is_success() {
            bail!(
                "Exa web_search request failed ({status}): {}",
                clip_chars(&body, 2_000).0
            );
        }

        let mut output = parse_exa_web_search_response(&body)?;
        if truncated {
            output.push_str("\n\n[Response truncated]");
        }

        Ok(clip_with_notice(output, TOOL_OUTPUT_LIMIT))
    }
}

fn load_linkup_api_key(configured: Option<&str>) -> Result<String> {
    configured
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env::var("LINKUP_API_KEY")
                .ok()
                .map(|key| key.trim().to_string())
        })
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "LinkUp API key is missing. Add it in Settings > Tools before using web_search."
            )
        })
}

fn exa_web_search_body(input: &ExaSearchInput, query: &str) -> Value {
    let mut arguments = Map::new();
    arguments.insert("query".into(), json!(query));
    arguments.insert("type".into(), json!("deep"));
    arguments.insert(
        "numResults".into(),
        json!(input.num_results.unwrap_or(EXA_DEFAULT_NUM_RESULTS)),
    );
    arguments.insert("livecrawl".into(), json!("preferred"));
    if let Some(context_max_characters) = input.context_max_characters {
        arguments.insert("contextMaxCharacters".into(), json!(context_max_characters));
    }

    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "web_search_exa",
            "arguments": arguments
        }
    })
}

#[derive(Debug, Clone)]
pub struct WebFetchTool {
    http: reqwest::Client,
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebFetchTool {
    pub fn new() -> Self {
        Self { http: web_client() }
    }

    pub fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: tool_names::WEB_FETCH.into(),
            description: "Fetch a specific URL, usually a source returned by web_search, and return readable text for closer inspection.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch."
                    }
                },
                "required": ["url"],
                "additionalProperties": false
            }),
        }
    }

    pub async fn run(&self, input: Value) -> ToolRunResult {
        match self.fetch(input).await {
            Ok(output) => ToolRunResult::ok(output, Vec::new()),
            Err(err) => ToolRunResult::err(err.to_string(), Vec::new()),
        }
    }

    async fn fetch(&self, input: Value) -> Result<String> {
        let parsed: WebFetchInput = serde_json::from_value(input)
            .map_err(|err| anyhow::anyhow!("invalid web_fetch input: {err}"))?;
        let url = parse_http_url(&parsed.url)?;

        let response = self
            .http
            .get(url)
            .header(
                ACCEPT,
                "text/html, text/plain, application/json, application/xml, text/xml, */*;q=0.8",
            )
            .send()
            .await
            .context("web fetch failed")?;

        let final_url = response.url().to_string();
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("unknown")
            .to_string();
        let (body, truncated_bytes) =
            collect_response_text(response, WEBFETCH_RESPONSE_LIMIT).await?;

        if !status.is_success() {
            bail!(
                "fetch failed ({status}) for {final_url}: {}",
                clip_chars(&body, 2_000).0
            );
        }

        let is_html = content_type.to_ascii_lowercase().contains("html")
            || body
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("<!doctype html")
            || body.trim_start().to_ascii_lowercase().starts_with("<html");
        let readable = if is_html {
            html_to_markdown(&body, &final_url)
        } else {
            body.trim().to_string()
        };
        let (content, truncated_chars) = clip_chars(&readable, TOOL_OUTPUT_LIMIT);

        let mut output = format!(
            "url: {final_url}\nstatus: {status}\ncontent-type: {content_type}\n\n{content}"
        );
        if truncated_bytes || truncated_chars {
            output.push_str("\n\n[Content truncated]");
        }

        Ok(output)
    }
}

#[derive(Debug, Deserialize)]
struct WebSearchInput {
    #[serde(alias = "query")]
    q: String,
    // Le REPL (`web.search(query)`) n'envoie pas de profondeur : standard.
    #[serde(default)]
    depth: SearchDepth,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SearchDepth {
    #[default]
    Standard,
    Deep,
}

impl SearchDepth {
    fn as_str(self) -> &'static str {
        match self {
            SearchDepth::Standard => "standard",
            SearchDepth::Deep => "deep",
        }
    }
}

#[derive(Debug, Deserialize)]
struct ExaSearchInput {
    #[serde(alias = "q")]
    query: String,
    // `max_results` : nom utilisé par `web.search(query, max_results=...)` du REPL.
    #[serde(default, rename = "numResults", alias = "num_results", alias = "max_results")]
    num_results: Option<u8>,
    #[serde(
        default,
        rename = "contextMaxCharacters",
        alias = "context_max_characters"
    )]
    context_max_characters: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct WebFetchInput {
    url: String,
}

fn web_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn parse_http_url(raw: &str) -> Result<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        bail!("url is required");
    }
    let url = Url::parse(raw).context("invalid url")?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => bail!("url must start with http:// or https://"),
    }
}

async fn collect_response_text(
    response: reqwest::Response,
    byte_limit: usize,
) -> Result<(String, bool)> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("unable to read response body")?;
        let remaining = byte_limit.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= byte_limit {
            truncated = true;
            break;
        }
    }

    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

/// Texte et sources (annotations `url_citation`) d'une réponse OpenAI `web_search`.
fn format_openai_web_search(items: &[Value], via: &str) -> String {
    let mut text = String::new();
    let mut sources: Vec<(String, String)> = Vec::new();
    for item in items.iter().filter(|i| i.get("type").and_then(Value::as_str) == Some("message")) {
        for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
            if let Some(t) = part.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(t.trim());
            }
            for note in part.get("annotations").and_then(Value::as_array).into_iter().flatten() {
                let Some(url) = note.get("url").and_then(Value::as_str) else { continue };
                if sources.iter().any(|(u, _)| u == url) {
                    continue;
                }
                let title = note.get("title").and_then(Value::as_str).unwrap_or("").trim().to_string();
                sources.push((url.to_string(), title));
            }
        }
    }
    if text.trim().is_empty() {
        return String::new();
    }
    let missing: Vec<String> = sources
        .iter()
        .filter(|(url, _)| !text.contains(url.as_str()))
        .map(|(url, title)| if title.is_empty() { format!("- {url}") } else { format!("- {title} — {url}") })
        .collect();
    if !missing.is_empty() {
        text.push_str("\n\nSources :\n");
        text.push_str(&missing.join("\n"));
    }
    text.push_str(&format!("\n\n(Recherche OpenAI web_search, {via}.)"));
    text
}

fn format_linkup_response(value: &Value) -> String {
    let mut output = String::new();
    if let Some(answer) = string_field(value, &["answer", "sourcedAnswer", "output"]) {
        output.push_str(answer.trim());
    } else {
        output.push_str(&serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()));
    }

    if let Some(sources) = array_field(value, &["sources", "results", "documents"]) {
        let rendered = sources
            .iter()
            .take(12)
            .enumerate()
            .filter_map(|(index, source)| render_source(index + 1, source))
            .collect::<Vec<_>>();
        if !rendered.is_empty() {
            output.push_str("\n\nSources:\n");
            output.push_str(&rendered.join("\n"));
        }
    }

    output
}

fn parse_exa_web_search_response(body: &str) -> Result<String> {
    if body
        .lines()
        .any(|line| line.trim_start().starts_with("data:"))
    {
        for event in parse_sse_json_events(body)? {
            if let Some(text) = exa_result_text(&event) {
                return Ok(text);
            }
        }
        bail!("No search results found. Please try a different query.");
    }

    let value: Value = serde_json::from_str(body).context("invalid Exa web_search response")?;
    exa_result_text(&value)
        .ok_or_else(|| anyhow::anyhow!("No search results found. Please try a different query."))
}

fn exa_result_text(value: &Value) -> Option<String> {
    value
        .get("result")?
        .get("content")?
        .as_array()?
        .iter()
        .find_map(|item| {
            let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if kind == "text" {
                item.get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string)
            } else {
                None
            }
        })
}

fn parse_sse_json_events(body: &str) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    let mut current = String::new();

    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            flush_sse_json_event(&mut current, &mut events)?;
            continue;
        }
        let Some(data) = line.trim_start().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        if data == "[DONE]" {
            flush_sse_json_event(&mut current, &mut events)?;
            continue;
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(data);
    }
    flush_sse_json_event(&mut current, &mut events)?;

    if events.is_empty() {
        bail!("Exa web_search returned an empty stream");
    }
    Ok(events)
}

fn flush_sse_json_event(current: &mut String, events: &mut Vec<Value>) -> Result<()> {
    let payload = current.trim();
    if !payload.is_empty() {
        events.push(
            serde_json::from_str(payload)
                .with_context(|| format!("invalid Exa web_search stream event: {payload}"))?,
        );
    }
    current.clear();
    Ok(())
}

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| value.get(*key)?.as_str())
}

fn array_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter().find_map(|key| value.get(*key)?.as_array())
}

fn render_source(index: usize, source: &Value) -> Option<String> {
    let title = string_field(source, &["title", "name", "source"])
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let url = string_field(source, &["url", "link"])
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let snippet = string_field(source, &["snippet", "content", "text"])
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if title.is_none() && url.is_none() && snippet.is_none() {
        return None;
    }

    let mut line = format!("[{index}]");
    if let Some(title) = title {
        line.push(' ');
        line.push_str(title);
    }
    if let Some(url) = url {
        if title.is_some() {
            line.push_str(" - ");
        } else {
            line.push(' ');
        }
        line.push_str(url);
    }
    if let Some(snippet) = snippet {
        let snippet = clip_chars(snippet, 300).0;
        line.push_str("\n    ");
        line.push_str(&snippet);
    }

    Some(line)
}

fn clip_with_notice(input: String, max_chars: usize) -> String {
    let (mut clipped, truncated) = clip_chars(&input, max_chars);
    if truncated {
        clipped.push_str("\n\n[Output truncated]");
    }
    clipped
}

fn clip_chars(input: &str, max_chars: usize) -> (String, bool) {
    if input.chars().count() <= max_chars {
        return (input.to_string(), false);
    }
    (input.chars().take(max_chars).collect(), true)
}

fn html_to_markdown(html: &str, base_url: &str) -> String {
    let document = kuchikiki::parse_html().one(html).document_node;
    let root = content_root(&document);
    let base = Url::parse(base_url).ok();
    let mut output = String::new();

    render_children(&root, &mut output, base.as_ref(), 0);
    normalize_markdown(&output)
}

fn content_root(document: &NodeRef) -> NodeRef {
    for selector in ["article", "main", "body"] {
        if let Ok(node) = document.select_first(selector) {
            return node.as_node().clone();
        }
    }
    document.clone()
}

fn render_children(node: &NodeRef, output: &mut String, base: Option<&Url>, list_depth: usize) {
    for child in node.children() {
        render_node(&child, output, base, list_depth);
    }
}

fn render_node(node: &NodeRef, output: &mut String, base: Option<&Url>, list_depth: usize) {
    match node.data() {
        NodeData::Text(text) => push_text(output, &text.borrow()),
        NodeData::Element(element) => {
            let tag = element.name.local.to_string().to_ascii_lowercase();
            if should_skip_tag(&tag) {
                return;
            }

            match tag.as_str() {
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    let level = tag[1..].parse::<usize>().unwrap_or(2).clamp(1, 6);
                    ensure_blank_line(output);
                    output.push_str(&"#".repeat(level));
                    output.push(' ');
                    render_children(node, output, base, list_depth);
                    ensure_blank_line(output);
                }
                "p" => {
                    ensure_blank_line(output);
                    render_children(node, output, base, list_depth);
                    ensure_blank_line(output);
                }
                "br" => output.push_str("  \n"),
                "hr" => {
                    ensure_blank_line(output);
                    output.push_str("---");
                    ensure_blank_line(output);
                }
                "strong" | "b" => render_wrapped(node, output, base, list_depth, "**", "**"),
                "em" | "i" => render_wrapped(node, output, base, list_depth, "*", "*"),
                "del" | "s" => render_wrapped(node, output, base, list_depth, "~~", "~~"),
                "code" => render_inline_code(node, output),
                "pre" => render_code_block(node, output),
                "a" => render_link(node, output, base),
                "img" => render_image(node, output, base),
                "ul" => render_list(node, output, base, list_depth, false),
                "ol" => render_list(node, output, base, list_depth, true),
                "blockquote" => render_blockquote(node, output, base, list_depth),
                "table" => {
                    if !render_table(node, output) {
                        render_children(node, output, base, list_depth);
                    }
                }
                "div" | "section" | "article" | "main" | "body" | "header" | "footer" => {
                    render_children(node, output, base, list_depth);
                    ensure_blank_line(output);
                }
                "li" => {
                    ensure_line_start(output);
                    output.push_str("- ");
                    render_children(node, output, base, list_depth);
                    output.push('\n');
                }
                _ => render_children(node, output, base, list_depth),
            }
        }
        _ => {}
    }
}

fn should_skip_tag(tag: &str) -> bool {
    matches!(
        tag,
        "script"
            | "style"
            | "noscript"
            | "svg"
            | "canvas"
            | "iframe"
            | "head"
            | "meta"
            | "link"
            | "title"
            | "nav"
            | "aside"
            | "form"
            | "button"
            | "input"
            | "select"
            | "textarea"
    )
}

fn render_wrapped(
    node: &NodeRef,
    output: &mut String,
    base: Option<&Url>,
    list_depth: usize,
    before: &str,
    after: &str,
) {
    output.push_str(before);
    render_children(node, output, base, list_depth);
    trim_trailing_inline_space(output);
    output.push_str(after);
}

fn render_inline_code(node: &NodeRef, output: &mut String) {
    let text = node.text_contents();
    let text = text.trim();
    if text.is_empty() {
        return;
    }

    let fence = if text.contains('`') { "``" } else { "`" };
    output.push_str(fence);
    output.push_str(text);
    output.push_str(fence);
}

fn render_code_block(node: &NodeRef, output: &mut String) {
    let text = node.text_contents();
    let text = text.trim_matches('\n');
    if text.trim().is_empty() {
        return;
    }

    ensure_blank_line(output);
    output.push_str("```");
    if let Some(language) = code_language(node) {
        output.push_str(&language);
    }
    output.push('\n');
    output.push_str(text);
    output.push_str("\n```");
    ensure_blank_line(output);
}

fn code_language(node: &NodeRef) -> Option<String> {
    let class = attr(node, "class").or_else(|| {
        node.select_first("code")
            .ok()
            .and_then(|code| attr(code.as_node(), "class"))
    })?;

    class.split_whitespace().find_map(|part| {
        part.strip_prefix("language-")
            .or_else(|| part.strip_prefix("lang-"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn render_link(node: &NodeRef, output: &mut String, base: Option<&Url>) {
    let Some(href) = attr(node, "href").map(|value| resolve_url(&value, base)) else {
        render_children(node, output, base, 0);
        return;
    };

    let label = normalize_inline(&node.text_contents());
    let label = if label.is_empty() {
        href.clone()
    } else {
        escape_markdown_text(&label)
    };

    output.push('[');
    output.push_str(&label);
    output.push_str("](");
    output.push_str(&escape_markdown_url(&href));
    output.push(')');
}

fn render_image(node: &NodeRef, output: &mut String, base: Option<&Url>) {
    let Some(src) = attr(node, "src").map(|value| resolve_url(&value, base)) else {
        return;
    };
    let alt = attr(node, "alt").unwrap_or_default();

    output.push_str("![");
    output.push_str(&escape_markdown_text(&alt));
    output.push_str("](");
    output.push_str(&escape_markdown_url(&src));
    output.push(')');
}

fn render_list(
    node: &NodeRef,
    output: &mut String,
    base: Option<&Url>,
    list_depth: usize,
    ordered: bool,
) {
    ensure_blank_line(output);
    let mut index = 1usize;

    for child in node.children() {
        if tag_name(&child).as_deref() != Some("li") {
            continue;
        }

        let mut item = String::new();
        render_children(&child, &mut item, base, list_depth + 1);
        let item = normalize_markdown(&item);
        if item.is_empty() {
            continue;
        }

        let indent = "  ".repeat(list_depth);
        let prefix = if ordered {
            let value = format!("{index}. ");
            index += 1;
            value
        } else {
            "- ".to_string()
        };

        for (line_index, line) in item.lines().enumerate() {
            ensure_line_start(output);
            output.push_str(&indent);
            if line_index == 0 {
                output.push_str(&prefix);
            } else {
                output.push_str(&" ".repeat(prefix.len()));
            }
            output.push_str(line);
            output.push('\n');
        }
    }

    ensure_blank_line(output);
}

fn render_blockquote(node: &NodeRef, output: &mut String, base: Option<&Url>, list_depth: usize) {
    let mut quoted = String::new();
    render_children(node, &mut quoted, base, list_depth);
    let quoted = normalize_markdown(&quoted);
    if quoted.is_empty() {
        return;
    }

    ensure_blank_line(output);
    for line in quoted.lines() {
        output.push_str("> ");
        output.push_str(line);
        output.push('\n');
    }
    ensure_blank_line(output);
}

fn render_table(node: &NodeRef, output: &mut String) -> bool {
    let mut rows = Vec::new();
    collect_table_rows(node, &mut rows);
    rows.retain(|row| !row.is_empty());
    if rows.is_empty() {
        return false;
    }

    let column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
    if column_count == 0 {
        return false;
    }

    ensure_blank_line(output);
    render_table_row(output, &rows[0], column_count);
    output.push('|');
    for _ in 0..column_count {
        output.push_str(" --- |");
    }
    output.push('\n');
    for row in rows.iter().skip(1) {
        render_table_row(output, row, column_count);
    }
    ensure_blank_line(output);

    true
}

fn collect_table_rows(node: &NodeRef, rows: &mut Vec<Vec<String>>) {
    for child in node.children() {
        match tag_name(&child).as_deref() {
            Some("tr") => {
                let cells = child
                    .children()
                    .filter_map(|cell| match tag_name(&cell).as_deref() {
                        Some("th") | Some("td") => {
                            Some(escape_table_cell(&normalize_inline(&cell.text_contents())))
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                rows.push(cells);
            }
            Some("table") => {}
            _ => collect_table_rows(&child, rows),
        }
    }
}

fn render_table_row(output: &mut String, row: &[String], column_count: usize) {
    output.push('|');
    for index in 0..column_count {
        output.push(' ');
        output.push_str(row.get(index).map(String::as_str).unwrap_or(""));
        output.push_str(" |");
    }
    output.push('\n');
}

fn attr(node: &NodeRef, name: &str) -> Option<String> {
    node.as_element()?
        .attributes
        .borrow()
        .get(name)
        .map(ToString::to_string)
}

fn tag_name(node: &NodeRef) -> Option<String> {
    Some(
        node.as_element()?
            .name
            .local
            .to_string()
            .to_ascii_lowercase(),
    )
}

fn resolve_url(raw: &str, base: Option<&Url>) -> String {
    let raw = raw.trim();
    base.and_then(|url| url.join(raw).ok())
        .map(|url| url.to_string())
        .unwrap_or_else(|| raw.to_string())
}

fn push_text(output: &mut String, text: &str) {
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }

        if pending_space && should_insert_space(output) {
            output.push(' ');
        }
        pending_space = false;

        if matches!(ch, '\\' | '*' | '_' | '[' | ']' | '`') {
            output.push('\\');
        }
        output.push(ch);
    }

    if pending_space && should_insert_space(output) {
        output.push(' ');
    }
}

fn should_insert_space(output: &str) -> bool {
    output
        .chars()
        .last()
        .is_some_and(|ch| !ch.is_whitespace() && ch != '(' && ch != '[')
}

fn ensure_blank_line(output: &mut String) {
    trim_trailing_inline_space(output);
    if output.is_empty() || output.ends_with("\n\n") {
        return;
    }
    if output.ends_with('\n') {
        output.push('\n');
    } else {
        output.push_str("\n\n");
    }
}

fn ensure_line_start(output: &mut String) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
}

fn trim_trailing_inline_space(output: &mut String) {
    let trimmed_len = output.trim_end_matches([' ', '\t']).len();
    output.truncate(trimmed_len);
}

fn normalize_inline(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_markdown(text: &str) -> String {
    let mut output = String::new();
    let mut pending_blank = false;

    for raw_line in text.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            pending_blank = true;
            continue;
        }

        if !output.is_empty() {
            if pending_blank {
                output.push_str("\n\n");
            } else {
                output.push('\n');
            }
        }
        output.push_str(line);
        pending_blank = false;
    }

    output.trim().to_string()
}

fn escape_markdown_text(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, '\\' | '*' | '_' | '[' | ']' | '`') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn escape_markdown_url(url: &str) -> String {
    url.replace(')', "%29").replace(' ', "%20")
}

fn escape_table_cell(text: &str) -> String {
    text.replace('|', "\\|")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- web.search du REPL et compte OpenAI par défaut ----

    #[test]
    fn repl_max_results_and_missing_depth_are_accepted() {
        let exa: ExaSearchInput = serde_json::from_value(json!({"query": "x", "max_results": 3})).unwrap();
        assert_eq!(exa.num_results, Some(3), "max_results du REPL ignoré");
        let linkup: Result<WebSearchInput, _> = serde_json::from_value(json!({"query": "x"}));
        assert!(linkup.is_ok(), "LinkUp exige depth : {linkup:?}");
    }

    #[test]
    fn classic_stored_value_becomes_auto() {
        let p: WebSearchProvider = serde_json::from_value(json!("classic")).unwrap();
        assert_eq!(p, WebSearchProvider::Auto);
        assert_eq!(WebSearchProvider::default(), WebSearchProvider::Auto);
        assert_eq!(serde_json::to_value(WebSearchProvider::Exa).unwrap(), json!("exa"));
    }

    fn reponse_openai() -> Value {
        json!({"type": "message", "role": "assistant", "content": [{
            "type": "output_text",
            "text": "Rust 1.99 est sortie.",
            "annotations": [{"type": "url_citation", "url": "https://blog.rust-lang.org/x", "title": "Blog Rust"}]
        }]})
    }

    fn exa_sse() -> crate::faux_http::Reponse {
        crate::faux_http::Reponse::sse(&[json!({"result": {"content": [{"type": "text", "text": "Title: Exa\nURL: https://exa.example"}]}})])
    }

    fn cle_env_absente() -> bool {
        env::var("OPENAI_API_KEY").map(|k| k.trim().is_empty()).unwrap_or(true)
    }

    #[tokio::test]
    async fn auto_uses_chatgpt_subscription_without_api_key() {
        if !cle_env_absente() {
            return;
        }
        use crate::faux_http::{compte_chatgpt, lancer, Reponse};
        let dir = tempfile::tempdir().unwrap();
        let serveur = lancer(|r, _| match r.path.as_str() {
            "/codex" => Reponse::sse(&[
                json!({"type": "response.output_item.done", "item": {"type": "web_search_call", "status": "completed"}}),
                json!({"type": "response.output_item.done", "item": reponse_openai()}),
                json!({"type": "response.completed", "response": {"output": []}}),
            ]),
            _ => exa_sse(),
        })
        .await;
        let b = &serveur.base;
        let tool = WebSearchTool::with_settings(WebSearchProvider::Auto, None).with_test_endpoints(
            compte_chatgpt(dir.path()),
            format!("{b}/api"),
            format!("{b}/codex"),
            format!("{b}/exa"),
        );
        let out = tool.run(json!({"query": "rust", "max_results": 2})).await;
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("Rust 1.99 est sortie."), "{}", out.content);
        assert!(out.content.contains("Blog Rust — https://blog.rust-lang.org/x"), "{}", out.content);
        assert!(out.content.contains("abonnement ChatGPT"), "{}", out.content);
        let reqs = serveur.requetes();
        assert_eq!(reqs.len(), 1, "un seul appel, pas d'Exa : {reqs:?}");
        assert_eq!(reqs[0].path, "/codex");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer jeton-test"));
        assert_eq!(reqs[0].header("chatgpt-account-id"), Some("compte-test"));
        let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
        assert_eq!(body["tools"][0]["type"], "web_search");
        assert_eq!(body["stream"], true);
        assert!(body["instructions"].as_str().unwrap().contains("up to 2 sources"));
    }

    #[tokio::test]
    async fn auto_follows_the_saved_subscription_choice_over_the_api_key() {
        use crate::faux_http::{compte_chatgpt, lancer, Reponse};
        let dir = tempfile::tempdir().unwrap();
        let serveur = lancer(|r, _| match r.path.as_str() {
            "/codex" => Reponse::sse(&[
                json!({"type": "response.output_item.done", "item": reponse_openai()}),
                json!({"type": "response.completed", "response": {"output": []}}),
            ]),
            "/api" => Reponse::json(json!({"output": [reponse_openai()]})),
            _ => exa_sse(),
        })
        .await;
        let b = serveur.base.clone();
        let settings = crate::store::ToolSettings {
            openai_image_api_key: "sk-test".into(),
            openai_image_use_subscription: true,
            ..Default::default()
        };
        let tool = WebSearchTool::from_settings(&settings).with_test_endpoints(
            compte_chatgpt(dir.path()),
            format!("{b}/api"),
            format!("{b}/codex"),
            format!("{b}/exa"),
        );
        let out = tool.run(json!({"query": "rust"})).await;
        assert!(out.content.contains("abonnement ChatGPT"), "{}", out.content);
        let reqs = serveur.requetes();
        assert_eq!(reqs[0].path, "/codex", "la clé API ne doit pas passer devant l'abonnement choisi : {reqs:?}");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer jeton-test"));
    }

    #[tokio::test]
    async fn auto_prefers_the_api_key_then_falls_back_to_exa() {
        if !cle_env_absente() {
            return;
        }
        use crate::faux_http::{compte_chatgpt, lancer, Reponse};
        let dir = tempfile::tempdir().unwrap();
        let serveur = lancer(|r, _| match r.path.as_str() {
            "/api" => Reponse::json(json!({"output": [reponse_openai()]})),
            _ => exa_sse(),
        })
        .await;
        let b = serveur.base.clone();
        let tool = WebSearchTool::with_settings(WebSearchProvider::Auto, None)
            .with_openai_api_key(Some("sk-test".into()))
            .with_test_endpoints(compte_chatgpt(dir.path()), format!("{b}/api"), format!("{b}/codex"), format!("{b}/exa"));
        let out = tool.run(json!({"query": "rust"})).await;
        assert!(out.content.contains("clé API OpenAI"), "{}", out.content);
        let reqs = serveur.requetes();
        assert_eq!(reqs[0].path, "/api");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer sk-test"));
        assert_eq!(serde_json::from_str::<Value>(&reqs[0].body).unwrap()["stream"], false);

        // Ni clé ni compte : Exa, gratuit, sans erreur.
        let sans = WebSearchTool::with_settings(WebSearchProvider::Auto, None).with_test_endpoints(
            dir.path().join("absent.json"),
            format!("{b}/api"),
            format!("{b}/codex"),
            format!("{b}/exa"),
        );
        let out = sans.run(json!({"query": "rust", "max_results": 3})).await;
        assert!(!out.is_error && out.content.contains("Title: Exa"), "{}", out.content);
        let exa = serveur.requetes().into_iter().find(|r| r.path == "/exa").expect("Exa appelé");
        let body: Value = serde_json::from_str(&exa.body).unwrap();
        assert_eq!(body["params"]["arguments"]["numResults"], 3, "max_results transmis à Exa");
    }

    #[tokio::test]
    async fn auto_falls_back_to_exa_when_openai_fails() {
        if !cle_env_absente() {
            return;
        }
        use crate::faux_http::{compte_chatgpt, lancer, Reponse};
        let dir = tempfile::tempdir().unwrap();
        let serveur = lancer(|r, _| match r.path.as_str() {
            "/codex" => Reponse::status(429, r#"{"error":{"message":"quota"}}"#),
            _ => exa_sse(),
        })
        .await;
        let b = serveur.base.clone();
        let tool = WebSearchTool::with_settings(WebSearchProvider::Auto, None).with_test_endpoints(
            compte_chatgpt(dir.path()),
            format!("{b}/api"),
            format!("{b}/codex"),
            format!("{b}/exa"),
        );
        let out = tool.run(json!({"query": "rust"})).await;
        assert!(!out.is_error, "{}", out.content);
        assert!(out.content.contains("indisponible") && out.content.contains("Title: Exa"), "{}", out.content);
    }

    #[test]
    fn html_to_markdown_removes_noise_and_formats_blocks() {
        let html = r#"<html><head><style>.x{}</style></head><body><h1>Hello</h1><script>alert(1)</script><p>World &amp; <strong>friends</strong></p><a href="/docs">Docs</a></body></html>"#;
        let markdown = html_to_markdown(html, "https://example.com/base/");

        assert!(markdown.contains("# Hello"));
        assert!(markdown.contains("World & **friends**"));
        assert!(markdown.contains("[Docs](https://example.com/docs)"));
        assert!(!markdown.contains("alert"));
    }

    #[test]
    fn html_to_markdown_formats_lists_code_and_tables() {
        let html = r#"
            <body>
              <ul><li>One</li><li>Two</li></ul>
              <pre><code class="language-rust">fn main() {}</code></pre>
              <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
            </body>
        "#;
        let markdown = html_to_markdown(html, "https://example.com");

        assert!(markdown.contains("- One"));
        assert!(markdown.contains("```rust\nfn main() {}\n```"));
        assert!(markdown.contains("| A | B |"));
        assert!(markdown.contains("| 1 | 2 |"));
    }

    #[test]
    fn parse_http_url_rejects_other_schemes() {
        assert!(parse_http_url("https://example.com").is_ok());
        assert!(parse_http_url("file:///etc/passwd").is_err());
    }
}
