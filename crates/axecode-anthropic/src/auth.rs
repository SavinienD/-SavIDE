use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use directories::ProjectDirs;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use axecode_core::{AppError, Result};

const ANTHROPIC_OAUTH_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const ANTHROPIC_OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// Account behind the subscription login (e-mail, plan) — same header as the usage endpoint.
const ANTHROPIC_OAUTH_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_SCOPE: &str =
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REFRESH_SKEW_MS: i64 = 5 * 60_000;
pub(crate) const ANTHROPIC_RECONNECT_MESSAGE: &str =
    "Anthropic login expired. Please reconnect Anthropic in Settings > Providers.";

#[derive(Clone)]
pub enum Credential {
    OAuth(Arc<Mutex<OAuthToken>>),
    // providers — plain API key for Anthropic-compatible endpoints.
    ApiKey(String),
}

pub struct OAuthToken {
    access: String,
    refresh: String,
    expires_at_ms: i64,
    source_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicAuthStatus {
    pub connected: bool,
    pub expires_at_ms: Option<i64>,
    pub last_refresh_ms: Option<i64>,
    /// E-mail of the Claude account (never a token).
    pub email: Option<String>,
    /// Plan shown by Anthropic ("Pro", "Max"…), when known.
    pub plan: Option<String>,
}

impl AnthropicAuthStatus {
    pub fn disconnected() -> Self {
        Self {
            connected: false,
            expires_at_ms: None,
            last_refresh_ms: None,
            email: None,
            plan: None,
        }
    }
}

/// Who is connected: read from the token response (`account.email_address`)
/// and from `GET /api/oauth/profile`, stored next to the tokens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicAccount {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

impl AnthropicAccount {
    fn is_empty(&self) -> bool {
        self.email.is_none() && self.plan.is_none()
    }

    /// Fields of `newer` win, missing ones keep the previous value.
    fn merged(self, newer: AnthropicAccount) -> AnthropicAccount {
        AnthropicAccount {
            email: newer.email.or(self.email),
            plan: newer.plan.or(self.plan),
        }
    }
}

fn non_empty(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// E-mail and plan from the body of `/api/oauth/profile`
/// (`account.email`, `organization.plan_display_name` / `organization_type`).
pub fn account_from_profile(profile: &serde_json::Value) -> AnthropicAccount {
    let account = profile.get("account");
    let organization = profile.get("organization");
    let email = account.and_then(|a| non_empty(a.get("email")).or_else(|| non_empty(a.get("email_address"))));
    let flag = |name: &str| account.and_then(|a| a.get(name)).and_then(serde_json::Value::as_bool) == Some(true);
    let plan = organization
        .and_then(|o| non_empty(o.get("plan_display_name")))
        .or_else(|| {
            let kind = organization.and_then(|o| non_empty(o.get("organization_type")))?;
            let name = match kind.as_str() {
                "claude_max" => "Max".to_string(),
                "claude_pro" => "Pro".to_string(),
                "claude_team" => "Team".to_string(),
                "claude_enterprise" => "Enterprise".to_string(),
                other => {
                    let rest = other.strip_prefix("claude_")?;
                    let mut chars = rest.chars();
                    let first = chars.next()?;
                    first.to_uppercase().chain(chars).collect::<String>().replace('_', " ")
                }
            };
            Some(name)
        })
        .or_else(|| {
            if flag("has_claude_max") {
                Some("Max".to_string())
            } else if flag("has_claude_pro") {
                Some("Pro".to_string())
            } else {
                None
            }
        });
    AnthropicAccount { email, plan }
}

/// E-mail sent with the token response (`account.email_address`).
fn account_from_token(body: &TokenResponse) -> AnthropicAccount {
    AnthropicAccount {
        email: body.account.as_ref().and_then(|a| non_empty(a.get("email_address")).or_else(|| non_empty(a.get("email")))),
        plan: None,
    }
}

/// Profile endpoint next to `token_url` (a test server) or Anthropic's.
fn profile_url_for(token_url: Option<&str>) -> String {
    token_url
        .and_then(|raw| url::Url::parse(raw).ok())
        .map(|mut url| {
            url.set_path("/api/oauth/profile");
            url.set_query(None);
            url.to_string()
        })
        .unwrap_or_else(|| ANTHROPIC_OAUTH_PROFILE_URL.to_string())
}

/// `GET /api/oauth/profile` with the subscription token.
pub async fn fetch_account(http: &reqwest::Client, profile_url: &str, access_token: &str) -> Result<AnthropicAccount> {
    let response = http
        .get(profile_url)
        .bearer_auth(access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| AppError::Network(format!("anthropic profile request failed: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Auth(format!("anthropic profile failed with {status}")));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|err| AppError::Decode(format!("invalid anthropic profile body: {err}")))?;
    Ok(account_from_profile(&body))
}

/// Merges `account` into the login file (the tokens are untouched).
fn persist_account(path: &Path, account: AnthropicAccount) -> Result<AnthropicAuthStatus> {
    let bytes = std::fs::read(path)
        .map_err(|err| AppError::Auth(format!("unable to re-read auth file: {err}")))?;
    let mut root: StoredAuth = serde_json::from_slice(&bytes)
        .map_err(|err| AppError::Auth(format!("unable to parse auth file: {err}")))?;
    let merged = root.account.take().unwrap_or_default().merged(account);
    root.account = (!merged.is_empty()).then_some(merged);
    write_auth_file(path, &root)?;
    Ok(status_from_auth(&root))
}

/// A login made before the e-mail was kept (or whose profile call
/// failed): reads the profile once with the stored token (refreshed first when it
/// has expired) and stores the e-mail and the plan. Best effort: the status is
/// returned as it is when the profile cannot be read.
///
/// `server_url`: token or profile URL of a test server (its `/api/oauth/profile`
/// is called); `None` = Anthropic.
pub async fn ensure_account(
    http: &reqwest::Client,
    path: &Path,
    server_url: Option<&str>,
) -> Result<AnthropicAuthStatus> {
    let status = load_auth_status(path)?;
    if !status.connected || status.email.is_some() {
        return Ok(status);
    }
    let Some(credential) = Credential::from_axecode_auth_file(path)? else {
        return Ok(status);
    };
    let token = match credential.bearer_or_key(http).await {
        Ok(token) => token,
        Err(err) => {
            tracing::warn!(error = %err, "anthropic token unavailable for the profile");
            return Ok(status);
        }
    };
    match fetch_account(http, &profile_url_for(server_url), &token).await {
        Ok(account) if !account.is_empty() => persist_account(path, account),
        Ok(_) => Ok(load_auth_status(path)?),
        Err(err) => {
            tracing::warn!(error = %err, "anthropic profile unavailable");
            Ok(load_auth_status(path)?)
        }
    }
}

pub async fn ensure_default_account(http: &reqwest::Client) -> Result<AnthropicAuthStatus> {
    ensure_account(http, &default_auth_path()?, None).await
}

#[derive(Debug, Clone)]
pub struct PkceCodes {
    pub code_verifier: String,
    pub code_challenge: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAuth {
    provider: String,
    auth_mode: String,
    tokens: StoredTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_refresh_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account: Option<AnthropicAccount>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTokens {
    access_token: String,
    refresh_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<i64>,
}

impl Credential {
    pub fn from_oauth_parts(
        access: impl Into<String>,
        refresh: impl Into<String>,
        expires_at_ms: i64,
        source_path: Option<PathBuf>,
    ) -> Self {
        Self::OAuth(Arc::new(Mutex::new(OAuthToken {
            access: access.into(),
            refresh: refresh.into(),
            expires_at_ms,
            source_path,
        })))
    }

    pub fn load_default() -> Result<Option<Self>> {
        Self::from_axecode_auth_file(&default_auth_path()?)
    }

    pub fn from_axecode_auth_file(path: &Path) -> Result<Option<Self>> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(AppError::Auth(format!("unable to read auth file: {err}"))),
        };

        let payload: StoredAuth = serde_json::from_slice(&bytes)
            .map_err(|err| AppError::Auth(format!("invalid auth file: {err}")))?;

        if payload.provider != "anthropic" || payload.auth_mode != "oauth" {
            return Ok(None);
        }

        if payload.tokens.access_token.is_empty() {
            return Err(AppError::Auth(
                "anthropic oauth is missing access token".into(),
            ));
        }

        Ok(Some(Self::from_oauth_parts(
            payload.tokens.access_token,
            payload.tokens.refresh_token,
            payload.tokens.expires_at_ms.unwrap_or(0),
            Some(path.to_path_buf()),
        )))
    }

    pub fn is_oauth(&self) -> bool {
        matches!(self, Self::OAuth(_))
    }

    // providers
    pub fn from_api_key(api_key: impl Into<String>) -> Self {
        Self::ApiKey(api_key.into())
    }

    pub async fn bearer_or_key(&self, http: &reqwest::Client) -> Result<String> {
        match self {
            Self::ApiKey(key) => Ok(key.clone()),
            Self::OAuth(_) => self.oauth_token(http, None).await,
        }
    }

    pub async fn force_refresh(
        &self,
        http: &reqwest::Client,
        previous_access: &str,
    ) -> Result<String> {
        match self {
            Self::ApiKey(key) => Ok(key.clone()),
            Self::OAuth(_) => self.oauth_token(http, Some(previous_access)).await,
        }
    }

    async fn oauth_token(
        &self,
        http: &reqwest::Client,
        refresh_access: Option<&str>,
    ) -> Result<String> {
        match self {
            Self::ApiKey(key) => Ok(key.clone()),
            Self::OAuth(state) => {
                let mut guard = state.lock().await;
                if let Some(previous_access) = refresh_access {
                    if guard.access != previous_access {
                        return Ok(guard.access.clone());
                    }
                } else if !is_expired(guard.expires_at_ms) {
                    return Ok(guard.access.clone());
                }

                if guard.refresh.is_empty() {
                    return Err(AppError::Auth(ANTHROPIC_RECONNECT_MESSAGE.into()));
                }

                let fresh = refresh_token(http, &guard.refresh).await?;
                let expires_at_ms = expires_at(fresh.expires_in);

                guard.access = fresh.access_token.clone();
                guard.refresh = fresh.refresh_token.clone();
                guard.expires_at_ms = expires_at_ms;
                let source_path = guard.source_path.clone();
                drop(guard);

                if let Some(path) = source_path {
                    if let Err(err) = persist_refresh(
                        &path,
                        &fresh.access_token,
                        &fresh.refresh_token,
                        expires_at_ms,
                        account_from_token(&fresh),
                    ) {
                        tracing::warn!(error = %err, "failed to persist refreshed anthropic oauth token");
                    }
                    // The account may have changed with the renewal: re-read
                    // the profile in the background (the request in progress does not wait).
                    let http = http.clone();
                    let access = fresh.access_token.clone();
                    tokio::spawn(async move {
                        match fetch_account(&http, ANTHROPIC_OAUTH_PROFILE_URL, &access).await {
                            Ok(account) if !account.is_empty() => {
                                if let Err(err) = persist_account(&path, account) {
                                    tracing::warn!(error = %err, "failed to store anthropic account");
                                }
                            }
                            Ok(_) => {}
                            Err(err) => tracing::warn!(error = %err, "anthropic profile unavailable after refresh"),
                        }
                    });
                }

                Ok(fresh.access_token)
            }
        }
    }
}

fn is_expired(expires_at_ms: i64) -> bool {
    now_ms() + REFRESH_SKEW_MS >= expires_at_ms
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn expires_at(expires_in_seconds: u64) -> i64 {
    now_ms() + (expires_in_seconds as i64 * 1000) - REFRESH_SKEW_MS
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    /// `{ "uuid", "email_address" }` when Anthropic sends it.
    #[serde(default)]
    account: Option<serde_json::Value>,
}

async fn refresh_token(http: &reqwest::Client, refresh_token: &str) -> Result<TokenResponse> {
    let response = http
        .post(ANTHROPIC_OAUTH_TOKEN_URL)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": ANTHROPIC_CLIENT_ID,
            "refresh_token": refresh_token,
        }))
        .send()
        .await
        .map_err(|err| AppError::Network(format!("anthropic oauth refresh failed: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Auth(format!(
            "anthropic oauth refresh failed with {status}: {body}"
        )));
    }

    response
        .json()
        .await
        .map_err(|err| AppError::Decode(format!("invalid anthropic oauth refresh body: {err}")))
}

fn persist_refresh(
    path: &Path,
    access: &str,
    refresh: &str,
    expires_at_ms: i64,
    account: AnthropicAccount,
) -> Result<()> {
    let bytes = std::fs::read(path)
        .map_err(|err| AppError::Auth(format!("unable to re-read auth file: {err}")))?;
    let mut root: StoredAuth = serde_json::from_slice(&bytes)
        .map_err(|err| AppError::Auth(format!("unable to parse auth file: {err}")))?;

    root.tokens.access_token = access.to_string();
    root.tokens.refresh_token = refresh.to_string();
    root.tokens.expires_at_ms = Some(expires_at_ms);
    root.last_refresh_ms = Some(now_ms());
    let merged = root.account.take().unwrap_or_default().merged(account);
    root.account = (!merged.is_empty()).then_some(merged);

    write_auth_file(path, &root)
}

pub fn default_auth_path() -> Result<PathBuf> {
    let dirs = ProjectDirs::from("fr", "savide", "savide")
        .ok_or_else(|| AppError::Auth("unable to resolve local data directory".into()))?;
    Ok(dirs.data_local_dir().join("anthropic-auth.json"))
}

pub fn load_default_auth_status() -> Result<AnthropicAuthStatus> {
    load_auth_status(&default_auth_path()?)
}

// providers — a fresh OAuth access token for the usage/quota endpoint.
pub async fn load_default_oauth_access_token(http: &reqwest::Client) -> Result<Option<String>> {
    match Credential::load_default()? {
        Some(credential) => credential.bearer_or_key(http).await.map(Some),
        None => Ok(None),
    }
}

pub fn load_auth_status(path: &Path) -> Result<AnthropicAuthStatus> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AnthropicAuthStatus::disconnected());
        }
        Err(err) => return Err(AppError::Auth(format!("unable to read auth file: {err}"))),
    };
    let payload: StoredAuth = serde_json::from_slice(&bytes)
        .map_err(|err| AppError::Auth(format!("invalid auth file: {err}")))?;
    Ok(status_from_auth(&payload))
}

pub fn delete_default_auth() -> Result<()> {
    let path = default_auth_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::Auth(format!("unable to delete auth file: {err}"))),
    }
}

pub fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn generate_pkce() -> PkceCodes {
    let code_verifier = generate_state();
    let digest = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(digest);
    PkceCodes {
        code_verifier,
        code_challenge,
    }
}

pub fn oauth_authorize_url(redirect_uri: &str, pkce: &PkceCodes, state: &str) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer
        .append_pair("code", "true")
        .append_pair("client_id", ANTHROPIC_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", ANTHROPIC_OAUTH_SCOPE)
        .append_pair("code_challenge", &pkce.code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    format!("{ANTHROPIC_OAUTH_AUTHORIZE_URL}?{}", serializer.finish())
}

pub async fn exchange_oauth_code(
    http: &reqwest::Client,
    code: &str,
    state: &str,
    redirect_uri: &str,
    pkce: &PkceCodes,
) -> Result<AnthropicAuthStatus> {
    exchange_oauth_code_into(http, None, &default_auth_path()?, code, state, redirect_uri, pkce)
        .await
}

/// [`exchange_oauth_code`] against `token_url` (None = Anthropic's; a test server
/// otherwise), the tokens saved at `path` (0600): an added account keeps its own file.
pub async fn exchange_oauth_code_into(
    http: &reqwest::Client,
    token_url: Option<&str>,
    path: &Path,
    code: &str,
    state: &str,
    redirect_uri: &str,
    pkce: &PkceCodes,
) -> Result<AnthropicAuthStatus> {
    let response = http
        .post(token_url.unwrap_or(ANTHROPIC_OAUTH_TOKEN_URL))
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "client_id": ANTHROPIC_CLIENT_ID,
            "code": code,
            "state": state,
            "redirect_uri": redirect_uri,
            "code_verifier": &pkce.code_verifier,
        }))
        .send()
        .await
        .map_err(|err| AppError::Network(format!("anthropic oauth exchange failed: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Auth(format!(
            "anthropic oauth exchange failed with {status}: {body}"
        )));
    }

    let body: TokenResponse = response
        .json()
        .await
        .map_err(|err| AppError::Decode(format!("invalid anthropic oauth body: {err}")))?;
    // E-mail of the token response, then the profile (plan, e-mail);
    // a failed profile call does not fail the login.
    let mut account = account_from_token(&body);
    match fetch_account(http, &profile_url_for(token_url), &body.access_token).await {
        Ok(profile) => account = account.merged(profile),
        Err(err) => tracing::warn!(error = %err, "anthropic profile unavailable after login"),
    }
    save_oauth_tokens(
        path,
        &body.access_token,
        &body.refresh_token,
        body.expires_in,
        account,
    )
}

fn save_oauth_tokens(
    path: &Path,
    access_token: &str,
    refresh_token: &str,
    expires_in: u64,
    account: AnthropicAccount,
) -> Result<AnthropicAuthStatus> {
    let auth = StoredAuth {
        provider: "anthropic".into(),
        auth_mode: "oauth".into(),
        tokens: StoredTokens {
            access_token: access_token.into(),
            refresh_token: refresh_token.into(),
            expires_at_ms: Some(expires_at(expires_in)),
        },
        last_refresh_ms: Some(now_ms()),
        account: (!account.is_empty()).then_some(account),
    };
    write_auth_file(path, &auth)?;
    Ok(status_from_auth(&auth))
}

fn write_auth_file(path: &Path, auth: &StoredAuth) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| AppError::Auth(format!("unable to create auth directory: {err}")))?;
    }
    let pretty = serde_json::to_vec_pretty(auth)
        .map_err(|err| AppError::Decode(format!("unable to serialize auth file: {err}")))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, pretty)
        .map_err(|err| AppError::Auth(format!("unable to write temp auth file: {err}")))?;
    apply_permissions(&temp)?;
    std::fs::rename(&temp, path)
        .map_err(|err| AppError::Auth(format!("unable to replace auth file: {err}")))?;
    Ok(())
}

fn status_from_auth(auth: &StoredAuth) -> AnthropicAuthStatus {
    if auth.provider != "anthropic" || auth.auth_mode != "oauth" {
        return AnthropicAuthStatus::disconnected();
    }
    AnthropicAuthStatus {
        connected: !auth.tokens.access_token.is_empty(),
        expires_at_ms: auth.tokens.expires_at_ms,
        last_refresh_ms: auth.last_refresh_ms,
        email: auth.account.as_ref().and_then(|a| a.email.clone()),
        plan: auth.account.as_ref().and_then(|a| a.plan.clone()),
    }
}

#[cfg(unix)]
fn apply_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|err| AppError::Auth(format!("unable to chmod auth file: {err}")))?;
    Ok(())
}

#[cfg(not(unix))]
fn apply_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod comptes_tests {
    //! E-mail and plan of the Claude account (no real token involved).
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn profile_gives_email_and_plan() {
        let profile = json!({
            "account": {"uuid": "u", "email": "claude@example.com", "has_claude_max": true, "has_claude_pro": false},
            "organization": {"organization_type": "claude_max", "plan_display_name": "Ultra", "rate_limit_tier": "default_claude_max_20x"}
        });
        let account = account_from_profile(&profile);
        assert_eq!(account.email.as_deref(), Some("claude@example.com"));
        assert_eq!(account.plan.as_deref(), Some("Ultra"));

        let by_type = json!({"account": {"email": "a@b.c"}, "organization": {"organization_type": "claude_pro"}});
        assert_eq!(account_from_profile(&by_type).plan.as_deref(), Some("Pro"));
        let team = json!({"organization": {"organization_type": "claude_team", "plan_display_name": "  "}});
        assert_eq!(account_from_profile(&team).plan.as_deref(), Some("Team"));
        let other = json!({"organization": {"organization_type": "claude_max_family"}});
        assert_eq!(account_from_profile(&other).plan.as_deref(), Some("Max family"));
        let flags = json!({"account": {"email_address": "x@y.z", "has_claude_pro": true}});
        let account = account_from_profile(&flags);
        assert_eq!((account.email.as_deref(), account.plan.as_deref()), (Some("x@y.z"), Some("Pro")));
        assert_eq!(account_from_profile(&json!({})), AnthropicAccount::default());
        assert_eq!(account_from_profile(&json!({"organization": {"organization_type": "api"}})).plan, None);
    }

    #[test]
    fn token_response_gives_email() {
        let body: TokenResponse = serde_json::from_value(json!({
            "access_token": "a", "refresh_token": "r", "expires_in": 60,
            "account": {"uuid": "u", "email_address": "claude@example.com"},
            "organization": {"uuid": "o"}
        }))
        .unwrap();
        assert_eq!(account_from_token(&body).email.as_deref(), Some("claude@example.com"));
        let bare: TokenResponse =
            serde_json::from_value(json!({"access_token": "a", "refresh_token": "r", "expires_in": 60})).unwrap();
        assert!(account_from_token(&bare).is_empty());
    }

    #[test]
    fn profile_url_follows_the_token_server() {
        assert_eq!(profile_url_for(None), ANTHROPIC_OAUTH_PROFILE_URL);
        assert_eq!(
            profile_url_for(Some("http://127.0.0.1:4100/v1/oauth/token")),
            "http://127.0.0.1:4100/api/oauth/profile"
        );
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("comptes-test-{name}-{}", generate_state()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("anthropic-auth.json")
    }

    fn old_login(path: &Path, access: &str, refresh: &str) {
        // Login file written before the account was kept (no `account`).
        let json = json!({
            "provider": "anthropic", "authMode": "oauth",
            "tokens": {"accessToken": access, "refreshToken": refresh, "expiresAtMs": now_ms() + 3_600_000},
            "lastRefreshMs": 1
        });
        std::fs::write(path, serde_json::to_vec(&json).unwrap()).unwrap();
    }

    #[test]
    fn refresh_keeps_the_account() {
        let path = temp_file("refresh");
        old_login(&path, "acc-1", "ref-1");
        assert_eq!(load_auth_status(&path).unwrap().email, None);
        persist_account(&path, AnthropicAccount { email: Some("a@b.c".into()), plan: Some("Max".into()) }).unwrap();
        persist_refresh(&path, "acc-2", "ref-2", now_ms() + 1000, AnthropicAccount::default()).unwrap();
        let status = load_auth_status(&path).unwrap();
        assert_eq!((status.email.as_deref(), status.plan.as_deref()), (Some("a@b.c"), Some("Max")));
        persist_refresh(&path, "acc-3", "ref-3", now_ms() + 1000, AnthropicAccount { email: Some("new@b.c".into()), plan: None }).unwrap();
        let status = load_auth_status(&path).unwrap();
        assert_eq!((status.email.as_deref(), status.plan.as_deref()), (Some("new@b.c"), Some("Max")));
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(stored.contains("acc-3") && stored.contains("ref-3"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn old_login_gets_its_email_and_plan() {
        let access = format!("acc-{}", generate_state());
        let refresh = format!("ref-{}", generate_state());
        let path = temp_file("ensure");
        old_login(&path, &access, &refresh);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = socket.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = json!({
                "account": {"email": "claude@example.com", "has_claude_max": true},
                "organization": {"organization_type": "claude_max", "plan_display_name": "Max"}
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });

        let http = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{port}/api/oauth/profile");
        let status = ensure_account(&http, &path, Some(&url)).await.unwrap();
        assert!(status.connected);
        assert_eq!(status.email.as_deref(), Some("claude@example.com"));
        assert_eq!(status.plan.as_deref(), Some("Max"));

        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/oauth/profile "));
        assert!(request.contains("anthropic-beta: oauth-2025-04-20"));
        assert!(request.contains(&format!("authorization: bearer {}", access.to_ascii_lowercase())));

        // Stored with the tokens (unchanged), and not asked again.
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(stored.contains(&access) && stored.contains(&refresh));
        assert_eq!(load_auth_status(&path).unwrap().email.as_deref(), Some("claude@example.com"));
        let again = ensure_account(&http, &path, Some("http://127.0.0.1:9/none")).await.unwrap();
        assert_eq!(again.plan.as_deref(), Some("Max"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn profile_failure_keeps_the_login() {
        let path = temp_file("echec");
        old_login(&path, "acc-x", "ref-x");
        let http = reqwest::Client::new();
        let status = ensure_account(&http, &path, Some("http://127.0.0.1:9/api/oauth/profile")).await.unwrap();
        assert!(status.connected);
        assert_eq!(status.email, None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
