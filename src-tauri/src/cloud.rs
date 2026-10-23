// axe:cloud — Axe Cloud sign-in and calls (Axe Cloud plan, step 1).
//
// Sign-in: the app listens on http://127.0.0.1:<free port>/callback and opens
// the system browser on <base>/app/connexion (port, state, PKCE S256
// challenge, short machine name). The porte signs the user in with Google and
// redirects to the loopback with a one-time code, exchanged on
// POST <base>/app/jeton for an app token (`axa_…`). The token lives in
// `connection-secrets.json` (0600, same mechanism as the other connections)
// under the « Axe Cloud » connection and is never sent to the frontend.
// `cloud_api` only reaches `/prime/api/*` and `/app/*` on the cloud host and
// never follows redirects.

use crate::*;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::SecureRandom;

pub(crate) const CLOUD_CONNECTION_ID: &str = "axe-cloud";
const CLOUD_CONNECTION_NAME: &str = "Axe Cloud";
const DEFAULT_BASE: &str = "https://cloud.exemple.invalid";
const CLOUD_FILE: &str = "cloud.json";
pub(crate) const CLOUD_EVENT: &str = "axe://cloud-state";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Paths reachable through `cloud_api`.
const API_PREFIXES: [&str; 2] = ["/prime/api/", "/app/"];
/// Pages that `cloud_open_web` may open (signed in through `/app/code-web`).
const WEB_PREFIXES: [&str; 2] = ["/prime/", "/admin/"];
const SESSION_EXPIRED: &str = "session expirée : reconnectez-vous";

// ----- pure helpers (unit tested) ---------------------------------------------

fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `len` random bytes, base64url without padding (32 bytes → 43 characters).
fn random_b64url(len: usize) -> std::result::Result<String, String> {
    let mut bytes = vec![0u8; len];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "générateur aléatoire indisponible".to_string())?;
    Ok(b64url(&bytes))
}

/// PKCE S256: BASE64URL(SHA256(verifier)) (RFC 7636 §4.2).
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    b64url(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref())
}

pub(crate) fn is_b64url(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Loopback callback port accepted by the porte (1024-65535).
pub(crate) fn valid_callback_port(port: u16) -> bool {
    port >= 1024
}

pub(crate) fn valid_app_token(token: &str) -> bool {
    token
        .strip_prefix("axa_")
        .is_some_and(|rest| is_b64url(rest, 20, 200))
}

/// Cloud host: `https://<host>[:port]`, or `http://` on the loopback (tests).
/// Returns the normalised origin (no trailing slash).
pub(crate) fn validate_base(raw: &str) -> std::result::Result<String, String> {
    let invalid = || "adresse du service invalide (https://… attendu)".to_string();
    let url = url::Url::parse(raw.trim()).map_err(|_| invalid())?;
    let host = url.host_str().unwrap_or_default();
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !scheme_ok
        || host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(invalid());
    }
    Ok(url.origin().ascii_serialization())
}

/// Host used for a new sign-in (`AXE_CLOUD_URL` overrides it in debug builds,
/// for tests against a local porte).
fn base_url() -> String {
    std::env::var("AXE_CLOUD_URL")
        .ok()
        .filter(|_| cfg!(debug_assertions))
        .and_then(|value| validate_base(&value).ok())
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
}

/// Plain relative path under one of `prefixes`: ASCII, no traversal, no
/// encoded separator, no fragment.
pub(crate) fn validate_path(path: &str, prefixes: &[&str]) -> std::result::Result<(), String> {
    let refused = || {
        Err(format!(
            "chemin refusé : {}",
            path.chars().filter(|c| !c.is_control()).take(80).collect::<String>()
        ))
    };
    if path.len() > 1024 || !prefixes.iter().any(|prefix| path.starts_with(prefix)) {
        return refused();
    }
    if !path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/-_.~?=&%+,".contains(&b))
    {
        return refused();
    }
    let lower = path.to_ascii_lowercase();
    if path.contains("//") || ["%2e", "%2f", "%5c", "%00"].iter().any(|bad| lower.contains(bad)) {
        return refused();
    }
    let route = path.split('?').next().unwrap_or_default();
    if route.split('/').any(|segment| segment == "." || segment == "..") {
        return refused();
    }
    Ok(())
}

/// Full URL of an API path, checked again after URL normalisation.
pub(crate) fn api_url(base: &str, path: &str) -> std::result::Result<url::Url, String> {
    validate_path(path, &API_PREFIXES)?;
    let url = url::Url::parse(&format!("{base}{path}")).map_err(|_| "chemin refusé".to_string())?;
    if url.origin().ascii_serialization() != base
        || !API_PREFIXES.iter().any(|prefix| url.path().starts_with(prefix))
    {
        return Err("chemin refusé".into());
    }
    Ok(url)
}

/// Browser URL of the sign-in (contract §2.4 step 1).
pub(crate) fn login_url(
    base: &str,
    port: u16,
    state: &str,
    challenge: &str,
    poste: &str,
) -> std::result::Result<String, String> {
    let mut url = url::Url::parse(&format!("{base}/app/connexion")).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("port", &port.to_string())
        .append_pair("state", state)
        .append_pair("challenge", challenge)
        .append_pair("poste", poste);
    Ok(url.to_string())
}

/// URL returned by `/app/code-web`: must be `<base>/app/ouvrir?…`.
pub(crate) fn check_web_url(base: &str, raw: &str) -> std::result::Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "adresse de page invalide".to_string())?;
    if url.origin().ascii_serialization() != base
        || url.path() != "/app/ouvrir"
        || url.query().is_none()
        || url.fragment().is_some()
        || !url.username().is_empty()
    {
        return Err("adresse de page refusée".into());
    }
    Ok(url)
}

pub(crate) fn sanitize_poste(raw: &str) -> String {
    let clean: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(32)
        .collect();
    if clean.is_empty() {
        "poste".into()
    } else {
        clean
    }
}

/// Short machine name sent as `poste` (shown in the porte's journal).
fn poste_name() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| fs::read_to_string("/etc/hostname").ok())
        .unwrap_or_default();
    sanitize_poste(&raw)
}

/// Loopback callback request, parsed (contract §2.4 step 4).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Callback {
    /// Not the callback path (favicon, bad request): answer and keep waiting.
    Other,
    /// Missing or wrong `state`: refused, keep waiting for the real one.
    BadState,
    /// Right state but no usable code: the sign-in stops.
    Malformed,
    Code(String),
    /// Right state and `erreur=<reason>` from the porte.
    Refused(String),
}

pub(crate) fn parse_callback(target: &str, expected_state: &str) -> Callback {
    if !target.starts_with('/') {
        return Callback::Other;
    }
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Other;
    };
    if url.path() != "/callback" {
        return Callback::Other;
    }
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    match params.get("state") {
        Some(state) if !expected_state.is_empty() && constant_time_eq(state, expected_state) => {}
        _ => return Callback::BadState,
    }
    if let Some(reason) = params.get("erreur") {
        let clean: String = reason.chars().filter(|c| !c.is_control()).take(200).collect();
        let clean = clean.trim();
        return Callback::Refused(if clean.is_empty() {
            "connexion refusée".into()
        } else {
            clean.to_string()
        });
    }
    match params.get("code") {
        Some(code) if is_b64url(code, 16, 256) => Callback::Code(code.clone()),
        _ => Callback::Malformed,
    }
}

// ----- local state: cloud.json (identity) + token in connection-secrets.json ----

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudFile {
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub expire_le: String,
    #[serde(default)]
    pub poste: String,
}

fn cloud_path() -> std::result::Result<PathBuf, String> {
    Ok(axecode_daemon::util::default_data_dir()
        .map_err(|e| e.to_string())?
        .join(CLOUD_FILE))
}

fn load_cloud() -> CloudFile {
    cloud_path()
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_cloud(file: &CloudFile) -> std::result::Result<(), String> {
    crate::connections::write_json(&cloud_path()?, file)
}

fn stored_token() -> Option<String> {
    crate::connections::load_secrets()
        .remove(CLOUD_CONNECTION_ID)
        .and_then(|secret| secret.token)
        .filter(|token| valid_app_token(token))
}

fn current_state() -> (CloudFile, bool) {
    let file = load_cloud();
    let connected = !crate::EDITION_LOCALE
        && !file.email.is_empty() && validate_base(&file.base).is_ok() && stored_token().is_some();
    (file, connected)
}

/// State shown to the frontend (never the token).
fn public_state(file: &CloudFile, connected: bool) -> Value {
    let base = validate_base(&file.base).unwrap_or_else(|_| base_url());
    json!({
        "connected": connected,
        "base": base,
        "email": if connected { file.email.as_str() } else { "" },
        "role": if connected { file.role.as_str() } else { "" },
        "expireLe": if connected { file.expire_le.as_str() } else { "" },
        "poste": file.poste,
        "connectionId": CLOUD_CONNECTION_ID,
    })
}

struct TokenGrant {
    jeton: String,
    email: String,
    role: String,
    expire_le: String,
}

/// Stores the token, the identity and the « Axe Cloud » connection (active).
async fn store_login(
    app: &AppHandle,
    base: &str,
    poste: &str,
    grant: TokenGrant,
) -> std::result::Result<Value, String> {
    use crate::connections::{Connection, ConnectionKind, ConnectionSecret};
    let mut secrets = crate::connections::load_secrets();
    secrets.insert(
        CLOUD_CONNECTION_ID.into(),
        ConnectionSecret { password: None, token: Some(grant.jeton) },
    );
    crate::connections::save_secrets(&secrets)?;
    let file = CloudFile {
        base: base.into(),
        email: grant.email,
        role: grant.role,
        expire_le: grant.expire_le,
        poste: poste.into(),
    };
    save_cloud(&file)?;
    let mut connections = crate::connections::load_file();
    connections.connections.retain(|c| c.id != CLOUD_CONNECTION_ID);
    connections.connections.push(Connection {
        id: CLOUD_CONNECTION_ID.into(),
        name: CLOUD_CONNECTION_NAME.into(),
        kind: ConnectionKind::Remote,
        url: crate::connections::ws_url(base)?,
        username: String::new(),
        ssh: None,
    });
    connections.active = CLOUD_CONNECTION_ID.into();
    crate::connections::save_file(&connections)?;
    // A previous client may hold an old token.
    crate::connections::disconnect(app, CLOUD_CONNECTION_ID).await;
    let _ = app.emit("axe://connection-active", json!({"active": CLOUD_CONNECTION_ID}));
    let state = public_state(&file, true);
    let _ = app.emit(CLOUD_EVENT, state.clone());
    Ok(state)
}

/// Forgets the token and the « Axe Cloud » connection (logout or 401).
async fn forget(app: &AppHandle, expired: bool) -> std::result::Result<Value, String> {
    let mut secrets = crate::connections::load_secrets();
    if secrets.remove(CLOUD_CONNECTION_ID).is_some() {
        crate::connections::save_secrets(&secrets)?;
    }
    let mut connections = crate::connections::load_file();
    let was_active = connections.active == CLOUD_CONNECTION_ID;
    connections.connections.retain(|c| c.id != CLOUD_CONNECTION_ID);
    if was_active {
        connections.active = crate::connections::LOCAL_ID.into();
    }
    crate::connections::save_file(&connections)?;
    crate::connections::disconnect(app, CLOUD_CONNECTION_ID).await;
    let previous = load_cloud();
    let file = CloudFile { base: previous.base, poste: previous.poste, ..Default::default() };
    save_cloud(&file)?;
    if was_active {
        let _ = app.emit("axe://connection-active", json!({"active": crate::connections::LOCAL_ID}));
    }
    let mut state = public_state(&file, false);
    state["expired"] = json!(expired);
    let _ = app.emit(CLOUD_EVENT, state.clone());
    Ok(state)
}

// ----- HTTP to the cloud host ----------------------------------------------------

const NOT_CONNECTED: &str = "non connecté à Axe Cloud";

fn http_client() -> std::result::Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("axecode/", env!("CARGO_PKG_VERSION")))
        // A redirect means « not signed in » or a misconfigured route: never follow it.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

fn network_error(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "le service ne répond pas (délai dépassé)".into()
    } else if err.is_connect() {
        "service injoignable : vérifiez la connexion Internet".into()
    } else {
        format!("erreur réseau : {err}")
    }
}

async fn read_body(mut response: reqwest::Response) -> std::result::Result<Vec<u8>, String> {
    let too_big = || "réponse trop volumineuse".to_string();
    if response.content_length().is_some_and(|len| len > MAX_RESPONSE_BYTES as u64) {
        return Err(too_big());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) fn parse_body(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|_| {
        json!({"texte": String::from_utf8_lossy(bytes).chars().take(500).collect::<String>()})
    })
}

pub(crate) fn error_message(status: u16, data: &Value) -> String {
    data.get("erreur")
        .and_then(Value::as_str)
        .map(|m| m.chars().filter(|c| !c.is_control()).take(300).collect())
        .unwrap_or_else(|| format!("erreur du service (HTTP {status})"))
}

struct Reply {
    status: u16,
    data: Value,
}

async fn send(
    http: &reqwest::Client,
    method: &str,
    url: url::Url,
    token: Option<&str>,
    body: Option<&Value>,
) -> std::result::Result<Reply, String> {
    let mut request = match method {
        "GET" => http.get(url),
        "POST" => http.post(url).json(body.unwrap_or(&json!({}))),
        _ => return Err("méthode refusée".into()),
    };
    request = request.header(reqwest::header::ACCEPT, "application/json");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(network_error)?;
    let status = response.status().as_u16();
    let data = parse_body(&read_body(response).await?);
    Ok(Reply { status, data })
}

fn valid_role(role: &str) -> bool {
    (1..=16).contains(&role.len()) && role.bytes().all(|b| b.is_ascii_lowercase())
}

fn grant_from(data: &Value) -> std::result::Result<TokenGrant, String> {
    let text = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let (jeton, email, role) = (text("jeton"), text("email"), text("role"));
    if !valid_app_token(&jeton) || !email.contains('@') || email.len() > 254 || !valid_role(&role) {
        return Err("réponse de connexion invalide".into());
    }
    Ok(TokenGrant { jeton, email, role, expire_le: text("expire_le") })
}

/// POST /app/jeton (contract §2.4 step 5).
async fn exchange_code(
    http: &reqwest::Client,
    base: &str,
    code: &str,
    verifier: &str,
    poste: &str,
) -> std::result::Result<TokenGrant, String> {
    let body = json!({"code": code, "verifier": verifier, "poste": poste});
    let reply = send(http, "POST", api_url(base, "/app/jeton")?, None, Some(&body)).await?;
    if reply.status != 200 {
        return Err(error_message(reply.status, &reply.data));
    }
    grant_from(&reply.data)
}

// ----- loopback sign-in ----------------------------------------------------------

async fn read_request_target(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buffer = vec![0u8; 8192];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
        .await
        .ok()?
        .ok()?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut parts = request.lines().next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    parts.next().map(str::to_string)
}

async fn write_page(stream: &mut tokio::net::TcpStream, status: u16, title: &str, message: &str) {
    let body = format!(
        r#"<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>SavIDE</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#e8e9ec;font:15px "Segoe UI",system-ui,sans-serif}}main{{max-width:460px;padding:32px;text-align:center}}h1{{font-size:22px;margin:0 0 10px}}p{{margin:0;color:#9aa0a8;line-height:1.5;overflow-wrap:anywhere}}</style></head><body><main><h1>{}</h1><p>{}</p></main></body></html>"#,
        crate::providers::html_escape(title),
        crate::providers::html_escape(message)
    );
    let _ = crate::providers::write_html_response(stream, status, body).await;
}

/// Waits for the browser on the loopback, then exchanges the code.
/// Requests with a wrong `state` are refused without ending the sign-in.
async fn run_login(
    listener: &tokio::net::TcpListener,
    expected_state: &str,
    base: &str,
    verifier: &str,
    poste: &str,
) -> std::result::Result<TokenGrant, String> {
    let http = http_client()?;
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let Some(target) = read_request_target(&mut stream).await else {
            write_page(&mut stream, 400, "Demande illisible", "Revenez dans SavIDE.").await;
            continue;
        };
        match parse_callback(&target, expected_state) {
            Callback::Other => {
                let _ = crate::providers::write_http_response(&mut stream, 404, "Not Found", "Introuvable").await;
            }
            Callback::BadState => {
                write_page(
                    &mut stream,
                    400,
                    "Demande refusée",
                    "Cette demande ne vient pas de la connexion en cours. Revenez dans SavIDE.",
                )
                .await;
            }
            Callback::Malformed => {
                write_page(&mut stream, 400, "Connexion impossible", "Réponse incomplète. Recommencez depuis SavIDE.").await;
                return Err("réponse de connexion invalide".into());
            }
            Callback::Refused(reason) => {
                write_page(&mut stream, 403, "Connexion refusée", &reason).await;
                return Err(reason);
            }
            Callback::Code(code) => {
                let result = exchange_code(&http, base, &code, verifier, poste).await;
                match &result {
                    Ok(grant) => {
                        let text = format!(
                            "Vous êtes connecté avec {}. Vous pouvez fermer cet onglet et revenir dans SavIDE.",
                            grant.email
                        );
                        write_page(&mut stream, 200, "Connexion réussie", &text).await;
                    }
                    Err(message) => write_page(&mut stream, 400, "Connexion impossible", message).await,
                }
                return result;
            }
        }
    }
}

// ----- IPC ------------------------------------------------------------------------

static NEXT_LOGIN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct LoginHandle {
    id: u64,
    cancel: Arc<Notify>,
    url: String,
}

#[derive(Default)]
pub(crate) struct CloudState {
    login: StdMutex<Option<LoginHandle>>,
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Signs in through the system browser (contract §2.4) and activates the
/// « Axe Cloud » connection. Resolves when the browser comes back, on
/// cancel, or after 5 minutes.
#[tauri::command]
pub(crate) async fn cloud_login(app: AppHandle) -> std::result::Result<Value, String> {
    if crate::EDITION_LOCALE {
        return Err("Édition locale\u{a0}: pas de connexion au cloud.".into());
    }
    let base = base_url();
    let verifier = random_b64url(32)?;
    let state = random_b64url(32)?;
    let challenge = pkce_challenge(&verifier);
    let poste = poste_name();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("écoute locale impossible : {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    if !valid_callback_port(port) {
        return Err("port local invalide".into());
    }
    let url = login_url(&base, port, &state, &challenge, &poste)?;
    let cancel = Arc::new(Notify::new());
    let id = NEXT_LOGIN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    {
        let cloud = app.state::<CloudState>();
        let mut slot = cloud.login.lock().map_err(|_| "état verrouillé")?;
        if let Some(previous) = slot.take() {
            previous.cancel.notify_one();
        }
        *slot = Some(LoginHandle { id, cancel: cancel.clone(), url: url.clone() });
    }
    let outcome = match crate::platform::open_external_url(&url) {
        Err(err) => Err(format!("navigateur impossible à ouvrir : {err}")),
        Ok(()) => tokio::select! {
            result = run_login(&listener, &state, &base, &verifier, &poste) => result,
            _ = cancel.notified() => Err("connexion annulée".to_string()),
            _ = tokio::time::sleep(LOGIN_TIMEOUT) => Err("délai dépassé (5 minutes) : recommencez".to_string()),
        },
    };
    drop(listener);
    if let Ok(mut slot) = app.state::<CloudState>().login.lock() {
        if slot.as_ref().is_some_and(|handle| handle.id == id) {
            *slot = None;
        }
    }
    let canceled = matches!(&outcome, Err(message) if message.starts_with("connexion annulée") || message.starts_with("délai"));
    let result = match outcome {
        Ok(grant) => store_login(&app, &base, &poste, grant).await,
        Err(message) => Err(message),
    };
    // The user is in the browser: bring the app back (not after a cancel).
    if !canceled {
        focus_main_window(&app);
    }
    result
}

#[tauri::command]
pub(crate) async fn cloud_login_cancel(app: AppHandle) -> std::result::Result<(), String> {
    let handle = app.state::<CloudState>().login.lock().map_err(|_| "état verrouillé")?.take();
    if let Some(handle) = handle {
        handle.cancel.notify_one();
    }
    Ok(())
}

/// Opens the sign-in page of the running sign-in again (tab closed by mistake).
#[tauri::command]
pub(crate) async fn cloud_login_reopen(app: AppHandle) -> std::result::Result<(), String> {
    let url = app
        .state::<CloudState>()
        .login
        .lock()
        .map_err(|_| "état verrouillé")?
        .as_ref()
        .map(|handle| handle.url.clone())
        .ok_or("aucune connexion en cours")?;
    crate::platform::open_external_url(&url).map_err(|e| e.to_string())
}

/// Local state only (no network): connected or not, e-mail, role.
#[tauri::command]
pub(crate) async fn cloud_state() -> std::result::Result<Value, String> {
    let (file, connected) = current_state();
    if connected {
        ensure_connection(&file.base);
    }
    Ok(public_state(&file, connected))
}

/// Re-creates the « Axe Cloud » connection if it was deleted in Settings.
fn ensure_connection(base: &str) {
    let mut connections = crate::connections::load_file();
    if connections.connections.iter().any(|c| c.id == CLOUD_CONNECTION_ID) {
        return;
    }
    let Ok(url) = crate::connections::ws_url(base) else { return };
    connections.connections.push(crate::connections::Connection {
        id: CLOUD_CONNECTION_ID.into(),
        name: CLOUD_CONNECTION_NAME.into(),
        kind: crate::connections::ConnectionKind::Remote,
        url,
        username: String::new(),
        ssh: None,
    });
    let _ = crate::connections::save_file(&connections);
}

/// Revokes the token on the porte (best effort) and forgets it locally.
#[tauri::command]
pub(crate) async fn cloud_logout(app: AppHandle) -> std::result::Result<Value, String> {
    let (file, _) = current_state();
    let mut revoked = false;
    if let (Some(token), Ok(base)) = (stored_token(), validate_base(&file.base)) {
        if let (Ok(http), Ok(url)) = (http_client(), api_url(&base, "/app/deconnexion")) {
            revoked = send(&http, "POST", url, Some(&token), Some(&json!({})))
                .await
                .is_ok_and(|reply| (200..300).contains(&reply.status) || reply.status == 401);
        }
    }
    let mut state = forget(&app, false).await?;
    state["revoked"] = json!(revoked);
    Ok(state)
}

fn session() -> std::result::Result<(String, String), String> {
    let (file, connected) = current_state();
    let token = stored_token().filter(|_| connected).ok_or(NOT_CONNECTED)?;
    Ok((validate_base(&file.base)?, token))
}

/// Keeps the stored role / expiry in step with `GET /app/moi`.
fn refresh_identity(app: &AppHandle, data: &Value) {
    let mut file = load_cloud();
    let mut changed = false;
    if let Some(role) = data.get("role").and_then(Value::as_str).filter(|r| valid_role(r)) {
        if role != file.role {
            file.role = role.to_string();
            changed = true;
        }
    }
    if let Some(expiry) = data.get("expire_le").and_then(Value::as_str) {
        let expiry: String = expiry.chars().filter(|c| !c.is_control()).take(64).collect();
        if expiry != file.expire_le {
            file.expire_le = expiry;
            changed = true;
        }
    }
    if changed && save_cloud(&file).is_ok() {
        let _ = app.emit(CLOUD_EVENT, public_state(&file, true));
    }
}

/// Routes kept out of `cloud_api` (handled by the dedicated commands, or
/// returning a one-time sign-in code that must stay in Rust).
const API_DENIED: [&str; 5] = ["/app/jeton", "/app/connexion", "/app/ouvrir", "/app/code-web", "/app/deconnexion"];

#[derive(Deserialize)]
pub(crate) struct CloudApiInput {
    method: String,
    path: String,
    #[serde(default)]
    body: Option<Value>,
}

/// Authenticated call to `/prime/api/*` or `/app/*`. Returns
/// `{status, ok, data}`; a 401 forgets the session (event `axe://cloud-state`).
#[tauri::command]
pub(crate) async fn cloud_api(app: AppHandle, input: CloudApiInput) -> std::result::Result<Value, String> {
    let method = input.method.trim().to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err("méthode refusée".into());
    }
    let (base, token) = session()?;
    let url = api_url(&base, input.path.trim())?;
    if API_DENIED.contains(&url.path()) {
        return Err("chemin réservé à la connexion".into());
    }
    let reply = send(&http_client()?, &method, url.clone(), Some(&token), input.body.as_ref()).await?;
    match reply.status {
        401 => {
            let _ = forget(&app, true).await;
            Err(SESSION_EXPIRED.into())
        }
        300..=399 => Err("réponse inattendue du service (redirection)".into()),
        status => {
            if status == 200 && url.path() == "/app/moi" {
                refresh_identity(&app, &reply.data);
            }
            Ok(json!({"status": status, "ok": (200..300).contains(&status), "data": reply.data}))
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct CloudOpenWebInput {
    /// Page to open (`/prime/…` or `/admin/…`, default `/prime/`).
    #[serde(default)]
    suite: Option<String>,
}

/// Opens a cloud page already signed in, in the SYSTEM BROWSER:
/// `POST /app/code-web` returns a one-time `/app/ouvrir` link that sets the
/// session cookie there.
///
/// Never in a window of the app: Tauri injects its IPC bridge (with the
/// invoke key) into every page of a webview, and this app declares no app ACL
/// manifest (`tauri_build::build()`), so app commands are not access-checked.
/// A remote page in an app window could therefore call local commands
/// (terminal, files…): a flaw in the portal would become code execution on
/// the user's machine.
#[tauri::command]
pub(crate) async fn cloud_open_web(
    app: AppHandle,
    input: CloudOpenWebInput,
) -> std::result::Result<Value, String> {
    let suite = input
        .suite
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("/prime/")
        .to_string();
    validate_path(&suite, &WEB_PREFIXES)?;
    let (base, token) = session()?;
    let body = json!({"suite": suite});
    let reply = send(&http_client()?, "POST", api_url(&base, "/app/code-web")?, Some(&token), Some(&body)).await?;
    match reply.status {
        200 => {}
        401 => {
            let _ = forget(&app, true).await;
            return Err(SESSION_EXPIRED.into());
        }
        status => return Err(error_message(status, &reply.data)),
    }
    let raw = reply
        .data
        .get("url")
        .and_then(Value::as_str)
        .ok_or("réponse du service invalide")?;
    let url = check_web_url(&base, raw)?;
    crate::platform::open_external_url(url.as_str()).map_err(|e| format!("navigateur impossible à ouvrir : {e}"))?;
    Ok(json!({"ouvert": "navigateur"}))
}

