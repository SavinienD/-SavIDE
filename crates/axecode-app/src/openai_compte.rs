//! Compte OpenAI des outils (recherche web et images du REPL et de l'agent).
//!
//! Règle unique : une clé API OpenAI (Réglages > REPL ou
//! variable `OPENAI_API_KEY`) est utilisée si elle existe ; sinon, si un compte
//! ChatGPT est connecté (Réglages > Fournisseurs > OpenAI, OAuth), l'outil
//! passe par l'abonnement ChatGPT (API Responses de chatgpt.com, outils
//! `web_search` / `image_generation`) ; sinon le message dit quoi connecter.

use std::{env, path::Path};

use anyhow::{bail, Result};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;
use axecode_openai::Credential;

pub const OPENAI_API_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
pub const CHATGPT_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

/// Ce qui manque quand aucun compte OpenAI n'est disponible.
pub const AUCUN_COMPTE_OPENAI: &str = "aucun compte OpenAI : connectez ChatGPT dans Réglages > Fournisseurs > OpenAI (l'abonnement est alors utilisé), ou ajoutez une clé API OpenAI dans Réglages > REPL > Recherche web et images.";

/// Accès OpenAI retenu pour un outil.
#[derive(Clone)]
pub enum OpenAiRoute {
    ApiKey(String),
    Subscription(Credential),
    None,
}

impl OpenAiRoute {
    pub fn label(&self) -> &'static str {
        match self {
            OpenAiRoute::ApiKey(_) => "clé API OpenAI",
            OpenAiRoute::Subscription(_) => "abonnement ChatGPT",
            OpenAiRoute::None => "aucun",
        }
    }
}

/// Clé configurée (réglage) sinon `OPENAI_API_KEY`.
pub fn openai_api_key(configured: Option<&str>) -> Option<String> {
    configured
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .or_else(|| env::var("OPENAI_API_KEY").ok().map(|k| k.trim().to_string()))
        .filter(|k| !k.is_empty())
}

/// Compte ChatGPT connecté (OAuth), lu dans `auth_path` ou à l'emplacement habituel.
pub fn chatgpt_credential(auth_path: Option<&Path>) -> Option<Credential> {
    let loaded = match auth_path {
        Some(path) => Credential::from_axecode_auth_file(path),
        None => Credential::load_default(),
    };
    loaded.ok().flatten().filter(Credential::is_oauth)
}

/// Clé API d'abord, abonnement ChatGPT ensuite. `force_subscription` (case
/// « Utiliser l'abonnement » des images) fait passer l'abonnement devant la clé.
pub fn openai_route(configured_key: Option<&str>, auth_path: Option<&Path>, force_subscription: bool) -> OpenAiRoute {
    let key = openai_api_key(configured_key);
    if force_subscription || key.is_none() {
        if let Some(credential) = chatgpt_credential(auth_path) {
            return OpenAiRoute::Subscription(credential);
        }
    }
    match key {
        Some(key) => OpenAiRoute::ApiKey(key),
        None => OpenAiRoute::None,
    }
}

/// Refus de l'abonnement ChatGPT (401/403 : jeton expiré ou révoqué, par
/// exemple après une connexion du même compte dans un autre outil) : dit quoi faire.
pub fn subscription_refused(status: u16) -> Option<String> {
    matches!(status, 401 | 403).then(|| {
        format!(
            "abonnement ChatGPT refusé (HTTP {status} : connexion expirée ou révoquée) : reconnectez ChatGPT dans Réglages > Fournisseurs > OpenAI, ou saisissez une clé API OpenAI dans Réglages > REPL > Recherche web et images."
        )
    })
}

/// Lit un flux SSE de l'API Responses et renvoie les éléments de sortie
/// (`response.output`) une fois la réponse terminée.
pub async fn responses_stream_output(response: reqwest::Response) -> Result<Vec<Value>> {
    let mut stream = response.bytes_stream().eventsource();
    let mut items = Vec::new();
    while let Some(event) = stream.next().await {
        let event = event.map_err(|err| anyhow::anyhow!("flux OpenAI interrompu : {err}"))?;
        let data = event.data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else { continue };
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_item.done") => {
                if let Some(item) = value.get("item") {
                    items.push(item.clone());
                }
            }
            Some("response.completed") => {
                if items.is_empty() {
                    if let Some(output) = value.pointer("/response/output").and_then(Value::as_array) {
                        items.extend(output.iter().cloned());
                    }
                }
                return Ok(items);
            }
            Some("response.failed" | "response.incomplete" | "error") => {
                let message = value
                    .pointer("/response/error/message")
                    .or_else(|| value.pointer("/error/message"))
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("réponse OpenAI en échec");
                bail!("{message}");
            }
            _ => {}
        }
    }
    if items.is_empty() {
        bail!("flux OpenAI terminé avant la fin de la réponse");
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_file(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("openai-auth.json");
        std::fs::write(
            &path,
            r#"{"provider":"openai","authMode":"oauth","tokens":{"accessToken":"a","refreshToken":"r","expiresAtMs":99999999999999}}"#,
        )
        .unwrap();
        path
    }

    #[test]
    fn un_abonnement_refuse_dit_quoi_faire() {
        assert!(subscription_refused(401).unwrap().contains("reconnectez ChatGPT"));
        assert!(subscription_refused(429).is_none());
    }

    #[test]
    fn la_cle_passe_devant_l_abonnement_qui_passe_devant_rien() {
        let dir = tempfile::tempdir().unwrap();
        let auth = auth_file(dir.path());
        let absent = dir.path().join("absent.json");
        assert_eq!(openai_route(Some("sk-x"), Some(&auth), false).label(), "clé API OpenAI");
        assert_eq!(openai_route(None, Some(&auth), false).label(), "abonnement ChatGPT");
        assert_eq!(openai_route(Some("  "), Some(&auth), false).label(), "abonnement ChatGPT");
        assert_eq!(openai_route(Some("sk-x"), Some(&auth), true).label(), "abonnement ChatGPT");
        assert_eq!(openai_route(Some("sk-x"), Some(&absent), true).label(), "clé API OpenAI");
        if env::var("OPENAI_API_KEY").map(|k| k.trim().is_empty()).unwrap_or(true) {
            assert_eq!(openai_route(None, Some(&absent), false).label(), "aucun");
        }
    }
}
