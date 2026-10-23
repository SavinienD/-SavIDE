//! Dedicated Chrome/Edge profile used to sign in to gemini.google.com once and
//! to refresh the session cookies later (headless), through the DevTools
//! protocol. The browser handles Google's device-bound session refresh, so the
//! connection lasts as long as that profile stays signed in.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use axecode_core::{AppError, Result};
use tokio::{net::TcpStream, process::Child};
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::{
    cookies::{base_dir, now_ms, CookieJar},
    protocol::APP_URL,
};

pub const LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp";

pub fn profile_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("browser-profile"))
}

/// Chrome, Edge, Brave or Chromium; `AXECODE_GEMINI_WEB_BROWSER` overrides.
pub fn find_browser() -> Option<PathBuf> {
    if let Ok(path) = axecode_core::env::var("AXECODE_GEMINI_WEB_BROWSER") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(root) = std::env::var(var) {
                let root = PathBuf::from(root);
                candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
                candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
                candidates.push(root.join("BraveSoftware/Brave-Browser/Application/brave.exe"));
            }
        }
    } else if cfg!(target_os = "macos") {
        for app in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            candidates.push(PathBuf::from(app));
        }
    } else {
        for bin in ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/usr/bin/brave-browser"] {
            candidates.push(PathBuf::from(bin));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Cdp {
    socket: Socket,
    next_id: u64,
}

impl Cdp {
    async fn connect(url: &str) -> Result<Self> {
        let (socket, _) = tokio::time::timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(url))
            .await
            .map_err(|_| AppError::Network("DevTools connection timed out".into()))?
            .map_err(|err| AppError::Network(format!("DevTools connection failed: {err}")))?;
        Ok(Self { socket, next_id: 1 })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.socket
            .send(Message::text(json!({"id": id, "method": method, "params": params}).to_string()))
            .await
            .map_err(|err| AppError::Network(err.to_string()))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let next = tokio::time::timeout_at(deadline, self.socket.next())
                .await
                .map_err(|_| AppError::Network(format!("DevTools {method} timed out")))?;
            let Some(message) = next else {
                return Err(AppError::Network("DevTools connection closed".into()));
            };
            let message = message.map_err(|err| AppError::Network(err.to_string()))?;
            let Message::Text(text) = message else { continue };
            let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else { continue };
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") {
                    return Err(AppError::Provider(format!("DevTools {method}: {error}")));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    async fn google_cookies(&mut self) -> Result<CookieJar> {
        let result = self.call("Storage.getCookies", json!({})).await?;
        let cookies = result.get("cookies").and_then(Value::as_array).cloned().unwrap_or_default();
        let pairs: Vec<(String, String)> = cookies
            .iter()
            .filter(|c| {
                let domain = c.get("domain").and_then(Value::as_str).unwrap_or("");
                domain == ".google.com" || domain == "google.com"
            })
            .filter_map(|c| {
                Some((
                    c.get("name")?.as_str()?.to_string(),
                    c.get("value")?.as_str()?.to_string(),
                ))
            })
            .collect();
        Ok(CookieJar::from_pairs(pairs.iter().map(|(n, v)| (n.as_str(), v.as_str()))))
    }

    async fn open_tab(&mut self, url: &str) -> Option<String> {
        self.call("Target.createTarget", json!({"url": url}))
            .await
            .ok()
            .and_then(|r| r.get("targetId").and_then(Value::as_str).map(str::to_string))
    }

    async fn close_tab(&mut self, target: &str) {
        let _ = self.call("Target.closeTarget", json!({"targetId": target})).await;
    }

    async fn close_browser(&mut self) {
        let _ = self.call("Browser.close", json!({})).await;
    }
}

pub(crate) fn read_active_port(profile: &Path) -> Option<String> {
    let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let mut lines = text.lines();
    let port = lines.next()?.trim().parse::<u16>().ok()?;
    let path = lines.next()?.trim().to_string();
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

/// The profile's browser when it is already running with DevTools enabled.
async fn running(profile: &Path) -> Option<Cdp> {
    let url = read_active_port(profile)?;
    Cdp::connect(&url).await.ok()
}

pub(crate) async fn launch_raw(profile: &Path, headless: bool, url: &str) -> Result<Child> {
    let browser = find_browser().ok_or_else(|| {
        AppError::Auth("Gemini web : aucun navigateur Chrome, Edge ou Brave trouvé sur ce poste.".into())
    })?;
    std::fs::create_dir_all(profile)?;
    let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
    let mut command = tokio::process::Command::new(browser);
    command
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--remote-debugging-port=0")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-features=Translate")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    if headless {
        // Headless runs only serve SavIDE: no restored tabs, no extensions.
        for dir in ["Default/Sessions", "Default/Sessions_Encrypted"] {
            let _ = std::fs::remove_dir_all(profile.join(dir));
        }
        command
            .arg("--headless=new")
            .arg("--disable-extensions")
            .arg("--disable-sync")
            .arg(format!("--user-agent={}", crate::protocol::USER_AGENT));
    } else {
        command.arg("--new-window");
    }
    command.arg(url);
    command
        .spawn()
        .map_err(|err| AppError::Provider(format!("Gemini web : impossible de lancer le navigateur : {err}")))
}

/// Waits for the DevTools endpoint of a browser started on `profile`.
pub(crate) async fn wait_endpoint(profile: &Path) -> Result<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    loop {
        if let Some(ws) = read_active_port(profile) {
            if Cdp::connect(&ws).await.is_ok() {
                return Ok(ws);
            }
        }
        if tokio::time::Instant::now() > deadline {
            return Err(AppError::Provider(
                "Gemini web : le navigateur du profil Gemini ne répond pas. Fermez la fenêtre Chrome du profil Gemini ouverte hors de SavIDE, puis réessayez.".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn launch(profile: &Path, headless: bool, url: &str) -> Result<(Child, Cdp)> {
    let child = launch_raw(profile, headless, url).await?;
    let ws = wait_endpoint(profile).await?;
    Ok((child, Cdp::connect(&ws).await?))
}

async fn shutdown(mut child: Child, mut cdp: Cdp) {
    cdp.close_browser().await;
    if tokio::time::timeout(Duration::from_secs(8), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

/// Opens the app in the dedicated profile (headless unless it is already
/// open), lets the browser refresh the session, and returns its cookies.
pub async fn refresh_cookies() -> Result<CookieJar> {
    let profile = profile_dir()?;
    if !profile.is_dir() {
        return Err(AppError::Auth(
            "Gemini web : pas encore connecté. Settings > Providers > Gemini (app web) > Se connecter.".into(),
        ));
    }
    let mut jar = if let Some(mut cdp) = running(&profile).await {
        let tab = cdp.open_tab(APP_URL).await;
        tokio::time::sleep(Duration::from_secs(6)).await;
        let jar = cdp.google_cookies().await;
        if let Some(tab) = tab {
            cdp.close_tab(&tab).await;
        }
        jar?
    } else {
        let (child, mut cdp) = launch(&profile, true, APP_URL).await?;
        tokio::time::sleep(Duration::from_secs(7)).await;
        let jar = cdp.google_cookies().await;
        shutdown(child, cdp).await;
        jar?
    };
    if !jar.is_logged_in() {
        return Err(AppError::Auth(
            "Gemini web : la session Google du profil Gemini est expirée. Settings > Providers > Gemini (app web) > Se connecter.".into(),
        ));
    }
    jar.last_browser_refresh_ms = now_ms();
    Ok(jar)
}

/// Shows a browser window on Google sign-in and waits until the account is
/// signed in (or `timeout`). The window closes itself once done.
pub async fn login(timeout: Duration) -> Result<CookieJar> {
    let profile = profile_dir()?;
    // A running instance is usually SavIDE's headless one: close it so that the
    // sign-in window is visible.
    if let Some(mut cdp) = running(&profile).await {
        cdp.close_browser().await;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if running(&profile).await.is_none() {
                break;
            }
        }
    }
    let (child, cdp) = launch(&profile, false, LOGIN_URL).await?;
    let (child, mut cdp, launched) = (Some(child), cdp, true);
    let deadline = tokio::time::Instant::now() + timeout;
    let result = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        match cdp.google_cookies().await {
            Ok(jar) if jar.is_logged_in() && jar.cookies.contains_key("__Secure-1PSIDTS") => {
                // Let the redirect to gemini.google.com settle the cookies.
                tokio::time::sleep(Duration::from_secs(3)).await;
                break cdp.google_cookies().await;
            }
            Ok(_) => {}
            Err(err) => break Err(AppError::Auth(format!("Gemini web : fenêtre de connexion fermée ({err})."))),
        }
        if tokio::time::Instant::now() > deadline {
            break Err(AppError::Auth("Gemini web : connexion non terminée à temps.".into()));
        }
    };
    if launched {
        if let Some(child) = child {
            shutdown(child, cdp).await;
        }
    }
    let mut jar = result?;
    jar.last_browser_refresh_ms = now_ms();
    Ok(jar)
}

/// Forgets the session: cookie jar and browser profile.
pub fn logout() -> Result<()> {
    if let Ok(path) = crate::cookies::jar_path() {
        let _ = std::fs::remove_file(path);
    }
    let profile = profile_dir()?;
    if profile.is_dir() {
        std::fs::remove_dir_all(&profile)
            .map_err(|err| AppError::Provider(format!("Gemini web : profil non supprimé (navigateur encore ouvert ?) : {err}")))?;
    }
    Ok(())
}
