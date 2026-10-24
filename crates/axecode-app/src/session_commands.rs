//! Chantier F — session commands served as a REPL [`TurnHook`]:
//! `/goal` (+ `goal.*`), `/autonomous` (bounded continuation with an
//! optional gate command), `/heartbeat` (+ `heartbeat.*`), `/refine`
//! (+ `refine.run` / `refine.status`) and `/compact` forwarding.
//!
//! State is kept per session in `<data_dir>/session_state/<id>.json` and every
//! change is also journaled as an `Extension` entry (`goal`, `autonomous`,
//! `heartbeat`), so `/tree` and the IDE see it.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use axecode_core::{
    ChatMessage, JournalEntry, JournalEntryKind, RuntimeContext, SessionHost, SessionMeta,
    SessionStatus, TurnInput, TurnOutcome, TurnRequest,
};
use axecode_harness::{refine, HarnessStore};

use crate::repl::{ProviderResolver, TurnHook};

/// Gate output kept for the model (bytes).
pub const GATE_OUTPUT_MAX: usize = 4_096;
pub const MIN_HEARTBEAT_MS: u64 = 5_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Goal {
    pub text: String,
    /// `active`, `paused`, `complete`
    pub status: String,
    #[serde(default)]
    pub progress: Vec<String>,
    #[serde(default)]
    pub budget_tokens: Option<u64>,
    #[serde(default)]
    pub used_tokens: u64,
    #[serde(default)]
    pub summary: Option<String>,
    pub created_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Autonomous {
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub gate: Option<String>,
    pub started_ms: i64,
    #[serde(default)]
    pub turns: u32,
    #[serde(default)]
    pub tokens: u64,
    /// `running`, `done`, `limit_reached`, `stopped`
    pub status: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub last_gate_hash: Option<String>,
    #[serde(default)]
    pub last_gate_output: Option<String>,
    #[serde(default)]
    pub last_gate_passed: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Heartbeat {
    pub interval_ms: u64,
    pub message: String,
    /// Next slot of the fixed wall-clock grid (`set time + k × interval`).
    pub next_at_ms: i64,
    /// Last delivered wake-up (shown in the IDE indicator).
    #[serde(default)]
    pub last_at_ms: Option<i64>,
    /// Slots reached but not delivered yet (turn running, PC asleep).
    #[serde(default)]
    pub pending: u32,
}

/// One tick of the heartbeat clock (pure, tested). Slots follow a fixed grid
/// (`next = previous slot + interval`, never « last message + interval »); a slot
/// reached while the session is busy waits and is delivered as soon as it is idle;
/// several slots missed (long turn, sleep of the PC) give ONE wake-up. Returns the
/// number of slots covered by the wake-up to deliver now (`None` = nothing).
pub fn heartbeat_tick(hb: &mut Heartbeat, now: i64, busy: bool) -> Option<u32> {
    let interval = hb.interval_ms.max(1) as i64;
    if now >= hb.next_at_ms {
        let slots = (now - hb.next_at_ms) / interval + 1;
        hb.pending = hb.pending.saturating_add(slots.min(u32::MAX as i64) as u32);
        hb.next_at_ms += slots * interval;
    }
    // Never two wake-ups in a row: at least half an interval between deliveries.
    let too_soon = hb.last_at_ms.is_some_and(|last| now - last < interval / 2);
    if hb.pending > 0 && !busy && !too_soon {
        let n = hb.pending;
        hb.pending = 0;
        hb.last_at_ms = Some(now);
        return Some(n);
    }
    None
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionState {
    #[serde(default)]
    pub goal: Option<Goal>,
    #[serde(default)]
    pub autonomous: Option<Autonomous>,
    #[serde(default)]
    pub heartbeat: Option<Heartbeat>,
    /// One-shot notices for the next reminder (slash command results, ...).
    #[serde(default)]
    pub notices: Vec<String>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parsed `/command args` typed in the composer.
#[derive(Debug, Clone, PartialEq)]
pub struct SlashCommand {
    pub name: String,
    pub args: Vec<String>,
    pub rest: String,
}

/// Shell-like split honouring double quotes.
pub fn split_args(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

pub fn parse_slash(text: &str) -> Option<SlashCommand> {
    let text = text.trim();
    let body = text.strip_prefix('/')?;
    let (name, rest) = body.split_once(char::is_whitespace).unwrap_or((body, ""));
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(SlashCommand {
        name: name.to_ascii_lowercase(),
        args: split_args(rest),
        rest: rest.trim().to_string(),
    })
}

/// `--flag value` lookup; returns remaining positional words.
fn take_flags(args: &[String], flags: &[&str]) -> (HashMap<String, String>, Vec<String>) {
    let mut map = HashMap::new();
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(key) = a.strip_prefix("--").filter(|k| flags.contains(k)) {
            if let Some(v) = args.get(i + 1) {
                map.insert(key.to_string(), v.clone());
                i += 2;
                continue;
            }
        }
        rest.push(a.clone());
        i += 1;
    }
    (map, rest)
}

/// `30s`, `2m`, `1h`, `90` (seconds) → milliseconds.
pub fn parse_interval(value: &str) -> Option<u64> {
    let v = value.trim().to_ascii_lowercase();
    let split = v.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(v.len());
    let (num, unit) = v.split_at(split);
    let n: f64 = num.parse().ok()?;
    let mult = match unit.trim() {
        "" | "s" | "sec" => 1_000.0,
        "ms" => 1.0,
        "m" | "min" => 60_000.0,
        "h" | "hr" => 3_600_000.0,
        _ => return None,
    };
    Some((n * mult) as u64)
}

fn truncate_bytes(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…[truncated, {} bytes total]", &text[..cut], text.len())
}

/// Hash of the modified files of the workspace (`git status` + contents);
/// `None` outside a git repository.
pub fn workspace_change_hash(root: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=all"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let listing = String::from_utf8_lossy(&out.stdout).to_string();
    let mut hasher = Sha256::new();
    hasher.update(listing.as_bytes());
    for line in listing.lines() {
        let path = line.get(3..).unwrap_or("").rsplit(" -> ").next().unwrap_or("").trim_matches('"');
        if let Ok(bytes) = std::fs::read(root.join(path)) {
            hasher.update(path.as_bytes());
            hasher.update(&bytes);
        }
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Run the gate command in the workspace; `(passed, output ≤ 4 KB)`.
pub async fn run_gate(root: &Path, command: &str) -> (bool, String) {
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("pwsh");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(root).kill_on_drop(true);
    match tokio::time::timeout(Duration::from_secs(900), cmd.output()).await {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                text.push_str("\n[stderr]\n");
                text.push_str(&err);
            }
            let code = out.status.code().map_or("signal".into(), |c| c.to_string());
            let text = format!("$ {command}\n[exit {code}]\n{}", text.trim());
            (out.status.success(), truncate_bytes(&text, GATE_OUTPUT_MAX))
        }
        Ok(Err(e)) => (false, format!("$ {command}\nunable to start the gate: {e}")),
        Err(_) => (false, format!("$ {command}\ngate timed out after 15 minutes")),
    }
}

/// Linear chat history rebuilt from journal `Message` entries (planner input).
pub fn history_from_journal(entries: &[JournalEntry]) -> Vec<ChatMessage> {
    entries
        .iter()
        .filter_map(|e| match &e.kind {
            JournalEntryKind::Message { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// The F hook. One instance is shared by every REPL runtime of the process.
pub struct SessionCommandsHook {
    providers: Arc<dyn ProviderResolver>,
    inner: Arc<Inner>,
}

struct Inner {
    data_dir: Mutex<Option<PathBuf>>,
    hosts: Mutex<HashMap<String, Arc<dyn SessionHost>>>,
    states: Mutex<HashMap<String, SessionState>>,
    heartbeats: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    refine: refine::RefineRunner,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Inner {
    fn state_path(&self, id: &str) -> Option<PathBuf> {
        lock(&self.data_dir).as_ref().map(|d| d.join("session_state").join(format!("{id}.json")))
    }

    /// The state file is the source of truth: the IDE changes it too (« Arrêter le
    /// heartbeat », « Mettre le goal en pause » : `sessions.commands_set` du démon),
    /// so it is re-read every time; the memory copy only serves without data dir.
    fn load(&self, id: &str) -> SessionState {
        if let Some(path) = self.state_path(id) {
            if let Some(state) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<SessionState>(&t).ok())
            {
                lock(&self.states).insert(id.to_string(), state.clone());
                return state;
            }
        }
        if let Some(s) = lock(&self.states).get(id) {
            return s.clone();
        }
        SessionState::default()
    }

    fn save(&self, id: &str, state: SessionState) {
        if let Some(path) = self.state_path(id) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(bytes) = serde_json::to_vec_pretty(&state) {
                let _ = std::fs::write(path, bytes);
            }
        }
        lock(&self.states).insert(id.to_string(), state);
    }

    fn update<R>(&self, id: &str, f: impl FnOnce(&mut SessionState) -> R) -> R {
        let mut state = self.load(id);
        let out = f(&mut state);
        self.save(id, state);
        out
    }

    fn host(&self, id: &str) -> Option<Arc<dyn SessionHost>> {
        lock(&self.hosts).get(id).cloned()
    }

    async fn journal(&self, id: &str, name: &str, payload: Value) {
        if let Some(host) = self.host(id) {
            let _ = host
                .record(id, JournalEntryKind::Extension { name: name.into(), payload })
                .await;
        }
    }

    fn journal_entries(&self, id: &str) -> Vec<JournalEntry> {
        let Some(dir) = lock(&self.data_dir).clone() else { return Vec::new() };
        std::fs::read_to_string(dir.join("sessions").join(format!("{id}.jsonl")))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// (Re)start the heartbeat timer of a session.
    fn arm_heartbeat(self: &Arc<Self>, id: &str) {
        if let Some(old) = lock(&self.heartbeats).remove(id) {
            old.abort();
        }
        if self.load(id).heartbeat.is_none() {
            return;
        }
        let me = self.clone();
        let sid = id.to_string();
        let handle = tokio::spawn(async move {
            loop {
                let Some(hb) = me.load(&sid).heartbeat else { return };
                let host = me.host(&sid);
                // No host yet / turn running: the slot waits (delivered at the end of the turn).
                let busy = match &host {
                    Some(h) => h.get_session(&sid).await.map_or(true, |m| m.status == SessionStatus::Running),
                    None => true,
                };
                let now = now_ms();
                let mut next = hb.clone();
                let fire = heartbeat_tick(&mut next, now, busy);
                if next.next_at_ms != hb.next_at_ms || next.pending != hb.pending || fire.is_some() {
                    me.update(&sid, |s| {
                        if let Some(h) = s.heartbeat.as_mut().filter(|h| h.message == hb.message && h.interval_ms == hb.interval_ms) {
                            *h = next.clone();
                        }
                    });
                }
                if let (Some(n), Some(host)) = (fire, host.as_ref()) {
                    let _ = host
                        .send_user_message(&sid, heartbeat_text_missed(&hb.message, now, n.saturating_sub(1)))
                        .await;
                }
                // Short waits on the WALL clock: a monotonic sleep does not count the
                // PC's sleep (Windows), which delayed a 5 min heartbeat by hours.
                let wait = if next.pending > 0 { 1_000 } else { (next.next_at_ms - now_ms()).clamp(250, 5_000) };
                tokio::time::sleep(Duration::from_millis(wait as u64)).await;
            }
        });
        lock(&self.heartbeats).insert(id.to_string(), handle);
    }
}

impl SessionCommandsHook {
    pub fn new(providers: Arc<dyn ProviderResolver>) -> Arc<Self> {
        Arc::new(Self {
            providers,
            inner: Arc::new(Inner {
                data_dir: Mutex::new(None),
                hosts: Mutex::new(HashMap::new()),
                states: Mutex::new(HashMap::new()),
                heartbeats: Mutex::new(HashMap::new()),
                refine: refine::RefineRunner::new(),
            }),
        })
    }

    pub fn state(&self, session_id: &str) -> SessionState {
        self.inner.load(session_id)
    }

    /// Execute a slash command typed by the user; returns a notice for the model.
    pub async fn run_slash(&self, session: &SessionMeta, cmd: &SlashCommand) -> Option<String> {
        let id = session.id.as_str();
        let inner = &self.inner;
        Some(match cmd.name.as_str() {
            "goal" => {
                let (flags, words) = take_flags(&cmd.args, &["budget"]);
                let text = words.join(" ");
                match text.as_str() {
                    "" => return Some(goal_reminder(&inner.load(id)).unwrap_or_else(|| "No goal is set.".into())),
                    "clear" | "off" | "stop" => { self.goal_call(session, "goal.clear", json!({})).await.ok(); "The user cleared the goal.".into() }
                    "pause" => { self.goal_call(session, "goal.pause", json!({})).await.ok(); "The user paused the goal.".into() }
                    "resume" => { self.goal_call(session, "goal.resume", json!({})).await.ok(); "The user resumed the goal.".into() }
                    "done" | "complete" | "fini" | "terminé" => {
                        self.goal_call(session, "goal.complete", json!({"summary": "marqué atteint par l'utilisateur (/goal done)"})).await.ok();
                        "The user marked the goal as reached (/goal done). Do not keep working on it.".into()
                    }
                    _ => {
                        let budget = flags.get("budget").and_then(|b| b.replace(['_', ' '], "").parse::<u64>().ok());
                        let _ = self.goal_call(session, "goal.set", json!({"text": text, "budget_tokens": budget})).await;
                        format!("The user set a persistent session goal: {text}. Work towards it; record progress with `goal.progress(note)` and call `goal.complete(summary)` only when it is fully reached.")
                    }
                }
            }
            "autonomous" => {
                let (flags, words) = take_flags(&cmd.args, &["max-turns", "max-tokens", "timeout-ms", "gate"]);
                if words.first().is_some_and(|w| w == "stop" || w == "off") {
                    inner.update(id, |s| if let Some(a) = s.autonomous.as_mut() { a.status = "stopped".into(); });
                    inner.journal(id, "autonomous", json!({"status": "stopped"})).await;
                    return Some("The user stopped autonomous mode.".into());
                }
                let auto = Autonomous {
                    max_turns: flags.get("max-turns").and_then(|v| v.parse().ok()),
                    max_tokens: flags.get("max-tokens").and_then(|v| v.parse().ok()),
                    timeout_ms: flags.get("timeout-ms").and_then(|v| v.parse().ok()),
                    gate: flags.get("gate").cloned(),
                    started_ms: now_ms(),
                    status: "running".into(),
                    ..Default::default()
                };
                inner.journal(id, "autonomous", serde_json::to_value(&auto).unwrap_or_default()).await;
                let desc = describe_autonomous(&auto);
                inner.update(id, |s| s.autonomous = Some(auto));
                let task = words.join(" ");
                format!(
                    "Autonomous mode is ON ({desc}). Keep working without waiting for the user. {}Call `goal.complete(summary)` when the work is done{}.{}",
                    if task.is_empty() { String::new() } else { format!("Task: {task}. ") },
                    "; a gate command, if any, is then run and must pass",
                    ""
                )
            }
            "heartbeat" => {
                let first = cmd.args.first().cloned().unwrap_or_default();
                if first.is_empty() || matches!(first.as_str(), "clear" | "off" | "stop") {
                    let _ = self.heartbeat_call(session, "heartbeat.clear", json!({})).await;
                    return Some("The user cleared the heartbeat.".into());
                }
                let message = cmd.args[1..].join(" ");
                match parse_interval(&first) {
                    Some(ms) if !message.trim().is_empty() => {
                        let _ = self.heartbeat_call(session, "heartbeat.set", json!({"interval_ms": ms, "message": message})).await;
                        format!("The user installed a heartbeat every {first}: «{message}». It will reach you as a <heartbeat> message.")
                    }
                    _ => "Invalid /heartbeat usage. Expected `/heartbeat <interval> <message>` (e.g. `/heartbeat 10m check CI`).".into(),
                }
            }
            "refine" => {
                let focus = (!cmd.rest.is_empty()).then(|| cmd.rest.clone());
                match self.start_refine(session, "user:/refine", focus).await {
                    Ok(true) => "The user asked for a harness refinement; it runs in the background and is applied as soon as it is ready (see `refine.status()`). Continue normally.".into(),
                    Ok(false) => "A harness refinement is already planning for this session.".into(),
                    Err(e) => format!("/refine could not start: {e}"),
                }
            }
            "compact" => {
                let directive = if cmd.rest.is_empty() { "None".to_string() } else { serde_json::to_string(&cmd.rest).unwrap_or_default() };
                format!("The user asked to compact the conversation. Call `compact.run(directive={directive})` right now, then continue.")
            }
            _ => return None,
        })
    }

    async fn start_refine(&self, session: &SessionMeta, trigger: &str, focus: Option<String>) -> Result<bool, String> {
        let provider = self.providers.provider(&session.model.provider)?;
        let history = history_from_journal(&self.inner.journal_entries(&session.id));
        Ok(self.inner.refine.start(
            provider,
            session.model.clone(),
            HarnessStore::open(&session.workspace_id),
            session.id.clone(),
            history,
            trigger.to_string(),
            focus,
        ))
    }

    async fn goal_call(&self, session: &SessionMeta, method: &str, params: Value) -> Result<Value, String> {
        let id = session.id.as_str();
        let inner = &self.inner;
        let s = |k: &str| params.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
        let result = inner.update(id, |state| -> Result<Value, String> {
            match method {
                "goal.get" => {}
                "goal.set" => {
                    let text = s("text").ok_or("goal.set: text is required")?;
                    state.goal = Some(Goal {
                        text,
                        status: "active".into(),
                        budget_tokens: params.get("budget_tokens").and_then(Value::as_u64),
                        created_ms: now_ms(),
                        ..Default::default()
                    });
                }
                "goal.clear" => state.goal = None,
                _ => {
                    let goal = state.goal.as_mut().ok_or("no goal is set")?;
                    match method {
                        "goal.progress" => goal.progress.push(s("note").ok_or("goal.progress: note is required")?),
                        "goal.complete" => {
                            goal.status = "complete".into();
                            goal.summary = s("summary");
                        }
                        "goal.pause" => {
                            goal.status = "paused".into();
                            if let Some(r) = s("reason") { goal.progress.push(format!("paused: {r}")); }
                        }
                        "goal.resume" => goal.status = "active".into(),
                        other => return Err(format!("unknown goal call `{other}`")),
                    }
                }
            }
            Ok(serde_json::to_value(&state.goal).unwrap_or(Value::Null))
        })?;
        if method != "goal.get" {
            inner.journal(id, "goal", json!({"op": method.trim_start_matches("goal."), "goal": result})).await;
        }
        Ok(result)
    }

    async fn heartbeat_call(&self, session: &SessionMeta, method: &str, params: Value) -> Result<Value, String> {
        let id = session.id.as_str();
        let inner = &self.inner;
        let result = match method {
            "heartbeat.get" => serde_json::to_value(inner.load(id).heartbeat).unwrap_or(Value::Null),
            "heartbeat.clear" => {
                inner.update(id, |s| s.heartbeat = None);
                json!({"cleared": true})
            }
            "heartbeat.set" => {
                let interval_ms = params.get("interval_ms").and_then(Value::as_u64).ok_or("heartbeat.set: interval_ms is required")?;
                if interval_ms < MIN_HEARTBEAT_MS {
                    return Err(format!("heartbeat interval must be at least {}s", MIN_HEARTBEAT_MS / 1000));
                }
                let message = params.get("message").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if message.is_empty() {
                    return Err("heartbeat.set: message is required".into());
                }
                // Same heartbeat set again (agents often re-run `heartbeat.set`): keep its
                // grid, otherwise every call pushed the next wake-up back.
                let hb = inner.update(id, |s| {
                    match s.heartbeat.as_ref().filter(|h| h.interval_ms == interval_ms && h.message == message) {
                        Some(existing) => existing.clone(),
                        None => {
                            let hb = Heartbeat { interval_ms, message, next_at_ms: now_ms() + interval_ms as i64, ..Default::default() };
                            s.heartbeat = Some(hb.clone());
                            hb
                        }
                    }
                });
                serde_json::to_value(hb).unwrap_or(Value::Null)
            }
            other => return Err(format!("unknown heartbeat call `{other}`")),
        };
        if method != "heartbeat.get" {
            inner.journal(id, "heartbeat", json!({"op": method.trim_start_matches("heartbeat."), "heartbeat": result})).await;
            inner.arm_heartbeat(id);
        }
        Ok(result)
    }
}

/// Message injected by a heartbeat (shown in the IDE as « réveil : … » with its time).
pub fn heartbeat_text(message: &str, at_ms: i64) -> String {
    heartbeat_text_missed(message, at_ms, 0)
}

/// Same, with the number of wake-ups merged into this one (turn running, PC asleep).
pub fn heartbeat_text_missed(message: &str, at_ms: i64, missed: u32) -> String {
    if missed == 0 {
        return format!("<heartbeat at_ms=\"{at_ms}\">\n{message}\n</heartbeat>");
    }
    let s = if missed > 1 { "s" } else { "" };
    format!("<heartbeat at_ms=\"{at_ms}\" missed=\"{missed}\">\n{message}\n({missed} réveil{s} manqué{s})\n</heartbeat>")
}

/// Inverse of [`heartbeat_text`]: `(message, at_ms)` of an injected heartbeat
/// (also accepts the bare `<heartbeat>` form of `TurnInput::Heartbeat`).
pub fn parse_heartbeat_text(text: &str) -> Option<(String, Option<i64>)> {
    let rest = text.trim().strip_prefix("<heartbeat")?;
    let (attrs, body) = rest.split_once('>')?;
    let body = body.strip_suffix("</heartbeat>")?;
    let at_ms = attrs
        .split("at_ms=\"")
        .nth(1)
        .and_then(|v| v.split('"').next())
        .and_then(|v| v.parse().ok());
    Some((body.trim().to_string(), at_ms))
}

/// Commands served by [`SessionCommandsHook::run_slash`] (the IDE checks its
/// autocompletion list against it).
pub const SLASH_COMMANDS: &[&str] = &["goal", "autonomous", "heartbeat", "refine", "compact"];

fn describe_autonomous(a: &Autonomous) -> String {
    let mut parts = Vec::new();
    if let Some(v) = a.max_turns { parts.push(format!("max {v} turns")); }
    if let Some(v) = a.max_tokens { parts.push(format!("max {v} tokens")); }
    if let Some(v) = a.timeout_ms { parts.push(format!("timeout {}s", v / 1000)); }
    if let Some(g) = &a.gate { parts.push(format!("gate `{g}`")); }
    if parts.is_empty() { "no explicit limit".into() } else { parts.join(", ") }
}

fn goal_reminder(state: &SessionState) -> Option<String> {
    let goal = state.goal.as_ref()?;
    let mut out = format!("## Session goal ({})\n{}\n", goal.status, goal.text);
    if let Some(b) = goal.budget_tokens {
        out.push_str(&format!("Token budget: {} / {b} used.\n", goal.used_tokens));
    }
    if !goal.progress.is_empty() {
        out.push_str("Progress:\n");
        for p in goal.progress.iter().rev().take(8).rev() {
            out.push_str(&format!("- {p}\n"));
        }
    }
    if let Some(s) = &goal.summary {
        out.push_str(&format!("Completion summary: {s}\n"));
    }
    Some(out.trim_end().to_string())
}

fn user_text(request: &TurnRequest) -> Option<String> {
    match &request.input {
        TurnInput::User { message } => Some(message.text()),
        _ => None,
    }
}

impl SessionCommandsHook {
    /// Evaluate `/autonomous` after a turn: budgets, completion gate.
    async fn autonomous_step(&self, session: &SessionMeta, outcome: &TurnOutcome) -> bool {
        let id = session.id.as_str();
        let inner = &self.inner;
        let used = (outcome.usage.input_tokens + outcome.usage.output_tokens) as u64;
        let state = inner.update(id, |s| {
            if let Some(g) = s.goal.as_mut() {
                g.used_tokens += used;
            }
            if let Some(a) = s.autonomous.as_mut().filter(|a| a.status == "running") {
                a.turns += 1;
                a.tokens += used;
            }
            s.clone()
        });
        // Goal budget exhausted → pause (reported, not a success).
        if let Some(g) = state.goal.as_ref().filter(|g| g.status == "active") {
            if g.budget_tokens.is_some_and(|b| g.used_tokens >= b) {
                let _ = self.goal_call(session, "goal.pause", json!({"reason": "token budget reached"})).await;
                self.stop_autonomous(id, "limit_reached", "goal token budget reached — limite atteinte, pas un succès").await;
                return false;
            }
        }
        let Some(auto) = state.autonomous.clone().filter(|a| a.status == "running") else {
            return false;
        };
        let goal_done = state.goal.as_ref().is_some_and(|g| g.status == "complete");
        if goal_done {
            let Some(gate) = auto.gate.clone() else {
                self.stop_autonomous(id, "done", "goal completed").await;
                return false;
            };
            let root = PathBuf::from(&session.workspace_id);
            let hash = workspace_change_hash(&root);
            let unchanged = hash.is_some() && hash == auto.last_gate_hash && auto.last_gate_passed == Some(false);
            let (passed, output) = if unchanged {
                (false, format!("Gate not re-run: the workspace did not change since the last failure.\n{}", auto.last_gate_output.clone().unwrap_or_default()))
            } else {
                run_gate(&root, &gate).await
            };
            inner.update(id, |s| {
                if let Some(a) = s.autonomous.as_mut() {
                    a.last_gate_hash = hash.clone();
                    a.last_gate_output = Some(output.clone());
                    a.last_gate_passed = Some(passed);
                }
            });
            inner.journal(id, "autonomous", json!({"gate": gate, "passed": passed, "output": output})).await;
            if passed {
                self.stop_autonomous(id, "done", "goal completed and gate passed").await;
                return false;
            }
            // Re-open the goal and hand the failure back to the model.
            inner.update(id, |s| {
                if let Some(g) = s.goal.as_mut() {
                    g.status = "active".into();
                }
                s.notices.push(format!("The completion gate failed, the goal was re-opened. Fix the problem, then call `goal.complete()` again.\n```\n{output}\n```"));
            });
        }
        let elapsed = (now_ms() - auto.started_ms).max(0) as u64;
        let limit = if auto.max_turns.is_some_and(|m| auto.turns + 1 > m) {
            Some(format!("max turns ({}) reached", auto.max_turns.unwrap_or_default()))
        } else if auto.max_tokens.is_some_and(|m| auto.tokens >= m) {
            Some(format!("max tokens ({}) reached", auto.max_tokens.unwrap_or_default()))
        } else if auto.timeout_ms.is_some_and(|t| elapsed >= t) {
            Some(format!("timeout ({} ms) reached", auto.timeout_ms.unwrap_or_default()))
        } else {
            None
        };
        if let Some(why) = limit {
            self.stop_autonomous(id, "limit_reached", &format!("{why} — limite atteinte, pas un succès")).await;
            return false;
        }
        true
    }

    async fn stop_autonomous(&self, id: &str, status: &str, note: &str) {
        let inner = &self.inner;
        inner.update(id, |s| {
            if let Some(a) = s.autonomous.as_mut() {
                a.status = status.into();
                a.note = Some(note.into());
            }
            s.notices.push(format!("Autonomous mode ended: {note}."));
        });
        inner.journal(id, "autonomous", json!({"status": status, "note": note})).await;
    }
}

#[async_trait]
impl TurnHook for SessionCommandsHook {
    fn bind(&self, context: &RuntimeContext) {
        *lock(&self.inner.data_dir) = Some(context.data_dir.clone());
        lock(&self.inner.hosts).insert(context.session.id.clone(), context.host.clone());
        if self.inner.load(&context.session.id).heartbeat.is_some() {
            if tokio::runtime::Handle::try_current().is_ok() {
                self.inner.arm_heartbeat(&context.session.id);
            }
        }
    }

    async fn reminder(&self, session: &SessionMeta, request: &TurnRequest) -> Option<String> {
        let id = session.id.as_str();
        let mut blocks = Vec::new();
        if let Some(cmd) = user_text(request).as_deref().and_then(parse_slash) {
            if let Some(notice) = self.run_slash(session, &cmd).await {
                blocks.push(format!("## Slash command `/{}`\n{notice}", cmd.name));
            }
        }
        // A ready /refine plan is applied at the start of the next turn.
        let store = HarnessStore::open(&session.workspace_id);
        match self.inner.refine.apply_pending(&store, id) {
            Some(Ok(record)) => {
                if let Some(host) = self.inner.host(id) {
                    let _ = host
                        .record(
                            id,
                            JournalEntryKind::Refinement {
                                refinement_id: record.id.clone(),
                                trigger: record.trigger.clone(),
                                evidence: record.evidence.join("\n"),
                                result: record.summary.clone(),
                                rolled_back: false,
                            },
                        )
                        .await;
                }
                blocks.push(format!("## Harness refinement\n{}", refine::render_applied_notice(&record)));
            }
            Some(Err(e)) => blocks.push(format!("## Harness refinement\nBackground refinement failed: {e:#}")),
            None => {}
        }
        let state = self.inner.update(id, |s| {
            let snapshot = s.clone();
            s.notices.clear();
            snapshot
        });
        if let Some(goal) = goal_reminder(&state) {
            blocks.push(goal);
        }
        if let Some(a) = state.autonomous.as_ref().filter(|a| a.status == "running") {
            blocks.push(format!(
                "## Autonomous mode\nRunning ({}); turn {} so far, {} tokens. Keep going without asking the user; call `goal.complete(summary)` when done.",
                describe_autonomous(a), a.turns, a.tokens
            ));
        }
        if let Some(hb) = &state.heartbeat {
            blocks.push(format!("## Heartbeat\nEvery {}s: «{}» (`heartbeat.clear()` to stop).", hb.interval_ms / 1000, hb.message));
        }
        blocks.extend(state.notices);
        (!blocks.is_empty()).then(|| blocks.join("\n\n"))
    }

    fn handles(&self, method: &str) -> bool {
        method.starts_with("goal.") || method.starts_with("heartbeat.") || matches!(method, "refine.run" | "refine.status" | "refine.cancel")
    }

    async fn host_call(&self, session: &SessionMeta, method: &str, params: Value) -> Result<Value, String> {
        if method.starts_with("goal.") {
            return self.goal_call(session, method, params).await;
        }
        if method.starts_with("heartbeat.") {
            return self.heartbeat_call(session, method, params).await;
        }
        match method {
            "refine.run" => {
                let focus = params.get("focus").and_then(Value::as_str).map(str::to_string).filter(|f| !f.trim().is_empty());
                let started = self.start_refine(session, "agent:refine.run", focus).await?;
                Ok(json!({"started": started, "note": if started { "running in the background; applied as soon as it is ready (refine.status() / refine.cancel())" } else { "a refinement is already running (refine.cancel() to stop it)" }}))
            }
            "refine.status" => {
                let store = HarnessStore::open(&session.workspace_id);
                refine::status_json(&self.inner.refine, &store, &session.id).map_err(|e| e.to_string())
            }
            // axe:refine-run — stop a running refinement (this session's one by default).
            "refine.cancel" => {
                let store = HarnessStore::open(&session.workspace_id);
                let target = params.get("id").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).unwrap_or(&session.id);
                let record = self.inner.refine.cancel(&store, target).map_err(|e| format!("{e:#}"))?;
                Ok(serde_json::to_value(record).map_err(|e| e.to_string())?)
            }
            other => Err(format!("unknown session command `{other}`")),
        }
    }

    async fn wants_continuation(&self, session: &SessionMeta, outcome: &TurnOutcome) -> bool {
        self.autonomous_step(session, outcome).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_parsing() {
        let c = parse_slash("/autonomous --max-turns 5 --gate \"npm test\" fix it").unwrap();
        assert_eq!(c.name, "autonomous");
        let (flags, rest) = take_flags(&c.args, &["max-turns", "gate"]);
        assert_eq!(flags["max-turns"], "5");
        assert_eq!(flags["gate"], "npm test");
        assert_eq!(rest, vec!["fix", "it"]);
        assert!(parse_slash("not a command").is_none());
        assert!(parse_slash("/path/to/file").is_none());
    }

    #[test]
    fn intervals() {
        assert_eq!(parse_interval("30s"), Some(30_000));
        assert_eq!(parse_interval("2m"), Some(120_000));
        assert_eq!(parse_interval("90"), Some(90_000));
        assert_eq!(parse_interval("x"), None);
    }

    /// 30 min of continuous activity (turns of 2 min 50 s, 10 s idle between them, a
    /// delivered wake-up starts a turn), heartbeat every 5 min: the 6 slots (5, 10, …,
    /// 30 min) give exactly 6 wake-ups, each at the end of the running turn (the last
    /// one at 32 min 50 s), never two at once, grid unchanged.
    #[test]
    fn heartbeat_fixed_grid_under_activity() {
        let min = 60_000i64;
        let mut hb = Heartbeat { interval_ms: 5 * min as u64, message: "x".into(), next_at_ms: 5 * min, ..Default::default() };
        let mut deliveries = Vec::new();
        let mut busy_until = 0i64;
        let mut now = 0i64;
        while now < 33 * min {
            let in_cycle = now % (3 * min);
            let busy = in_cycle < 3 * min - 10_000 || now < busy_until;
            if let Some(n) = heartbeat_tick(&mut hb, now, busy) {
                deliveries.push((now, n));
                busy_until = now + 30_000;
            }
            now += 1_000;
        }
        assert_eq!(deliveries.len(), 6, "{deliveries:?}");
        assert!(deliveries.iter().all(|&(_, n)| n == 1), "no merged slot: {deliveries:?}");
        assert!(deliveries.windows(2).all(|w| w[1].0 - w[0].0 >= 150_000), "never two at once: {deliveries:?}");
        assert_eq!(hb.next_at_ms, 35 * min, "grid unchanged by the delays");
    }

    /// PC asleep 2 h: ONE catch-up wake-up carrying the 24 missed slots.
    #[test]
    fn heartbeat_one_catch_up_after_sleep() {
        let min = 60_000i64;
        let mut hb = Heartbeat { interval_ms: 5 * min as u64, message: "x".into(), next_at_ms: 5 * min, ..Default::default() };
        assert_eq!(heartbeat_tick(&mut hb, 5 * min, false), Some(1));
        assert_eq!(heartbeat_tick(&mut hb, 125 * min + 7_000, false), Some(24));
        assert_eq!(heartbeat_tick(&mut hb, 125 * min + 8_000, false), None, "no second one");
        assert_eq!(hb.next_at_ms, 130 * min);
        assert!(heartbeat_text_missed("x", 1, 23).contains("23 réveils manqués"));
        assert_eq!(parse_heartbeat_text(&heartbeat_text_missed("x", 7, 2)).map(|p| p.1), Some(Some(7)));
    }

    #[test]
    fn heartbeat_round_trip() {
        let t = heartbeat_text("coucou", 1_792_000_000_000);
        assert_eq!(parse_heartbeat_text(&t), Some(("coucou".into(), Some(1_792_000_000_000))));
        assert_eq!(parse_heartbeat_text("<heartbeat>\nx\n</heartbeat>"), Some(("x".into(), None)));
        assert_eq!(parse_heartbeat_text("<heartbeats>"), None);
        assert_eq!(parse_heartbeat_text("bonjour"), None);
    }

    #[test]
    fn truncation() {
        let long = "é".repeat(5000);
        assert!(truncate_bytes(&long, GATE_OUTPUT_MAX).len() < GATE_OUTPUT_MAX + 64);
    }
}
