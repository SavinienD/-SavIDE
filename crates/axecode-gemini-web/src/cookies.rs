//! Persistent cookie jar of the Gemini web session
//! (`<data>/gemini-web/cookies.json`), updated from every `Set-Cookie`.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use axecode_core::{AppError, Result};

/// Only the session cookies are sent: extra Google cookies trigger 401s on
/// rotation and are not needed by the app endpoints.
pub const AUTH_COOKIES: &[&str] = &["__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDCC"];

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

pub fn base_dir() -> Result<PathBuf> {
    if let Ok(dir) = axecode_core::env::var("AXECODE_GEMINI_WEB_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let dirs = ProjectDirs::from("fr", "savide", "savide")
        .ok_or_else(|| AppError::Auth("unable to resolve local data directory".into()))?;
    Ok(dirs.data_local_dir().join("gemini-web"))
}

pub fn jar_path() -> Result<PathBuf> {
    Ok(base_dir()?.join("cookies.json"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CookieJar {
    #[serde(default)]
    pub cookies: BTreeMap<String, String>,
    #[serde(default)]
    pub updated_ms: i64,
    #[serde(default)]
    pub last_rotation_ms: i64,
    #[serde(default)]
    pub last_browser_refresh_ms: i64,
    /// Google account shown in Settings (best effort).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

impl CookieJar {
    pub fn load(path: &Path) -> Result<Option<Self>> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn load_default() -> Option<Self> {
        jar_path().ok().and_then(|path| Self::load(&path).ok().flatten())
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn save_default(&self) -> Result<()> {
        self.save(&jar_path()?)
    }

    pub fn is_logged_in(&self) -> bool {
        self.cookies.get("__Secure-1PSID").is_some_and(|v| !v.is_empty())
    }

    pub fn header(&self) -> String {
        self.cookies
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// Keeps the auth cookies of a `name -> value` list (browser import).
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut jar = Self::default();
        for (name, value) in pairs {
            if AUTH_COOKIES.contains(&name) && !value.is_empty() {
                jar.cookies.insert(name.to_string(), value.to_string());
            }
        }
        jar.updated_ms = now_ms();
        jar
    }

    /// Applies `Set-Cookie` headers; returns true when something changed.
    pub fn absorb(&mut self, headers: &reqwest::header::HeaderMap) -> bool {
        let mut changed = false;
        for value in headers.get_all(reqwest::header::SET_COOKIE) {
            let Ok(text) = value.to_str() else { continue };
            if let Some((name, value, expired)) = parse_set_cookie(text) {
                if !AUTH_COOKIES.contains(&name.as_str()) {
                    continue;
                }
                if expired || value.is_empty() {
                    // Never drop the long-lived session cookie on a stray expiry:
                    // a failed request will trigger a browser refresh instead.
                    continue;
                }
                if self.cookies.get(&name) != Some(&value) {
                    self.cookies.insert(name, value);
                    changed = true;
                }
            }
        }
        if changed {
            self.updated_ms = now_ms();
        }
        changed
    }
}

/// `(name, value, expired)` of one `Set-Cookie` header.
pub fn parse_set_cookie(header: &str) -> Option<(String, String, bool)> {
    let mut parts = header.split(';');
    let (name, value) = parts.next()?.trim().split_once('=')?;
    let mut expired = false;
    for attr in parts {
        let attr = attr.trim();
        if let Some(age) = attr.strip_prefix("Max-Age=").or_else(|| attr.strip_prefix("max-age=")) {
            if age.trim().parse::<i64>().map(|a| a <= 0).unwrap_or(false) {
                expired = true;
            }
        }
        if attr.to_ascii_lowercase().starts_with("expires=") && attr.contains("1970") {
            expired = true;
        }
    }
    Some((name.trim().to_string(), value.trim().to_string(), expired))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_cookie_parsing() {
        let (n, v, e) = parse_set_cookie("__Secure-1PSIDTS=sidts-abc; Domain=.google.com; Path=/; Secure; HttpOnly; Max-Age=31536000").unwrap();
        assert_eq!((n.as_str(), v.as_str(), e), ("__Secure-1PSIDTS", "sidts-abc", false));
        assert!(parse_set_cookie("NID=; Max-Age=0").unwrap().2);
    }

    #[test]
    fn absorb_keeps_auth_cookies_only() {
        let mut jar = CookieJar::from_pairs([("__Secure-1PSID", "a"), ("NID", "x")]);
        assert!(jar.is_logged_in());
        assert_eq!(jar.cookies.len(), 1);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(reqwest::header::SET_COOKIE, "__Secure-1PSIDTS=new; Domain=.google.com".parse().unwrap());
        headers.append(reqwest::header::SET_COOKIE, "NID=zz; Domain=.google.com".parse().unwrap());
        assert!(jar.absorb(&headers));
        assert_eq!(jar.header(), "__Secure-1PSID=a; __Secure-1PSIDTS=new");
    }
}
