//! axe:remote — credentials for the network listener (`--listen`).
//!
//! Stored in `<data_dir>/remote-auth.json`: user passwords hashed with
//! argon2 (PHC strings) and access tokens hashed with SHA-256. Clear-text
//! secrets never touch the disk; a token is printed once when created.

use std::path::{Path, PathBuf};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::util::now_ms;

pub const AUTH_FILE: &str = "remote-auth.json";
const TOKEN_PREFIX: &str = "axs_";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStore {
    #[serde(default)]
    pub users: Vec<UserEntry>,
    #[serde(default)]
    pub tokens: Vec<TokenEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserEntry {
    pub username: String,
    /// argon2 PHC string.
    pub hash: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEntry {
    pub id: String,
    pub label: String,
    /// Hex SHA-256 of the token.
    pub hash: String,
    pub created_at_ms: i64,
}

pub fn auth_path(data_dir: &Path) -> PathBuf {
    data_dir.join(AUTH_FILE)
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Constant-time comparison of two equal-length strings.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl AuthStore {
    pub fn load(data_dir: &Path) -> Self {
        std::fs::read_to_string(auth_path(data_dir))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, data_dir: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        let path = auth_path(data_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        restrict_permissions(&tmp);
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// True when at least one way to authenticate exists.
    pub fn has_credentials(&self) -> bool {
        !self.users.is_empty() || !self.tokens.is_empty()
    }

    pub fn set_password(&mut self, username: &str, password: &str) -> anyhow::Result<()> {
        let username = username.trim();
        anyhow::ensure!(!username.is_empty(), "empty username");
        anyhow::ensure!(password.chars().count() >= 8, "password must be at least 8 characters");
        let mut salt_bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut salt_bytes);
        let salt = SaltString::encode_b64(&salt_bytes).map_err(|e| anyhow::anyhow!("salt: {e}"))?;
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| anyhow::anyhow!("argon2: {e}"))?
            .to_string();
        self.users.retain(|u| u.username != username);
        self.users.push(UserEntry {
            username: username.to_string(),
            hash,
            updated_at_ms: now_ms(),
        });
        Ok(())
    }

    pub fn remove_user(&mut self, username: &str) -> bool {
        let before = self.users.len();
        self.users.retain(|u| u.username != username);
        before != self.users.len()
    }

    /// Creates a token and returns `(entry, clear_token)`; the clear token
    /// is never stored.
    pub fn create_token(&mut self, label: &str) -> (TokenEntry, String) {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token = format!(
            "{TOKEN_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        );
        let entry = TokenEntry {
            id: crate::util::new_id()[..8].to_string(),
            label: if label.trim().is_empty() { "token".into() } else { label.trim().into() },
            hash: sha256_hex(&token),
            created_at_ms: now_ms(),
        };
        self.tokens.push(entry.clone());
        (entry, token)
    }

    pub fn revoke_token(&mut self, id: &str) -> bool {
        let before = self.tokens.len();
        self.tokens.retain(|t| t.id != id);
        before != self.tokens.len()
    }

    pub fn verify_token(&self, token: &str) -> bool {
        let hash = sha256_hex(token.trim());
        self.tokens.iter().any(|t| same(&t.hash, &hash))
    }

    pub fn verify_password(&self, username: &str, password: &str) -> bool {
        let Some(user) = self.users.iter().find(|u| u.username == username) else {
            return false;
        };
        PasswordHash::new(&user.hash)
            .map(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            })
            .unwrap_or(false)
    }

    /// Checks an HTTP `Authorization` header (`Bearer <token>` or
    /// `Basic base64(user:password)`).
    pub fn verify_header(&self, header: &str) -> bool {
        let header = header.trim();
        if let Some(token) = header.strip_prefix("Bearer ") {
            return self.verify_token(token);
        }
        if let Some(encoded) = header.strip_prefix("Basic ") {
            let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(encoded.trim()) else {
                return false;
            };
            let Ok(text) = String::from_utf8(raw) else {
                return false;
            };
            if let Some((user, password)) = text.split_once(':') {
                return self.verify_password(user, password);
            }
        }
        false
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn read_secret(prompt: &str) -> anyhow::Result<String> {
    use std::io::{BufRead, IsTerminal, Write};
    if std::io::stdin().is_terminal() {
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
    }
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

/// `set-password [--user NAME] [--remove]`, `token [create|list|revoke ID]
/// [--label L]`, `auth` (summary). Passwords are read from stdin (or the
/// `AXECODE_PASSWORD` variable) so they never appear in the process list.
pub fn run_cli(command: &str, args: &[String], data_dir: &Path) -> anyhow::Result<()> {
    let mut store = AuthStore::load(data_dir);
    match command {
        "set-password" => {
            let user = flag_value(args, "--user").unwrap_or_else(|| "axe".into());
            if args.iter().any(|a| a == "--remove") {
                let removed = store.remove_user(&user);
                store.save(data_dir)?;
                println!("{}", serde_json::json!({"user": user, "removed": removed}));
                return Ok(());
            }
            let password = match axecode_core::env::var("AXECODE_PASSWORD") {
                Ok(p) if !p.is_empty() => p,
                _ => {
                    let first = read_secret("Mot de passe : ")?;
                    if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
                        let again = read_secret("Confirmer : ")?;
                        anyhow::ensure!(first == again, "passwords do not match");
                    }
                    first
                }
            };
            store.set_password(&user, &password)?;
            store.save(data_dir)?;
            println!("{}", serde_json::json!({"user": user, "ok": true}));
        }
        "token" => {
            let action = args.get(1).map(String::as_str).unwrap_or("create");
            match action {
                "list" => {
                    println!("{}", serde_json::to_string_pretty(&store.tokens)?);
                }
                "revoke" => {
                    let id = args
                        .get(2)
                        .ok_or_else(|| anyhow::anyhow!("usage: token revoke <id>"))?;
                    let removed = store.revoke_token(id);
                    store.save(data_dir)?;
                    println!("{}", serde_json::json!({"id": id, "revoked": removed}));
                }
                _ => {
                    let label = flag_value(args, "--label").unwrap_or_default();
                    let (entry, token) = store.create_token(&label);
                    store.save(data_dir)?;
                    eprintln!("Jeton créé (affiché une seule fois, conservez-le) :");
                    println!("{}", serde_json::json!({"id": entry.id, "label": entry.label, "token": token}));
                }
            }
        }
        _ => {
            let users: Vec<&str> = store.users.iter().map(|u| u.username.as_str()).collect();
            println!(
                "{}",
                serde_json::json!({"file": auth_path(data_dir), "users": users, "tokens": store.tokens.len()})
            );
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_and_token_roundtrip() {
        let mut store = AuthStore::default();
        assert!(!store.has_credentials());
        store.set_password("alice", "correct horse").unwrap();
        assert!(store.verify_password("alice", "correct horse"));
        assert!(!store.verify_password("alice", "wrong password"));
        let basic = base64::engine::general_purpose::STANDARD.encode("alice:correct horse");
        assert!(store.verify_header(&format!("Basic {basic}")));
        let (entry, token) = store.create_token("laptop");
        assert!(store.verify_header(&format!("Bearer {token}")));
        assert!(!store.verify_token("axs_nope"));
        assert!(store.revoke_token(&entry.id));
        assert!(!store.verify_token(&token));
    }
}
