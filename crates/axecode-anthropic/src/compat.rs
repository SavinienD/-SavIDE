// axe:providers — helpers for Anthropic-compatible endpoints: model discovery
// and key validation. The native OAuth provider never calls these.

use serde::Deserialize;
use axecode_core::{AppError, ModelDefinition, Result};

use crate::cli_version;

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelBody>,
}

#[derive(Debug, Deserialize)]
struct ModelBody {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(cli_version::user_agent())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| AppError::Network(err.to_string()))
}

/// `GET {base_url}/v1/models` with an `x-api-key` header. Returns model
/// definitions with conservative default capabilities; the user can refine
/// them in Settings.
pub async fn discover_models(base_url: &str, api_key: &str) -> Result<Vec<ModelDefinition>> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err(AppError::InvalidRequest("base URL cannot be empty".into()));
    }
    let route = if base_url.ends_with("/v1") {
        format!("{base_url}/models")
    } else {
        format!("{base_url}/v1/models")
    };
    let mut request = http()?
        .get(route)
        .header("anthropic-version", "2023-06-01")
        .header("accept", "application/json");
    if !api_key.trim().is_empty() {
        request = request.header("x-api-key", api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|err| AppError::Network(format!("model discovery failed: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            AppError::Auth(format!("API key rejected ({status}): {body}"))
        } else {
            AppError::Provider(format!("HTTP {status}: {body}"))
        });
    }
    let body: ModelsResponse = response
        .json()
        .await
        .map_err(|err| AppError::Decode(format!("invalid models body: {err}")))?;
    Ok(body
        .data
        .into_iter()
        .filter(|model| !model.id.trim().is_empty())
        .map(|model| {
            let mut def = ModelDefinition::new(model.id.trim());
            def.label = model.display_name.unwrap_or_default();
            def.context_window = 200_000;
            def.max_output_tokens = 32_000;
            def.supports_tools = true;
            def.supports_vision = true;
            def.supports_reasoning = def.id.contains("claude");
            def
        })
        .collect())
}

/// axe:providers — Claude subscription usage windows
/// (`GET https://api.anthropic.com/api/oauth/usage`). Returned raw: every
/// top-level object carrying a `utilization` field is a quota window
/// (`five_hour`, `seven_day`, `seven_day_opus`, …).
pub async fn fetch_oauth_usage() -> Result<Option<serde_json::Value>> {
    let http = http()?;
    let Some(token) = crate::auth::load_default_oauth_access_token(&http).await? else {
        return Ok(None);
    };
    let response = http
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|err| AppError::Network(format!("usage request failed: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Provider(format!("usage HTTP {status}: {body}")));
    }
    response
        .json()
        .await
        .map(Some)
        .map_err(|err| AppError::Decode(format!("invalid usage body: {err}")))
}
