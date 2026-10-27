//! axe:voix — dictée vocale (`voice.*`).
//!
//! L'IDE enregistre la voix (MediaRecorder, webm/opus) et l'envoie en base64.
//! Le service la confie au serveur whisper.cpp de sa machine (route
//! `/inference`), meilleur modèle d'abord : large-v3-turbo sur 127.0.0.1:8179
//! (unité `whisper-voix`), puis le serveur des notes vocales (small, 8178) en
//! secours. La transcription tourne en tâche de fond : `voice.transcribe` rend
//! un `jobId` et `voice.result` le résultat, ce qui évite la limite de 60 s
//! d'un appel RPC pour une longue dictée.
//!
//! - `voice.transcribe {audio, mime?, durationMs?, language?, prompt?, fast?, wait?}`
//!   -> `{jobId}` (ou le résultat directement avec `wait: true`)
//! - `voice.result {jobId}` -> `{status: "pending"|"done"|"error", ...}`
//! - `voice.cancel {jobId}` -> `{ok}`
//! - `voice.status {}` -> `{engines: [{url, label, ok, error?}]}`
//! - `voice.clean {text, provider, model, effort?, vocabulary?}` -> `{text}`
//!   (nettoyage par le modèle du chat, sans outil)
//!
//! Réglage : `AXE_VOIX_WHISPER="url|libellé;url|libellé"` (ordre = priorité).
//! Un compte SavIDE ne joint que les ports locaux permis par nftables
//! (table `inet axe_atelier`, ensemble `ports_permis`) : 8179/8178 doivent y être.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::Engine as _;
use serde_json::{json, Value};
use axecode_core::{Effort, ModelRef, SessionError, SessionResult};

use crate::daemon::Daemon;

const DEFAULT_ENGINES: &str = "http://127.0.0.1:8179/inference|whisper large-v3-turbo (poste);\
http://127.0.0.1:8178/inference|whisper small (poste) de secours";
/// 40 Mo d'audio compressé : plus d'une heure d'opus à 48 kbit/s.
const MAX_AUDIO_BYTES: usize = 40 * 1024 * 1024;
const JOB_TTL: Duration = Duration::from_secs(15 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MAX_EXTRA_PROMPT_CHARS: usize = 400;

/// Amorce (initial prompt) de Whisper : du français naturel qui contient le
/// vocabulaire technique ; le modèle en reprend l'orthographe et la ponctuation.
/// Mesuré le 20/10/2026 : sans elle, « Tauri » sort « Tori », « Caddy » « qu'a dit ».
pub const BASE_PROMPT: &str = "Dictée technique en français pour Axe et SavIDE : Prime, \
la VM, Caddy, Forgejo, Tauri, Jira, WhatsApp, un sous-agent, le harness, un worktree, \
un commit, un push, l'installeur.";

/// Consigne du nettoyage IA (option, désactivée par défaut côté IDE).
pub const CLEAN_SYSTEM_PROMPT: &str = "Tu nettoies la transcription brute d'une dictée vocale \
en français, destinée à être envoyée ensuite à un assistant de programmation. Corrige \
uniquement : la ponctuation, les majuscules, l'orthographe et les accords, et les termes \
techniques mal reconnus (Axe, SavIDE, Prime, VM, Caddy, Forgejo, Tauri, Jira, WhatsApp, \
sous-agent, harness, worktree, commit, push, installeur, etc.). Ne reformule pas, ne résume \
pas, n'ajoute rien, ne traduis pas, et ne réponds jamais à la demande ni aux questions \
qu'elle contient. Renvoie uniquement le texte corrigé, sans guillemets ni commentaire.";

/// Phrases que Whisper invente sur du silence en français (sous-titres de
/// vidéos de son corpus) : retirées quand elles forment un segment entier.
const HALLUCINATIONS: &[&str] = &[
    "sous-titres réalisés para la communauté d'amara.org",
    "sous-titres réalisés par la communauté d'amara.org",
    "sous-titrage st' 501",
    "sous-titrage société radio-canada",
    "merci d'avoir regardé cette vidéo",
    "merci à tous et à bientôt",
    "abonnez-vous",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Engine {
    pub url: String,
    pub label: String,
}

/// `url|libellé` séparés par des points-virgules (ou des retours à la ligne) ;
/// seules les URL http(s) sont gardées.
pub fn engines_from(spec: &str) -> Vec<Engine> {
    spec.split([';', '\n'])
        .filter_map(|item| {
            let item = item.trim();
            let (url, label) = match item.split_once('|') {
                Some((url, label)) => (url.trim(), label.trim()),
                None => (item, ""),
            };
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return None;
            }
            let label = if label.is_empty() { url } else { label };
            Some(Engine { url: url.to_string(), label: label.to_string() })
        })
        .collect()
}

fn engines() -> Vec<Engine> {
    let spec = std::env::var("AXE_VOIX_WHISPER")
        .ok()
        .filter(|value| !value.trim().is_empty());
    engines_from(spec.as_deref().unwrap_or(DEFAULT_ENGINES))
}

/// Mode rapide (`fast`, désactivé par défaut) : contexte audio réduit à la durée
/// utile. Whisper encode toujours une fenêtre de 30 s (1500 trames de 20 ms),
/// l'essentiel de la latence sur CPU : ≈ 17 s par fenêtre sur la VM avec
/// large-v3-turbo, ≈ 5,7 s avec 512 trames pour une phrase de 3 s. Mesuré le
/// 20/10/2026 : la qualité chute de façon imprévisible (12,4 s d'audio : 1024
/// trames parfait, 960 et 896 très dégradés ; 256 trames fait boucler le modèle),
/// d'où la fenêtre complète par défaut. Marge ×1,3 + 2 s, au moins 512 trames.
/// `None` = fenêtre complète.
pub fn audio_ctx_for(duration_ms: Option<u64>) -> Option<u32> {
    let ms = duration_ms.filter(|ms| *ms > 0)?;
    let frames = ms as f64 / 20.0;
    let ctx = (frames * 1.3 + 100.0).ceil() as u32;
    let ctx = ctx.div_ceil(64) * 64;
    let ctx = ctx.max(512);
    (ctx < 1400).then_some(ctx)
}

/// Sortie suspecte d'une fenêtre réduite : vide alors qu'on a parlé, débit
/// impossible (plus de 30 caractères par seconde) ou phrase répétée en boucle.
pub fn looks_degenerate(text: &str, duration_ms: u64) -> bool {
    let chars = text.chars().count() as u64;
    if chars == 0 {
        return duration_ms > 1500;
    }
    if chars > 40 + duration_ms * 30 / 1000 {
        return true;
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    for part in text.split(['.', '!', '?', '\n', '…']) {
        let key = part
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if key.chars().count() < 12 {
            continue;
        }
        let count = seen.entry(key).or_insert(0);
        *count += 1;
        if *count >= 3 {
            return true;
        }
    }
    false
}

fn normalized(text: &str) -> String {
    text.to_lowercase()
        .replace('\u{2019}', "'")
        .trim_matches(|c: char| matches!(c, '.' | ' ' | '!' | '\u{2026}'))
        .to_string()
}

/// Texte de whisper-server (un segment par ligne) -> un paragraphe propre.
pub fn tidy_transcript(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let line = normalized(line);
            !HALLUCINATIONS.iter().any(|h| normalized(h) == line)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Graphie canonique des noms propres du vocabulaire : Whisper écrit souvent
/// « AxeCode », « Axe Code », « Jira », « whatsapp ». Mots entiers, casse
/// ignorée ; « prime » (mot courant) et les mots en minuscules (« worktree », qui
/// peut ouvrir une phrase) ne sont pas touchés. Les termes ajoutés par
/// l'utilisateur suivent la même règle s'ils portent une majuscule ou un chiffre.
const CANONICAL_TERMS: &[&str] = &["SavIDE", "Jira", "WhatsApp", "Forgejo", "Tauri", "Caddy", "VM"];

pub fn canonical_terms(text: &str, extra: Option<&str>) -> String {
    let mut terms: Vec<String> = CANONICAL_TERMS.iter().map(|t| t.to_string()).collect();
    if let Some(extra) = extra {
        for term in extra.split([',', ';', '\n']).map(str::trim) {
            let simple = !term.is_empty() && term.chars().all(char::is_alphanumeric);
            let marked = term.chars().any(|c| c.is_uppercase() || c.is_ascii_digit());
            if simple && marked && term.chars().count() >= 2 {
                terms.push(term.to_string());
            }
        }
    }
    // Découpe en mots (alphanumériques) et séparateurs, en gardant tout.
    let mut tokens: Vec<(bool, String)> = Vec::new();
    for c in text.chars() {
        let word = c.is_alphanumeric();
        match tokens.last_mut() {
            Some((is_word, buf)) if *is_word == word => buf.push(c),
            _ => tokens.push((word, c.to_string())),
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < tokens.len() {
        let (is_word, token) = &tokens[i];
        if *is_word {
            // « Axe Code » -> « SavIDE »
            if token.eq_ignore_ascii_case("axe")
                && tokens.get(i + 1).is_some_and(|(w, sep)| !*w && sep == " ")
                && tokens.get(i + 2).is_some_and(|(w, next)| *w && next.eq_ignore_ascii_case("code"))
            {
                out.push_str("SavIDE");
                i += 3;
                continue;
            }
            let lower = token.to_lowercase();
            match terms.iter().find(|term| term.to_lowercase() == lower) {
                Some(term) => out.push_str(term),
                None => out.push_str(token),
            }
        } else {
            out.push_str(token);
        }
        i += 1;
    }
    out
}

pub fn build_prompt(extra: Option<&str>) -> String {
    let mut prompt = BASE_PROMPT.to_string();
    if let Some(extra) = extra.map(str::trim).filter(|extra| !extra.is_empty()) {
        let extra: String = extra
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_EXTRA_PROMPT_CHARS)
            .collect();
        prompt.push_str(" Autres termes : ");
        prompt.push_str(extra.trim());
        if !prompt.ends_with('.') {
            prompt.push('.');
        }
    }
    prompt
}

/// Type MIME réduit à des caractères sûrs (il part dans un en-tête multipart).
pub fn sanitize_mime(mime: &str) -> String {
    let clean: String = mime
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | ';' | '=' | '.' | '+' | '-'))
        .take(80)
        .collect();
    if clean.contains('/') {
        clean
    } else {
        "audio/webm".into()
    }
}

fn extension_for(mime: &str) -> &'static str {
    let mime = mime.to_ascii_lowercase();
    if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("mp4") || mime.contains("m4a") || mime.contains("aac") {
        "m4a"
    } else if mime.contains("wav") {
        "wav"
    } else if mime.contains("mpeg") || mime.contains("mp3") {
        "mp3"
    } else {
        "webm"
    }
}

/// Corps `multipart/form-data` (la dépendance reqwest du projet n'a pas la
/// fonction multipart) : champs texte puis le fichier audio.
pub fn multipart_body(boundary: &str, audio: &[u8], mime: &str, fields: &[(&str, String)]) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 1024);
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictee.{}\"\r\nContent-Type: {mime}\r\n\r\n",
            extension_for(mime)
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Séparateur multipart aléatoire.
pub fn new_boundary() -> String {
    format!("axevoix{}", uuid::Uuid::new_v4().simple())
}

fn truncate(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

fn http_error(err: &reqwest::Error) -> String {
    if err.is_connect() {
        "connexion refusée (service arrêté ou port non permis par nftables)".into()
    } else if err.is_timeout() {
        "délai dépassé".into()
    } else {
        truncate(&err.to_string(), 200)
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Requête de transcription.
#[derive(Clone, Debug)]
pub struct Dictation {
    pub audio: Vec<u8>,
    pub mime: String,
    pub duration_ms: Option<u64>,
    pub language: String,
    pub prompt: String,
    /// Fenêtre réduite (plus rapide, moins sûre) : voir [`audio_ctx_for`].
    pub fast: bool,
    /// Termes ajoutés par l'utilisateur (graphie canonique).
    pub extra_terms: Option<String>,
}

async fn whisper_once(
    client: &reqwest::Client,
    engine: &Engine,
    dictation: &Dictation,
    audio_ctx: Option<u32>,
) -> Result<String, String> {
    let boundary = new_boundary();
    let mut fields = vec![
        ("language", dictation.language.clone()),
        ("response_format", "json".to_string()),
        ("prompt", dictation.prompt.clone()),
        ("carry_initial_prompt", "true".to_string()),
    ];
    if let Some(ctx) = audio_ctx {
        fields.push(("audio_ctx", ctx.to_string()));
    }
    let body = multipart_body(&boundary, &dictation.audio, &dictation.mime, &fields);
    let response = client
        .post(&engine.url)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| http_error(&e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| http_error(&e))?;
    if !status.is_success() {
        return Err(format!("HTTP {status} : {}", truncate(&text, 200)));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("réponse illisible : {}", truncate(&text, 200)))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(truncate(error, 200));
    }
    Ok(canonical_terms(
        &tidy_transcript(value.get("text").and_then(Value::as_str).unwrap_or("")),
        dictation.extra_terms.as_deref(),
    ))
}

/// Essaie les moteurs dans l'ordre. Fenêtre complète par défaut ; en mode
/// rapide, fenêtre réduite puis fenêtre complète si la sortie est suspecte.
pub async fn transcribe_with(engines: &[Engine], dictation: &Dictation) -> Result<Value, String> {
    let client = http_client()?;
    let started = Instant::now();
    let mut failures: Vec<String> = Vec::new();
    for engine in engines {
        let ctx = if dictation.fast { audio_ctx_for(dictation.duration_ms) } else { None };
        let first = whisper_once(&client, engine, dictation, ctx).await;
        let outcome = match first {
            Ok(text) if ctx.is_some() && looks_degenerate(&text, dictation.duration_ms.unwrap_or(0)) => {
                tracing::info!(engine = %engine.label, "voice: reduced window looked degenerate, full window retry");
                whisper_once(&client, engine, dictation, None).await.map(|text| (text, None))
            }
            Ok(text) => Ok((text, ctx)),
            Err(err) => Err(err),
        };
        match outcome {
            Ok((text, used_ctx)) => {
                return Ok(json!({
                    "text": text,
                    "engine": "whisper",
                    "model": engine.label,
                    "url": engine.url,
                    "ms": started.elapsed().as_millis() as u64,
                    "audioCtx": used_ctx,
                    "fallbacks": failures,
                }));
            }
            Err(err) => {
                tracing::warn!(engine = %engine.label, error = %err, "voice: engine failed");
                failures.push(format!("{} : {err}", engine.label));
            }
        }
    }
    if engines.is_empty() {
        failures.push("aucun moteur configuré (AXE_VOIX_WHISPER)".into());
    }
    Err(format!("transcription impossible — {}", failures.join(" ; ")))
}

// ----- tâches de fond --------------------------------------------------------

enum JobState {
    Pending,
    Done(Value),
    Failed(String),
}

struct Job {
    state: JobState,
    at: Instant,
    abort: Option<tokio::task::AbortHandle>,
}

fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_jobs<T>(f: impl FnOnce(&mut HashMap<String, Job>) -> T) -> T {
    let mut map = jobs().lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, job| job.at.elapsed() < JOB_TTL);
    f(&mut map)
}

fn proto(message: impl Into<String>) -> SessionError {
    SessionError::Protocol(message.into())
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn dictation_from(params: &Value) -> SessionResult<Dictation> {
    let raw = str_param(params, "audio").ok_or_else(|| proto("audio manquant"))?;
    // Accepte aussi une URL `data:audio/webm;base64,...`.
    let raw = match raw.split_once(',') {
        Some((head, data)) if head.starts_with("data:") => data,
        _ => raw,
    };
    let audio = base64::engine::general_purpose::STANDARD
        .decode(raw.as_bytes())
        .map_err(|e| proto(format!("audio base64 invalide : {e}")))?;
    if audio.is_empty() {
        return Err(proto("audio vide"));
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(proto("enregistrement trop long (40 Mo au plus)"));
    }
    let language = str_param(params, "language")
        .filter(|l| l.len() <= 8 && l.chars().all(|c| c.is_ascii_alphabetic() || c == '-'))
        .unwrap_or("fr")
        .to_string();
    Ok(Dictation {
        audio,
        mime: sanitize_mime(str_param(params, "mime").unwrap_or("audio/webm")),
        duration_ms: params.get("durationMs").and_then(Value::as_u64),
        language,
        prompt: build_prompt(str_param(params, "prompt")),
        fast: params.get("fast").and_then(Value::as_bool).unwrap_or(false),
        extra_terms: str_param(params, "prompt").map(str::to_string),
    })
}

fn health_url(url: &str) -> String {
    let base = url.strip_suffix("/inference").unwrap_or(url).trim_end_matches('/');
    format!("{base}/health")
}

/// Nettoyage par le modèle du chat : refuse une sortie vide ou démesurée
/// (le modèle a répondu à la demande au lieu de la corriger).
pub fn accept_cleaned(original: &str, cleaned: &str) -> Option<String> {
    let cleaned = cleaned
        .trim()
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .trim_matches(|c| c == '"' || c == '«' || c == '»')
        .trim()
        .to_string();
    let limit = original.chars().count() * 3 / 2 + 60;
    (!cleaned.is_empty() && cleaned.chars().count() <= limit).then_some(cleaned)
}

pub(crate) async fn dispatch(daemon: &Daemon, method: &str, params: &Value) -> SessionResult<Value> {
    match method {
        "voice.transcribe" => {
            let dictation = dictation_from(params)?;
            if params.get("wait").and_then(Value::as_bool) == Some(true) {
                return transcribe_with(&engines(), &dictation)
                    .await
                    .map_err(SessionError::Runtime);
            }
            let id = uuid::Uuid::new_v4().to_string();
            with_jobs(|map| {
                map.insert(id.clone(), Job { state: JobState::Pending, at: Instant::now(), abort: None })
            });
            let job_id = id.clone();
            let task = tokio::spawn(async move {
                let state = match transcribe_with(&engines(), &dictation).await {
                    Ok(value) => JobState::Done(value),
                    Err(err) => JobState::Failed(err),
                };
                with_jobs(|map| {
                    if let Some(job) = map.get_mut(&job_id) {
                        job.state = state;
                        job.at = Instant::now();
                        job.abort = None;
                    }
                });
            });
            with_jobs(|map| {
                if let Some(job) = map.get_mut(&id) {
                    if matches!(job.state, JobState::Pending) {
                        job.abort = Some(task.abort_handle());
                    }
                }
            });
            Ok(json!({"jobId": id}))
        }
        "voice.result" => {
            let id = str_param(params, "jobId").ok_or_else(|| proto("jobId manquant"))?;
            with_jobs(|map| match map.get(id) {
                None => Err(SessionError::NotFound(id.to_string())),
                Some(job) => Ok(match &job.state {
                    JobState::Pending => json!({"status": "pending"}),
                    JobState::Done(value) => {
                        let mut value = value.clone();
                        value["status"] = json!("done");
                        value
                    }
                    JobState::Failed(err) => json!({"status": "error", "error": err}),
                }),
            })
        }
        "voice.cancel" => {
            let id = str_param(params, "jobId").ok_or_else(|| proto("jobId manquant"))?;
            let removed = with_jobs(|map| map.remove(id));
            if let Some(abort) = removed.as_ref().and_then(|job| job.abort.as_ref()) {
                abort.abort();
            }
            Ok(json!({"ok": removed.is_some()}))
        }
        "voice.status" => {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(4))
                .build()
                .map_err(|e| SessionError::Runtime(e.to_string()))?;
            let mut out = Vec::new();
            for engine in engines() {
                let (ok, error) = match client.get(health_url(&engine.url)).send().await {
                    Ok(response) if response.status().is_success() => (true, None),
                    Ok(response) => (false, Some(format!("HTTP {}", response.status()))),
                    Err(err) => (false, Some(http_error(&err))),
                };
                out.push(json!({"url": engine.url, "label": engine.label, "ok": ok, "error": error}));
            }
            Ok(json!({"engines": out, "prompt": BASE_PROMPT}))
        }
        "voice.clean" => {
            let text = str_param(params, "text").ok_or_else(|| proto("texte manquant"))?;
            let provider = str_param(params, "provider").ok_or_else(|| proto("provider manquant"))?;
            let name = str_param(params, "model").ok_or_else(|| proto("model manquant"))?;
            let mut model = ModelRef::new(provider, name);
            model.effort = params
                .get("effort")
                .and_then(|value| serde_json::from_value::<Effort>(value.clone()).ok());
            let mut system = CLEAN_SYSTEM_PROMPT.to_string();
            if let Some(extra) = str_param(params, "vocabulary") {
                let extra: String = extra.chars().filter(|c| !c.is_control()).take(MAX_EXTRA_PROMPT_CHARS).collect();
                system.push_str(" Autres termes à respecter : ");
                system.push_str(&extra);
                system.push('.');
            }
            let cleaned = daemon.factory.complete_text(model, system, text.to_string()).await?;
            accept_cleaned(text, &cleaned)
                .map(|text| json!({"text": text}))
                .ok_or_else(|| SessionError::Runtime("nettoyage rejeté (réponse vide ou hors sujet)".into()))
        }
        other => Err(proto(format!("unknown method {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines_parse_order_labels_and_reject_non_http() {
        let list = engines_from("http://a:1/inference|turbo, très bien; ftp://x|bad ;http://b:2/inference");
        assert_eq!(
            list,
            vec![
                Engine { url: "http://a:1/inference".into(), label: "turbo, très bien".into() },
                Engine { url: "http://b:2/inference".into(), label: "http://b:2/inference".into() },
            ]
        );
        let defaults = engines_from(DEFAULT_ENGINES);
        assert_eq!(defaults.len(), 2);
        assert_eq!(defaults[1].label, "whisper small (poste) de secours");
    }

    #[test]
    fn audio_ctx_keeps_a_safe_margin_and_full_window_for_long_audio() {
        assert_eq!(audio_ctx_for(None), None);
        assert_eq!(audio_ctx_for(Some(0)), None);
        // 3 s -> plancher de 512 trames (≈ 10 s), jamais 256 (boucle mesurée).
        assert_eq!(audio_ctx_for(Some(3_000)), Some(512));
        // 12,4 s -> 620 trames × 1,3 + 100 = 906 -> 960.
        assert_eq!(audio_ctx_for(Some(12_400)), Some(960));
        // au-delà de ≈ 20 s, fenêtre complète.
        assert_eq!(audio_ctx_for(Some(25_000)), None);
        assert_eq!(audio_ctx_for(Some(120_000)), None);
    }

    #[test]
    fn degenerate_output_is_detected() {
        let ok = "Fais un commit sur la branche et relance l'installeur.";
        assert!(!looks_degenerate(ok, 3_100));
        let boucle = ok.repeat(12);
        assert!(looks_degenerate(&boucle, 3_100));
        let repete = "Bonjour à tous. Bonjour à tous. Bonjour à tous.";
        assert!(looks_degenerate(repete, 60_000));
        assert!(looks_degenerate("", 4_000));
        assert!(!looks_degenerate("", 800));
    }

    #[test]
    fn transcript_is_joined_and_silence_hallucinations_dropped() {
        let raw = " Alors, pour la suite.\n Si le dépôt est à jour, crée un worktree.\n Sous-titres réalisés para la communauté d'Amara.org\n";
        assert_eq!(
            tidy_transcript(raw),
            "Alors, pour la suite. Si le dépôt est à jour, crée un worktree."
        );
        assert_eq!(tidy_transcript(" Merci d'avoir regardé cette vidéo !\n"), "");
    }

    #[test]
    fn prompt_mime_and_multipart_are_safe() {
        assert!(build_prompt(None).contains("worktree"));
        let p = build_prompt(Some("Kubernetes, Grafana\n"));
        assert!(p.ends_with("Autres termes : Kubernetes, Grafana."));
        assert_eq!(sanitize_mime("audio/webm;codecs=opus"), "audio/webm;codecs=opus");
        assert_eq!(sanitize_mime("audio/webm\r\nX-Evil: 1"), "audio/webmX-Evil1");
        assert_eq!(sanitize_mime("rien"), "audio/webm");
        let body = multipart_body("B", b"OPUS", "audio/ogg", &[("language", "fr".into())]);
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--B\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nfr\r\n"));
        assert!(text.contains("filename=\"dictee.ogg\"\r\nContent-Type: audio/ogg\r\n\r\nOPUS\r\n--B--\r\n"));
        assert_eq!(health_url("http://127.0.0.1:8179/inference"), "http://127.0.0.1:8179/health");
    }

    #[test]
    fn vocabulary_spelling_is_canonical() {
        assert_eq!(
            canonical_terms("les tickets Jira et whatsapp d'Axe dans AxeCode, puis Axe Code sur la vm", None),
            "les tickets Jira et WhatsApp d'Axe dans SavIDE, puis SavIDE sur la VM"
        );
        // « prime » (mot courant), « worktree » en début de phrase et « axe » seul : intacts.
        assert_eq!(canonical_terms("Worktree, prime, un axe.", None), "Worktree, prime, un axe.");
        assert_eq!(
            canonical_terms("ouvre grafana et la base dupont", Some("Grafana, dupont, K8s")),
            "ouvre Grafana et la base dupont"
        );
    }

    #[test]
    fn cleaned_text_is_bounded() {
        assert_eq!(accept_cleaned("fais un commit", "« Fais un commit. »").as_deref(), Some("Fais un commit."));
        assert_eq!(accept_cleaned("fais un commit", "   "), None);
        let bavard = "Voici le texte corrigé : ".repeat(10);
        assert_eq!(accept_cleaned("fais un commit", &bavard), None);
    }

    #[test]
    fn dictation_params_are_validated() {
        let ok = dictation_from(&json!({"audio": "data:audio/webm;base64,T1BVUw==", "durationMs": 1200, "language": "fr"})).unwrap();
        assert_eq!(ok.audio, b"OPUS");
        assert_eq!(ok.mime, "audio/webm");
        assert_eq!(ok.duration_ms, Some(1200));
        assert!(!ok.fast);
        assert!(dictation_from(&json!({"audio": "!!"})).is_err());
        assert!(dictation_from(&json!({})).is_err());
        let lang = dictation_from(&json!({"audio": "T1BVUw==", "language": "fr; rm -rf"})).unwrap();
        assert_eq!(lang.language, "fr");
    }
}
