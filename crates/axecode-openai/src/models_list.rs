// models announced by OpenAI for the connected account: ChatGPT
// subscription (`GET {codex}/models`, `models[].slug`) or API key (`GET /v1/models`, `data[].id`).

use serde::Serialize;
use axecode_core::{AppError, Result};

use crate::{auth::Credential, client::{OAUTH_ORIGINATOR, USER_AGENT}};

const API_MODELS_URL: &str = "https://api.openai.com/v1/models";
const CODEX_MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models?client_version=0.99.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// `{ data: [{ id }] }` or `{ models: [{ slug, display_name, visibility }] }`: ids in the
/// server order, once; models the server hides from its own picker are left out.
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
        .filter(|item| item.get("visibility").and_then(serde_json::Value::as_str) != Some("hide"))
        .filter_map(|item| {
            let text = |key: &str| {
                item.get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let id = text("slug").or_else(|| text("id"))?;
            seen.insert(id.clone()).then(|| ListedModel { label: text("display_name"), id })
        })
        .collect()
}

pub async fn list_models(credential: &Credential) -> Result<Vec<ListedModel>> {
    let http = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| AppError::Network(err.to_string()))?;
    let bearer = credential.bearer(&http).await?;
    let mut request = http
        .get(if bearer.is_oauth { CODEX_MODELS_URL } else { API_MODELS_URL })
        .header("authorization", format!("Bearer {}", bearer.token))
        .header("accept", "application/json");
    if bearer.is_oauth {
        request = request.header("originator", OAUTH_ORIGINATOR);
        if let Some(account_id) = bearer.account_id {
            request = request.header("chatgpt-account-id", account_id);
        }
    }
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn added_chatgpt_accounts_are_openai_models() {
        assert!(crate::client::is_openai_provider("openai"));
        assert!(crate::client::is_openai_provider("openai~2"));
        assert!(!crate::client::is_openai_provider("openai~"));
        assert!(!crate::client::is_openai_provider("openrouter"));
    }

    #[test]
    fn chatgpt_and_api_bodies() {
        let chatgpt = json!({"models": [
            {"slug": "gpt-6-nova", "display_name": "GPT-6 Nova", "visibility": "list"},
            {"slug": "codex-auto-review", "visibility": "hide"},
            {"slug": "gpt-6-nova"}
        ]});
        assert_eq!(
            parse_listed_models(&chatgpt),
            vec![ListedModel { id: "gpt-6-nova".into(), label: Some("GPT-6 Nova".into()) }]
        );
        let api = json!({"object": "list", "data": [{"id": "gpt-6-sol", "object": "model"}, {"id": "text-embedding-4"}]});
        assert_eq!(parse_listed_models(&api).len(), 2);
    }
}
