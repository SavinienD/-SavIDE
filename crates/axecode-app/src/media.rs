//! API personnalisées de génération de médias (images et vidéos).
//!
//! Réglages > REPL > Recherche web et images > « API personnalisées » : une
//! entrée = URL (POST), en-tête d'authentification + clé, modèle, gabarit JSON
//! du corps, et au besoin URL de suivi / URL du résultat / chemin du résultat.
//! Tout est facultatif sauf l'URL : par défaut le corps est celui de l'API
//! OpenAI (`{"model": "{model}", "prompt": "{prompt}"}`) et le reste est
//! détecté dans la réponse :
//! - média direct (octets image/vidéo), `b64_json`/`base64`, `data:` ou URL
//!   (clés `url`, `video`, `output`… ou extension .png/.mp4…) ;
//! - tâche asynchrone (champ `status`/`state` en attente, ou un `id` sans
//!   média) : suivi par `status_url` (fal), `urls.get` (Replicate),
//!   `polling_url`, sinon `{url}/{id}` (OpenAI /v1/videos) toutes les
//!   quelques secondes ; une fois finie, `response_url` (fal) ou
//!   `{suivi}/content` (OpenAI) donne le résultat.
//! La clé n'est envoyée qu'à l'hôte de l'API (jamais au CDN des fichiers) et
//! n'apparaît dans aucun message ; `$NOM` la lit dans la variable `NOM`.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const DEFAULT_TIMEOUT_SECONDS: u64 = 900;
const DEFAULT_POLL_SECONDS: f64 = 4.0;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    #[default]
    Image,
    Video,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProviderConfig {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: MediaKind,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub model: String,
    /// En-tête d'authentification (vide = `Authorization`).
    #[serde(default)]
    pub auth_header: String,
    /// Préfixe de la clé (vide avec `Authorization` = `Bearer `).
    #[serde(default)]
    pub auth_prefix: String,
    /// Clé (gardée dans les réglages de l'appli), ou `$NOM` pour la variable `NOM`.
    #[serde(default)]
    pub api_key: String,
    /// Gabarit JSON du corps ; `{prompt}`, `{model}` et les options passées.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub poll_url: String,
    #[serde(default)]
    pub result_url: String,
    /// Chemin du média dans la réponse : `data.0.url`, `video.url`, `/output/0`…
    #[serde(default)]
    pub result_path: String,
    #[serde(default)]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub poll_seconds: f64,
}

impl MediaProviderConfig {
    pub fn normalized(mut self) -> Self {
        for field in [
            &mut self.name,
            &mut self.url,
            &mut self.model,
            &mut self.auth_header,
            &mut self.api_key,
            &mut self.poll_url,
            &mut self.result_url,
            &mut self.result_path,
        ] {
            *field = field.trim().to_string();
        }
        self
    }

    fn api_key(&self) -> Option<String> {
        let raw = self.api_key.trim();
        let key = match raw.strip_prefix('$') {
            Some(var) => std::env::var(var.trim_matches(|c| c == '{' || c == '}')).unwrap_or_default(),
            None => raw.to_string(),
        };
        let key = key.trim().to_string();
        (!key.is_empty()).then_some(key)
    }

    fn auth(&self) -> Option<(String, String)> {
        let key = self.api_key()?;
        let header = if self.auth_header.is_empty() { "Authorization".to_string() } else { self.auth_header.clone() };
        let prefix = if self.auth_prefix.is_empty() && header.eq_ignore_ascii_case("authorization") {
            "Bearer ".to_string()
        } else {
            self.auth_prefix.clone()
        };
        Some((header, format!("{prefix}{key}")))
    }

    /// Vue sans secret, pour `images.providers()` / `videos.providers()`.
    pub fn public_view(&self) -> Value {
        json!({
            "name": self.name,
            "kind": self.kind,
            "model": self.model,
            "host": host_of(&self.url).unwrap_or_default(),
            "key": if self.api_key().is_some() { "configurée" } else { "absente" },
        })
    }
}

/// Fichier produit par une API personnalisée.
#[derive(Debug, Clone)]
pub struct SavedMedia {
    pub path: PathBuf,
    pub media_type: String,
}

#[derive(Debug, Clone)]
pub struct MediaOutput {
    pub files: Vec<SavedMedia>,
    /// Étapes (POST, suivis, téléchargement), pour le compte rendu.
    pub steps: Vec<String>,
}

enum Reply {
    Bytes(Vec<u8>, String),
    Json(Value),
}

enum Status {
    Done,
    Failed(String),
    Pending,
    Unknown,
}

/// Génère un média avec `cfg` ; les fichiers vont dans `out_dir` (données de l'appli).
pub async fn generate(
    cfg: &MediaProviderConfig,
    prompt: &str,
    options: &Map<String, Value>,
    out_dir: &Path,
) -> Result<MediaOutput> {
    if cfg.url.trim().is_empty() {
        bail!("API personnalisée « {} » : URL manquante (Réglages > REPL > Recherche web et images)", cfg.name);
    }
    let http = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("axecode/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut vars = options.clone();
    vars.insert("prompt".into(), json!(prompt));
    if !cfg.model.is_empty() {
        vars.insert("model".into(), json!(cfg.model));
    }
    let url = fill_template(&cfg.url, &vars, None, "");
    let body = build_body(&cfg.body, &vars)?;
    let mut steps = vec![format!("POST {}", strip_query(&url))];
    let mut reply = send(&http, cfg, reqwest::Method::POST, &url, Some(&body)).await?;
    let first = match &reply {
        Reply::Json(v) => v.clone(),
        Reply::Bytes(..) => Value::Null,
    };
    let deadline = Instant::now()
        + Duration::from_secs(if cfg.timeout_seconds == 0 { DEFAULT_TIMEOUT_SECONDS } else { cfg.timeout_seconds });
    let pause = Duration::from_secs_f64(if cfg.poll_seconds > 0.0 { cfg.poll_seconds } else { DEFAULT_POLL_SECONDS });
    let mut poll_url: Option<String> = None;
    let mut fetched_result = false;
    loop {
        let json = match reply {
            Reply::Bytes(bytes, content_type) => {
                let file = save(out_dir, &bytes, &content_type, 0)?;
                steps.push(format!("média reçu ({} octets)", bytes.len()));
                return Ok(MediaOutput { files: vec![file], steps });
            }
            Reply::Json(json) => json,
        };
        let found = find_media(&json, &cfg.result_path);
        if !found.is_empty() {
            let mut files = Vec::new();
            for (index, media) in found.iter().enumerate() {
                let (bytes, content_type) = match media {
                    Found::Base64(data, mime) => (decode_base64(data)?, mime.clone()),
                    Found::Url(link) => {
                        steps.push(format!("téléchargement {}", strip_query(link)));
                        download(&http, cfg, &url, link).await?
                    }
                };
                files.push(save(out_dir, &bytes, &content_type, index)?);
            }
            return Ok(MediaOutput { files, steps });
        }
        match status_of(&json) {
            Status::Failed(message) => bail!("l'API « {} » signale un échec : {message}", cfg.name),
            Status::Done => {
                if fetched_result {
                    bail!("tâche finie mais aucun média trouvé dans la réponse : {}", clip(&json.to_string(), 600));
                }
                let target = if !cfg.result_url.is_empty() {
                    fill_template(&cfg.result_url, &vars, Some(&first), &url)
                } else if let Some(link) = json.get("response_url").or_else(|| first.get("response_url")).and_then(Value::as_str) {
                    link.to_string()
                } else if let Some(poll) = &poll_url {
                    format!("{}/content", poll.trim_end_matches('/'))
                } else {
                    bail!("tâche finie mais aucun média trouvé dans la réponse : {}", clip(&json.to_string(), 600));
                };
                steps.push(format!("résultat {}", strip_query(&target)));
                fetched_result = true;
                reply = send(&http, cfg, reqwest::Method::GET, &target, None).await?;
            }
            status @ (Status::Pending | Status::Unknown) => {
                if poll_url.is_none() {
                    poll_url = if !cfg.poll_url.is_empty() {
                        Some(fill_template(&cfg.poll_url, &vars, Some(&first), &url))
                    } else {
                        auto_poll_url(&first, &url)
                    };
                }
                let Some(target) = poll_url.clone() else {
                    if matches!(status, Status::Unknown) {
                        bail!("réponse sans média ni tâche à suivre : {}", clip(&json.to_string(), 600));
                    }
                    bail!("tâche en attente mais aucune URL de suivi : renseignez « URL de suivi » (ex. {{url}}/{{id}})");
                };
                if Instant::now() >= deadline {
                    bail!("délai dépassé en attendant l'API « {} » ({} étapes)", cfg.name, steps.len());
                }
                tokio::time::sleep(pause).await;
                if steps.last().map(|s| s.starts_with("suivi")) != Some(true) {
                    steps.push(format!("suivi {}", strip_query(&target)));
                }
                reply = send(&http, cfg, reqwest::Method::GET, &target, None).await?;
            }
        }
    }
}

async fn send(
    http: &reqwest::Client,
    cfg: &MediaProviderConfig,
    method: reqwest::Method,
    url: &str,
    body: Option<&Value>,
) -> Result<Reply> {
    let mut request = http.request(method, url).header(ACCEPT, "application/json, image/*, video/*, */*;q=0.5");
    if same_host(url, &cfg.url) {
        if let Some((name, value)) = cfg.auth() {
            request = request.header(name.as_str(), value);
        }
    }
    if let Some(body) = body {
        request = request.header(CONTENT_TYPE, "application/json").json(body);
    }
    let response = request.send().await.with_context(|| format!("API « {} » injoignable ({})", cfg.name, strip_query(url)))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = response.bytes().await.context("réponse illisible")?;
    if !status.is_success() {
        bail!(
            "API « {} » : HTTP {} ({}) : {}",
            cfg.name,
            status.as_u16(),
            strip_query(url),
            clip(&String::from_utf8_lossy(&bytes), 800)
        );
    }
    if content_type.contains("json") || (!is_media_type(&content_type) && sniff(&bytes).is_none()) {
        let value: Value = serde_json::from_slice(&bytes)
            .with_context(|| format!("réponse non JSON : {}", clip(&String::from_utf8_lossy(&bytes), 300)))?;
        return Ok(Reply::Json(value));
    }
    Ok(Reply::Bytes(bytes.to_vec(), content_type))
}

async fn download(http: &reqwest::Client, cfg: &MediaProviderConfig, api_url: &str, link: &str) -> Result<(Vec<u8>, String)> {
    if let Some(rest) = link.strip_prefix("data:") {
        let (head, data) = rest.split_once(',').context("URL data: invalide")?;
        return Ok((decode_base64(data)?, head.split(';').next().unwrap_or("").to_string()));
    }
    let mut request = http.get(link);
    if same_host(link, api_url) {
        if let Some((name, value)) = cfg.auth() {
            request = request.header(name.as_str(), value);
        }
    }
    let response = request.send().await.with_context(|| format!("téléchargement impossible ({})", strip_query(link)))?;
    let status = response.status();
    let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = response.bytes().await.context("téléchargement interrompu")?;
    if !status.is_success() {
        bail!("téléchargement HTTP {} ({})", status.as_u16(), strip_query(link));
    }
    Ok((bytes.to_vec(), content_type))
}

fn auto_poll_url(first: &Value, api_url: &str) -> Option<String> {
    for pointer in ["/status_url", "/urls/get", "/polling_url", "/poll_url", "/links/status"] {
        if let Some(link) = first.pointer(pointer).and_then(Value::as_str) {
            return Some(link.to_string());
        }
    }
    let id = id_of(first)?;
    Some(format!("{}/{}", strip_query(api_url).trim_end_matches('/'), id))
}

fn id_of(value: &Value) -> Option<String> {
    for pointer in ["/id", "/request_id", "/task_id", "/generation_id", "/name", "/data/id", "/data/task_id"] {
        match value.pointer(pointer) {
            Some(Value::String(s)) if !s.is_empty() => return Some(s.clone()),
            Some(Value::Number(n)) => return Some(n.to_string()),
            _ => {}
        }
    }
    None
}

fn status_of(value: &Value) -> Status {
    if value.get("done").and_then(Value::as_bool) == Some(true) {
        return match value.get("error") {
            Some(error) if !error.is_null() => Status::Failed(clip(&error.to_string(), 400)),
            _ => Status::Done,
        };
    }
    let raw = ["/status", "/state", "/data/status", "/task_status", "/data/task_status"]
        .iter()
        .find_map(|p| value.pointer(p).and_then(Value::as_str))
        .map(|s| s.trim().to_ascii_lowercase());
    let Some(status) = raw else {
        return Status::Unknown;
    };
    match status.as_str() {
        "completed" | "complete" | "succeeded" | "success" | "successful" | "done" | "finished" | "ready" => Status::Done,
        "failed" | "failure" | "error" | "errored" | "canceled" | "cancelled" | "rejected" | "expired" => {
            let detail = ["/error/message", "/error", "/failure", "/failure_reason", "/message", "/detail"]
                .iter()
                .find_map(|p| value.pointer(p))
                .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                .unwrap_or_else(|| status.clone());
            Status::Failed(clip(&detail, 400))
        }
        "" => Status::Unknown,
        _ => Status::Pending,
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Found {
    Url(String),
    Base64(String, String),
}

const BASE64_KEYS: &[&str] = &["b64_json", "base64", "b64", "bytesBase64Encoded", "image_base64", "video_base64"];
const MEDIA_KEYS: &[&str] = &[
    "url", "uri", "video_url", "image_url", "download_url", "file_url", "media_url", "output", "outputs", "video",
    "videos", "image", "images", "sample", "result", "results", "data", "generations", "assets", "content",
];
/// Sous-arbres qui décrivent la requête ou le suivi, jamais le résultat.
const SKIP_KEYS: &[&str] = &[
    "input", "inputs", "urls", "request", "params", "parameters", "metrics", "logs", "status_url", "response_url",
    "cancel_url", "polling_url", "poll_url", "webhook", "links",
];
const MEDIA_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "m4v"];

fn find_media(value: &Value, path: &str) -> Vec<Found> {
    let mut out = Vec::new();
    let path = path.trim();
    if !path.is_empty() {
        let pointer = if path.starts_with('/') { path.to_string() } else { format!("/{}", path.replace('.', "/")) };
        if let Some(target) = value.pointer(&pointer) {
            collect(target, None, true, &mut out);
        }
        return out;
    }
    collect(value, None, false, &mut out);
    out
}

fn collect(value: &Value, key: Option<&str>, chosen: bool, out: &mut Vec<Found>) {
    match value {
        Value::String(s) => {
            let s = s.trim();
            if s.starts_with("data:image/") || s.starts_with("data:video/") {
                out.push(Found::Url(s.to_string()));
            } else if s.starts_with("http://") || s.starts_with("https://") {
                let media_key = key.map(|k| MEDIA_KEYS.contains(&k)).unwrap_or(false);
                if chosen || media_key || has_media_extension(s) {
                    out.push(Found::Url(s.to_string()));
                }
            } else if key.map(|k| BASE64_KEYS.contains(&k)).unwrap_or(false) || (chosen && s.len() > 64) {
                out.push(Found::Base64(s.to_string(), String::new()));
            }
        }
        Value::Array(items) => {
            for item in items {
                collect(item, key, chosen, out);
            }
        }
        Value::Object(map) => {
            // Gemini / Vertex : {"mimeType": "image/png", "data": "<base64>"}.
            let mime = map.get("mimeType").or_else(|| map.get("mime_type")).and_then(Value::as_str).unwrap_or("");
            if (mime.starts_with("image/") || mime.starts_with("video/")) && map.get("data").and_then(Value::as_str).is_some() {
                out.push(Found::Base64(map["data"].as_str().unwrap_or_default().to_string(), mime.to_string()));
                return;
            }
            for (k, v) in map {
                if SKIP_KEYS.contains(&k.as_str()) {
                    continue;
                }
                collect(v, Some(k.as_str()), chosen, out);
            }
        }
        _ => {}
    }
}

fn has_media_extension(url: &str) -> bool {
    let path = strip_query(url);
    path.rsplit('.').next().map(|ext| MEDIA_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Corps de la requête : gabarit JSON (défaut : compatible OpenAI) rempli avec
/// `{prompt}`, `{model}` et les options ; une valeur `"{x}"` sans `x` est
/// retirée ; les options absentes du gabarit rejoignent l'objet du `{prompt}`.
fn build_body(template: &str, vars: &Map<String, Value>) -> Result<Value> {
    let template = template.trim();
    let mut body: Value = if template.is_empty() {
        json!({"model": "{model}", "prompt": "{prompt}"})
    } else {
        serde_json::from_str(template).context("gabarit JSON du corps invalide (Réglages > REPL > API personnalisées)")?
    };
    let mut used = Vec::new();
    fill_value(&mut body, vars, &mut used);
    let extra: Map<String, Value> = vars
        .iter()
        .filter(|(k, _)| !used.iter().any(|u| u == *k) && k.as_str() != "prompt" && k.as_str() != "model")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if !extra.is_empty() {
        let prompt = vars.get("prompt").cloned().unwrap_or(Value::Null);
        let path = parent_path_of(&body, &prompt);
        let mut target = &mut body;
        for key in path {
            target = target.get_mut(&key).expect("chemin trouvé dans le corps");
        }
        if let Value::Object(map) = target {
            for (k, v) in extra {
                map.entry(k).or_insert(v);
            }
        }
    }
    Ok(body)
}

fn fill_value(value: &mut Value, vars: &Map<String, Value>, used: &mut Vec<String>) -> bool {
    match value {
        Value::String(s) => {
            if let Some(name) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')).filter(|n| is_name(n)) {
                used.push(name.to_string());
                match vars.get(name) {
                    Some(v) => *value = v.clone(),
                    None => return false,
                }
                return true;
            }
            *s = fill_template(s, vars, None, "");
            for name in vars.keys() {
                if s.contains(name.as_str()) {
                    used.push(name.clone());
                }
            }
            true
        }
        Value::Array(items) => {
            items.retain_mut(|item| fill_value(item, vars, used));
            true
        }
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                let keep = fill_value(map.get_mut(&key).unwrap(), vars, used);
                if !keep {
                    map.remove(&key);
                }
            }
            true
        }
        _ => true,
    }
}

/// Chemin (clés) de l'objet qui contient directement `needle`, sinon de la racine.
fn parent_path_of(value: &Value, needle: &Value) -> Vec<String> {
    let mut path = Vec::new();
    let mut current = value;
    loop {
        let Value::Object(map) = current else { return path };
        if map.values().any(|v| v == needle) {
            return path;
        }
        match map.iter().find(|(_, v)| v.is_object() && contains_value(v, needle)) {
            Some((key, next)) => {
                path.push(key.clone());
                current = next;
            }
            None => return path,
        }
    }
}

fn contains_value(value: &Value, needle: &Value) -> bool {
    value == needle
        || match value {
            Value::Object(map) => map.values().any(|v| contains_value(v, needle)),
            Value::Array(items) => items.iter().any(|v| contains_value(v, needle)),
            _ => false,
        }
}

fn is_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Remplace `{nom}` par les variables, puis par les champs texte de `reply`
/// (`{id}` : id, request_id, task_id, name…), et `{url}` par l'URL de l'API.
fn fill_template(template: &str, vars: &Map<String, Value>, reply: Option<&Value>, api_url: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        let replacement = if !is_name(name) {
            None
        } else if name == "url" && !api_url.is_empty() {
            Some(strip_query(api_url).trim_end_matches('/').to_string())
        } else if let Some(v) = vars.get(name) {
            Some(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
        } else if let Some(reply) = reply {
            if name == "id" {
                id_of(reply)
            } else {
                reply.get(name).and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_number().map(|n| n.to_string())))
            }
        } else {
            None
        };
        match replacement {
            Some(text) => out.push_str(&text),
            None => {
                out.push('{');
                out.push_str(name);
                out.push('}');
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn save(dir: &Path, bytes: &[u8], content_type: &str, index: usize) -> Result<SavedMedia> {
    if bytes.is_empty() {
        bail!("média vide");
    }
    let (extension, media_type) = sniff(bytes)
        .or_else(|| from_content_type(content_type))
        .with_context(|| format!("le fichier reçu n'est ni une image ni une vidéo ({content_type}) : {}", clip(&String::from_utf8_lossy(&bytes[..bytes.len().min(200)]), 200)))?;
    let sub = if media_type.starts_with("video/") { "videos" } else { "images" };
    let dir = dir.join(sub);
    std::fs::create_dir_all(&dir).with_context(|| format!("impossible de créer {}", dir.display()))?;
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default();
    let path = dir.join(format!("{millis}-{}.{extension}", index + 1));
    std::fs::write(&path, bytes).with_context(|| format!("impossible d'écrire {}", path.display()))?;
    Ok(SavedMedia { path, media_type: media_type.to_string() })
}

fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("jpg", "image/jpeg"))
    } else if bytes.starts_with(b"GIF8") {
        Some(("gif", "image/gif"))
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        if &bytes[8..10] == b"qt" {
            Some(("mov", "video/quicktime"))
        } else {
            Some(("mp4", "video/mp4"))
        }
    } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some(("webm", "video/webm"))
    } else {
        None
    }
}

fn from_content_type(content_type: &str) -> Option<(&'static str, &'static str)> {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    Some(match ct.as_str() {
        "image/png" => ("png", "image/png"),
        "image/jpeg" | "image/jpg" => ("jpg", "image/jpeg"),
        "image/webp" => ("webp", "image/webp"),
        "image/gif" => ("gif", "image/gif"),
        "video/mp4" => ("mp4", "video/mp4"),
        "video/webm" => ("webm", "video/webm"),
        "video/quicktime" => ("mov", "video/quicktime"),
        _ => return None,
    })
}

fn is_media_type(content_type: &str) -> bool {
    content_type.starts_with("image/") || content_type.starts_with("video/") || content_type.starts_with("application/octet-stream")
}

fn decode_base64(data: &str) -> Result<Vec<u8>> {
    let clean: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64.decode(clean.as_bytes()).context("base64 du média invalide")
}

fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| match u.port() {
        Some(p) => format!("{h}:{p}"),
        None => h.to_string(),
    }))
}

fn same_host(a: &str, b: &str) -> bool {
    matches!((host_of(a), host_of(b)), (Some(x), Some(y)) if x.eq_ignore_ascii_case(&y))
}

fn strip_query(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).to_string()
}

fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// Outil (agent et REPL) : génère avec `cfg`, fichiers dans les données de
/// l'appli du projet (jamais dans le projet), résultat au format des images.
pub async fn run_tool(cfg: &MediaProviderConfig, workspace_root: &Path, input: Value) -> crate::tool_run::ToolRunResult {
    use crate::tool_run::{ToolRunImage, ToolRunResult};
    let mut options = match input {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let prompt = options.remove("prompt").and_then(|p| p.as_str().map(str::to_string)).unwrap_or_default();
    if prompt.trim().is_empty() {
        return ToolRunResult::err("prompt is required", Vec::new());
    }
    options.retain(|_, v| !v.is_null());
    let out_dir = axecode_harness::project_data_dir(workspace_root);
    match generate(cfg, prompt.trim(), &options, &out_dir).await {
        Ok(output) => {
            let kind = match cfg.kind {
                MediaKind::Image => "images",
                MediaKind::Video => "vidéo",
            };
            let mut content = format!("source: API personnalisée « {} » ({kind})", cfg.name);
            if !cfg.model.is_empty() {
                content.push_str(&format!("\nmodel: {}", cfg.model));
            }
            content.push_str(&format!("\nétapes: {}", output.steps.join(" ; ")));
            content.push_str("\nsaved:");
            for file in &output.files {
                content.push_str(&format!("\n- {} ({})", file.path.display(), file.media_type));
            }
            let images = output
                .files
                .iter()
                .map(|f| ToolRunImage { media_type: f.media_type.clone(), data: String::new(), path: Some(f.path.display().to_string()) })
                .collect();
            ToolRunResult::ok_with_images(content, images, Vec::new())
        }
        Err(err) => ToolRunResult::err(format!("{err:#}"), Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::faux_http::{lancer, Reponse};

    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const MP4: &[u8] = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomvideo-de-test";

    fn vars(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn body_defaults_to_openai_and_merges_options_next_to_the_prompt() {
        let v = vars(&[("prompt", json!("chat")), ("model", json!("m1"))]);
        assert_eq!(build_body("", &v).unwrap(), json!({"model": "m1", "prompt": "chat"}));
        let sans_modele = vars(&[("prompt", json!("chat"))]);
        assert_eq!(build_body("", &sans_modele).unwrap(), json!({"prompt": "chat"}), "{{model}} absent : clé retirée");
        let v = vars(&[("prompt", json!("chat")), ("aspect_ratio", json!("16:9")), ("duration", json!(5))]);
        let body = build_body(r#"{"input": {"prompt": "{prompt}", "seconds": "{duration}"}, "version": "{version}"}"#, &v).unwrap();
        assert_eq!(body, json!({"input": {"prompt": "chat", "seconds": 5, "aspect_ratio": "16:9"}}));
        assert!(build_body("{pas du json", &v).is_err());
    }

    #[test]
    fn media_is_found_in_the_usual_answers_but_not_in_inputs() {
        let openai = json!({"created": 1, "data": [{"b64_json": PNG_B64}]});
        assert_eq!(find_media(&openai, ""), vec![Found::Base64(PNG_B64.into(), String::new())]);
        let fal = json!({"video": {"url": "https://v3.fal.media/files/x/out.mp4", "content_type": "video/mp4"}, "seed": 3});
        assert_eq!(find_media(&fal, ""), vec![Found::Url("https://v3.fal.media/files/x/out.mp4".into())]);
        let replicate = json!({"id": "p1", "status": "succeeded", "input": {"image": "https://ref.example/in.png"},
            "urls": {"get": "https://api.replicate.com/v1/predictions/p1"}, "output": "https://replicate.delivery/a/out.mp4"});
        assert_eq!(find_media(&replicate, ""), vec![Found::Url("https://replicate.delivery/a/out.mp4".into())]);
        let pending = json!({"id": "p1", "status": "starting", "input": {"image": "https://ref.example/in.png"}, "urls": {"get": "https://x/get"}});
        assert!(find_media(&pending, "").is_empty());
        let gemini = json!({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": PNG_B64}}]}}]});
        assert_eq!(find_media(&gemini, ""), vec![Found::Base64(PNG_B64.into(), "image/png".into())]);
        let chemin = json!({"result": {"assets": {"video": "https://cdn.example/sans-extension"}}});
        assert_eq!(find_media(&chemin, "result.assets.video"), vec![Found::Url("https://cdn.example/sans-extension".into())]);
    }

    fn config(name: &str, url: String) -> MediaProviderConfig {
        MediaProviderConfig { name: name.into(), url, api_key: "cle-secrete".into(), poll_seconds: 0.01, timeout_seconds: 20, ..Default::default() }
    }

    #[tokio::test]
    async fn openai_compatible_images_are_saved_synchronously() {
        let serveur = lancer(|_, _| Reponse::json(json!({"data": [{"b64_json": PNG_B64}]}))).await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config("images-maison", format!("{}/v1/images/generations", serveur.base));
        cfg.model = "modele-x".into();
        let out = generate(&cfg, "un chat", &vars(&[("size", json!("1024x1024"))]), dir.path()).await.unwrap();
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.files[0].media_type, "image/png");
        assert!(out.files[0].path.starts_with(dir.path().join("images")));
        let reqs = serveur.requetes();
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].header("authorization"), Some("Bearer cle-secrete"));
        let body: Value = serde_json::from_str(&reqs[0].body).unwrap();
        assert_eq!(body, json!({"model": "modele-x", "prompt": "un chat", "size": "1024x1024"}));
    }

    #[tokio::test]
    async fn fal_like_queue_is_polled_and_the_key_never_reaches_the_cdn() {
        let cdn = lancer(|_, _| Reponse::bytes("video/mp4", MP4)).await;
        let cdn_base = cdn.base.clone();
        let api = lancer(move |r, _| {
            let base = r.header("host").map(|h| format!("http://{h}")).unwrap_or_default();
            match (r.method.as_str(), r.path.as_str()) {
                ("POST", "/fal-ai/kling/video") => Reponse::json(json!({"request_id": "req-1", "status": "IN_QUEUE",
                    "status_url": format!("{base}/fal-ai/kling/requests/req-1/status"),
                    "response_url": format!("{base}/fal-ai/kling/requests/req-1")})),
                (_, "/fal-ai/kling/requests/req-1/status") => Reponse::json(json!({"status": "COMPLETED"})),
                (_, "/fal-ai/kling/requests/req-1") => Reponse::json(json!({"video": {"url": format!("{cdn_base}/files/out.mp4")}})),
                _ => Reponse::status(404, "{}"),
            }
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config("fal", format!("{}/fal-ai/kling/video", api.base));
        cfg.kind = MediaKind::Video;
        cfg.auth_prefix = "Key ".into();
        cfg.body = r#"{"prompt": "{prompt}", "duration": "{duration}"}"#.into();
        let out = generate(&cfg, "une course", &vars(&[("duration", json!("5"))]), dir.path()).await.unwrap();
        assert_eq!(out.files[0].media_type, "video/mp4");
        assert!(out.files[0].path.starts_with(dir.path().join("videos")));
        assert_eq!(std::fs::read(&out.files[0].path).unwrap(), MP4);
        let reqs = api.requetes();
        assert_eq!(reqs.len(), 3, "{reqs:?}");
        assert!(reqs.iter().all(|r| r.header("authorization") == Some("Key cle-secrete")));
        assert_eq!(serde_json::from_str::<Value>(&reqs[0].body).unwrap(), json!({"prompt": "une course", "duration": "5"}));
        let telechargement = cdn.requetes();
        assert_eq!(telechargement.len(), 1);
        assert_eq!(telechargement[0].header("authorization"), None, "clé envoyée au CDN");
    }

    #[tokio::test]
    async fn openai_videos_style_job_is_followed_then_its_content_downloaded() {
        let api = lancer(|r, n| match (r.method.as_str(), r.path.as_str()) {
            ("POST", "/v1/videos") => Reponse::json(json!({"id": "video_1", "object": "video", "status": "queued"})),
            ("GET", "/v1/videos/video_1") if n < 3 => Reponse::json(json!({"id": "video_1", "status": "in_progress", "progress": 40})),
            ("GET", "/v1/videos/video_1") => Reponse::json(json!({"id": "video_1", "status": "completed"})),
            ("GET", "/v1/videos/video_1/content") => Reponse::bytes("video/mp4", MP4),
            _ => Reponse::status(404, "{}"),
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config("sora", format!("{}/v1/videos", api.base));
        cfg.kind = MediaKind::Video;
        cfg.model = "sora-2".into();
        let out = generate(&cfg, "un lever de soleil", &vars(&[("seconds", json!("4"))]), dir.path()).await.unwrap();
        assert_eq!(out.files[0].media_type, "video/mp4");
        let chemins: Vec<String> = api.requetes().iter().map(|r| format!("{} {}", r.method, r.path)).collect();
        assert_eq!(chemins.first().map(String::as_str), Some("POST /v1/videos"));
        assert_eq!(chemins.last().map(String::as_str), Some("GET /v1/videos/video_1/content"));
        assert!(chemins.iter().filter(|c| c.as_str() == "GET /v1/videos/video_1").count() >= 2, "{chemins:?}");
    }

    #[tokio::test]
    async fn failures_are_explained_without_leaking_the_key() {
        let api = lancer(|r, _| match r.path.as_str() {
            "/echec" => Reponse::json(json!({"id": "t1", "status": "failed", "error": {"message": "contenu refusé"}})),
            _ => Reponse::status(401, r#"{"detail":"bad key"}"#),
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let err = generate(&config("x", format!("{}/echec", api.base)), "p", &Map::new(), dir.path()).await.unwrap_err().to_string();
        assert!(err.contains("contenu refusé"), "{err}");
        let err = generate(&config("x", format!("{}/autre", api.base)), "p", &Map::new(), dir.path()).await.unwrap_err().to_string();
        assert!(err.contains("HTTP 401") && !err.contains("cle-secrete"), "{err}");
        let mut env_cfg = config("x", format!("{}/autre", api.base));
        env_cfg.api_key = "$AXECODE_TEST_CLE_INEXISTANTE".into();
        assert!(env_cfg.auth().is_none());
        assert_eq!(config("x", String::new()).public_view()["key"], "configurée");
    }
}
