// providers — helpers for Anthropic-compatible endpoints: model discovery
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
        .user_agent(cli_version::api_key_user_agent())
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

/// providers — Claude subscription usage windows
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

/// a model announced by the provider (`GET /v1/models`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// `{ data: [{ id, display_name }] }` (Anthropic, OpenAI API) or
/// `{ models: [{ slug | id, display_name }] }` (ChatGPT): ids in the server order, once.
pub fn parse_listed_models(body: &serde_json::Value) -> Vec<ListedModel> {
    let items = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    items
        .iter()
        .filter_map(|item| {
            let text = |key: &str| {
                item.get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let id = text("id").or_else(|| text("slug"))?;
            seen.insert(id.clone()).then(|| ListedModel { label: text("display_name"), id })
        })
        .collect()
}

/// models of the native provider with the connected account (OAuth)
/// or the key: `GET https://api.anthropic.com/v1/models?limit=1000`.
pub async fn list_models(credential: &crate::Credential) -> Result<Vec<ListedModel>> {
    let is_oauth = credential.is_oauth();
    let http = reqwest::Client::builder()
        .user_agent(cli_version::user_agent_for(is_oauth))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| AppError::Network(err.to_string()))?;
    let token = credential.bearer_or_key(&http).await?;
    let mut request = http
        .get("https://api.anthropic.com/v1/models?limit=1000")
        .header("anthropic-version", "2023-06-01")
        .header("accept", "application/json");
    request = if is_oauth {
        request.bearer_auth(token).header("anthropic-beta", "oauth-2025-04-20")
    } else {
        request.header("x-api-key", token)
    };
    let response = request
        .send()
        .await
        .map_err(|err| AppError::Network(format!("model list failed: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Provider(format!("models HTTP {status}: {}", body.chars().take(300).collect::<String>())));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|err| AppError::Decode(format!("invalid models body: {err}")))?;
    Ok(parse_listed_models(&body))
}

#[cfg(test)]
mod listed_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anthropic_and_chatgpt_bodies_give_ids_in_order_once() {
        let anthropic = json!({"data": [
            {"type": "model", "id": "claude-opus-6", "display_name": "Claude Opus 6"},
            {"type": "model", "id": "claude-opus-5-5", "display_name": ""},
            {"type": "model", "id": "claude-opus-6"},
            {"type": "model", "id": "  "}
        ], "has_more": false});
        assert_eq!(
            parse_listed_models(&anthropic),
            vec![
                ListedModel { id: "claude-opus-6".into(), label: Some("Claude Opus 6".into()) },
                ListedModel { id: "claude-opus-5-5".into(), label: None },
            ]
        );
        let chatgpt = json!({"models": [{"slug": "gpt-6-nova", "display_name": "GPT-6 Nova"}]});
        assert_eq!(parse_listed_models(&chatgpt)[0].id, "gpt-6-nova");
        assert!(parse_listed_models(&json!({"error": "x"})).is_empty());
    }
}
