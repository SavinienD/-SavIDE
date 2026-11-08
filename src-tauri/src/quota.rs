// Quotas des abonnements Claude et ChatGPT : IPC `provider_quota`.
//
// Chaque compte connecté est lu, le principal comme les comptes ajoutés (comptes.rs) :
// - Claude : `GET https://api.anthropic.com/api/oauth/usage`, une fenêtre par objet portant
//   `utilization` (0–100) et `resets_at` (`five_hour`, `seven_day`, `seven_day_opus`…) ;
// - ChatGPT : `GET https://chatgpt.com/backend-api/wham/usage`, comme Codex CLI :
//   `rate_limit.primary_window` et `secondary_window` (`used_percent`, `limit_window_seconds`,
//   `reset_at` en secondes) ; la durée dit laquelle est la fenêtre de 5 h, laquelle celle de 7 j.
// Le jeton ChatGPT n'est jamais renouvelé ici : un renouvellement remplace aussi le jeton de
// renouvellement, et le fournisseur en mémoire garderait l'ancien (refusé ensuite). Expiré, le
// compte attend son prochain message. Le jeton Claude se renouvelle comme avant.
// Chaque lecture ajoute un point par fenêtre à `<data>/quota-history.jsonl` : l'heure
// d'épuisement est extrapolée du rythme récent. Les autres fournisseurs sont rendus sans quota
// (`supported` faux) ; les appelants (garde-fou des sous-agents, indicateur) l'acceptent.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;

use crate::comptes::{self, CompteConnecte};
use crate::*;

const CACHE_TTL_MS: u64 = 60_000;
const HISTORY_FILE: &str = "quota-history.jsonl";
const HISTORY_MAX_LINES: usize = 4_000;
/// Samples older than this are ignored for the rate estimate.
const RATE_LOOKBACK_MS: u64 = 3 * 60 * 60 * 1000;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const ANTHROPIC_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CHATGPT_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// Durées des fenêtres ChatGPT (minutes), reconnues à une minute près (d'après Orca, MIT).
const SESSION_MINUTES: u32 = 300;
const WEEKLY_MINUTES: u32 = 10_080;
/// Jeton ChatGPT expiré : pas de renouvellement ici (voir l'en-tête).
pub(crate) const CHATGPT_EXPIRED: &str =
    "connexion à renouveler : elle se renouvelle au prochain message envoyé avec ce compte";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuotaWindow {
    id: String,
    label: String,
    /// 0–100.
    utilization: f64,
    resets_at: Option<String>,
    /// Réinitialisation en ms Unix, quel que soit le format du fournisseur.
    resets_at_ms: Option<u64>,
    /// Durée de la fenêtre (minutes) quand elle est connue.
    window_minutes: Option<u32>,
    /// Unix ms at which utilisation would reach 100 % at the recent rate.
    projected_exhaustion_ms: Option<u64>,
    /// True when the projection lands before the window resets.
    exhausts_before_reset: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderQuota {
    /// Identifiant du fournisseur : `anthropic`, `openai`, `openai~2` (compte ajouté)…
    provider: String,
    /// `Claude`, `ChatGPT`, sinon l'identifiant.
    label: String,
    /// E-mail du compte, quand il est connu.
    account: Option<String>,
    /// Formule de l'abonnement (`max`, `plus`…), quand elle est connue.
    plan: Option<String>,
    /// False when the provider exposes no quota API (not an error).
    supported: bool,
    error: Option<String>,
    windows: Vec<QuotaWindow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuotaReport {
    fetched_at_ms: u64,
    providers: Vec<ProviderQuota>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Sample {
    t: u64,
    w: String,
    u: f64,
}

/// Fenêtre telle que le fournisseur la donne (avant l'historique).
#[derive(Debug, Clone, PartialEq)]
struct RawWindow {
    id: String,
    label: String,
    utilization: f64,
    resets_at: Option<String>,
    resets_at_ms: Option<u64>,
    window_minutes: Option<u32>,
}

/// Adresses lues (remplacées par un faux serveur dans les tests).
#[derive(Debug, Clone)]
struct Urls {
    anthropic: String,
    chatgpt: String,
}

impl Default for Urls {
    fn default() -> Self {
        Self { anthropic: ANTHROPIC_USAGE_URL.into(), chatgpt: CHATGPT_USAGE_URL.into() }
    }
}

static CACHE: StdMutex<Option<QuotaReport>> = StdMutex::new(None);

fn history_path() -> Option<PathBuf> {
    comptes::dossier().map(|dossier| dossier.join(HISTORY_FILE))
}

fn load_history(path: Option<&Path>) -> Vec<Sample> {
    let Some(path) = path else { return Vec::new() };
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn append_history(path: Option<&Path>, samples: &[Sample]) {
    let Some(path) = path else { return };
    if samples.is_empty() {
        return;
    }
    let mut all = load_history(Some(path));
    all.extend_from_slice(samples);
    if all.len() > HISTORY_MAX_LINES {
        all.drain(..all.len() - HISTORY_MAX_LINES);
    }
    let body = all
        .iter()
        .filter_map(|sample| serde_json::to_string(sample).ok())
        .collect::<Vec<_>>()
        .join("\n");
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, body + "\n");
}

/// Clé d'une fenêtre dans l'historique : celles du compte Claude principal gardent leur
/// ancien nom (`five_hour`) pour suivre l'historique d'avant ; les autres sont préfixées.
fn history_key(provider: &str, window: &str) -> String {
    if provider == "anthropic" {
        window.to_string()
    } else {
        format!("{provider}/{window}")
    }
}

/// Minimal RFC 3339 → unix ms (`YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`).
fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    let b = value.as_bytes();
    if b.len() < 19 || !value.is_ascii() {
        return None;
    }
    let num = |s: &str| s.parse::<i64>().ok();
    let (y, mo, d) = (num(&value[0..4])?, num(&value[5..7])?, num(&value[8..10])?);
    let (h, mi, s) = (num(&value[11..13])?, num(&value[14..16])?, num(&value[17..19])?);
    let mut rest = &value[19..];
    let mut frac_ms = 0i64;
    if let Some(stripped) = rest.strip_prefix('.') {
        let digits: String = stripped.chars().take_while(char::is_ascii_digit).collect();
        frac_ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().unwrap_or(0);
        rest = &stripped[digits.len()..];
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        _ if rest.len() >= 6 => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            sign * (num(&rest[1..3])? * 60 + num(&rest[4..6])?)
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3_600 + mi * 60 + s - offset_min * 60;
    u64::try_from(secs * 1_000 + frac_ms).ok()
}

/// Secondes ou millisecondes Unix : 1e10 les sépare (d'après Orca, MIT).
fn epoch_ms(value: f64) -> Option<u64> {
    (value.is_finite() && value > 0.0).then(|| if value > 10_000_000_000.0 { value as u64 } else { (value * 1000.0) as u64 })
}

/// Réinitialisation : RFC 3339, ou nombre (secondes ou millisecondes).
fn reset_ms(value: &Value) -> Option<u64> {
    match value {
        Value::String(text) => {
            let text = text.trim();
            text.parse::<f64>().ok().and_then(epoch_ms).or_else(|| parse_rfc3339_ms(text))
        }
        Value::Number(n) => n.as_f64().and_then(epoch_ms),
        _ => None,
    }
}

/// Linear extrapolation from the oldest recent sample still in the same
/// window period (utilisation monotonic since then).
fn project(history: &[Sample], window: &str, now: u64, utilization: f64) -> Option<u64> {
    let mut start: Option<&Sample> = None;
    for sample in history.iter().rev().filter(|s| s.w == window) {
        if now.saturating_sub(sample.t) > RATE_LOOKBACK_MS || sample.u > utilization + 0.01 {
            break; // too old, or a reset happened in between
        }
        start = Some(sample);
    }
    let start = start?;
    let dt = now.saturating_sub(start.t);
    let du = utilization - start.u;
    if dt < 60_000 || du <= 0.0 {
        return None;
    }
    let remaining = (100.0 - utilization).max(0.0);
    Some(now + (remaining / du * dt as f64) as u64)
}

fn window_label(id: &str) -> String {
    match id {
        "five_hour" => "5 h".into(),
        "seven_day" => "7 j".into(),
        "seven_day_opus" => "7 j Opus".into(),
        "seven_day_sonnet" => "7 j Sonnet".into(),
        "extra_usage" => "Usage en plus".into(),
        other => other.replace('_', " "),
    }
}

fn window_minutes_of(id: &str) -> Option<u32> {
    match id {
        "five_hour" => Some(SESSION_MINUTES),
        id if id.starts_with("seven_day") => Some(WEEKLY_MINUTES),
        _ => None,
    }
}

/// « 5 h », « 7 j », « 90 min » : durée d'une fenêtre inconnue.
fn duration_label(minutes: u32) -> String {
    if minutes >= 1_440 && minutes % 1_440 == 0 {
        format!("{} j", minutes / 1_440)
    } else if minutes >= 60 && minutes % 60 == 0 {
        format!("{} h", minutes / 60)
    } else {
        format!("{minutes} min")
    }
}

/// Fenêtres Claude : chaque objet de premier niveau qui porte `utilization`.
fn anthropic_windows(body: &Value) -> Vec<RawWindow> {
    let Some(map) = body.as_object() else { return Vec::new() };
    let mut windows: Vec<RawWindow> = map
        .iter()
        .filter_map(|(id, value)| {
            let utilization = value
                .get("utilization")
                .or_else(|| value.get("used_percentage"))
                .and_then(Value::as_f64)
                .filter(|u| u.is_finite())?;
            let resets = value.get("resets_at");
            Some(RawWindow {
                id: id.clone(),
                label: window_label(id),
                utilization: utilization.clamp(0.0, 100.0),
                resets_at: resets.and_then(Value::as_str).map(str::to_string),
                resets_at_ms: resets.and_then(reset_ms),
                window_minutes: window_minutes_of(id),
            })
        })
        .collect();
    windows.sort_by(|a, b| a.id.cmp(&b.id));
    windows
}

/// Fenêtres ChatGPT : `primary_window` et `secondary_window`, classées par leur durée
/// (300 min : 5 h, 10 080 min : 7 j) ; sans durée, l'ordre historique de Codex (primaire
/// = 5 h, secondaire = 7 j). Rend aussi la formule (`plan_type`).
fn chatgpt_windows(body: &Value, now: u64) -> (Vec<RawWindow>, Option<String>) {
    let rate = body.get("rate_limit");
    let mut windows: Vec<RawWindow> = Vec::new();
    for (slot, key, legacy) in [("primary", "primary_window", "five_hour"), ("secondary", "secondary_window", "seven_day")] {
        let Some(raw) = rate.and_then(|r| r.get(key)).filter(|w| w.is_object()) else { continue };
        let Some(used) = raw.get("used_percent").and_then(Value::as_f64).filter(|u| u.is_finite()) else { continue };
        let minutes = raw
            .get("limit_window_seconds")
            .and_then(Value::as_f64)
            .filter(|s| s.is_finite() && *s > 0.0)
            .map(|s| (s / 60.0).ceil() as u32);
        let known = match minutes {
            Some(m) if m.abs_diff(SESSION_MINUTES) <= 1 => Some("five_hour"),
            Some(m) if m.abs_diff(WEEKLY_MINUTES) <= 1 => Some("seven_day"),
            Some(_) => None,
            None => Some(legacy),
        };
        let id = known.filter(|k| !windows.iter().any(|w| w.id == *k)).unwrap_or(slot).to_string();
        let label = if known == Some(id.as_str()) {
            window_label(&id)
        } else {
            minutes.map(duration_label).unwrap_or_else(|| id.clone())
        };
        let resets_at_ms = raw.get("reset_at").and_then(reset_ms).or_else(|| {
            raw.get("reset_after_seconds")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite() && *s >= 0.0)
                .map(|s| now + (s * 1000.0) as u64)
        });
        windows.push(RawWindow {
            window_minutes: minutes.or_else(|| known.and_then(window_minutes_of)),
            id,
            label,
            utilization: used.clamp(0.0, 100.0),
            resets_at: None,
            resets_at_ms,
        });
    }
    windows.sort_by(|a, b| a.id.cmp(&b.id));
    let plan = body.get("plan_type").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
    (windows, plan)
}

/// Champs d'un jeton JWT (sans vérifier sa signature).
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Jeton d'accès ChatGPT du fichier du compte et son `chatgpt-account-id`, sans
/// renouvellement : [`CHATGPT_EXPIRED`] quand il a expiré.
fn chatgpt_token(path: &Path, now: u64) -> std::result::Result<(String, Option<String>), String> {
    let text = fs::read_to_string(path).map_err(|err| format!("fichier du compte illisible : {err}"))?;
    let root: Value = serde_json::from_str(&text).map_err(|_| "fichier du compte illisible".to_string())?;
    let tokens = root.get("tokens").cloned().unwrap_or(Value::Null);
    let field = |key: &str| {
        tokens.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
    };
    let access = field("accessToken").ok_or_else(|| "compte sans jeton d'accès".to_string())?;
    let claims = jwt_claims(&access);
    let expires_ms = tokens
        .get("expiresAtMs")
        .and_then(Value::as_i64)
        .or_else(|| claims.as_ref().and_then(|c| c.get("exp")).and_then(Value::as_i64).map(|s| s.saturating_mul(1000)));
    if expires_ms.is_some_and(|ms| ms <= now as i64) {
        return Err(CHATGPT_EXPIRED.into());
    }
    let account = field("accountId").or_else(|| {
        let claims = claims.as_ref()?;
        claims
            .get("https://api.openai.com/auth")
            .and_then(|auth| auth.get("chatgpt_account_id"))
            .or_else(|| claims.get("chatgpt_account_id"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    Ok((access, account))
}

/// Erreur de lecture en clair ; le corps n'est repris que s'il porte un message JSON.
fn http_error(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        v.pointer("/error/message")
            .or_else(|| v.get("message"))
            .or_else(|| v.get("detail"))
            .and_then(Value::as_str)
            .map(|m| m.trim().chars().take(200).collect::<String>())
            .filter(|m| !m.is_empty())
    });
    let base = match status {
        401 | 403 => format!("connexion refusée (HTTP {status}) : reconnectez ce compte dans Réglages > Fournisseurs"),
        429 => format!("trop de lectures (HTTP {status}) : nouvel essai à la prochaine actualisation"),
        _ => format!("lecture impossible (HTTP {status})"),
    };
    match message {
        Some(message) => format!("{base} · {message}"),
        None => base,
    }
}

async fn get_json(
    http: &reqwest::Client,
    url: &str,
    headers: &[(&str, String)],
) -> std::result::Result<Value, String> {
    let mut request = http.get(url).header("accept", "application/json");
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    let response = request.send().await.map_err(|err| format!("lecture impossible : {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(http_error(status.as_u16(), &body));
    }
    response.json().await.map_err(|err| format!("réponse illisible : {err}"))
}

async fn anthropic_raw(http: &reqwest::Client, path: &Path, url: &str) -> std::result::Result<Vec<RawWindow>, String> {
    let credential = axecode_anthropic::Credential::from_axecode_auth_file(path)
        .map_err(error_to_string)?
        .ok_or_else(|| "compte Claude sans connexion".to_string())?;
    let token = credential.bearer_or_key(http).await.map_err(error_to_string)?;
    let headers = [
        ("authorization", format!("Bearer {token}")),
        ("anthropic-beta", "oauth-2025-04-20".to_string()),
        ("user-agent", axecode_anthropic::api_key_user_agent()),
    ];
    Ok(anthropic_windows(&get_json(http, url, &headers).await?))
}

async fn chatgpt_raw(
    http: &reqwest::Client,
    path: &Path,
    url: &str,
    now: u64,
) -> std::result::Result<(Vec<RawWindow>, Option<String>), String> {
    let (token, account) = chatgpt_token(path, now)?;
    let mut headers = vec![("authorization", format!("Bearer {token}")), ("user-agent", "codex-cli".to_string())];
    if let Some(account) = account {
        headers.push(("chatgpt-account-id", account));
    }
    let body = get_json(http, url, &headers).await?;
    let (windows, plan) = chatgpt_windows(&body, now);
    if windows.is_empty() && plan.is_none() {
        return Err("réponse sans quota".into());
    }
    Ok((windows, plan))
}

fn with_history(provider: &str, raw: Vec<RawWindow>, history: &[Sample], now: u64) -> (Vec<QuotaWindow>, Vec<Sample>) {
    let mut samples = Vec::new();
    let windows = raw
        .into_iter()
        .map(|w| {
            let key = history_key(provider, &w.id);
            let projected = project(history, &key, now, w.utilization);
            samples.push(Sample { t: now, w: key, u: w.utilization });
            QuotaWindow {
                exhausts_before_reset: matches!((projected, w.resets_at_ms), (Some(p), Some(r)) if p < r),
                projected_exhaustion_ms: projected,
                id: w.id,
                label: w.label,
                utilization: w.utilization,
                resets_at: w.resets_at,
                resets_at_ms: w.resets_at_ms,
                window_minutes: w.window_minutes,
            }
        })
        .collect();
    (windows, samples)
}

/// Quota d'un compte connecté, et ses points d'historique.
async fn account_quota(
    http: &reqwest::Client,
    compte: &CompteConnecte,
    path: &Path,
    urls: &Urls,
    history: &[Sample],
    now: u64,
) -> (ProviderQuota, Vec<Sample>) {
    let mut quota = ProviderQuota {
        provider: compte.provider_id.clone(),
        label: if compte.base == "openai" { "ChatGPT".into() } else { "Claude".into() },
        account: compte.email.clone(),
        plan: compte.plan.clone(),
        supported: true,
        error: None,
        windows: Vec::new(),
    };
    let raw = match compte.base.as_str() {
        "anthropic" => anthropic_raw(http, path, &urls.anthropic).await,
        "openai" => match chatgpt_raw(http, path, &urls.chatgpt, now).await {
            Ok((windows, plan)) => {
                quota.plan = plan.or(quota.plan);
                Ok(windows)
            }
            Err(err) => Err(err),
        },
        _ => {
            quota.supported = false;
            return (quota, Vec::new());
        }
    };
    match raw {
        Ok(raw) => {
            let (windows, samples) = with_history(&compte.provider_id, raw, history, now);
            quota.windows = windows;
            (quota, samples)
        }
        Err(err) => {
            quota.error = Some(err);
            (quota, Vec::new())
        }
    }
}

/// Rapport : chaque compte connecté de `dossier`, puis les fournisseurs `configured` sans quota.
async fn build_report(
    configured: &[String],
    dossier: Option<&Path>,
    urls: &Urls,
    history_file: Option<&Path>,
    now: u64,
) -> QuotaReport {
    let comptes = dossier.map(comptes::comptes_dans).unwrap_or_default();
    let history = load_history(history_file);
    let http = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().unwrap_or_default();
    let lectures = comptes.iter().map(|compte| {
        let path = dossier
            .map(|d| comptes::fichier_dans(d, &compte.base, comptes::rang(&compte.provider_id)))
            .unwrap_or_default();
        let (http, history) = (&http, &history);
        async move { account_quota(http, compte, &path, urls, history, now).await }
    });
    let mut providers = Vec::new();
    let mut samples = Vec::new();
    for (quota, points) in futures_util::future::join_all(lectures).await {
        providers.push(quota);
        samples.extend(points);
    }
    for id in configured {
        if !providers.iter().any(|p| &p.provider == id) {
            providers.push(ProviderQuota {
                label: id.clone(),
                provider: id.clone(),
                account: None,
                plan: None,
                supported: false,
                error: None,
                windows: Vec::new(),
            });
        }
    }
    providers.sort_by(|a, b| b.supported.cmp(&a.supported).then(a.provider.cmp(&b.provider)));
    append_history(history_file, &samples);
    QuotaReport { fetched_at_ms: now, providers }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderQuotaInput {
    #[serde(default)]
    force: bool,
}

#[tauri::command]
pub(crate) async fn provider_quota(
    state: State<'_, DesktopState>,
    input: Option<ProviderQuotaInput>,
) -> std::result::Result<QuotaReport, String> {
    let now = now_ms() as u64;
    let force = input.map(|i| i.force).unwrap_or(false);
    if !force {
        if let Some(cached) = CACHE.lock().ok().and_then(|guard| guard.clone()) {
            if now.saturating_sub(cached.fetched_at_ms) < CACHE_TTL_MS {
                return Ok(cached);
            }
        }
    }
    let configured: Vec<String> = provider_registry_snapshot(&state)?.into_keys().collect();
    let dossier = comptes::dossier();
    let history = history_path();
    let report = build_report(&configured, dossier.as_deref(), &Urls::default(), history.as_deref(), now).await;
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(report.clone());
    }
    Ok(report)
}

#[cfg(test)]
mod quota_tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn parses_rfc3339() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2001-09-09T01:46:40.5+00:00"), Some(1_000_000_000_500));
        assert_eq!(parse_rfc3339_ms("2001-09-09T03:46:40+02:00"), Some(1_000_000_000_000));
        assert_eq!(parse_rfc3339_ms("2001-09-09T03:46:4é+02:00"), None);
    }

    #[test]
    fn projects_linear_exhaustion() {
        let h = vec![Sample { t: 0, w: "five_hour".into(), u: 10.0 }];
        // +10 points in 10 min -> 80 remaining points in 80 min.
        assert_eq!(project(&h, "five_hour", 600_000, 20.0), Some(600_000 + 4_800_000));
        assert_eq!(project(&h, "seven_day", 600_000, 20.0), None);
    }

    #[test]
    fn claude_windows_any_reset_format() {
        let body = json!({
            "five_hour": {"utilization": 42.5, "resets_at": "2001-09-09T01:46:40Z"},
            "seven_day": {"utilization": 120.0, "resets_at": 1_000_000_000},
            "seven_day_opus": null,
            "extra_usage": {"is_enabled": false, "utilization": null}
        });
        let w = anthropic_windows(&body);
        assert_eq!(w.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["five_hour", "seven_day"]);
        assert_eq!(w[0].resets_at_ms, Some(1_000_000_000_000));
        assert_eq!(w[1].resets_at_ms, Some(1_000_000_000_000));
        assert_eq!((w[0].utilization, w[1].utilization), (42.5, 100.0));
        assert_eq!((w[0].window_minutes, w[1].window_minutes), (Some(300), Some(10_080)));
    }

    #[test]
    fn chatgpt_windows_by_duration() {
        let now = 1_000_000_000_000;
        // Fenêtre de 7 j en primaire : classée par sa durée (301 min : 5 h, à une minute près).
        let body = json!({"plan_type": "plus", "rate_limit": {
            "primary_window": {"used_percent": 61, "limit_window_seconds": 604_800, "reset_at": 1_000_100_000},
            "secondary_window": {"used_percent": 12.5, "limit_window_seconds": 18_060, "reset_after_seconds": 600}
        }});
        let (w, plan) = chatgpt_windows(&body, now);
        assert_eq!(plan.as_deref(), Some("plus"));
        let ids = |w: &[RawWindow]| w.iter().map(|w| (w.id.clone(), w.label.clone())).collect::<Vec<_>>();
        assert_eq!(ids(&w), [("five_hour".to_string(), "5 h".to_string()), ("seven_day".into(), "7 j".into())]);
        assert_eq!(w[0].resets_at_ms, Some(now + 600_000));
        assert_eq!(w[1].resets_at_ms, Some(1_000_100_000_000));
        assert_eq!((w[0].utilization, w[1].utilization), (12.5, 61.0));
        // Sans durée : primaire = 5 h ; durée inconnue : son libellé.
        let (w, _) = chatgpt_windows(
            &json!({"rate_limit": {
                "primary_window": {"used_percent": 3},
                "secondary_window": {"used_percent": 4, "limit_window_seconds": 5_400}
            }}),
            now,
        );
        assert_eq!(ids(&w), [("five_hour".to_string(), "5 h".to_string()), ("secondary".into(), "90 min".into())]);
        assert!(chatgpt_windows(&json!({"rate_limit": null}), now).0.is_empty());
    }

    fn dossier_test(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("savide-quota-{nom}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn claude(d: &Path, rang: &str, email: &str) {
        let json = json!({
            "provider": "anthropic", "authMode": "oauth",
            "tokens": {"accessToken": format!("a-{rang}"), "refreshToken": "r", "expiresAtMs": 4_000_000_000_000i64},
            "account": {"email": email, "plan": "Max"}
        });
        fs::write(comptes::fichier_dans(d, "anthropic", rang), serde_json::to_vec(&json).unwrap()).unwrap();
    }

    fn chatgpt(d: &Path, rang: &str, email: &str, access: &str, expires: Option<i64>, account: Option<&str>) {
        let mut tokens = json!({"accessToken": access, "refreshToken": "r", "email": email, "planType": "plus"});
        if let Some(ms) = expires {
            tokens["expiresAtMs"] = json!(ms);
        }
        if let Some(id) = account {
            tokens["accountId"] = json!(id);
        }
        let json = json!({"provider": "openai", "authMode": "oauth", "tokens": tokens});
        fs::write(comptes::fichier_dans(d, "openai", rang), serde_json::to_vec(&json).unwrap()).unwrap();
    }

    /// Jeton JWT non signé (seuls `exp` et le compte ChatGPT comptent ici).
    fn jwt(exp_s: i64) -> String {
        let b64 = |v: Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
        let claims = json!({"exp": exp_s, "https://api.openai.com/auth": {"chatgpt_account_id": "acc-jwt"}});
        format!("{}.{}.sig", b64(json!({"alg": "none"})), b64(claims))
    }

    #[test]
    fn chatgpt_token_is_never_refreshed() {
        let d = dossier_test("jeton");
        let now = 1_000_000_000_000u64;
        let path = comptes::fichier_dans(&d, "openai", "");
        chatgpt(&d, "", "a@b.fr", "tok", Some(now as i64 + 60_000), Some("acc-1"));
        assert_eq!(chatgpt_token(&path, now).unwrap(), ("tok".to_string(), Some("acc-1".to_string())));
        chatgpt(&d, "", "a@b.fr", "tok", Some(now as i64 - 1), Some("acc-1"));
        assert_eq!(chatgpt_token(&path, now).unwrap_err(), CHATGPT_EXPIRED);
        // Sans `expiresAtMs` : l'expiration et le compte viennent du jeton lui-même.
        chatgpt(&d, "", "a@b.fr", &jwt(1_000_000_100), None, None);
        assert_eq!(chatgpt_token(&path, now).unwrap().1.as_deref(), Some("acc-jwt"));
        chatgpt(&d, "", "a@b.fr", &jwt(999_999_000), None, None);
        assert_eq!(chatgpt_token(&path, now).unwrap_err(), CHATGPT_EXPIRED);
    }

    /// Faux serveur HTTP local : une réponse par chemin ; requêtes reçues gardées (en-têtes compris).
    async fn faux_serveur(routes: Vec<(&'static str, u16, String)>) -> (String, Arc<StdMutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let recues = Arc::new(StdMutex::new(Vec::new()));
        let journal = recues.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (routes, journal) = (routes.clone(), journal.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16 * 1024];
                    let mut lu = 0;
                    while lu < buf.len() {
                        let n = socket.read(&mut buf[lu..]).await.unwrap_or(0);
                        lu += n;
                        if n == 0 || buf[..lu].windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let requete = String::from_utf8_lossy(&buf[..lu]).to_string();
                    let chemin = requete.split_whitespace().nth(1).unwrap_or("").to_string();
                    journal.lock().unwrap().push(requete);
                    let (status, corps) = routes
                        .iter()
                        .find(|(p, _, _)| *p == chemin)
                        .map(|(_, s, c)| (*s, c.clone()))
                        .unwrap_or((404, "{}".into()));
                    let reponse = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{corps}",
                        corps.len()
                    );
                    let _ = socket.write_all(reponse.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (base, recues)
    }

    #[tokio::test]
    async fn every_connected_account_is_read() {
        let d = dossier_test("rapport");
        let now = now_ms() as u64;
        let loin = 4_000_000_000_000i64;
        claude(&d, "", "a@exemple.fr");
        chatgpt(&d, "", "c@d.fr", "tok-1", Some(loin), Some("acc-1"));
        chatgpt(&d, "2", "e@f.fr", "tok-2", Some(loin), Some("acc-2"));
        chatgpt(&d, "3", "g@h.fr", "tok-3", Some(1_000), None);
        let wham = json!({"plan_type": "pro", "rate_limit": {
            "primary_window": {"used_percent": 40, "limit_window_seconds": 18_000, "reset_after_seconds": 3_600},
            "secondary_window": {"used_percent": 70, "limit_window_seconds": 604_800, "reset_at": 4_000_000_000i64}
        }});
        let claude_usage = json!({"five_hour": {"utilization": 30.0, "resets_at": "2099-01-01T00:00:00Z"}, "seven_day": null});
        let (base, recues) = faux_serveur(vec![
            ("/api/oauth/usage", 200, claude_usage.to_string()),
            ("/backend-api/wham/usage", 200, wham.to_string()),
        ])
        .await;
        let urls = Urls { anthropic: format!("{base}/api/oauth/usage"), chatgpt: format!("{base}/backend-api/wham/usage") };
        let historique = d.join(HISTORY_FILE);
        let configured = ["anthropic".to_string(), "openai".into(), "ollama".into()];
        let rapport = build_report(&configured, Some(&d), &urls, Some(&historique), now).await;

        let ids: Vec<_> = rapport.providers.iter().map(|p| (p.provider.as_str(), p.supported)).collect();
        assert_eq!(ids, [("anthropic", true), ("openai", true), ("openai~2", true), ("openai~3", true), ("ollama", false)]);
        let claude = &rapport.providers[0];
        assert_eq!((claude.label.as_str(), claude.account.as_deref()), ("Claude", Some("a@exemple.fr")));
        assert_eq!(claude.windows.len(), 1);
        assert_eq!(claude.windows[0].resets_at_ms, parse_rfc3339_ms("2099-01-01T00:00:00Z"));
        let gpt = &rapport.providers[2];
        assert_eq!((gpt.label.as_str(), gpt.account.as_deref(), gpt.plan.as_deref()), ("ChatGPT", Some("e@f.fr"), Some("pro")));
        assert_eq!(gpt.windows.iter().map(|w| w.utilization).collect::<Vec<_>>(), [40.0, 70.0]);
        assert_eq!(gpt.windows[0].resets_at_ms, Some(now + 3_600_000));
        let expire = &rapport.providers[3];
        assert_eq!(expire.error.as_deref(), Some(CHATGPT_EXPIRED));
        assert!(expire.windows.is_empty());

        // Chaque compte ChatGPT avec son jeton et son compte ; rien pour le jeton expiré.
        let recues = recues.lock().unwrap().join("\n---\n").to_lowercase();
        assert!(recues.contains("authorization: bearer a-\r\n"));
        assert!(recues.contains("anthropic-beta: oauth-2025-04-20"));
        assert!(recues.contains("bearer tok-1") && recues.contains("chatgpt-account-id: acc-1"));
        assert!(recues.contains("bearer tok-2") && recues.contains("chatgpt-account-id: acc-2"));
        assert!(!recues.contains("tok-3"));

        // Historique : noms d'avant pour le compte Claude principal, préfixés pour les autres.
        let lignes = fs::read_to_string(&historique).unwrap();
        assert!(lignes.contains(r#""w":"five_hour""#), "{lignes}");
        assert!(lignes.contains(r#""w":"openai~2/seven_day""#), "{lignes}");
        assert_eq!(lignes.lines().count(), 5);
    }

    #[tokio::test]
    async fn refused_account_says_what_to_do() {
        let d = dossier_test("refus");
        chatgpt(&d, "", "c@d.fr", "tok-1", Some(4_000_000_000_000), Some("acc-1"));
        let (base, _) = faux_serveur(vec![(
            "/wham/usage",
            401,
            json!({"error": {"message": "Your authentication token has expired."}}).to_string(),
        )])
        .await;
        let urls = Urls { anthropic: format!("{base}/x"), chatgpt: format!("{base}/wham/usage") };
        let rapport = build_report(&[], Some(&d), &urls, None, now_ms() as u64).await;
        let erreur = rapport.providers[0].error.clone().unwrap();
        assert!(erreur.starts_with("connexion refusée (HTTP 401)\u{a0}: reconnectez ce compte"), "{erreur}");
        assert!(erreur.ends_with("Your authentication token has expired."), "{erreur}");
    }
}
