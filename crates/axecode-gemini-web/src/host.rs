//! Long-lived DevTools connection to the dedicated browser profile, used as
//! the transport: every Gemini request runs as a `fetch` inside a
//! gemini.google.com tab, so Chrome handles cookies, session refresh and
//! Google's bot checks exactly like for a person using the site.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};

use futures::{stream::SplitSink, SinkExt, StreamExt};
use serde_json::{json, Value};
use axecode_core::{AppError, Result};
use tokio::{
    net::TcpStream,
    process::Child,
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::{
    browser,
    cookies::{now_ms, CookieJar},
    protocol::{PageTokens, APP_URL},
};

const BINDING: &str = "__axecodeGeminiChunk";
const PAGE_TTL: Duration = Duration::from_secs(30 * 60);
pub const IDLE_SHUTDOWN: Duration = Duration::from_secs(15 * 60);

type Writer = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

struct Conn {
    writer: tokio::sync::Mutex<Writer>,
    pending: Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>>,
    streams: Arc<StdMutex<HashMap<String, mpsc::UnboundedSender<Value>>>>,
    alive: Arc<AtomicBool>,
    next_id: AtomicU64,
    child: StdMutex<Option<Child>>,
    /// Headless browser started by SavIDE (this process or a previous one):
    /// closed after inactivity. A visible window is never closed.
    owned: AtomicBool,
    session: StdMutex<Option<(String, Instant)>>,
}

impl Conn {
    async fn open(ws_url: &str, child: Option<Child>) -> Result<Arc<Self>> {
        let (socket, _) = tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(ws_url))
            .await
            .map_err(|_| AppError::Network("DevTools connection timed out".into()))?
            .map_err(|err| AppError::Network(format!("DevTools connection failed: {err}")))?;
        let (writer, mut reader) = socket.split();
        let conn = Arc::new(Self {
            writer: tokio::sync::Mutex::new(writer),
            pending: Default::default(),
            streams: Default::default(),
            alive: Arc::new(AtomicBool::new(true)),
            next_id: AtomicU64::new(1),
            owned: AtomicBool::new(child.is_some()),
            child: StdMutex::new(child),
            session: StdMutex::new(None),
        });
        let pending = conn.pending.clone();
        let streams = conn.streams.clone();
        let alive = conn.alive.clone();
        tokio::spawn(async move {
            while let Some(Ok(message)) = reader.next().await {
                let Message::Text(text) = message else { continue };
                let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = pending.lock().ok().and_then(|mut p| p.remove(&id)) {
                        let _ = tx.send(value);
                    }
                    continue;
                }
                if value.get("method").and_then(Value::as_str) == Some("Runtime.bindingCalled") {
                    let params = value.get("params").cloned().unwrap_or_default();
                    if params.get("name").and_then(Value::as_str) != Some(BINDING) {
                        continue;
                    }
                    let Some(payload) = params
                        .get("payload")
                        .and_then(Value::as_str)
                        .and_then(|p| serde_json::from_str::<Value>(p).ok())
                    else {
                        continue;
                    };
                    let Some(id) = payload.get("id").and_then(Value::as_str).map(str::to_string) else { continue };
                    let finished = payload.get("done").is_some() || payload.get("error").is_some();
                    if let Ok(mut map) = streams.lock() {
                        if let Some(tx) = map.get(&id) {
                            let _ = tx.send(payload);
                        }
                        if finished {
                            map.remove(&id);
                        }
                    }
                }
            }
            alive.store(false, Ordering::SeqCst);
            if let Ok(mut map) = pending.lock() {
                map.clear();
            }
            if let Ok(mut map) = streams.lock() {
                map.clear();
            }
        });
        Ok(conn)
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    async fn call(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Result<Value> {
        if !self.is_alive() {
            return Err(AppError::Network("navigateur Gemini fermé".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|_| AppError::Network("poisoned".into()))?.insert(id, tx);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.writer
            .lock()
            .await
            .send(Message::text(message.to_string()))
            .await
            .map_err(|err| AppError::Network(err.to_string()))?;
        let reply = tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| AppError::Network(format!("DevTools {method} timed out")))?
            .map_err(|_| AppError::Network("navigateur Gemini fermé".into()))?;
        if let Some(error) = reply.get("error") {
            return Err(AppError::Provider(format!("DevTools {method}: {error}")));
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn eval(&self, session: &str, expression: &str, await_promise: bool, timeout: Duration) -> Result<Value> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({"expression": expression, "awaitPromise": await_promise, "returnByValue": true}),
                Some(session),
                timeout,
            )
            .await?;
        if let Some(details) = result.get("exceptionDetails") {
            return Err(AppError::Provider(format!("Gemini web : erreur dans la page : {details}")));
        }
        Ok(result.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }
}

/// Owner of the browser connection (one per provider instance).
#[derive(Default)]
pub struct BrowserHost {
    conn: tokio::sync::Mutex<Option<Arc<Conn>>>,
    last_used: StdMutex<Option<Instant>>,
    watchdog: AtomicBool,
}

pub struct ReadyPage {
    conn: Arc<Conn>,
    session: String,
    pub tokens: PageTokens,
}

impl BrowserHost {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Closes the browser SavIDE launched after a period without requests.
    fn start_watchdog(self: &Arc<Self>) {
        if self.watchdog.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(host) = weak.upgrade() else { break };
                host.close_if_idle().await;
            }
        });
    }

    fn touch(&self) {
        if let Ok(mut last) = self.last_used.lock() {
            *last = Some(Instant::now());
        }
    }

    async fn close_if_idle(&self) {
        let idle = self
            .last_used
            .lock()
            .ok()
            .and_then(|l| *l)
            .is_some_and(|at| at.elapsed() > IDLE_SHUTDOWN);
        if !idle {
            return;
        }
        let mut slot = self.conn.lock().await;
        if let Some(conn) = slot.take() {
            if conn.owned.load(Ordering::SeqCst) && conn.is_alive() {
                let _ = conn.call("Browser.close", json!({}), None, Duration::from_secs(5)).await;
            }
            let child = conn.child.lock().ok().and_then(|mut c| c.take());
            if let Some(mut child) = child {
                if tokio::time::timeout(Duration::from_secs(8), child.wait()).await.is_err() {
                    let _ = child.kill().await;
                }
            }
            tracing::info!("gemini-web browser closed after inactivity");
        }
    }

    async fn connection(&self) -> Result<Arc<Conn>> {
        let mut slot = self.conn.lock().await;
        if let Some(conn) = slot.as_ref() {
            if conn.is_alive() {
                return Ok(conn.clone());
            }
        }
        let profile = browser::profile_dir()?;
        if !profile.join("Default").is_dir() {
            return Err(AppError::Auth(
                "Gemini web : pas encore connecté. Settings > Providers > Gemini (app web) > Se connecter.".into(),
            ));
        }
        // Reuse a browser already running on the profile (another SavIDE process).
        let marker = profile.with_file_name("headless-endpoint.txt");
        if let Some(ws) = browser::read_active_port(&profile) {
            if let Ok(conn) = Conn::open(&ws, None).await {
                // Headless instance left by a previous SavIDE process: ours to close.
                let ours = std::fs::read_to_string(&marker).is_ok_and(|m| m.trim() == ws);
                conn.owned.store(ours, Ordering::SeqCst);
                *slot = Some(conn.clone());
                return Ok(conn);
            }
        }
        let child = browser::launch_raw(&profile, true, "about:blank").await?;
        let ws = browser::wait_endpoint(&profile).await?;
        let _ = std::fs::write(&marker, &ws);
        let conn = Conn::open(&ws, Some(child)).await?;
        *slot = Some(conn.clone());
        Ok(conn)
    }

    /// A gemini.google.com tab with fresh page tokens, reloaded every 30 min.
    pub async fn page(self: &Arc<Self>) -> Result<ReadyPage> {
        self.start_watchdog();
        self.touch();
        for attempt in 0..2 {
            let conn = self.connection().await?;
            match self.ensure_page(&conn).await {
                Ok(page) => return Ok(page),
                Err(err @ AppError::Auth(_)) => return Err(err),
                Err(err) if attempt == 0 => {
                    tracing::info!(error = %err, "gemini-web page not ready, reconnecting");
                    if let Ok(mut s) = conn.session.lock() {
                        *s = None;
                    }
                    *self.conn.lock().await = None;
                }
                Err(err) => return Err(err),
            }
        }
        unreachable!()
    }

    async fn ensure_page(&self, conn: &Arc<Conn>) -> Result<ReadyPage> {
        let current = conn.session.lock().ok().and_then(|s| s.clone());
        let session = match current {
            Some((session, loaded)) if loaded.elapsed() < PAGE_TTL => session,
            Some((session, _)) => {
                conn.call("Page.navigate", json!({"url": APP_URL}), Some(&session), Duration::from_secs(30)).await?;
                self.store_session(conn, &session);
                session
            }
            None => {
                let target = conn
                    .call("Target.createTarget", json!({"url": APP_URL}), None, Duration::from_secs(15))
                    .await?
                    .get("targetId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| AppError::Provider("Gemini web : onglet non créé".into()))?;
                let session = conn
                    .call("Target.attachToTarget", json!({"targetId": target, "flatten": true}), None, Duration::from_secs(15))
                    .await?
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| AppError::Provider("Gemini web : onglet non attaché".into()))?;
                conn.call("Runtime.enable", json!({}), Some(&session), Duration::from_secs(10)).await?;
                self.store_session(conn, &session);
                session
            }
        };
        let deadline = Instant::now() + Duration::from_secs(40);
        loop {
            let probe = conn
                .eval(
                    &session,
                    "JSON.stringify({href: location.href, g: (window.WIZ_global_data && WIZ_global_data.SNlM0e) ? {at: WIZ_global_data.SNlM0e, bl: WIZ_global_data.cfb2h || null, sid: WIZ_global_data.FdrFJe || null, hl: WIZ_global_data.TuX5cc || 'fr'} : null, ready: document.readyState})",
                    false,
                    Duration::from_secs(10),
                )
                .await
                .ok()
                .and_then(|v| v.as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()))
                .unwrap_or_default();
            let href = probe.get("href").and_then(Value::as_str).unwrap_or("");
            if let Some(g) = probe.get("g").filter(|g| !g.is_null()) {
                let tokens = PageTokens {
                    at: g.get("at").and_then(Value::as_str).unwrap_or_default().to_string(),
                    build_label: g.get("bl").and_then(Value::as_str).map(str::to_string),
                    session_id: g.get("sid").and_then(Value::as_str).map(str::to_string),
                    language: g.get("hl").and_then(Value::as_str).unwrap_or("fr").to_string(),
                };
                // Bindings do not survive the initial cross-site navigation:
                // (re)install it on the loaded document (idempotent).
                conn.call("Runtime.addBinding", json!({"name": BINDING}), Some(&session), Duration::from_secs(10)).await?;
                self.save_cookies(conn).await;
                return Ok(ReadyPage { conn: conn.clone(), session, tokens });
            }
            if href.contains("accounts.google.com") && probe.get("ready").and_then(Value::as_str) == Some("complete") {
                return Err(AppError::Auth(
                    "Gemini web : la session Google a expiré. Settings > Providers > Gemini (app web) > Se connecter.".into(),
                ));
            }
            if href.contains("google.com/sorry") {
                return Err(AppError::Auth(
                    "Gemini web : Google demande une vérification (« trafic inhabituel »). Settings > Providers > Gemini (app web) > Se connecter, puis validez la vérification dans la fenêtre.".into(),
                ));
            }
            if Instant::now() > deadline {
                return Err(AppError::Network(format!("Gemini web : la page ne s'est pas chargée ({href}).")));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    fn store_session(&self, conn: &Arc<Conn>, session: &str) {
        if let Ok(mut s) = conn.session.lock() {
            *s = Some((session.to_string(), Instant::now()));
        }
    }

    /// Mirrors the browser cookies in cookies.json (status shown in Settings).
    async fn save_cookies(&self, conn: &Arc<Conn>) {
        let Ok(result) = conn.call("Storage.getCookies", json!({}), None, Duration::from_secs(10)).await else { return };
        let cookies = result.get("cookies").and_then(Value::as_array).cloned().unwrap_or_default();
        let pairs: Vec<(String, String)> = cookies
            .iter()
            .filter(|c| matches!(c.get("domain").and_then(Value::as_str), Some(".google.com" | "google.com")))
            .filter_map(|c| Some((c.get("name")?.as_str()?.to_string(), c.get("value")?.as_str()?.to_string())))
            .collect();
        let mut jar = CookieJar::from_pairs(pairs.iter().map(|(n, v)| (n.as_str(), v.as_str())));
        if !jar.is_logged_in() {
            return;
        }
        let previous = CookieJar::load_default();
        if previous.as_ref().map(|p| &p.cookies) == Some(&jar.cookies) {
            return;
        }
        jar.last_browser_refresh_ms = now_ms();
        jar.email = previous.and_then(|p| p.email);
        let _ = jar.save_default();
    }
}

impl ReadyPage {
    /// Runs a same-origin POST in the page and returns status + full body.
    pub async fn post(&self, path_and_query: &str, headers: &[(String, String)], form: &[(String, String)]) -> Result<(u16, String)> {
        let script = format!(
            "(async () => {{ const r = await fetch({url}, {{method: 'POST', credentials: 'include', headers: Object.assign({{'content-type': 'application/x-www-form-urlencoded;charset=utf-8', 'x-same-domain': '1'}}, {headers}), body: new URLSearchParams({form})}}); return JSON.stringify({{status: r.status, body: await r.text()}}); }})()",
            url = json!(path_and_query),
            headers = headers_object(headers),
            form = pairs_array(form),
        );
        let value = self.conn.eval(&self.session, &script, true, Duration::from_secs(60)).await?;
        let parsed: Value = value.as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
        Ok((
            parsed.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
            parsed.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
        ))
    }

    /// Starts a streaming same-origin POST; chunks arrive as
    /// `{status}` then `{chunk}`... then `{done}` or `{error}`.
    pub async fn post_stream(&self, path_and_query: &str, headers: &[(String, String)], form: &[(String, String)]) -> Result<mpsc::UnboundedReceiver<Value>> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        self.conn
            .streams
            .lock()
            .map_err(|_| AppError::Network("poisoned".into()))?
            .insert(id.clone(), tx);
        let script = format!(
            "(() => {{ if (typeof window.{BINDING} !== 'function') return false; const id = {id}; const send = (o) => window.{BINDING}(JSON.stringify(Object.assign({{id}}, o))); (async () => {{ try {{ const r = await fetch({url}, {{method: 'POST', credentials: 'include', headers: Object.assign({{'content-type': 'application/x-www-form-urlencoded;charset=utf-8', 'x-same-domain': '1'}}, {headers}), body: new URLSearchParams({form})}}); send({{status: r.status}}); const reader = r.body.getReader(); const dec = new TextDecoder(); for (;;) {{ const {{done, value}} = await reader.read(); if (done) break; send({{chunk: dec.decode(value, {{stream: true}})}}); }} const tail = dec.decode(); if (tail) send({{chunk: tail}}); send({{done: true}}); }} catch (e) {{ send({{error: String(e)}}); }} }})(); return true; }})()",
            id = json!(id),
            url = json!(path_and_query),
            headers = headers_object(headers),
            form = pairs_array(form),
        );
        let started = self.conn.eval(&self.session, &script, false, Duration::from_secs(15)).await;
        if !matches!(started, Ok(Value::Bool(true))) {
            if let Ok(mut map) = self.conn.streams.lock() {
                map.remove(&id);
            }
            return Err(match started {
                Err(err) => err,
                Ok(_) => AppError::Network("Gemini web : canal de la page indisponible.".into()),
            });
        }
        Ok(rx)
    }
}

fn headers_object(headers: &[(String, String)]) -> String {
    let mut map = serde_json::Map::new();
    for (k, v) in headers {
        map.insert(k.clone(), json!(v));
    }
    Value::Object(map).to_string()
}

fn pairs_array(pairs: &[(String, String)]) -> String {
    Value::Array(pairs.iter().map(|(k, v)| json!([k, v])).collect()).to_string()
}

/// Query string of an app RPC, built from the page tokens.
pub fn rpc_path(base: &str, tokens: &PageTokens, reqid: u64, extra: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(base).expect("static url");
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in extra {
            q.append_pair(k, v);
        }
        q.append_pair("hl", &tokens.language);
        q.append_pair("_reqid", &reqid.to_string());
        q.append_pair("rt", "c");
        if let Some(bl) = &tokens.build_label {
            q.append_pair("bl", bl);
        }
        if let Some(sid) = &tokens.session_id {
            q.append_pair("f.sid", sid);
        }
    }
    format!("{}?{}", url.path(), url.query().unwrap_or(""))
}
