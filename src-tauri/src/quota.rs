// axe:providers — `provider_quota` IPC: subscription quota windows per provider.
//
// Anthropic OAuth exposes `GET /api/oauth/usage`; every window is returned
// with its utilisation and reset time. Samples are appended to
// `<data>/quota-history.jsonl` so the exhaustion time can be extrapolated
// from the recent consumption rate. Other providers are reported without
// quota (callers — rlm fan-out guard, QuotaIndicator — must tolerate that).

use crate::*;

use directories::ProjectDirs;

const CACHE_TTL_MS: u64 = 60_000;
const HISTORY_FILE: &str = "quota-history.jsonl";
const HISTORY_MAX_LINES: usize = 2_000;
/// Samples older than this are ignored for the rate estimate.
const RATE_LOOKBACK_MS: u64 = 3 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuotaWindow {
    id: String,
    label: String,
    /// 0–100.
    utilization: f64,
    resets_at: Option<String>,
    /// Unix ms at which utilisation would reach 100 % at the recent rate.
    projected_exhaustion_ms: Option<u64>,
    /// True when the projection lands before the window resets.
    exhausts_before_reset: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderQuota {
    provider: String,
    label: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sample {
    t: u64,
    w: String,
    u: f64,
}

static CACHE: StdMutex<Option<QuotaReport>> = StdMutex::new(None);

fn history_path() -> Option<PathBuf> {
    ProjectDirs::from("fr", "savide", "savide").map(|dirs| dirs.data_local_dir().join(HISTORY_FILE))
}

fn load_history() -> Vec<Sample> {
    let Some(path) = history_path() else { return Vec::new() };
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn append_history(samples: &[Sample]) {
    let Some(path) = history_path() else { return };
    let mut all = load_history();
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

/// Minimal RFC 3339 → unix ms (`YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`).
fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    let b = value.as_bytes();
    if b.len() < 19 {
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
        other => other.replace('_', " "),
    }
}

async fn anthropic_quota(now: u64) -> ProviderQuota {
    let mut quota = ProviderQuota {
        provider: "anthropic".into(),
        label: "Anthropic".into(),
        supported: true,
        error: None,
        windows: Vec::new(),
    };
    let body = match axecode_anthropic::fetch_oauth_usage().await {
        Ok(Some(body)) => body,
        Ok(None) => {
            quota.supported = false;
            return quota;
        }
        Err(err) => {
            quota.error = Some(error_to_string(err));
            return quota;
        }
    };
    let history = load_history();
    let mut samples = Vec::new();
    if let Some(map) = body.as_object() {
        for (id, value) in map {
            let Some(utilization) = value.get("utilization").and_then(Value::as_f64) else {
                continue;
            };
            let resets_at = value.get("resets_at").and_then(Value::as_str).map(str::to_string);
            let projected = project(&history, id, now, utilization);
            let reset_ms = resets_at.as_deref().and_then(parse_rfc3339_ms);
            quota.windows.push(QuotaWindow {
                id: id.clone(),
                label: window_label(id),
                utilization,
                exhausts_before_reset: matches!((projected, reset_ms), (Some(p), Some(r)) if p < r),
                projected_exhaustion_ms: projected,
                resets_at,
            });
            samples.push(Sample { t: now, w: id.clone(), u: utilization });
        }
    }
    quota.windows.sort_by(|a, b| a.id.cmp(&b.id));
    append_history(&samples);
    quota
}

#[cfg(test)]
mod quota_tests {
    use super::*;

    #[test]
    fn parses_rfc3339() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2001-09-09T01:46:40.5+00:00"), Some(1_000_000_000_500));
        assert_eq!(parse_rfc3339_ms("2001-09-09T03:46:40+02:00"), Some(1_000_000_000_000));
    }

    #[test]
    fn projects_linear_exhaustion() {
        let h = vec![Sample { t: 0, w: "five_hour".into(), u: 10.0 }];
        // +10 points in 10 min -> 80 remaining points in 80 min.
        assert_eq!(project(&h, "five_hour", 600_000, 20.0), Some(600_000 + 4_800_000));
        assert_eq!(project(&h, "seven_day", 600_000, 20.0), None);
    }
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
    let mut providers = Vec::new();
    for id in configured {
        if id == "anthropic" {
            providers.push(anthropic_quota(now).await);
        } else {
            providers.push(ProviderQuota {
                label: id.clone(),
                provider: id,
                supported: false,
                error: None,
                windows: Vec::new(),
            });
        }
    }
    providers.sort_by(|a, b| b.supported.cmp(&a.supported).then(a.provider.cmp(&b.provider)));
    let report = QuotaReport { fetched_at_ms: now, providers };
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(report.clone());
    }
    Ok(report)
}
