//! axe:webui — web interface of the conversations, served by the service on
//! the `--listen` address (see [`crate::listen`]): static app embedded in the
//! binary, cookie login, then the browser talks the regular protocol over
//! the authenticated `/ws` WebSocket.

pub mod session;

use std::{
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, OnceLock},
    time::Duration,
};

use serde_json::{json, Value};

use crate::{
    auth::AuthStore,
    listen::{header_of, HttpFallback, HttpRequest, HttpResponse},
    Daemon,
};

pub use session::{SessionStore, WebSession, COOKIE_NAME};

#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct Assets;

/// Content Security Policy of every page: no third-party origin at all.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; \
manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/// Header every state-changing API call must carry (with a same-origin
/// `Origin`): a cross-site form cannot set it.
pub const CSRF_HEADER: &str = "x-axecode";
/// Ancien nom de l'en-tête, envoyé par les pages ouvertes avant le renommage : accepté aussi.
pub const CSRF_HEADER_LEGACY: &str = "x-atelier"; // compat (rebrand:keep)

static STORE: OnceLock<Arc<SessionStore>> = OnceLock::new();

/// Browser session store of this data dir (one per process).
pub fn store(data_dir: &Path) -> Arc<SessionStore> {
    STORE.get_or_init(|| Arc::new(SessionStore::new(data_dir))).clone()
}

pub struct WebUi {
    sessions: Arc<SessionStore>,
}

impl WebUi {
    pub fn new(data_dir: &Path) -> Self {
        Self { sessions: store(data_dir) }
    }
}

/// Registers the web UI on the network listener.
pub fn install(data_dir: &Path) {
    crate::listen::set_http_fallback(Arc::new(WebUi::new(data_dir)));
}

/// Protocol methods `webui.*` (IDE: Settings > Interface web).
pub fn dispatch(daemon: &Daemon, method: &str, params: Value) -> axecode_core::SessionResult<Value> {
    let sessions = store(daemon.data_dir());
    match method {
        "webui.sessions" => Ok(json!(sessions
            .list()
            .into_iter()
            .map(|s| json!({
                "id": s.id,
                "user": s.user,
                "userAgent": s.user_agent,
                "createdAtMs": s.created_at_ms,
                "lastSeenMs": s.last_seen_ms,
                "expiresAtMs": s.expires_at_ms,
            }))
            .collect::<Vec<_>>())),
        "webui.revoke" => {
            let id = params.get("id").and_then(Value::as_str).unwrap_or("*");
            Ok(json!({"revoked": sessions.revoke(id)}))
        }
        other => Err(axecode_core::SessionError::Protocol(format!("unknown method {other}"))),
    }
}

impl HttpFallback for WebUi {
    fn handle(
        &self,
        daemon: Arc<Daemon>,
        request: HttpRequest,
        peer_is_loopback: bool,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send>> {
        let sessions = self.sessions.clone();
        Box::pin(async move { route(daemon, sessions, request, peer_is_loopback).await })
    }

    fn ws_authorized(&self, headers: &[(String, String)]) -> bool {
        header_of(headers, "cookie")
            .and_then(|cookie| self.sessions.from_cookie_header(cookie))
            .is_some()
    }
}

/// True when the request really comes from this machine: loopback peer, no
/// proxy forwarding header, loopback `Host`.
fn is_local(request: &HttpRequest, peer_is_loopback: bool) -> bool {
    let host = request.header("host").unwrap_or("").to_ascii_lowercase();
    let host = host.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or(host);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    peer_is_loopback
        && request.header("x-forwarded-for").is_none()
        && request.header("forwarded").is_none()
        && (host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()))
}

/// Login is required unless the request is local and no credentials exist.
fn login_required(daemon: &Daemon, request: &HttpRequest, peer_is_loopback: bool) -> bool {
    !(is_local(request, peer_is_loopback) && !AuthStore::load(daemon.data_dir()).has_credentials())
}

fn secure_headers(mut response: HttpResponse) -> HttpResponse {
    for (k, v) in [
        ("Content-Security-Policy", CSP),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
        ("Cross-Origin-Opener-Policy", "same-origin"),
        ("Permissions-Policy", "camera=(), geolocation=()"),
    ] {
        response.headers.push((k.into(), v.into()));
    }
    response
}

fn json_response(status: u16, value: Value) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![
            ("Content-Type".into(), "application/json; charset=utf-8".into()),
            ("Cache-Control".into(), "no-store".into()),
        ],
        body: serde_json::to_vec(&value).unwrap_or_default(),
    }
}

/// Same-origin check for state-changing requests (CSRF).
fn same_origin(request: &HttpRequest) -> bool {
    if request.header(CSRF_HEADER).is_none() && request.header(CSRF_HEADER_LEGACY).is_none() {
        return false;
    }
    let host = request.header("host").unwrap_or("").to_ascii_lowercase();
    match request.header("origin") {
        Some(origin) => origin
            .split("://")
            .nth(1)
            .is_some_and(|authority| authority.to_ascii_lowercase() == host),
        // Old browsers omit Origin on same-origin fetches; the custom header
        // alone still blocks simple cross-site forms.
        None => true,
    }
}

fn session_cookie(token: &str, secure: bool, max_age_s: i64) -> String {
    format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age_s}{}",
        if secure { "; Secure" } else { "" }
    )
}

fn client_key(request: &HttpRequest) -> String {
    request
        .header("x-forwarded-for")
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| "direct".into())
}

async fn route(
    daemon: Arc<Daemon>,
    sessions: Arc<SessionStore>,
    request: HttpRequest,
    peer_is_loopback: bool,
) -> HttpResponse {
    let required = login_required(&daemon, &request, peer_is_loopback);
    let current = request
        .header("cookie")
        .and_then(|c| sessions.from_cookie_header(c));
    let authed = !required || current.is_some();
    let path = request.path.clone();
    let response = match (request.method.as_str(), path.as_str()) {
        ("GET", "/api/auth/state") => json_response(
            200,
            json!({
                "authenticated": authed,
                "loginRequired": required,
                "user": current.as_ref().map(|s| s.user.clone()),
                "version": env!("CARGO_PKG_VERSION"),
            }),
        ),
        ("POST", "/api/auth/login") => login(&daemon, &sessions, &request).await,
        ("POST", "/api/auth/logout") => {
            if !same_origin(&request) {
                json_response(403, json!({"error": "csrf"}))
            } else {
                if let Some(token) = request
                    .header("cookie")
                    .and_then(|c| session::cookie_value(c, COOKIE_NAME))
                {
                    sessions.remove_token(token);
                }
                let mut response = json_response(200, json!({"ok": true}));
                response
                    .headers
                    .push(("Set-Cookie".into(), session_cookie("", false, 0)));
                response
            }
        }
        (_, p) if p.starts_with("/api/") => {
            if !authed {
                json_response(401, json!({"error": "authentication required"}))
            } else {
                api(&daemon, &request, current.as_ref()).await
            }
        }
        ("GET", _) | ("HEAD", _) => asset(&path),
        _ => HttpResponse::text(405, "method not allowed"),
    };
    secure_headers(response)
}

async fn login(daemon: &Daemon, sessions: &SessionStore, request: &HttpRequest) -> HttpResponse {
    if !same_origin(request) {
        return json_response(403, json!({"error": "csrf"}));
    }
    let key = client_key(request);
    if !sessions.may_attempt(&key) {
        return json_response(429, json!({"error": "Trop de tentatives, réessayez dans quelques minutes."}));
    }
    let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    let user = body.get("username").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let password = body.get("password").and_then(Value::as_str).unwrap_or("");
    let store = AuthStore::load(daemon.data_dir());
    if !store.verify_password(&user, password) {
        sessions.record_failure(&key);
        tokio::time::sleep(Duration::from_secs(1)).await;
        return json_response(401, json!({"error": "Identifiant ou mot de passe incorrect."}));
    }
    sessions.clear_failures(&key);
    let token = sessions.create(&user, request.header("user-agent").unwrap_or(""));
    // Behind a TLS reverse proxy the cookie must be Secure.
    let secure = request
        .header("x-forwarded-proto")
        .is_some_and(|p| p.eq_ignore_ascii_case("https"));
    let mut response = json_response(200, json!({"ok": true, "user": user}));
    response.headers.push((
        "Set-Cookie".into(),
        session_cookie(&token, secure, session::SESSION_TTL_MS / 1000),
    ));
    response
}

/// Authenticated JSON endpoints that do not fit the WebSocket protocol.
async fn api(daemon: &Daemon, request: &HttpRequest, _current: Option<&WebSession>) -> HttpResponse {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/status") => json_response(200, daemon.status_json()),
        _ => json_response(404, json!({"error": "not found"})),
    }
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Static file of the embedded app; unknown paths fall back to
/// `index.html` (client-side routing).
fn asset(path: &str) -> HttpResponse {
    let name = path.trim_start_matches('/');
    let name = if name.is_empty() { "index.html" } else { name };
    let (name, file) = match Assets::get(name) {
        Some(file) => (name, file),
        None => match Assets::get("index.html") {
            Some(file) if !name.starts_with("assets/") => ("index.html", file),
            _ => return HttpResponse::text(404, "not found"),
        },
    };
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    HttpResponse {
        status: 200,
        headers: vec![
            ("Content-Type".into(), content_type(name).into()),
            ("Cache-Control".into(), cache.into()),
        ],
        body: file.data.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(headers: &[(&str, &str)]) -> HttpRequest {
        HttpRequest {
            method: "POST".into(),
            path: "/api/auth/login".into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn origin_and_locality() {
        assert!(!same_origin(&req(&[("host", "a:1")])));
        assert!(same_origin(&req(&[("host", "a:1"), (CSRF_HEADER, "1"), ("origin", "http://a:1")])));
        assert!(!same_origin(&req(&[("host", "a:1"), (CSRF_HEADER, "1"), ("origin", "http://evil")])));
        // compat : l'ancien en-tête reste accepté, avec la même vérification d'origine.
        assert!(same_origin(&req(&[("host", "a:1"), (CSRF_HEADER_LEGACY, "1"), ("origin", "http://a:1")])));
        assert!(!same_origin(&req(&[("host", "a:1"), (CSRF_HEADER_LEGACY, "1"), ("origin", "http://evil")])));
        assert!(is_local(&req(&[("host", "127.0.0.1:9119")]), true));
        assert!(!is_local(&req(&[("host", "127.0.0.1:9119"), ("x-forwarded-for", "1.2.3.4")]), true));
        assert!(!is_local(&req(&[("host", "axe.example")]), true));
        assert!(!is_local(&req(&[("host", "localhost:9119")]), false));
    }
}
