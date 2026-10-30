//! On-disk task queue and supervisor.
//!
//! Layout, under the queue root (app data: `<data>/projects/<key>/agents/`,
//! never inside the user's project):
//!
//! ```text
//! <id>/tache.md     brief written by the caller
//! <id>/etat.json    state (atomic writes)
//! <id>/journal.log  stdout + stderr of the agent (append)
//! <id>/resultat.md  report written by the agent (optional)
//! ```
//!
//! Only commands declared in `AgentsConfig::agents_commandes` can run. Each
//! one runs in its own process group, with a minimal environment, so the
//! whole group can be stopped.

use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::config::AgentsConfig;
use crate::AgentsError;

pub const JOURNAL_FILE: &str = "journal.log";
pub const BRIEF_FILE: &str = "tache.md";
pub const STATE_FILE: &str = "etat.json";
pub const RESULT_FILE: &str = "resultat.md";
const MAX_BRIEF: usize = 64 * 1024;
const MAX_LABEL: usize = 200;
const MAX_MODELE: usize = 200;
const TAIL_LINES: usize = 300;
const RESUME_CHARS: usize = 200;
const SUPERVISE_EVERY: Duration = Duration::from_secs(2);

/// Task status, serialized exactly as the front expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Statut {
    EnAttente,
    EnCours,
    Termine,
    Erreur,
    Arrete,
}

impl Statut {
    pub fn as_str(self) -> &'static str {
        match self {
            Statut::EnAttente => "en_attente",
            Statut::EnCours => "en_cours",
            Statut::Termine => "termine",
            Statut::Erreur => "erreur",
            Statut::Arrete => "arrete",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Statut::Termine | Statut::Erreur | Statut::Arrete)
    }
}

/// `etat.json` on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    pub id: String,
    pub label: String,
    pub commande: String,
    pub modele: String,
    pub statut: Statut,
    pub pid: Option<u32>,
    pub debut_ms: Option<i64>,
    pub fin_ms: Option<i64>,
    pub code_sortie: Option<i32>,
    /// Relative name of the journal (`journal.log`).
    pub journal: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub brief: String,
    pub label: Option<String>,
    pub commande: Option<String>,
    pub modele: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    pub id: String,
    pub statut: Statut,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub label: String,
    pub commande: String,
    pub modele: String,
    pub statut: Statut,
    pub debut_ms: Option<i64>,
    pub fin_ms: Option<i64>,
    pub code_sortie: Option<i32>,
    pub resume: Option<String>,
    pub journal_taille: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub id: String,
    pub label: String,
    pub statut: Statut,
    pub debut_ms: Option<i64>,
    pub fin_ms: Option<i64>,
    pub code_sortie: Option<i32>,
    pub journal: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopView {
    pub id: String,
    pub statut: Statut,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultView {
    pub id: String,
    pub present: bool,
    pub resultat: String,
}

/// Atomic file write: temporary sibling then `rename`.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path without parent")
    })?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("write"),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_task_id() -> String {
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S");
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..6];
    format!("{stamp}-{suffix}")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_hexdigit() || c == '-')
}

fn clip_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn tail_lines(path: &Path, max_lines: usize) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut pos = len;
    let mut data: Vec<u8> = Vec::new();
    let mut newlines = 0usize;
    while pos > 0 && newlines <= max_lines && data.len() < 4 * 1024 * 1024 {
        let size = pos.min(16 * 1024);
        pos -= size;
        file.seek(SeekFrom::Start(pos))?;
        let mut chunk = vec![0u8; size as usize];
        file.read_exact(&mut chunk)?;
        newlines += chunk.iter().filter(|b| **b == b'\n').count();
        chunk.extend_from_slice(&data);
        data = chunk;
    }
    let text = String::from_utf8_lossy(&data);
    let mut lines: Vec<&str> = text.lines().collect();
    if pos > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let start = lines.len().saturating_sub(max_lines);
    Ok(lines[start..].join("\n"))
}

fn read_resume(path: &Path) -> Option<String> {
    let raw = std::fs::read(path).ok()?;
    Some(clip_chars(&String::from_utf8_lossy(&raw), RESUME_CHARS))
}

/// True when the process exists (or exists but belongs to another user).
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: `kill` with signal 0 only checks existence and permissions.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    // Best effort: no portable check without extra dependencies.
    pid != 0
        && __nw_std("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    if pid == 0 {
        return;
    }
    // SAFETY: the child was spawned with `process_group(0)`, so its pid is
    // also the process group id.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_group(pid: u32) {
    let _ = __nw_std("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

struct Inner {
    root: PathBuf,
    config: AgentsConfig,
    tasks: Mutex<BTreeMap<String, TaskState>>,
    /// Tasks launched by this process and awaited by a waiter task.
    owned: Mutex<HashSet<String>>,
    supervisor_started: AtomicBool,
}

impl Inner {
    fn state_path(&self, id: &str) -> PathBuf {
        self.root.join(id).join(STATE_FILE)
    }

    fn task_dir(&self, id: &str) -> Option<PathBuf> {
        if !valid_id(id) {
            return None;
        }
        let dir = self.root.join(id);
        let canonical = dir.canonicalize().ok()?;
        if !canonical.starts_with(&self.root) || !canonical.is_dir() {
            return None;
        }
        Some(canonical)
    }

    fn save(&self, state: &TaskState) -> Result<(), AgentsError> {
        let bytes = serde_json::to_vec_pretty(state)?;
        atomic_write(&self.state_path(&state.id), &bytes)?;
        Ok(())
    }

    fn running(&self, tasks: &BTreeMap<String, TaskState>) -> usize {
        tasks
            .values()
            .filter(|task| task.statut == Statut::EnCours)
            .count()
    }

    /// Starts queued tasks while a slot is free. The status is reserved
    /// (`en_cours`) under the lock so concurrent spawns respect the cap.
    fn pump(self: &Arc<Self>) {
        loop {
            let next = {
                let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
                if self.running(&tasks) >= self.config.agents_max {
                    None
                } else {
                    let id = tasks
                        .iter()
                        .find(|(_, task)| task.statut == Statut::EnAttente)
                        .map(|(id, _)| id.clone());
                    if let Some(id) = &id {
                        if let Some(task) = tasks.get_mut(id) {
                            task.statut = Statut::EnCours;
                            task.debut_ms = Some(now_ms());
                            let _ = self.save(task);
                        }
                    }
                    id
                }
            };
            let Some(id) = next else { break };
            if let Err(error) = self.launch(&id) {
                tracing::warn!(task = %id, error = %error, "agent launch failed");
                self.fail_launch(&id, &error);
            }
        }
    }

    fn fail_launch(&self, id: &str, error: &AgentsError) {
        let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(task) = tasks.get_mut(id) {
            task.statut = Statut::Erreur;
            task.fin_ms = Some(now_ms());
            task.code_sortie = None;
            let _ = self.save(task);
            let line = format!("agents: lancement impossible: {error}\n");
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.root.join(id).join(JOURNAL_FILE))
                .and_then(|mut file| file.write_all(line.as_bytes()));
        }
    }

    fn render(&self, template: &[String], dir: &Path, brief: &Path, modele: &str) -> Vec<String> {
        template
            .iter()
            .map(|arg| {
                arg.replace("{dir}", &dir.to_string_lossy())
                    .replace("{brief}", &brief.to_string_lossy())
                    .replace("{modele}", modele)
            })
            .collect()
    }

    fn launch(self: &Arc<Self>, id: &str) -> Result<(), AgentsError> {
        let task = {
            let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            tasks.get(id).cloned().ok_or(AgentsError::UnknownTask)?
        };
        let template = self
            .config
            .agents_commandes
            .get(&task.commande)
            .ok_or(AgentsError::UnknownCommand)?;
        let dir = self.task_dir(id).ok_or(AgentsError::InvalidTask)?;
        let brief = dir.join(BRIEF_FILE);
        let argv = self.render(template, &dir, &brief, &task.modele);
        let (program, args) = argv.split_first().ok_or(AgentsError::UnknownCommand)?;
        // axe:migration - /opt/axecode/... else the installation of before the rename.
        let program = crate::config::installed_program(program);

        let mut command = __nw_tokio(&program);
        command
            .args(args)
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear()
            .env("TERM", "dumb");
        for key in [
            "HOME",
            "PATH",
            "LANG",
            "CARGO_TARGET_DIR",
            "CARGO_BUILD_JOBS",
        ] {
            if let Ok(value) = std::env::var(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        if let Ok(value) = std::env::var("SYSTEMROOT") {
            command.env("SYSTEMROOT", value);
        }
        #[cfg(unix)]
        {
            command.process_group(0);
            // SAFETY: only async-signal-safe calls (`umask`) run after fork.
            unsafe {
                command.pre_exec(|| {
                    libc::umask(0o077);
                    Ok(())
                });
            }
        }

        let mut child = command.spawn().map_err(|e| AgentsError::Launch(e.to_string()))?;
        let pid = child.id();
        let cancelled = {
            let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            match tasks.get_mut(id) {
                Some(state) if state.statut == Statut::EnCours => {
                    state.pid = pid;
                    let _ = self.save(state);
                    false
                }
                // `stop` won the race: the process must not outlive its task.
                Some(_) => true,
                None => true,
            }
        };
        if cancelled {
            if let Some(pid) = pid {
                kill_group(pid);
            }
            let _ = child.start_kill();
            return Ok(());
        }
        self.owned
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_string());

        let journal_path = dir.join(JOURNAL_FILE);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out_task = spawn_pipe_reader(stdout, journal_path.clone());
        let err_task = spawn_pipe_reader(stderr, journal_path);
        let weak: Weak<Inner> = Arc::downgrade(self);
        let task_id = id.to_string();
        tokio::spawn(async move {
            let status = child.wait().await;
            if let Some(inner) = weak.upgrade() {
                // The status follows the agent process, not the pipe: a
                // grandchild may keep stdout open after the agent exits.
                inner.finished(&task_id, status.map(|s| s.code()).unwrap_or(None));
            }
            // Readers drain the remaining output on their own.
            drop(out_task);
            drop(err_task);
        });
        Ok(())
    }

    fn finished(&self, id: &str, code: Option<i32>) {
        self.owned
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
        let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        let Some(task) = tasks.get_mut(id) else {
            return;
        };
        if task.statut != Statut::EnCours {
            return;
        }
        task.code_sortie = code;
        task.fin_ms = Some(now_ms());
        task.statut = if code == Some(0) {
            Statut::Termine
        } else {
            Statut::Erreur
        };
        let _ = self.save(task);
    }

    fn tick(self: &Arc<Self>) {
        self.pump();
        let now = now_ms();
        let limit = self.config.agents_delai_s.saturating_mul(1000) as i64;
        let mut expired = Vec::new();
        let mut orphans = Vec::new();
        {
            let tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            let owned = self.owned.lock().unwrap_or_else(|p| p.into_inner());
            for task in tasks.values() {
                if task.statut != Statut::EnCours {
                    continue;
                }
                if let Some(start) = task.debut_ms {
                    if now.saturating_sub(start) > limit {
                        expired.push((task.id.clone(), task.pid));
                        continue;
                    }
                }
                if !owned.contains(&task.id) {
                    // A task reserved by `pump` but not spawned yet has no pid;
                    // leave it alone, `launch` will set the pid right after.
                    if let Some(pid) = task.pid {
                        if !pid_alive(pid) {
                            orphans.push(task.id.clone());
                        }
                    }
                }
            }
        }
        for (id, pid) in expired {
            if let Some(pid) = pid {
                kill_group(pid);
            }
            let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(task) = tasks.get_mut(&id) {
                if task.statut == Statut::EnCours {
                    task.statut = Statut::Erreur;
                    task.fin_ms = Some(now_ms());
                    task.code_sortie = None;
                    let _ = self.save(task);
                }
            }
        }
        for id in orphans {
            let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(task) = tasks.get_mut(&id) {
                if task.statut == Statut::EnCours {
                    task.statut = Statut::Erreur;
                    task.fin_ms = Some(now_ms());
                    task.code_sortie = None;
                    let _ = self.save(task);
                }
            }
        }
    }
}

fn spawn_pipe_reader<R>(
    stream: Option<R>,
    path: PathBuf,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let Some(mut stream) = stream else {
            return;
        };
        let mut file = match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(file) => file,
            Err(_) => return,
        };
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if file.write_all(&buffer[..n]).await.is_err() {
                        break;
                    }
                    let _ = file.flush().await;
                }
            }
        }
    })
}

/// The service-side queue: safe to clone (shares the same supervisor).
#[derive(Clone)]
pub struct AgentStore {
    inner: Arc<Inner>,
}

impl AgentStore {
    /// Opens (and creates) the queue `queue_root` of the workspace (in the
    /// app data, never in the user's project), rebuilds the index from disk
    /// and recovers ghost `en_cours` tasks.
    pub fn open_at(workspace_root: &Path, queue_root: &Path, config: AgentsConfig) -> Result<Self, AgentsError> {
        let workspace = workspace_root
            .canonicalize()
            .map_err(|_| AgentsError::NoWorkspace)?;
        if !workspace.is_dir() {
            return Err(AgentsError::NoWorkspace);
        }
        std::fs::create_dir_all(queue_root)?;
        let root = queue_root.canonicalize()?;
        let inner = Arc::new(Inner {
            root,
            config: config.normalized(),
            tasks: Mutex::new(BTreeMap::new()),
            owned: Mutex::new(HashSet::new()),
            supervisor_started: AtomicBool::new(false),
        });
        inner.recover();
        let store = Self { inner };
        store.ensure_supervisor();
        Ok(store)
    }

    fn ensure_supervisor(&self) {
        if self
            .inner
            .supervisor_started
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            self.inner
                .supervisor_started
                .store(false, Ordering::SeqCst);
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(SUPERVISE_EVERY);
            loop {
                tick.tick().await;
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                inner.tick();
            }
        });
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub fn config(&self) -> &AgentsConfig {
        &self.inner.config
    }

    /// Starts queued tasks now (also called by the 2 s supervisor).
    pub fn pump(&self) {
        self.inner.pump();
    }

    /// Runs one supervisor pass now: queued tasks, deadlines, ghost tasks.
    /// The 2 s background task calls the same pass.
    pub fn supervise(&self) {
        self.inner.tick();
    }

    pub fn spawn(&self, request: SpawnRequest) -> Result<Spawned, AgentsError> {
        let brief = request.brief;
        if brief.trim().is_empty() {
            return Err(AgentsError::MissingBrief);
        }
        if brief.len() > MAX_BRIEF {
            return Err(AgentsError::BriefTooLong);
        }
        let commande = request
            .commande
            .filter(|c| !c.trim().is_empty())
            .unwrap_or_else(|| {
                if self.inner.config.agents_commandes.contains_key("opencode") {
                    "opencode".to_string()
                } else {
                    self.inner
                        .config
                        .agents_commandes
                        .keys()
                        .next()
                        .cloned()
                        .unwrap_or_default()
                }
            });
        if !self.inner.config.agents_commandes.contains_key(&commande) {
            return Err(AgentsError::UnknownCommand);
        }
        let modele = request
            .modele
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| self.inner.config.agents_modele.clone());
        if modele.len() > MAX_MODELE || modele.chars().any(char::is_control) {
            return Err(AgentsError::InvalidTask);
        }
        let label = request
            .label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| clip_chars(brief.trim(), 40));
        let label: String = label
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(MAX_LABEL)
            .collect();

        let mut id = new_task_id();
        let dir = loop {
            let candidate = self.inner.root.join(&id);
            match std::fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    id = new_task_id();
                }
                Err(error) => return Err(error.into()),
            }
        };
        atomic_write(&dir.join(BRIEF_FILE), brief.as_bytes())?;
        File::create(dir.join(JOURNAL_FILE))?;
        let state = TaskState {
            id: id.clone(),
            label,
            commande,
            modele,
            statut: Statut::EnAttente,
            pid: None,
            debut_ms: None,
            fin_ms: None,
            code_sortie: None,
            journal: JOURNAL_FILE.to_string(),
        };
        atomic_write(
            &dir.join(STATE_FILE),
            &serde_json::to_vec_pretty(&state)?,
        )?;
        self.inner
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), state);
        self.ensure_supervisor();
        self.inner.pump();
        let statut = self
            .inner
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&id)
            .map(|task| task.statut)
            .unwrap_or(Statut::EnAttente);
        match statut {
            // `pump` ran synchronously: an error here can only come from a
            // failed launch, never from a command that exited.
            Statut::Erreur => {
                self.inner
                    .tasks
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                let _ = std::fs::remove_dir_all(self.inner.root.join(&id));
                Err(AgentsError::Launch(
                    "la commande n'a pas pu demarrer".into(),
                ))
            }
            Statut::EnAttente => Ok(Spawned {
                id,
                statut: Statut::EnAttente,
            }),
            // A very fast command may already be done: the contract still
            // answers `en_cours` right after a launch.
            _ => Ok(Spawned {
                id,
                statut: Statut::EnCours,
            }),
        }
    }

    pub fn list(&self) -> Vec<AgentSummary> {
        let tasks = self.inner.tasks.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<AgentSummary> = tasks
            .values()
            .map(|task| {
                let dir = self.inner.root.join(&task.id);
                let journal_taille = std::fs::metadata(dir.join(JOURNAL_FILE))
                    .map(|m| m.len())
                    .unwrap_or(0);
                AgentSummary {
                    id: task.id.clone(),
                    label: task.label.clone(),
                    commande: task.commande.clone(),
                    modele: task.modele.clone(),
                    statut: task.statut,
                    debut_ms: task.debut_ms,
                    fin_ms: task.fin_ms,
                    code_sortie: task.code_sortie,
                    resume: read_resume(&dir.join(RESULT_FILE)),
                    journal_taille,
                }
            })
            .collect();
        out.sort_by(|a, b| b.id.cmp(&a.id));
        out
    }

    fn task(&self, id: &str) -> Result<TaskState, AgentsError> {
        if self.inner.task_dir(id).is_none() {
            return Err(AgentsError::UnknownTask);
        }
        self.inner
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
            .ok_or(AgentsError::UnknownTask)
    }

    pub fn status(&self, id: &str) -> Result<StatusView, AgentsError> {
        let task = self.task(id)?;
        let journal = tail_lines(&self.inner.root.join(id).join(JOURNAL_FILE), TAIL_LINES)
            .unwrap_or_default();
        Ok(StatusView {
            id: task.id,
            label: task.label,
            statut: task.statut,
            debut_ms: task.debut_ms,
            fin_ms: task.fin_ms,
            code_sortie: task.code_sortie,
            journal,
        })
    }

    pub fn stop(&self, id: &str) -> Result<StopView, AgentsError> {
        let task = self.task(id)?;
        if task.statut.is_terminal() {
            return Ok(StopView {
                id: task.id,
                statut: task.statut,
            });
        }
        let pid = task.pid;
        let statut = {
            let mut tasks = self.inner.tasks.lock().unwrap_or_else(|p| p.into_inner());
            let state = tasks.get_mut(id).ok_or(AgentsError::UnknownTask)?;
            state.statut = Statut::Arrete;
            state.fin_ms = Some(now_ms());
            state.code_sortie = None;
            let _ = self.inner.save(state);
            state.statut
        };
        if let Some(pid) = pid {
            kill_group(pid);
        }
        // A slot just opened: start the next queued task without waiting for
        // the 2 s supervisor.
        self.inner.pump();
        Ok(StopView {
            id: id.to_string(),
            statut,
        })
    }

    pub fn result(&self, id: &str) -> Result<ResultView, AgentsError> {
        self.task(id)?;
        let path = self.inner.root.join(id).join(RESULT_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(ResultView {
                id: id.to_string(),
                present: true,
                resultat: String::from_utf8_lossy(&bytes).to_string(),
            }),
            Err(_) => Ok(ResultView {
                id: id.to_string(),
                present: false,
                resultat: String::new(),
            }),
        }
    }
}

impl Inner {
    /// Rebuilds the index from `etat.json` and turns ghost tasks into errors.
    fn recover(&self) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        let mut tasks = BTreeMap::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !valid_id(&name) {
                continue;
            }
            let path = entry.path();
            let is_real_dir = std::fs::symlink_metadata(&path)
                .map(|m| m.file_type().is_dir())
                .unwrap_or(false);
            if !is_real_dir {
                continue;
            }
            let raw = match std::fs::read_to_string(path.join(STATE_FILE)) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            let mut state: TaskState = match serde_json::from_str(&raw) {
                Ok(state) => state,
                Err(error) => {
                    tracing::warn!(task = %name, error = %error, "invalid agent state");
                    continue;
                }
            };
            if state.id != name {
                continue;
            }
            if state.statut == Statut::EnCours {
                let alive = state.pid.is_some_and(pid_alive);
                if !alive {
                    state.statut = Statut::Erreur;
                    state.fin_ms = Some(now_ms());
                    state.code_sortie = None;
                    let _ = self.save(&state);
                }
            }
            tasks.insert(name, state);
        }
        *self.tasks.lock().unwrap_or_else(|p| p.into_inner()) = tasks;
    }
}

/// axe:0.1.75 : aucun lancement de processus n'ouvre de fenetre console sous Windows.
#[allow(dead_code)]
fn __nw_std<S: AsRef<std::ffi::OsStr>>(p: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(p);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}
#[allow(dead_code)]
fn __nw_tokio<S: AsRef<std::ffi::OsStr>>(p: S) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(p);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c
}
