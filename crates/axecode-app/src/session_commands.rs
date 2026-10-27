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

use crate::guet::{self, Guet, GuetResultat, GUET_ESSAI_MAX_MS, GUET_MAX_ACTIFS, GUET_SORTIE_MAX};
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
    // axe:goal165 — automatic pursuit: while the goal is `active`, the hook
    // relaunches the agent after each turn (no heartbeat needed).
    /// Automatic relaunches delivered so far.
    #[serde(default)]
    pub relaunches: u32,
    /// Consecutive relaunch turns without progress (pause at [`GOAL_MAX_IDLE_RELAUNCHES`]).
    #[serde(default)]
    pub idle_relaunches: u32,
    /// Next planned relaunch (shown by the IDE indicator).
    #[serde(default)]
    pub next_relaunch_ms: Option<i64>,
    /// End of the turn after which the relaunch was planned (a message journaled
    /// after it = someone spoke: no relaunch).
    #[serde(default)]
    pub relaunch_after_ms: Option<i64>,
    /// Reason of an automatic pause (no progress), shown to the user and the agent.
    #[serde(default)]
    pub auto_pause: Option<String>,
    /// State at the start of the running turn (progress detection).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_mark: Option<TurnMark>,
}

/// axe:goal165 — goal state at the start of a turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TurnMark {
    pub progress: usize,
    #[serde(default)]
    pub hash: Option<String>,
    /// The turn was an automatic relaunch.
    #[serde(default)]
    pub relaunch: bool,
    pub started_ms: i64,
}

/// Pause before an automatic relaunch (doubled for each relaunch without progress).
pub const GOAL_PURSUIT_DELAY_MS: u64 = 20_000;
/// Relaunch turns in a row without `goal.progress` nor change in the workspace → pause.
pub const GOAL_MAX_IDLE_RELAUNCHES: u32 = 3;

/// What to do after a turn while the goal is active (pure, tested).
#[derive(Debug, Clone, PartialEq)]
pub enum Pursuit {
    /// Relaunch at this time.
    Relaunch { at_ms: i64 },
    /// Paused automatically (reason).
    Pause(String),
}

/// Decide the pursuit after a turn: `progressed` = new `goal.progress` note,
/// change in the workspace, or goal (re)set during the turn.
pub fn pursuit_after_turn(goal: &mut Goal, progressed: bool, now: i64, delay_ms: u64) -> Option<Pursuit> {
    if goal.status != "active" {
        goal.next_relaunch_ms = None;
        return None;
    }
    let relaunch = goal.turn_mark.take().is_some_and(|m| m.relaunch);
    if progressed {
        goal.idle_relaunches = 0;
    } else if relaunch {
        goal.idle_relaunches += 1;
    }
    if goal.idle_relaunches >= GOAL_MAX_IDLE_RELAUNCHES {
        let reason = format!(
            "pause automatique : {} relances de suite sans avancement (ni goal.progress ni changement de fichiers)",
            goal.idle_relaunches
        );
        goal.status = "paused".into();
        goal.next_relaunch_ms = None;
        goal.relaunch_after_ms = None;
        goal.auto_pause = Some(reason.clone());
        goal.progress.push(format!("paused: {reason}"));
        return Some(Pursuit::Pause(reason));
    }
    let wait = delay_ms.saturating_mul(1u64 << goal.idle_relaunches.min(6));
    let at_ms = now + wait as i64;
    goal.next_relaunch_ms = Some(at_ms);
    goal.relaunch_after_ms = Some(now);
    Some(Pursuit::Relaunch { at_ms })
}

/// Message of an automatic relaunch (shown in the IDE as « objectif : poursuite automatique »).
pub fn goal_continue_text(goal_text: &str, at_ms: i64, n: u32) -> String {
    format!("<goal_continue at_ms=\"{at_ms}\" n=\"{n}\">\nPoursuis l'objectif : {goal_text}\n</goal_continue>")
}

pub fn is_goal_continue(text: &str) -> bool {
    text.trim_start().starts_with("<goal_continue")
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
    /// axe:guet — guets en cours (commande, condition, fichier) et réveils à livrer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guets: Vec<Guet>,
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

// axe:goal165 — ONE store for the session commands state (goal, heartbeat,
// autonomous): `<data_dir>/session_state/<id>.json`, shared by this hook (goal.*,
// /goal, state block of every request) and by the daemon RPC of the IDE
// (`sessions.commands_state` / `sessions.commands_set`). Every read-modify-write
// holds the same process lock and writes atomically (temporary file + rename):
// a concurrent reader never sees a half-written file, a concurrent writer never
// loses the other's change.
static STATE_LOCK: Mutex<()> = Mutex::new(());

pub fn state_file(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("session_state").join(format!("{id}.json"))
}

fn read_state_value(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
}

fn write_state_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).or_else(|_| {
        // Windows: target held open by an antivirus a few ms → plain write.
        let r = std::fs::write(path, bytes);
        let _ = std::fs::remove_file(&tmp);
        r
    })
}

/// Read-modify-write of the raw JSON state under the shared lock (daemon RPC).
pub fn update_state_value<R>(
    data_dir: &Path,
    id: &str,
    f: impl FnOnce(&mut Value) -> Result<R, String>,
) -> Result<(R, Value), String> {
    let _guard = lock(&STATE_LOCK);
    let path = state_file(data_dir, id);
    let mut value = read_state_value(&path).unwrap_or_else(|| json!({}));
    let out = f(&mut value)?;
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    write_state_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    Ok((out, value))
}

/// Raw JSON state (empty object when absent), under the shared lock.
pub fn read_state(data_dir: &Path, id: &str) -> Value {
    let _guard = lock(&STATE_LOCK);
    read_state_value(&state_file(data_dir, id)).unwrap_or_else(|| json!({}))
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
    /// axe:goal165 — planned automatic relaunch of each session.
    pursuits: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    pursuit_delay_ms: std::sync::atomic::AtomicU64,
    /// axe:guet — tâche de chaque guet (clé : id du guet).
    guets: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    refine: refine::RefineRunner,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Inner {
    fn state_path(&self, id: &str) -> Option<PathBuf> {
        lock(&self.data_dir).as_ref().map(|d| state_file(d, id))
    }

    /// The state file is the ONLY source of truth (goal.get, the state block of
    /// each request, the IDE indicator all read it); the memory copy only serves
    /// without data dir (tests) or if the file cannot be read.
    fn load_unlocked(&self, id: &str) -> SessionState {
        if let Some(path) = self.state_path(id) {
            if let Some(state) = read_state_value(&path).and_then(|v| serde_json::from_value::<SessionState>(v).ok()) {
                lock(&self.states).insert(id.to_string(), state.clone());
                return state;
            }
        }
        if let Some(s) = lock(&self.states).get(id) {
            return s.clone();
        }
        SessionState::default()
    }

    fn load(&self, id: &str) -> SessionState {
        let _guard = lock(&STATE_LOCK);
        self.load_unlocked(id)
    }

    fn save_unlocked(&self, id: &str, state: SessionState) {
        if let Some(path) = self.state_path(id) {
            if let Ok(bytes) = serde_json::to_vec_pretty(&state) {
                if let Err(e) = write_state_atomic(&path, &bytes) {
                    tracing::warn!(session = %id, error = %e, "session state not saved");
                }
            }
        }
        lock(&self.states).insert(id.to_string(), state);
    }

    fn update<R>(&self, id: &str, f: impl FnOnce(&mut SessionState) -> R) -> R {
        let _guard = lock(&STATE_LOCK);
        let mut state = self.load_unlocked(id);
        let out = f(&mut state);
        self.save_unlocked(id, state);
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

    fn cancel_pursuit(&self, id: &str) {
        if let Some(old) = lock(&self.pursuits).remove(id) {
            old.abort();
        }
    }

    /// axe:goal165 — plan the automatic relaunch of `id` at `at_ms`. At that time it
    /// is delivered only if the goal is still active with this same plan, no turn
    /// is running, and nothing was journaled since the end of the turn (user,
    /// heartbeat or peer message: they start their own turn).
    fn arm_pursuit(self: &Arc<Self>, id: &str, at_ms: i64) {
        self.cancel_pursuit(id);
        let me = self.clone();
        let sid = id.to_string();
        let handle = tokio::spawn(async move {
            // Wall clock in short steps (the PC's sleep is not counted by a monotonic sleep).
            loop {
                let left = at_ms - now_ms();
                if left <= 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(left.clamp(20, 5_000) as u64)).await;
            }
            lock(&me.pursuits).remove(&sid);
            let state = me.load(&sid);
            let Some(goal) = state.goal.as_ref().filter(|g| g.status == "active" && g.next_relaunch_ms == Some(at_ms)) else { return };
            let after = goal.relaunch_after_ms.unwrap_or(at_ms);
            let autonomous = state.autonomous.as_ref().is_some_and(|a| a.status == "running");
            let Some(host) = me.host(&sid) else { return };
            let running = host.get_session(&sid).await.map_or(true, |m| m.status == SessionStatus::Running);
            let spoke = me.journal_entries(&sid).iter().rev().take_while(|e| e.ts > after).any(|e| matches!(e.kind, JournalEntryKind::Message { .. }));
            if autonomous || running || spoke {
                // The other turn plans the next relaunch when it ends.
                me.update(&sid, |s| if let Some(g) = s.goal.as_mut().filter(|g| g.next_relaunch_ms == Some(at_ms)) { g.next_relaunch_ms = None; });
                return;
            }
            let now = now_ms();
            let Some((text, n)) = me.update(&sid, |s| {
                let g = s.goal.as_mut().filter(|g| g.status == "active" && g.next_relaunch_ms == Some(at_ms))?;
                g.next_relaunch_ms = None;
                g.relaunches += 1;
                Some((g.text.clone(), g.relaunches))
            }) else { return };
            me.journal(&sid, "goal", json!({"op": "relaunch", "n": n, "at_ms": now})).await;
            let _ = host.send_user_message(&sid, goal_continue_text(&text, now, n)).await;
        });
        lock(&self.pursuits).insert(id.to_string(), handle);
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

    // ------------------------------------------------------------ axe:guet

    fn guet(&self, sid: &str, gid: &str) -> Option<Guet> {
        self.load(sid).guets.into_iter().find(|g| g.id == gid)
    }

    fn guet_vivant(&self, gid: &str) -> bool {
        lock(&self.guets).get(gid).is_some_and(|h| !h.is_finished())
    }

    /// Exécute le guet `gid` de `sid` (sauf s'il a déjà son résultat), puis livre
    /// son réveil dès que la session est libre. La tâche relit l'état à chaque pas :
    /// un guet retiré de l'état (annulé par l'agent ou par l'IDE) s'arrête.
    fn arm_guet(self: &Arc<Self>, sid: &str, gid: &str) {
        if self.guet_vivant(gid) {
            return;
        }
        let me = self.clone();
        let (sid, gid) = (sid.to_string(), gid.to_string());
        let key = gid.clone();
        let handle = tokio::spawn(async move {
            let Some(g) = me.guet(&sid, &gid) else { return };
            if g.statut == "actif" {
                let resultat = match g.genre.as_str() {
                    "commande" => me.guet_commande(&sid, &g).await,
                    _ => me.guet_sonde(&sid, &g).await,
                };
                let Some(r) = resultat else { return };
                let pret = me.update(&sid, |s| match s.guets.iter_mut().find(|x| x.id == gid) {
                    Some(x) => {
                        x.statut = "a_livrer".into();
                        x.prochain_ms = None;
                        x.resultat = Some(r.clone());
                        true
                    }
                    None => false,
                });
                if !pret {
                    return;
                }
            }
            me.livrer_guet(&sid, &gid).await;
        });
        lock(&self.guets).insert(key, handle);
    }

    async fn guet_commande(&self, sid: &str, g: &Guet) -> Option<GuetResultat> {
        let dir = lock(&self.data_dir).clone().unwrap_or_else(std::env::temp_dir).join("guets");
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join(format!("{}.log", g.id));
        let fin = |statut: &str, code: Option<i32>, extra: &str| {
            let sortie = std::fs::read(&log).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default();
            let _ = std::fs::remove_file(&log);
            GuetResultat { statut: statut.into(), code, sortie: guet::fin_de(&(sortie + extra), GUET_SORTIE_MAX), fin_ms: now_ms() }
        };
        let fichier = match std::fs::File::create(&log) {
            Ok(f) => f,
            Err(e) => return Some(GuetResultat { statut: "erreur".into(), code: None, sortie: format!("sortie impossible à enregistrer : {e}"), fin_ms: now_ms() }),
        };
        let mut c = guet::shell_cmd(g.cmd.as_deref().unwrap_or(""));
        if let Ok(e) = fichier.try_clone() {
            c.stderr(e);
        }
        c.current_dir(g.cwd.as_deref().unwrap_or(".")).stdout(fichier).kill_on_drop(true);
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => return Some(fin("erreur", None, &format!("impossible de lancer la commande : {e}"))),
        };
        let limite = g.cree_ms + g.timeout_ms as i64;
        loop {
            match tokio::time::timeout(Duration::from_millis(500), child.wait()).await {
                Ok(Ok(st)) => return Some(fin("termine", st.code(), "")),
                Ok(Err(e)) => return Some(fin("erreur", None, &format!("\n{e}"))),
                Err(_) => {}
            }
            if self.guet(sid, &g.id).is_none() {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&log);
                return None;
            }
            if now_ms() >= limite {
                let _ = child.kill().await;
                return Some(fin("delai_depasse", None, ""));
            }
        }
    }

    /// `condition` (relancer `cmd` jusqu'au code 0) et `fichier` (attendre qu'il existe).
    async fn guet_sonde(&self, sid: &str, g: &Guet) -> Option<GuetResultat> {
        let limite = g.cree_ms + g.timeout_ms as i64;
        let cwd = PathBuf::from(g.cwd.clone().unwrap_or_else(|| ".".into()));
        let (mut derniere, mut code) = (String::new(), None);
        loop {
            let prochain = self.guet(sid, &g.id)?.prochain_ms.unwrap_or(0).min(limite);
            // Horloge murale par petits pas : l'annulation est vue en moins d'une seconde.
            while now_ms() < prochain {
                tokio::time::sleep(Duration::from_millis((prochain - now_ms()).clamp(20, 1_000) as u64)).await;
                self.guet(sid, &g.id)?;
            }
            if now_ms() >= limite {
                return Some(GuetResultat { statut: "delai_depasse".into(), code, sortie: derniere, fin_ms: now_ms() });
            }
            let (ok, c, sortie) = if g.genre == "fichier" {
                (cwd.join(g.chemin.as_deref().unwrap_or("")).exists(), None, String::new())
            } else {
                let max = Duration::from_millis(GUET_ESSAI_MAX_MS.min((limite - now_ms()).max(1_000) as u64));
                guet::essai(&cwd, g.cmd.as_deref().unwrap_or(""), max).await
            };
            (derniere, code) = (sortie, c);
            let n = now_ms();
            self.update(sid, |s| {
                s.guets.iter_mut().find(|x| x.id == g.id).map(|x| {
                    x.essais += 1;
                    x.prochain_ms = Some(n + x.intervalle_ms as i64);
                })
            })?;
            if ok {
                return Some(GuetResultat { statut: "reussi".into(), code, sortie: derniere, fin_ms: n });
            }
        }
    }

    /// Livre le réveil une seule fois : retiré de l'état AVANT l'envoi.
    async fn livrer_guet(&self, sid: &str, gid: &str) {
        loop {
            let Some(g) = self.guet(sid, gid) else { return };
            let Some(r) = g.resultat.clone() else { return };
            let host = self.host(sid);
            let libre = match &host {
                Some(h) => h.get_session(sid).await.is_ok_and(|m| m.status != SessionStatus::Running),
                None => false,
            };
            if let (true, Some(host)) = (libre, host) {
                let pris = self.update(sid, |s| {
                    let avant = s.guets.len();
                    s.guets.retain(|x| x.id != gid);
                    s.guets.len() != avant
                });
                if pris {
                    self.journal(sid, "guet", json!({"op": "livre", "id": gid, "statut": r.statut})).await;
                    let _ = host.send_user_message(sid, guet::texte_reveil(&g, &r)).await;
                }
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Au (re)chargement d'une session : relance les guets, livre ceux qui sont
    /// prêts ; une commande lancée par un service précédent est perdue → réveil
    /// « interrompu » (l'agent la relance s'il le faut).
    fn rearm_guets(self: &Arc<Self>, sid: &str) {
        let guets = self.load(sid).guets;
        for g in guets {
            if self.guet_vivant(&g.id) {
                continue;
            }
            if g.genre == "commande" && g.statut == "actif" {
                let r = GuetResultat {
                    statut: "interrompu".into(),
                    code: None,
                    sortie: "Le service SavIDE a redémarré pendant la commande : son résultat est perdu.".into(),
                    fin_ms: now_ms(),
                };
                self.update(sid, |s| if let Some(x) = s.guets.iter_mut().find(|x| x.id == g.id) {
                    x.statut = "a_livrer".into();
                    x.resultat = Some(r.clone());
                });
            }
            self.arm_guet(sid, &g.id);
        }
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
                pursuits: Mutex::new(HashMap::new()),
                pursuit_delay_ms: std::sync::atomic::AtomicU64::new(GOAL_PURSUIT_DELAY_MS),
                guets: Mutex::new(HashMap::new()),
                refine: refine::RefineRunner::new(),
            }),
        })
    }

    /// axe:refine169 — délai de préparation des affinages (10 min ; tests : quelques ms).
    pub fn set_refine_timeout(&self, timeout: Duration) {
        self.inner.refine.set_timeout(timeout);
    }

    /// axe:goal165 — pause before an automatic relaunch (tests: a few ms).
    pub fn set_pursuit_delay(&self, delay: Duration) {
        self.inner.pursuit_delay_ms.store(delay.as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
    }

    /// axe:guet — arrête toutes les tâches de guet du processus (fin du service ;
    /// les tests simulent ainsi l'arrêt du processus avant un rechargement).
    pub fn stop_guets(&self) {
        for (_, h) in lock(&self.inner.guets).drain() {
            h.abort();
        }
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
                // axe:cmdnat — langage naturel ; jamais « usage invalide ».
                use crate::commandes_naturelles::{analyser_goal, IntentionObjectif as I};
                let brut = cmd.rest.trim();
                match analyser_goal(brut) {
                    // L'objectif est déjà rappelé par le bloc « Objectif de la session » du
                    // tour : ne pas le répéter ici (avant : affiché deux fois).
                    I::Afficher => if inner.load(id).goal.is_some() {
                        "L'utilisateur demande l'objectif actuel (rappelé plus bas) : redis-le-lui en une phrase, en français.".into()
                    } else {
                        "Aucun objectif n'est fixé pour cette session : dis-le à l'utilisateur en une phrase (exemple : « /goal migrer la base »).".into()
                    },
                    I::Effacer => { self.goal_call(session, "goal.clear", json!({})).await.ok(); "L'utilisateur a effacé l'objectif de la session.".into() }
                    I::Pause => { self.goal_call(session, "goal.pause", json!({})).await.ok(); "L'utilisateur a mis l'objectif en pause : n'y travaille plus tant qu'il ne l'a pas repris.".into() }
                    I::Reprendre => { self.goal_call(session, "goal.resume", json!({})).await.ok(); "L'utilisateur a repris l'objectif : continue d'y travailler.".into() }
                    I::Termine => {
                        self.goal_call(session, "goal.complete", json!({"summary": "marqué atteint par l'utilisateur (/goal)"})).await.ok();
                        "L'utilisateur a marqué l'objectif comme atteint. N'y travaille plus.".into()
                    }
                    I::Poser { texte, budget } => {
                        match self.goal_call(session, "goal.set", json!({"text": texte, "budget_tokens": budget})).await {
                            Ok(_) => format!(
                                "L'utilisateur a fixé un objectif persistant pour la session : {texte}{}. Travaille à l'atteindre ; note l'avancement avec `goal.progress(note)` et n'appelle `goal.complete(summary)` que lorsqu'il est entièrement atteint. (Demande d'origine : « /goal {brut} » ; si cette lecture est fausse, corrige-la avec `goal.set(...)`.)",
                                budget.map(|b| format!(" (budget : {b} jetons)")).unwrap_or_default()
                            ),
                            Err(e) => objectif_a_confier(brut, &e),
                        }
                    }
                    I::Flou { raison } => objectif_a_confier(brut, &raison),
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
                // axe:cmdnat — langage naturel ; jamais « usage invalide ».
                use crate::commandes_naturelles::{analyser_heartbeat, decrire_duree, IntentionReveil as I};
                let brut = cmd.rest.trim();
                match analyser_heartbeat(brut) {
                    I::Afficher => match inner.load(id).heartbeat {
                        Some(_) => "L'utilisateur demande le réveil actuel (rappelé plus bas) : redis-le-lui en une phrase, en français.".into(),
                        None => "L'utilisateur demande le réveil actuel : aucun réveil n'est en place. Dis-le-lui en une phrase (exemple : « /heartbeat dis coucou toutes les 5 minutes »).".into(),
                    },
                    I::Arreter => {
                        let _ = self.heartbeat_call(session, "heartbeat.clear", json!({})).await;
                        "L'utilisateur a arrêté le réveil (heartbeat).".into()
                    }
                    I::Poser { interval_ms, message } if interval_ms < MIN_HEARTBEAT_MS => format!(
                        "L'utilisateur a demandé un réveil toutes les {} (« {message} »), mais le minimum est de {} s : rien n'a été installé. Dis-le-lui en une phrase et propose {} s.",
                        decrire_duree(interval_ms), MIN_HEARTBEAT_MS / 1000, MIN_HEARTBEAT_MS / 1000
                    ),
                    I::Poser { interval_ms, message } => {
                        match self.heartbeat_call(session, "heartbeat.set", json!({"interval_ms": interval_ms, "message": message})).await {
                            Ok(_) => format!(
                                "L'utilisateur a installé un réveil (heartbeat) toutes les {} : « {message} ». Il t'arrivera comme message <heartbeat>. (Demande d'origine : « /heartbeat {brut} » ; si cette lecture est fausse, corrige-la avec `heartbeat.set(intervalle, message)` ou `heartbeat.clear()`.)",
                                decrire_duree(interval_ms)
                            ),
                            Err(e) => reveil_a_confier(brut, &e),
                        }
                    }
                    I::Flou { raison } => reveil_a_confier(brut, &raison),
                }
            }
            "guet" => {
                // axe:guet — langage courant ; sinon confié à l'agent.
                use crate::commandes_naturelles::{analyser_guet, IntentionGuet as I};
                let brut = cmd.rest.trim();
                match analyser_guet(brut) {
                    I::Afficher => if inner.load(id).guets.is_empty() {
                        "L'utilisateur demande les guets en cours : il n'y en a aucun. Dis-le-lui en une phrase (exemple : « /guet quand la construction est finie »).".into()
                    } else {
                        "L'utilisateur demande les guets en cours (rappelés plus bas) : résume-les-lui en une phrase chacun, en français.".into()
                    },
                    I::Annuler { id: cible } => match self.guet_call(session, "guet.annuler", json!({"id": cible.clone().unwrap_or_default()})).await {
                        Ok(v) => {
                            let n = v["annules"].as_array().map_or(0, Vec::len);
                            if n == 0 { "L'utilisateur a demandé d'annuler les guets : il n'y en avait aucun. Dis-le-lui en une phrase.".into() }
                            else { format!("L'utilisateur a annulé {n} guet{} ({}) : tu ne seras pas réveillé pour {}.", if n > 1 { "s" } else { "" }, v["annules"], if n > 1 { "eux" } else { "lui" }) }
                        }
                        Err(e) => guet_a_confier(brut, &e),
                    },
                    I::Commande { cmd: c, condition } => {
                        let methode = if condition { "guet.condition" } else { "guet.commande" };
                        match self.guet_call(session, methode, json!({"cmd": c, "message": format!("/guet {brut}"), "par_utilisateur": true})).await {
                            Ok(v) => format!(
                                "L'utilisateur a posé un guet ({}) sur `{c}` : {}. Tu seras réveillé par un message <guet id=\"{}\" …> ; termine ton tour sans attendre. (Si cette lecture est fausse : `guet.annuler(\"{}\")` puis pose le bon guet.)",
                                v["id"].as_str().unwrap_or(""),
                                if condition { "relancée toutes les 30 s jusqu'à ce qu'elle réussisse (2 h au plus)" } else { "lancée en arrière-plan, réveil à sa fin" },
                                v["id"].as_str().unwrap_or(""), v["id"].as_str().unwrap_or("")
                            ),
                            Err(e) => guet_a_confier(brut, &e),
                        }
                    }
                    I::Flou { raison } => guet_a_confier(brut, &raison),
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
            // axe:compact169 — /compact est exécuté directement par la boucle du tour
            // (repl/turn.rs), sans consigne à l'IA : l'ancienne consigne « Call
            // compact.run() right now » restait dans le prompt et l'IA bouclait.
            "compact" => return None,
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
                        "goal.resume" => {
                            goal.status = "active".into();
                            goal.idle_relaunches = 0;
                            goal.auto_pause = None;
                        }
                        other => return Err(format!("unknown goal call `{other}`")),
                    }
                }
            }
            Ok(serde_json::to_value(&state.goal).unwrap_or(Value::Null))
        })?;
        if matches!(method, "goal.pause" | "goal.complete" | "goal.clear" | "goal.set") {
            inner.cancel_pursuit(id);
            inner.update(id, |s| if let Some(g) = s.goal.as_mut() { g.next_relaunch_ms = None; });
        }
        if method != "goal.get" {
            inner.journal(id, "goal", json!({"op": method.trim_start_matches("goal."), "goal": result})).await;
        }
        Ok(result)
    }


    /// axe:guet — `guet.commande` / `guet.condition` / `guet.fichier` / `guet.liste` / `guet.annuler`.
    pub async fn guet_call(&self, session: &SessionMeta, method: &str, params: Value) -> Result<Value, String> {
        let id = session.id.as_str();
        let inner = &self.inner;
        match method {
            "guet.liste" => Ok(Value::Array(inner.load(id).guets.iter().map(guet::vue).collect())),
            "guet.annuler" => {
                let cible = params.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let tous = cible.is_empty() || cible == "tout" || cible == "tous";
                let annules: Vec<String> = inner.update(id, |s| {
                    let (out, garde): (Vec<Guet>, Vec<Guet>) = std::mem::take(&mut s.guets).into_iter().partition(|g| tous || g.id == cible);
                    s.guets = garde;
                    out.into_iter().map(|g| g.id).collect()
                });
                if annules.is_empty() && !tous {
                    return Err(format!("aucun guet `{cible}` (voir guet.liste())"));
                }
                for g in &annules {
                    if let Some(h) = lock(&inner.guets).remove(g) {
                        h.abort(); // la commande lancée est tuée (kill_on_drop)
                    }
                }
                inner.journal(id, "guet", json!({"op": "annule", "ids": annules})).await;
                Ok(json!({"annules": annules}))
            }
            "guet.commande" | "guet.condition" | "guet.fichier" => {
                let mut g = guet::depuis_params(method.trim_start_matches("guet."), &params, now_ms())?;
                let racine = PathBuf::from(&session.workspace_id);
                g.cwd = Some(match g.cwd.take() {
                    Some(c) => racine.join(c).display().to_string(),
                    None => session.workspace_id.clone(),
                });
                let ajoute = inner.update(id, |s| {
                    if s.guets.iter().filter(|x| x.statut == "actif").count() >= GUET_MAX_ACTIFS {
                        return false;
                    }
                    s.guets.push(g.clone());
                    true
                });
                if !ajoute {
                    return Err(format!("déjà {GUET_MAX_ACTIFS} guets actifs : annule-en avec guet.annuler(id)"));
                }
                inner.journal(id, "guet", json!({"op": "pose", "guet": guet::vue(&g)})).await;
                inner.arm_guet(id, &g.id);
                Ok(guet::vue(&g))
            }
            other => Err(format!("unknown guet call `{other}`")),
        }
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
pub const SLASH_COMMANDS: &[&str] = &["goal", "autonomous", "heartbeat", "guet", "refine", "compact"];

/// axe:guet — `/guet` en phrase libre : l'agent pose lui-même le bon guet.
fn guet_a_confier(brut: &str, raison: &str) -> String {
    format!(
        "L'utilisateur demande « /guet {brut} » ({raison}) : il veut que tu sois RÉVEILLÉ quand quelque chose se termine, sans heartbeat ni boucle. Trouve la commande qui le vérifie, puis pose le guet et termine ton tour : `guet.condition(cmd, intervalle=\"30s\", timeout=\"2h\", message=...)` relance `cmd` jusqu'à ce qu'elle réussisse (code 0) — ex. construction GitHub : `gh run watch <id> --exit-status` avec guet.commande, ou `gh run list -L1 --json status -q '.[0].status' | grep -qx completed` avec guet.condition ; `guet.commande(cmd, message=...)` lance une commande longue et réveille à sa fin ; `guet.fichier(chemin)` attend un fichier. Dis à l'utilisateur en une phrase ce que tu guettes. S'il manque une information (quel dépôt, quelle tâche), demande-la en une phrase. Ne réponds jamais « usage invalide »."
    )
}

/// axe:cmdnat — `/heartbeat` pas compris : la demande est confiée à l'agent.
fn reveil_a_confier(brut: &str, raison: &str) -> String {
    format!(
        "La commande « /heartbeat {brut} » n'a pas été comprise automatiquement ({raison}). Interprète toi-même la demande de l'utilisateur : appelle `heartbeat.set(intervalle, message)` (intervalle « 30s », « 5m », « 1h » ; minimum 5 s ; message sans « dis »/« écris ») ou `heartbeat.clear()` pour l'arrêter. Si elle reste ambiguë, demande une précision à l'utilisateur en une phrase, en français. Ne réponds jamais « usage invalide »."
    )
}

/// axe:cmdnat — `/goal` pas compris : la demande est confiée à l'agent.
fn objectif_a_confier(brut: &str, raison: &str) -> String {
    format!(
        "La commande « /goal {brut} » n'a pas été comprise automatiquement ({raison}). Interprète toi-même la demande de l'utilisateur : `goal.set(text, budget_tokens=None)` pour fixer un objectif, `goal.pause()`, `goal.resume()`, `goal.complete(summary)` ou `goal.clear()`. Si elle reste ambiguë, demande une précision à l'utilisateur en une phrase, en français. Ne réponds jamais « usage invalide »."
    )
}

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
    let statut = match goal.status.as_str() {
        "active" => "en cours",
        "paused" => "en pause",
        "complete" => "atteint",
        autre => autre,
    };
    let mut out = format!("## Objectif de la session ({statut})\n{}\n", goal.text);
    if let Some(b) = goal.budget_tokens {
        out.push_str(&format!("Budget : {} / {b} jetons utilisés.\n", goal.used_tokens));
    }
    if !goal.progress.is_empty() {
        out.push_str("Avancement :\n");
        for p in goal.progress.iter().rev().take(8).rev() {
            out.push_str(&format!("- {p}\n"));
        }
    }
    if let Some(s) = &goal.summary {
        out.push_str(&format!("Résumé de fin : {s}\n"));
    }
    if goal.status == "active" {
        out.push_str("Poursuite automatique : tant qu'il est en cours, tu es relancé tout seul peu après chaque fin de tour (pas besoin de heartbeat) ; `goal.pause(raison)` l'arrête, `goal.complete(summary)` le termine.\n");
    } else if let Some(r) = goal.auto_pause.as_ref().filter(|_| goal.status == "paused") {
        out.push_str(&format!("Poursuite automatique arrêtée ({r}) ; `goal.resume()` pour reprendre.\n"));
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
            // axe:goal165 — no /autonomous: an active goal relaunches the agent
            // after a short pause (no heartbeat needed).
            self.goal_pursuit(session).await;
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

    /// axe:goal165 — after a turn, with an active goal and no /autonomous: plan the
    /// relaunch, or pause after too many relaunches without progress.
    async fn goal_pursuit(&self, session: &SessionMeta) {
        let id = session.id.as_str();
        let inner = &self.inner;
        if !inner.load(id).goal.is_some_and(|g| g.status == "active") {
            return;
        }
        let hash = workspace_change_hash(Path::new(&session.workspace_id));
        let delay = inner.pursuit_delay_ms.load(std::sync::atomic::Ordering::Relaxed);
        let decision = inner.update(id, |s| {
            let g = s.goal.as_mut()?;
            let progressed = match &g.turn_mark {
                Some(m) => g.progress.len() > m.progress || hash != m.hash || g.created_ms >= m.started_ms,
                None => false,
            };
            let d = pursuit_after_turn(g, progressed, now_ms(), delay);
            if let Some(Pursuit::Pause(reason)) = &d {
                s.notices.push(format!("Objectif mis en pause automatiquement ({reason}). Dis-le à l'utilisateur ; `goal.resume()` pour reprendre."));
            }
            d
        });
        match decision {
            Some(Pursuit::Relaunch { at_ms }) => inner.arm_pursuit(id, at_ms),
            Some(Pursuit::Pause(reason)) => {
                inner.cancel_pursuit(id);
                inner.journal(id, "goal", json!({"op": "pause", "by": "auto", "reason": reason, "goal": serde_json::to_value(inner.load(id).goal).unwrap_or(Value::Null)})).await;
            }
            None => {}
        }
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
        // axe:goal165 — a relaunch planned before a restart of the service is re-armed.
        if let Some(at) = self.inner.load(&context.session.id).goal.filter(|g| g.status == "active").and_then(|g| g.next_relaunch_ms) {
            if tokio::runtime::Handle::try_current().is_ok() {
                self.inner.arm_pursuit(&context.session.id, at);
            }
        }
        if self.inner.load(&context.session.id).heartbeat.is_some() {
            if tokio::runtime::Handle::try_current().is_ok() {
                self.inner.arm_heartbeat(&context.session.id);
            }
        }
        // axe:guet — guets posés avant un redémarrage du service.
        if !self.inner.load(&context.session.id).guets.is_empty() && tokio::runtime::Handle::try_current().is_ok() {
            self.inner.rearm_guets(&context.session.id);
        }
    }

    async fn reminder(&self, session: &SessionMeta, request: &TurnRequest) -> Option<String> {
        let id = session.id.as_str();
        let mut blocks = Vec::new();
        if let Some(cmd) = user_text(request).as_deref().and_then(parse_slash) {
            if let Some(notice) = self.run_slash(session, &cmd).await {
                blocks.push(format!("## Commande `/{}`\n{notice}", cmd.name));
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
        // axe:goal165 — goal state at the start of the turn (progress detection);
        // a turn starting cancels the planned relaunch; the user speaking resets
        // the count of relaunches without progress.
        let input = user_text(request);
        let relaunch = input.as_deref().is_some_and(is_goal_continue);
        let by_user = input.is_some() && !relaunch && !input.as_deref().is_some_and(|t| t.trim_start().starts_with("<heartbeat") || guet::est_reveil(t) || t.trim_start().starts_with("<system_reminder"));
        let active = self.inner.load(id).goal.is_some_and(|g| g.status == "active");
        if active {
            self.inner.cancel_pursuit(id);
            let hash = workspace_change_hash(Path::new(&session.workspace_id));
            self.inner.update(id, |s| {
                if let Some(g) = s.goal.as_mut() {
                    g.next_relaunch_ms = None;
                    if by_user {
                        g.idle_relaunches = 0;
                    }
                    g.turn_mark = Some(TurnMark { progress: g.progress.len(), hash: hash.clone(), relaunch, started_ms: now_ms() });
                }
            });
        }
        if relaunch {
            if let Some(g) = self.inner.load(id).goal.filter(|g| g.status == "active") {
                blocks.push(format!(
                    "## Poursuite automatique de l'objectif\nCe tour a été lancé tout seul (relance n° {}, {} de suite sans avancement sur {GOAL_MAX_IDLE_RELAUNCHES} avant la pause automatique). Avance d'une étape vers l'objectif et note-la avec `goal.progress(note)`. Si tu attends quelque chose (sous-agent, construction), vérifie-le puis termine ton tour : tu seras relancé. Si plus rien ne peut avancer sans l'utilisateur, appelle `goal.pause(raison)` ; quand tout est fait, `goal.complete(summary)`.",
                    g.relaunches, g.idle_relaunches
                ));
            }
        }
        // Notices are one-shot: consumed by the turn that shows them.
        let notices = self.inner.update(id, |s| std::mem::take(&mut s.notices));
        blocks.extend(notices);
        (!blocks.is_empty()).then(|| blocks.join("\n\n"))
    }

    // axe:goal165 — goal / autonomous / heartbeat re-read from the state file for
    // EVERY request of the turn (before: frozen at the start of the turn, so an
    // objective cleared from the IDE during a long turn was still shown « en cours »
    // while `goal.get()` already returned None).
    async fn live_reminder(&self, session: &SessionMeta) -> Option<String> {
        let state = self.inner.load(&session.id);
        let mut blocks = Vec::new();
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
            blocks.push(format!(
                "## Réveil\nToutes les {} : « {} » (pour l'arrêter : /heartbeat stop, ou `heartbeat.clear()`).",
                crate::commandes_naturelles::decrire_duree(hb.interval_ms),
                hb.message
            ));
        }
        if !state.guets.is_empty() {
            let mut b = String::from("## Guets en cours (tu seras réveillé par un message <guet> ; inutile de vérifier toi-même)\n");
            for g in &state.guets {
                let etat = if g.statut == "a_livrer" { "fini, réveil en attente de la fin du tour".to_string() } else { format!("depuis {}", crate::commandes_naturelles::decrire_duree((now_ms() - g.cree_ms).max(0) as u64)) };
                b.push_str(&format!("- {} ({}) `{}` : {etat}\n", g.id, g.genre, g.libelle()));
            }
            b.push_str("Annuler : `guet.annuler(id)` ou /guet annule.");
            blocks.push(b);
        }
        (!blocks.is_empty()).then(|| blocks.join("\n\n"))
    }

    fn handles(&self, method: &str) -> bool {
        method.starts_with("goal.") || method.starts_with("heartbeat.") || method.starts_with("guet.") || matches!(method, "refine.run" | "refine.status" | "refine.cancel")
    }

    async fn host_call(&self, session: &SessionMeta, method: &str, params: Value) -> Result<Value, String> {
        if method.starts_with("goal.") {
            return self.goal_call(session, method, params).await;
        }
        if method.starts_with("heartbeat.") {
            return self.heartbeat_call(session, method, params).await;
        }
        if method.starts_with("guet.") {
            return self.guet_call(session, method, params).await;
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

    /// axe:goal165 — relaunch after each turn, backoff, pause after 3 idle relaunches.
    #[test]
    fn poursuite_de_l_objectif() {
        let mut g = Goal { text: "lot 3".into(), status: "active".into(), ..Default::default() };
        let mark = |relaunch| Some(TurnMark { progress: 0, hash: None, relaunch, started_ms: 0 });
        g.turn_mark = mark(false);
        assert_eq!(pursuit_after_turn(&mut g, false, 1_000, 20_000), Some(Pursuit::Relaunch { at_ms: 21_000 }));
        assert_eq!(g.idle_relaunches, 0, "un tour de l'utilisateur ne compte pas");
        g.turn_mark = mark(true);
        assert_eq!(pursuit_after_turn(&mut g, true, 1_000, 20_000), Some(Pursuit::Relaunch { at_ms: 21_000 }));
        for (i, at) in [(1, 41_000), (2, 81_000)] {
            g.turn_mark = mark(true);
            assert_eq!(pursuit_after_turn(&mut g, false, 1_000, 20_000), Some(Pursuit::Relaunch { at_ms: at }));
            assert_eq!(g.idle_relaunches, i);
        }
        g.turn_mark = mark(true);
        assert!(matches!(pursuit_after_turn(&mut g, false, 1_000, 20_000), Some(Pursuit::Pause(_))));
        assert_eq!((g.status.as_str(), g.next_relaunch_ms), ("paused", None));
        assert!(g.auto_pause.is_some());
        assert_eq!(pursuit_after_turn(&mut g, false, 1_000, 20_000), None, "en pause : plus de relance");
        assert!(is_goal_continue(&goal_continue_text("x", 1, 1)));
    }

    #[test]
    fn truncation() {
        let long = "é".repeat(5000);
        assert!(truncate_bytes(&long, GATE_OUTPUT_MAX).len() < GATE_OUTPUT_MAX + 64);
    }
}
