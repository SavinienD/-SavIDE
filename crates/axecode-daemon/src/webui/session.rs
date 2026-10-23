//! axe:webui — browser sessions (HttpOnly cookie) and login throttling.
//!
//! Cookies carry a random token; only its SHA-256 is kept, in
//! `<data_dir>/web-sessions.json`, so sessions survive a service restart and
//! can be listed / revoked from the IDE.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::util::now_ms;

pub const COOKIE_NAME: &str = "axs_session";
pub const SESSIONS_FILE: &str = "web-sessions.json";
/// Sliding expiration of a browser session.
pub const SESSION_TTL_MS: i64 = 14 * 24 * 3600 * 1000;
const MAX_FAILURES: usize = 8;
const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSession {
    /// Public identifier (for listing / revocation), never the secret.
    pub id: String,
    /// Hex SHA-256 of the cookie token.
    pub hash: String,
    pub user: String,
    #[serde(default)]
    pub user_agent: String,
    pub created_at_ms: i64,
    pub last_seen_ms: i64,
    pub expires_at_ms: i64,
}

pub struct SessionStore {
    path: PathBuf,
    sessions: Mutex<Vec<WebSession>>,
    failures: Mutex<HashMap<String, Vec<Instant>>>,
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Value of cookie `name` in a `Cookie` header.
pub fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|pair| {
        let (k, v) = pair.trim().split_once('=')?;
        (k.trim() == name).then(|| v.trim())
    })
}

impl SessionStore {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join(SESSIONS_FILE);
        let sessions: Vec<WebSession> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            sessions: Mutex::new(sessions),
            failures: Mutex::new(HashMap::new()),
        }
    }

    fn persist(&self, sessions: &[WebSession]) {
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(sessions) {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<WebSession>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Creates a session; returns the clear cookie token.
    pub fn create(&self, user: &str, user_agent: &str) -> String {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let now = now_ms();
        let mut sessions = self.lock();
        sessions.retain(|s| s.expires_at_ms > now);
        sessions.push(WebSession {
            id: crate::util::new_id()[..8].to_string(),
            hash: sha256_hex(&token),
            user: user.to_string(),
            user_agent: user_agent.chars().take(200).collect(),
            created_at_ms: now,
            last_seen_ms: now,
            expires_at_ms: now + SESSION_TTL_MS,
        });
        self.persist(&sessions);
        token
    }

    /// Validates a cookie token and slides its expiration.
    pub fn validate(&self, token: &str) -> Option<WebSession> {
        if token.is_empty() {
            return None;
        }
        let hash = sha256_hex(token);
        let now = now_ms();
        let mut sessions = self.lock();
        let session = sessions
            .iter_mut()
            .find(|s| same(&s.hash, &hash) && s.expires_at_ms > now)?;
        // Persist at most once a minute to keep disk writes low.
        let stale = now - session.last_seen_ms > 60_000;
        session.last_seen_ms = now;
        session.expires_at_ms = now + SESSION_TTL_MS;
        let found = session.clone();
        if stale {
            self.persist(&sessions);
        }
        Some(found)
    }

    /// Session from a `Cookie` header.
    pub fn from_cookie_header(&self, header: &str) -> Option<WebSession> {
        self.validate(cookie_value(header, COOKIE_NAME)?)
    }

    pub fn remove_token(&self, token: &str) {
        let hash = sha256_hex(token);
        let mut sessions = self.lock();
        sessions.retain(|s| !same(&s.hash, &hash));
        self.persist(&sessions);
    }

    pub fn list(&self) -> Vec<WebSession> {
        let now = now_ms();
        self.lock().iter().filter(|s| s.expires_at_ms > now).cloned().collect()
    }

    /// Revokes one session (`id`) or all of them (`"*"`).
    pub fn revoke(&self, id: &str) -> usize {
        let mut sessions = self.lock();
        let before = sessions.len();
        sessions.retain(|s| id != "*" && s.id != id);
        self.persist(&sessions);
        before - sessions.len()
    }

    /// True while `key` (client address) may still try to log in.
    pub fn may_attempt(&self, key: &str) -> bool {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        let list = failures.entry(key.to_string()).or_default();
        list.retain(|t| t.elapsed() < FAILURE_WINDOW);
        list.len() < MAX_FAILURES
    }

    pub fn record_failure(&self, key: &str) {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        failures.entry(key.to_string()).or_default().push(Instant::now());
    }

    pub fn clear_failures(&self, key: &str) {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        failures.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_validate_revoke() {
        let dir = std::env::temp_dir().join(format!("axs-web-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SessionStore::new(&dir);
        let token = store.create("axe", "test");
        let header = format!("theme=dark; {COOKIE_NAME}={token}");
        assert!(store.from_cookie_header(&header).is_some());
        assert!(store.validate("nope").is_none());
        // Reloaded from disk.
        let again = SessionStore::new(&dir);
        assert_eq!(again.list().len(), 1);
        assert_eq!(store.revoke("*"), 1);
        assert!(store.validate(&token).is_none());
        for _ in 0..MAX_FAILURES {
            store.record_failure("ip");
        }
        assert!(!store.may_attempt("ip"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
