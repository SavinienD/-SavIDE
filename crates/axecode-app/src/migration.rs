//! One-time migration of the data written before the rename to the new
//! folders: app data (`ProjectDirs` local data), global folder of the home
//! (harness, devices...), sub-agent settings and the webview profile.
//!
//! Called at the very start of the desktop app, before the store, the daemon
//! and the webview, and by a service started without the app (`--daemon
//! serve` on its default data folder, spaces of the VM). Rules:
//! - the old folders are only read: never moved, renamed or modified (the old
//!   app may still be running on them);
//! - files are copied one by one (hidden ones too), only when missing in the
//!   new folder, even when that folder already exists, and never overwritten:
//!   each copy goes to a temporary file, then to its name with a hard link
//!   that fails if the name exists;
//! - SQLite databases: consistent snapshot (backup API from a read-only
//!   connection while a WAL is in use, else file + WAL, kept only when the
//!   files did not change while they were read), checked with `quick_check`
//!   before taking their name;
//! - `.jsonl` journals may be written by the old app during the copy: the
//!   copy stops after the last newline (complete lines only);
//! - hidden files are copied too (`sessions/.legacy-imported` stops the
//!   daemon from importing the old SQLite store a second time);
//! - free conversations of the old app work in its data folder
//!   (`scratch/<id>`): in the COPIES of the journals (`workspace_id`) and of
//!   the store (`conversations.workspace_id`) that prefix becomes the one of
//!   the new data folder, so that the new app never works in the old folder;
//! - browser caches and files of running processes are not copied; locked
//!   files are skipped with a warning;
//! - once a part has been migrated without error, a marker in its NEW folder
//!   (`.axecode-migration-<part>.json`, with the report) stops any later copy:
//!   a conversation deleted in the new app never comes back. After an error
//!   the next start tries again (missing files only) and the errors are kept
//!   in `.axecode-migration-<part>-errors.json`. The webview profile is copied
//!   only when the new one does not exist, so it needs no marker;
//! - one process at a time: a lock file in the new data folder; a second
//!   instance started together waits (it must not open the new folder while
//!   the first one copies);
//! - errors are logged, never fatal.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use rusqlite::{
    backup::{Backup, StepResult},
    config::DbConfig,
    Connection, OpenFlags,
};
use serde_json::json;
use walkdir::WalkDir;

// rebrand:keep-begin (old names, read only by the migration)
/// Old `ProjectDirs` application name (app data).
pub const OLD_APP_NAME: &str = "ancienne-app";
/// Old `ProjectDirs` name of the sub-agent settings folder.
pub const OLD_AGENTS_APP_NAME: &str = "ancienne-app-agents";
/// Old global folder of the home.
pub const OLD_HOME_DIR: &str = ".ancienne-app";
/// Old Tauri identifier (webview profile folder).
pub const OLD_IDENTIFIER: &str = "ancienne.app";
// rebrand:keep-end
pub const NEW_APP_NAME: &str = "axecode";
pub const NEW_HOME_DIR: &str = ".axecode";
pub const NEW_IDENTIFIER: &str = "ancien.editeur.axecode";
pub const AGENTS_SETTINGS_FILE: &str = "agents-settings.json";
const MARKER_PREFIX: &str = ".axecode-migration";
const TMP_SUFFIX: &str = ".axecode-migration-tmp";
/// Lock of a migration run, in the new data folder.
const LOCK_FILE: &str = ".axecode-migration.lock";
const LOCK_WAIT: Duration = Duration::from_secs(120);
/// A lock older than this was left by a crash.
const LOCK_STALE: Duration = Duration::from_secs(15 * 60);
/// Files of a running process, never copied (anywhere in a tree).
const RUNTIME_FILES: &[&str] = &[
    "LOCK",
    "lockfile",
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
];
/// Files of the running daemon at the root of the data folder: copying
/// `daemon.json` would attach the new app to the old daemon.
const DATA_ROOT_RUNTIME_FILES: &[&str] = &["daemon.json", "daemon.sock"];
/// Browser caches (Chromium / WebView2, WebKitGTK), rebuilt on demand.
const CACHE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "CacheStorage",
    "ScriptCache",
    "GrShaderCache",
    "ShaderCache",
    "GraphiteDawnCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "WebKitCache",
    "component_crx_cache",
    "extensions_crx_cache",
];
/// Browser profiles inside the data folder: their SQLite files belong to the
/// browser (exclusive locks), copied as plain files.
const DATA_BROWSER_PROFILES: &[&str] = &["gemini-web/browser-profile"];
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
/// Folder of the free conversations in the data folder
/// (`axecode_daemon::scratch::SCRATCH_DIR`).
const SCRATCH_DIR_NAME: &str = "scratch";
const SQLITE_SIDECARS: &[&str] = &["-wal", "-shm", "-journal"];

/// What a migration did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    /// Files copied (databases included).
    pub copied: usize,
    /// SQLite databases copied (snapshot checked).
    pub databases: usize,
    /// Files already present in the new folder: left untouched.
    pub kept: usize,
    /// Warnings: locked file, symbolic link, cut journal line, conflict...
    pub skipped: Vec<String>,
    /// Failures: the part is tried again at the next start.
    pub errors: Vec<String>,
}

impl Report {
    fn merge(&mut self, other: Report) {
        self.copied += other.copied;
        self.databases += other.databases;
        self.kept += other.kept;
        self.skipped.extend(other.skipped);
        self.errors.extend(other.errors);
    }

    fn to_json(&self, part: Part, from: &Path) -> serde_json::Value {
        json!({
            "part": part.name(),
            "from": from.to_string_lossy(),
            "dateMs": now_ms(),
            "copied": self.copied,
            "databases": self.databases,
            "kept": self.kept,
            "skipped": self.skipped,
            "errors": self.errors,
        })
    }
}

/// The migrated parts, each with its own marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Data,
    Agents,
    Home,
    Webview,
}

impl Part {
    pub fn name(self) -> &'static str {
        match self {
            Part::Data => "data",
            Part::Agents => "agents",
            Part::Home => "home",
            Part::Webview => "webview",
        }
    }

    /// Marker file of this part, written in its NEW folder.
    pub fn marker(self) -> String {
        format!("{MARKER_PREFIX}-{}.json", self.name())
    }

    /// Errors of the last run of this part (overwritten, removed once done).
    pub fn errors_file(self) -> String {
        format!("{MARKER_PREFIX}-{}-errors.json", self.name())
    }
}

/// Folders of one machine (resolved once, injectable for the tests).
#[derive(Debug, Clone, Default)]
pub struct Locations {
    pub old_data: Option<PathBuf>,
    pub new_data: Option<PathBuf>,
    pub old_agents: Option<PathBuf>,
    pub new_agents: Option<PathBuf>,
    pub old_home: Option<PathBuf>,
    pub new_home: Option<PathBuf>,
    pub old_webview: Option<PathBuf>,
    pub new_webview: Option<PathBuf>,
}

impl Locations {
    /// The real folders of this machine.
    pub fn detect() -> Self {
        use directories::{BaseDirs, ProjectDirs};
        let data = |app: &str| {
            ProjectDirs::from("com", "ancien-editeur", app).map(|d| d.data_local_dir().to_path_buf())
        };
        let agents = |app: &str| ProjectDirs::from("", "", app).map(|d| d.data_dir().to_path_buf());
        let base = BaseDirs::new();
        let home = |name: &str| base.as_ref().map(|b| b.home_dir().join(name));
        let webview = |id: &str| base.as_ref().and_then(|b| webview_profile(b.data_local_dir(), id));
        Self {
            old_data: data(OLD_APP_NAME),
            new_data: data(NEW_APP_NAME),
            old_agents: agents(OLD_AGENTS_APP_NAME),
            new_agents: agents(NEW_APP_NAME),
            old_home: home(OLD_HOME_DIR),
            new_home: home(NEW_HOME_DIR),
            old_webview: webview(OLD_IDENTIFIER),
            new_webview: webview(NEW_IDENTIFIER),
        }
    }
}

/// Profile folder of the webview: Tauri gives `<local data>/<identifier>` to
/// WebView2 (which writes into `EBWebView`) and to WebKitGTK.
fn webview_profile(local_data: &Path, identifier: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        Some(local_data.join(identifier).join("EBWebView"))
    } else if cfg!(target_os = "linux") {
        Some(local_data.join(identifier))
    } else {
        None
    }
}

/// Runs the migration with the folders of this machine and logs the result.
/// Never fails, never panics the app.
pub fn run_at_startup() -> Vec<(Part, Report)> {
    // SavIDE : aucune reprise des données d'l'ancienne application (rien de partagé).
    // SavIDE : reprise unique des données de l'ancienne édition « Atelier ».
    if true {
        reprise_atelier();
        return Vec::new();
    }
    let started = Instant::now();
    let reports = std::panic::catch_unwind(|| run(&Locations::detect())).unwrap_or_else(|_| {
        tracing::warn!("data migration aborted (panic)");
        Vec::new()
    });
    for (part, report) in &reports {
        tracing::info!(
            part = part.name(),
            copied = report.copied,
            databases = report.databases,
            kept = report.kept,
            "data migration"
        );
        for warning in &report.skipped {
            tracing::warn!(part = part.name(), "data migration: {warning}");
        }
        for error in &report.errors {
            tracing::warn!(part = part.name(), "data migration failed, retried at next start: {error}");
        }
    }
    if !reports.is_empty() {
        tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, "data migration done");
    }
    reports
}

/// Runs every part whose old folder exists and whose new folder has no
/// marker yet. Returns one report per part that ran.
pub fn run(loc: &Locations) -> Vec<(Part, Report)> {
    run_with_lock(loc, LOCK_WAIT)
}

/// [`run`], one process at a time; gives up for this start after `wait`.
fn run_with_lock(loc: &Locations, wait: Duration) -> Vec<(Part, Report)> {
    let _lock = match loc.new_data.as_deref().map(|dir| RunLock::acquire(dir, wait)) {
        Some(Err(())) => {
            tracing::warn!("data migration skipped: another process is migrating");
            return Vec::new();
        }
        Some(Ok(lock)) => lock,
        None => None,
    };
    let steps = [
        (Part::Data, &loc.old_data, &loc.new_data),
        (Part::Agents, &loc.old_agents, &loc.new_agents),
        (Part::Home, &loc.old_home, &loc.new_home),
        (Part::Webview, &loc.old_webview, &loc.new_webview),
    ];
    steps
        .into_iter()
        .filter_map(|(part, old, new)| match (old, new) {
            (Some(old), Some(new)) => migrate_part(part, old, new).map(|report| (part, report)),
            _ => None,
        })
        .collect()
}

/// Exclusive lock of a migration run: a file created with `create_new`,
/// removed at the end (also on panic).
struct RunLock(PathBuf);

impl RunLock {
    /// `Ok(None)`: no lock possible in this folder (run anyway); `Err(())`:
    /// another process still migrates after `wait`.
    fn acquire(dir: &Path, wait: Duration) -> Result<Option<Self>, ()> {
        if fs::create_dir_all(dir).is_err() {
            return Ok(None);
        }
        let path = dir.join(LOCK_FILE);
        let deadline = Instant::now() + wait;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let _ = write!(file, "{}", std::process::id());
                    return Ok(Some(Self(path)));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let age = fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|time| time.elapsed().ok());
                    if age.is_some_and(|age| age > LOCK_STALE) {
                        if fs::remove_file(&path).is_err() {
                            return Ok(None);
                        }
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return Err(());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => return Ok(None),
            }
        }
    }
}

impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// One part, once: nothing when the old folder is missing or the marker of
/// the new folder exists.
pub fn migrate_part(part: Part, old: &Path, new: &Path) -> Option<Report> {
    if old == new || !old.is_dir() || new.join(part.marker()).exists() {
        return None;
    }
    let report = match part {
        Part::Webview => migrate_webview(old, new)?,
        _ => {
            if let Err(error) = fs::create_dir_all(new) {
                let mut report = Report::default();
                report.errors.push(format!("{}: {error}", new.display()));
                return Some(report);
            }
            match part {
                Part::Agents => copy_one(&old.join(AGENTS_SETTINGS_FILE), &new.join(AGENTS_SETTINGS_FILE), false, false, None),
                Part::Data => {
                    let rewrite = Some(Rewrite::for_data(old, new));
                    copy_tree(old, new, &TreeOptions { data_root: true, sqlite: true, lenient: false, rewrite })
                }
                _ => copy_tree(old, new, &TreeOptions { data_root: false, sqlite: true, lenient: false, rewrite: None }),
            }
        }
    };
    if part != Part::Webview {
        let text = serde_json::to_string_pretty(&report.to_json(part, old)).unwrap_or_default();
        let errors_file = new.join(part.errors_file());
        if report.errors.is_empty() {
            let marker = new.join(part.marker());
            if let Err(error) = write_new_file(&marker, text.as_bytes()) {
                tracing::warn!(path = %marker.display(), %error, "unable to write the migration marker");
            }
            let _ = fs::remove_file(errors_file);
        } else {
            let _ = fs::write(errors_file, text);
        }
    }
    Some(report)
}

/// Webview profile: copied only when the new profile does not exist yet,
/// into a temporary folder renamed at the end (never a half profile).
fn migrate_webview(old: &Path, new: &Path) -> Option<Report> {
    if new.exists() {
        return None;
    }
    let mut report = Report::default();
    let staging = with_suffix(new, TMP_SUFFIX);
    if staging.exists() {
        // Our own leftover of an interrupted start.
        let _ = fs::remove_dir_all(&staging);
    }
    if let Err(error) = fs::create_dir_all(&staging) {
        report.errors.push(format!("{}: {error}", staging.display()));
        return Some(report);
    }
    report.merge(copy_tree(old, &staging, &TreeOptions { data_root: false, sqlite: false, lenient: true, rewrite: None }));
    if report.errors.is_empty() {
        if let Err(error) = fs::rename(&staging, new) {
            report.errors.push(format!("{} -> {}: {error}", staging.display(), new.display()));
        }
    }
    if !report.errors.is_empty() {
        let _ = fs::remove_dir_all(&staging);
    }
    Some(report)
}

struct TreeOptions {
    /// Root of the app data folder: skip the files of the running daemon.
    data_root: bool,
    /// Copy SQLite databases as snapshots (not inside browser profiles).
    sqlite: bool,
    /// Locked or unreadable files are warnings (browser profile, best
    /// effort); otherwise they are errors and the part is tried again.
    lenient: bool,
    /// Paths of the old data folder rewritten in the copies (app data only).
    rewrite: Option<Rewrite>,
}

fn is_cache_dir(name: &str) -> bool {
    CACHE_DIRS.iter().any(|cache| cache.eq_ignore_ascii_case(name))
}

/// Copies the files of `old` missing in `new`, one by one.
fn copy_tree(old: &Path, new: &Path, options: &TreeOptions) -> Report {
    let mut report = Report::default();
    // Rights of the created folders, applied after the copy (a read-only
    // folder would refuse its files).
    let mut created_dirs: Vec<(PathBuf, fs::Permissions)> = Vec::new();
    let walker = WalkDir::new(old)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_entry(|entry| !(entry.file_type().is_dir() && is_cache_dir(&entry.file_name().to_string_lossy())));
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                let message = format!("{}: {error}", error.path().unwrap_or(old).display());
                let browser = options.data_root
                    && error.path().and_then(|p| p.strip_prefix(old).ok()).is_some_and(in_browser_profile);
                if options.lenient || browser {
                    report.skipped.push(message);
                } else {
                    report.errors.push(message);
                }
                continue;
            }
        };
        let Ok(relative) = entry.path().strip_prefix(old) else { continue };
        let target = new.join(relative);
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type();
        if file_type.is_dir() {
            let existed = target.is_dir();
            match fs::create_dir_all(&target) {
                Ok(()) if !existed && cfg!(unix) => {
                    if let Ok(meta) = entry.metadata() {
                        created_dirs.push((target, meta.permissions()));
                    }
                }
                Ok(()) => {}
                Err(error) => report.errors.push(format!("{}: {error}", target.display())),
            }
            continue;
        }
        if name.ends_with(TMP_SUFFIX) || name.starts_with(MARKER_PREFIX) || RUNTIME_FILES.contains(&name.as_str()) {
            continue;
        }
        if options.data_root && relative.components().count() == 1 && DATA_ROOT_RUNTIME_FILES.contains(&name.as_str()) {
            continue;
        }
        if file_type.is_symlink() {
            report.merge(copy_symlink(entry.path(), &target));
            continue;
        }
        if !file_type.is_file() {
            continue; // socket, pipe...
        }
        // A browser profile of the data folder: its SQLite files belong to
        // the browser (exclusive locks), copied as plain files, best effort.
        let browser = options.data_root && in_browser_profile(relative);
        let sqlite = options.sqlite && !browser;
        if sqlite && is_sqlite_sidecar(entry.path()) {
            continue; // copied with its database
        }
        report.merge(copy_one(entry.path(), &target, sqlite, options.lenient || browser, options.rewrite.as_ref()));
    }
    for (dir, permissions) in created_dirs.into_iter().rev() {
        let _ = fs::set_permissions(dir, permissions);
    }
    report
}

fn in_browser_profile(relative: &Path) -> bool {
    DATA_BROWSER_PROFILES
        .iter()
        .any(|profile| relative.starts_with(Path::new(profile)))
}

/// Result of one file copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Copied,
    /// The name appeared in the new folder meanwhile: left untouched.
    Exists,
}

/// Copies one file when its name is missing in the new folder. `lenient`:
/// a locked or unreadable file is a warning instead of an error.
fn copy_one(src: &Path, dst: &Path, sqlite: bool, lenient: bool, rewrite: Option<&Rewrite>) -> Report {
    let mut report = Report::default();
    if !src.is_file() {
        return report;
    }
    if fs::symlink_metadata(dst).is_ok() {
        report.kept += 1;
        return report;
    }
    if let Some(parent) = dst.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            report.errors.push(format!("{}: {error}", parent.display()));
            return report;
        }
    }
    let database = sqlite && is_sqlite_file(src);
    let result = if database {
        copy_sqlite(src, dst, rewrite)
    } else {
        copy_file(src, dst, is_jsonl(src), rewrite)
    };
    match result {
        Ok(Outcome::Copied) => {
            report.copied += 1;
            if database {
                report.databases += 1;
            }
        }
        Ok(Outcome::Exists) => report.kept += 1,
        Err(error) if lenient && is_unreadable(&error) => {
            report.skipped.push(format!("{} (locked or unreadable, not copied): {error}", src.display()));
        }
        Err(error) => report.errors.push(format!("{}: {error}", src.display())),
    }
    report
}

/// Free conversations of the old app work in its data folder
/// (`<old data>/scratch/<id>`), and their journals and the store of the IDE
/// keep that path. In the COPIES (never in the old folder) that prefix becomes
/// the one of the new data folder.
#[derive(Debug, Clone, Default)]
struct Rewrite {
    /// (old, new) `scratch` folders, under every form of the paths
    /// (canonical with or without the Windows verbatim prefix, as resolved).
    prefixes: Vec<(String, String)>,
}

impl Rewrite {
    fn for_data(old: &Path, new: &Path) -> Self {
        let forms = |dir: &Path| {
            let text = |path: &Path| path.to_string_lossy().to_string();
            let raw = dir.join(SCRATCH_DIR_NAME);
            let canonical = dir.canonicalize().map(|c| text(&c.join(SCRATCH_DIR_NAME))).unwrap_or_else(|_| text(&raw));
            let plain = canonical.strip_prefix(r"\\?\").unwrap_or(&canonical).to_string();
            [canonical, plain, text(&raw)]
        };
        let mut prefixes: Vec<(String, String)> = Vec::new();
        for (from, to) in forms(old).into_iter().zip(forms(new)) {
            if from != to && !prefixes.iter().any(|(known, _)| *known == from) {
                prefixes.push((from, to));
            }
        }
        Self { prefixes }
    }

    /// Journal text with its `workspace_id` values rewritten (only at a
    /// folder boundary); `None` when nothing changes or not UTF-8.
    fn journal(&self, bytes: &[u8]) -> Option<String> {
        let mut text = std::str::from_utf8(bytes).ok()?.to_string();
        let mut changed = false;
        for (from, to) in &self.prefixes {
            let (from, to) = (json_value_prefix("workspace_id", from), json_value_prefix("workspace_id", to));
            let mut out = String::with_capacity(text.len());
            let mut rest = text.as_str();
            while let Some(at) = rest.find(&from) {
                let after = &rest[at + from.len()..];
                out.push_str(&rest[..at]);
                if after.starts_with('"') || after.starts_with("\\\\") || after.starts_with('/') {
                    out.push_str(&to);
                    changed = true;
                } else {
                    out.push_str(&from);
                }
                rest = after;
            }
            out.push_str(rest);
            text = out;
        }
        changed.then_some(text)
    }

    /// Store of the IDE: `conversations.workspace_id` rewritten in the copy.
    fn sqlite(&self, db: &Path) -> io::Result<()> {
        let conn = Connection::open(db).map_err(sqlite_error)?;
        let columns: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('conversations') WHERE name = 'workspace_id'",
                [],
                |row| row.get(0),
            )
            .map_err(sqlite_error)?;
        if columns > 0 {
            for (from, to) in &self.prefixes {
                conn.execute(
                    "UPDATE conversations SET workspace_id = ?2 || substr(workspace_id, length(?1) + 1)
                     WHERE workspace_id = ?1 OR substr(workspace_id, 1, length(?1) + 1) IN (?1 || '/', ?1 || '\\')",
                    rusqlite::params![from, to],
                )
                .map_err(sqlite_error)?;
            }
        }
        conn.close().map_err(|(_, error)| sqlite_error(error))
    }
}

/// `"key":"value` (JSON of serde_json, without the closing quote).
fn json_value_prefix(key: &str, value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_default();
    format!("\"{key}\":{}", &quoted[..quoted.len().saturating_sub(1)])
}

fn is_jsonl(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
}

/// Windows sharing / lock violation, or no read permission.
fn is_unreadable(error: &io::Error) -> bool {
    (cfg!(windows) && matches!(error.raw_os_error(), Some(32) | Some(33)))
        || error.kind() == io::ErrorKind::PermissionDenied
}

/// Plain file: copy into a temporary file, then link it to its name.
/// `complete_lines`: keep the bytes up to the last newline (journal being
/// written by the old app).
fn copy_file(src: &Path, dst: &Path, complete_lines: bool, rewrite: Option<&Rewrite>) -> io::Result<Outcome> {
    let tmp = with_suffix(dst, TMP_SUFFIX);
    let _ = fs::remove_file(&tmp);
    let result = copy_bytes(src, &tmp, complete_lines, rewrite).and_then(|()| persist(&tmp, dst));
    let _ = fs::remove_file(&tmp);
    result
}

fn copy_bytes(src: &Path, tmp: &Path, complete_lines: bool, rewrite: Option<&Rewrite>) -> io::Result<()> {
    // Rust opens with every sharing mode on Windows: readable while the old
    // app writes it.
    let mut input = File::open(src)?;
    let meta = input.metadata()?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    if complete_lines {
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes)?;
        let lines = complete_lines_of(&bytes);
        match rewrite.and_then(|rewrite| rewrite.journal(lines)) {
            Some(fixed) => output.write_all(fixed.as_bytes())?,
            None => output.write_all(lines)?,
        }
    } else {
        io::copy(&mut input, &mut output)?;
    }
    output.sync_all()?;
    if let Ok(modified) = meta.modified() {
        let _ = output.set_modified(modified);
    }
    #[cfg(unix)]
    {
        // Same rights (keys of the devices folder stay private).
        let _ = output.set_permissions(meta.permissions());
    }
    Ok(())
}

/// The bytes up to the last newline: a line still being written by the old
/// app is dropped (the journals write each line with its newline; a kept
/// line without newline would be glued to the next one written by the new
/// app).
fn complete_lines_of(bytes: &[u8]) -> &[u8] {
    let end = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    &bytes[..end]
}

/// Gives `tmp` the name `dst` without ever replacing an existing file: a hard
/// link fails when the name exists. Without hard links (some file systems),
/// the name is created exclusively (`create_new`), then filled.
fn persist(tmp: &Path, dst: &Path) -> io::Result<Outcome> {
    match fs::hard_link(tmp, dst) {
        Ok(()) => Ok(Outcome::Copied),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(Outcome::Exists),
        Err(_) if fs::symlink_metadata(dst).is_ok() => Ok(Outcome::Exists),
        Err(_) => fill_new(tmp, dst),
    }
}

fn fill_new(tmp: &Path, dst: &Path) -> io::Result<Outcome> {
    let mut output = match OpenOptions::new().write(true).create_new(true).open(dst) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(Outcome::Exists),
        Err(error) => return Err(error),
    };
    let filled = File::open(tmp)
        .and_then(|mut input| io::copy(&mut input, &mut output))
        .and_then(|_| output.sync_all());
    if let Err(error) = filled {
        drop(output);
        let _ = fs::remove_file(dst); // our own partial file
        return Err(error);
    }
    if let Ok(modified) = fs::metadata(tmp).and_then(|meta| meta.modified()) {
        let _ = output.set_modified(modified);
    }
    Ok(Outcome::Copied)
}

#[cfg(unix)]
fn copy_symlink(src: &Path, dst: &Path) -> Report {
    let mut report = Report::default();
    if fs::symlink_metadata(dst).is_ok() {
        report.kept += 1;
        return report;
    }
    match fs::read_link(src).and_then(|target| std::os::unix::fs::symlink(target, dst)) {
        Ok(()) => report.copied += 1,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => report.kept += 1,
        Err(error) => report.errors.push(format!("{}: {error}", src.display())),
    }
    report
}

#[cfg(not(unix))]
fn copy_symlink(src: &Path, _dst: &Path) -> Report {
    let mut report = Report::default();
    report.skipped.push(format!("{} (symbolic link, not copied)", src.display()));
    report
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(bytes),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn other(error: impl ToString) -> io::Error {
    io::Error::other(error.to_string())
}

/// Bytes 18-19 of a SQLite file (2 = WAL mode), `None` when not SQLite.
fn sqlite_versions(path: &Path) -> Option<[u8; 2]> {
    let mut header = [0u8; 20];
    File::open(path).and_then(|mut file| file.read_exact(&mut header)).ok()?;
    (&header[..16] == SQLITE_HEADER).then(|| [header[18], header[19]])
}

fn is_sqlite_file(path: &Path) -> bool {
    sqlite_versions(path).is_some()
}

/// `-wal`, `-shm`, `-journal` of a database: copied with it.
fn is_sqlite_sidecar(path: &Path) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return false;
    };
    SQLITE_SIDECARS.iter().any(|suffix| {
        name.strip_suffix(suffix)
            .is_some_and(|base| !base.is_empty() && is_sqlite_file(&path.with_file_name(base)))
    })
}

fn remove_sqlite_files(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in SQLITE_SIDECARS {
        let _ = fs::remove_file(with_suffix(path, suffix));
    }
}

/// SQLite database: checked snapshot into a temporary file, then linked to
/// its name (never over an existing file).
fn copy_sqlite(src: &Path, dst: &Path, rewrite: Option<&Rewrite>) -> io::Result<Outcome> {
    let tmp = with_suffix(dst, TMP_SUFFIX);
    remove_sqlite_files(&tmp);
    let result = snapshot_sqlite(src, &tmp)
        .and_then(|()| match rewrite {
            Some(rewrite) => rewrite.sqlite(&tmp).and_then(|()| check_and_fold(&tmp)),
            None => Ok(()),
        })
        .and_then(|()| persist(&tmp, dst));
    remove_sqlite_files(&tmp);
    result
}

fn snapshot_sqlite(src: &Path, tmp: &Path) -> io::Result<()> {
    let wal_mode = sqlite_versions(src).is_some_and(|v| v.contains(&2));
    let exists = |suffix: &str| with_suffix(src, suffix).exists();
    let live_wal = wal_mode && exists("-wal") && exists("-shm");
    let plain_rollback = !wal_mode && !exists("-journal");
    if live_wal || plain_rollback {
        // Consistent snapshot through SQLite from a read-only connection
        // (one read transaction). It creates nothing in the old folder: in
        // WAL mode its -wal and -shm already exist (old app running, or not
        // closed); in rollback mode a reader writes no file.
        match backup_live(src, tmp) {
            Ok(()) => return check_and_fold(tmp),
            // Being written by the old app: tried again at the next start,
            // never a file copy of a database being written.
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Err(error),
            // e.g. hot WAL of a crash that a read-only connection cannot
            // recover: the files are copied and recovered in the NEW folder.
            Err(error) => {
                tracing::debug!(path = %src.display(), %error, "sqlite backup failed, copying the files");
                remove_sqlite_files(tmp);
            }
        }
    }
    // WAL mode without -wal / -shm: nobody has it open at this instant (SQLite
    // keeps both while a connection is open), so the file is complete; with a
    // -wal left by a crash (no -shm) or a hot -journal, those are copied too
    // and SQLite replays or rolls them back in the NEW folder. The old app
    // opens a connection for each operation: the copy is kept only when the
    // files did not change while they were read.
    copy_stable(src, tmp, STABLE_ATTEMPTS, || {})?;
    check_and_fold(tmp)
}

/// Attempts of [`copy_stable`], 500 ms apart (about 10 s at most).
const STABLE_ATTEMPTS: usize = 20;

/// Copies a database with its -wal / -journal and keeps the copy only when the
/// source did not change meanwhile: same size and date before the copy and
/// after the check, no sidecar created or removed, same bytes read a second
/// time. Else (or after a read error: a -journal removed by the old app while
/// it was read) tried again, then an error (`WouldBlock` when the files kept
/// changing): tried again at the next start. `between`: test hook, called
/// between the copy and the check.
fn copy_stable(src: &Path, tmp: &Path, attempts: usize, mut between: impl FnMut()) -> io::Result<()> {
    let changing = || io::Error::new(io::ErrorKind::WouldBlock, "database written during the copy");
    let mut last = changing();
    for attempt in 0..attempts {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(500));
        }
        let before = sqlite_stamps(src);
        match copy_sqlite_files(src, tmp) {
            Ok(()) => {
                between();
                let stable = sqlite_stamps(src) == before
                    && same_sqlite_files(src, tmp).unwrap_or(false)
                    && sqlite_stamps(src) == before;
                if stable {
                    return Ok(());
                }
                last = changing();
            }
            Err(error) => last = error,
        }
        remove_sqlite_files(tmp);
    }
    Err(last)
}

/// The database and its -wal / -journal, as they are.
fn copy_sqlite_files(src: &Path, tmp: &Path) -> io::Result<()> {
    copy_bytes(src, tmp, false, None)?;
    for suffix in ["-wal", "-journal"] {
        let side = with_suffix(src, suffix);
        if side.is_file() {
            copy_bytes(&side, &with_suffix(tmp, suffix), false, None)?;
        }
    }
    Ok(())
}

/// Size and date of a database and of each of its sidecars.
fn sqlite_stamps(path: &Path) -> Vec<Option<(u64, Option<std::time::SystemTime>)>> {
    std::iter::once("")
        .chain(SQLITE_SIDECARS.iter().copied())
        .map(|suffix| fs::metadata(with_suffix(path, suffix)).ok().map(|meta| (meta.len(), meta.modified().ok())))
        .collect()
}

/// The copy holds the same bytes as the source (database, -wal, -journal).
fn same_sqlite_files(src: &Path, copy: &Path) -> io::Result<bool> {
    for suffix in ["", "-wal", "-journal"] {
        let (a, b) = (with_suffix(src, suffix), with_suffix(copy, suffix));
        match (a.is_file(), b.is_file()) {
            (false, false) => {}
            (true, true) if same_bytes(&a, &b)? => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    let (mut a, mut b) = (File::open(a)?, File::open(b)?);
    let (mut x, mut y) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let (n, m) = (read_full(&mut a, &mut x)?, read_full(&mut b, &mut y)?);
        if n != m || x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Fills `buf` as far as possible (0: end of file).
fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

fn backup_live(src: &Path, tmp: &Path) -> io::Result<()> {
    let from = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(sqlite_error)?;
    // Never checkpoint the old database when this connection closes.
    from.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .map_err(sqlite_error)?;
    from.busy_timeout(Duration::from_secs(5)).map_err(sqlite_error)?;
    let mut to = Connection::open(tmp).map_err(sqlite_error)?;
    {
        let backup = Backup::new(&from, &mut to).map_err(sqlite_error)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            // -1: every page in one step, inside one read transaction.
            match backup.step(-1).map_err(sqlite_error)? {
                StepResult::Done => break,
                StepResult::More => {}
                _ => {
                    if Instant::now() > deadline {
                        return Err(io::Error::new(io::ErrorKind::WouldBlock, "database busy"));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    to.close().map_err(|(_, error)| sqlite_error(error))?;
    from.close().map_err(|(_, error)| sqlite_error(error))?;
    Ok(())
}

/// Busy or locked (old app writing): `WouldBlock`, never retried as a file copy.
fn sqlite_error(error: rusqlite::Error) -> io::Error {
    use rusqlite::ErrorCode;
    let busy = matches!(
        &error,
        rusqlite::Error::SqliteFailure(e, _) if matches!(e.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    );
    let kind = if busy { io::ErrorKind::WouldBlock } else { io::ErrorKind::Other };
    io::Error::new(kind, error.to_string())
}

/// Opens the copy (replays its WAL), checks it, folds the WAL into the file
/// so that a single file takes the final name.
fn check_and_fold(tmp: &Path) -> io::Result<()> {
    let conn = Connection::open(tmp).map_err(other)?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(other)?;
    if check != "ok" {
        return Err(other(format!("copy failed quick_check: {check}")));
    }
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .map_err(other)?;
    conn.close().map_err(|(_, error)| other(error))?;
    for suffix in ["-wal", "-journal"] {
        let side = with_suffix(tmp, suffix);
        if fs::metadata(&side).is_ok_and(|meta| meta.len() > 0) {
            return Err(other(format!("{} not folded into the copy", side.display())));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    /// Every file of a tree with its size and date (`-shm`: name only, SQLite
    /// readers update it). The old folder must never change.
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<(u64, std::time::SystemTime)>> {
        WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| !e.file_type().is_dir())
            .map(|e| {
                let meta = e.metadata().unwrap();
                let shm = e.file_name().to_string_lossy().ends_with("-shm");
                let key = e.path().strip_prefix(root).unwrap().to_path_buf();
                (key, (!shm).then(|| (meta.len(), meta.modified().unwrap())))
            })
            .collect()
    }

    fn leftovers(root: &Path) -> Vec<PathBuf> {
        WalkDir::new(root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(TMP_SUFFIX))
            .map(|e| e.path().to_path_buf())
            .collect()
    }

    fn folders() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join("old"), tmp.path().join("new"));
        fs::create_dir_all(&old).unwrap();
        (tmp, old, new)
    }

    #[test]
    fn copies_missing_files_once_even_into_an_existing_folder() {
        let (_tmp, old, new) = folders();
        write(&old.join("providers.json"), "{\"a\":1}");
        write(&old.join("sessions/.legacy-imported"), "{\"imported\":3}");
        write(&old.join("rlm/x/state.json"), "{}");
        write(&new.join("cloud.json"), "new");
        let before = snapshot(&old);
        let report = migrate_part(Part::Data, &old, &new).expect("first start");
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.copied, 3);
        assert_eq!(read(&new.join("providers.json")), "{\"a\":1}");
        assert_eq!(read(&new.join("sessions/.legacy-imported")), "{\"imported\":3}");
        assert_eq!(read(&new.join("rlm/x/state.json")), "{}");
        assert_eq!(read(&new.join("cloud.json")), "new");
        assert!(new.join(Part::Data.marker()).is_file());
        assert_eq!(snapshot(&old), before, "old folder changed");
        assert!(leftovers(&new).is_empty());
        // Second start: nothing comes back (deleted in the new app) or arrives.
        fs::remove_file(new.join("providers.json")).unwrap();
        write(&old.join("later.json"), "{}");
        assert!(migrate_part(Part::Data, &old, &new).is_none());
        assert!(!new.join("providers.json").exists());
        assert!(!new.join("later.json").exists());
    }

    #[test]
    fn never_overwrites_a_present_file() {
        let (tmp, old, new) = folders();
        write(&old.join("harness/index.json"), "old");
        write(&old.join("harness/notes/a.md"), "a");
        write(&new.join("harness/index.json"), "new");
        let report = migrate_part(Part::Home, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!((report.copied, report.kept), (1, 1));
        assert_eq!(read(&new.join("harness/index.json")), "new");
        assert_eq!(read(&new.join("harness/notes/a.md")), "a");
        // A name created meanwhile is kept: the link fails, nothing replaced.
        let (src, dst) = (tmp.path().join("t"), tmp.path().join("d"));
        write(&src, "copy");
        write(&dst, "present");
        assert_eq!(persist(&src, &dst).unwrap(), Outcome::Exists);
        assert_eq!(read(&dst), "present");
        // Without hard links: exclusive creation, same rule.
        assert_eq!(fill_new(&src, &dst).unwrap(), Outcome::Exists);
        assert_eq!(read(&dst), "present");
        let fresh = tmp.path().join("fresh");
        assert_eq!(fill_new(&src, &fresh).unwrap(), Outcome::Copied);
        assert_eq!(read(&fresh), "copy");
    }

    #[test]
    fn one_migration_at_a_time() {
        let (_tmp, old, new) = folders();
        write(&old.join("a.json"), "{}");
        let loc = Locations {
            old_data: Some(old.clone()),
            new_data: Some(new.clone()),
            ..Locations::default()
        };
        // Another process is migrating: nothing done, its lock kept.
        write(&new.join(LOCK_FILE), "1");
        assert!(run_with_lock(&loc, Duration::from_millis(200)).is_empty());
        assert!(!new.join("a.json").exists());
        assert!(new.join(LOCK_FILE).exists());
        // Its lock was left by a crash: taken over, removed at the end.
        let long_ago = std::time::SystemTime::now() - LOCK_STALE - Duration::from_secs(60);
        File::options().write(true).open(new.join(LOCK_FILE)).unwrap().set_modified(long_ago).unwrap();
        assert_eq!(run_with_lock(&loc, Duration::from_millis(200)).len(), 1);
        assert_eq!(read(&new.join("a.json")), "{}");
        assert!(!new.join(LOCK_FILE).exists());
    }

    fn create_db(path: &Path, rows: i64) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);",
        )
        .unwrap();
        for i in 0..rows {
            conn.execute("INSERT INTO t(v) VALUES (?1)", [format!("ligne {i}")]).unwrap();
        }
        conn
    }

    fn rows(path: &Path) -> i64 {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn sqlite_in_use_is_copied_complete_and_readable() {
        let (_tmp, old, new) = folders();
        let db = old.join("desktop-state.sqlite3");
        // The old app is running: its rows are still in the WAL.
        let live = create_db(&db, 500);
        assert!(with_suffix(&db, "-wal").exists() && with_suffix(&db, "-shm").exists());
        let before = snapshot(&old);
        let report = migrate_part(Part::Data, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!((report.copied, report.databases), (1, 1));
        let copy = new.join("desktop-state.sqlite3");
        assert!(!with_suffix(&copy, "-wal").exists(), "WAL folded into the copy");
        assert!(leftovers(&new).is_empty());
        assert_eq!(rows(&copy), 500);
        assert_eq!(snapshot(&old), before, "old folder changed");
        live.execute("INSERT INTO t(v) VALUES ('old app')", []).unwrap();
        drop(live);
        assert_eq!(rows(&db), 501);
    }

    #[test]
    fn sqlite_closed_or_after_a_crash_is_copied_complete() {
        let (tmp, old, new) = folders();
        drop(create_db(&old.join("closed.sqlite3"), 20));
        let rollback = Connection::open(old.join("rollback.db")).unwrap();
        rollback
            .execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('a'), ('b');")
            .unwrap();
        drop(rollback);
        // Crash: database + WAL, no -shm.
        let live = create_db(&tmp.path().join("live.sqlite3"), 30);
        fs::copy(tmp.path().join("live.sqlite3"), old.join("crash.sqlite3")).unwrap();
        fs::copy(tmp.path().join("live.sqlite3-wal"), old.join("crash.sqlite3-wal")).unwrap();
        drop(live);
        let before = snapshot(&old);
        let report = migrate_part(Part::Data, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.databases, 3);
        assert!(!new.join("crash.sqlite3-wal").exists());
        assert_eq!(rows(&new.join("closed.sqlite3")), 20);
        assert_eq!(rows(&new.join("crash.sqlite3")), 30);
        assert_eq!(rows(&new.join("rollback.db")), 2);
        assert_eq!(snapshot(&old), before, "old folder changed");
    }

    #[test]
    fn sqlite_file_copy_kept_only_when_not_written_meanwhile() {
        let (tmp, old, _new) = folders();
        let db = old.join("idle.sqlite3");
        drop(create_db(&db, 10)); // WAL mode, closed: no -wal / -shm, file copy
        let write = |text: &str| {
            let conn = Connection::open(&db).unwrap();
            conn.execute("INSERT INTO t(v) VALUES (?1)", [text]).unwrap();
        };
        let out = tmp.path().join("copy.sqlite3");
        // The old app writes during the first copy: copied again.
        let mut calls = 0;
        copy_stable(&db, &out, 3, || {
            if calls == 0 {
                write("meanwhile");
            }
            calls += 1;
        })
        .unwrap();
        assert_eq!(calls, 2);
        check_and_fold(&out).unwrap();
        assert_eq!(rows(&out), 11);
        remove_sqlite_files(&out);
        // Written during every copy: given up, nothing left (next start).
        let error = copy_stable(&db, &out, 3, || write("again")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(leftovers(tmp.path()).is_empty() && !out.exists());
    }

    #[test]
    fn journal_being_written_keeps_complete_lines_only() {
        let (_tmp, old, new) = folders();
        write(&old.join("sessions/a.jsonl"), "{\"n\":1}\n{\"n\":2}\n{\"n\":3,\"te");
        write(&old.join("sessions/b.jsonl"), "{\"n\":1}\n{\"n\":2}");
        write(&old.join("notes.txt"), "no newline at the end");
        let report = migrate_part(Part::Data, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(read(&new.join("sessions/a.jsonl")), "{\"n\":1}\n{\"n\":2}\n");
        assert_eq!(read(&new.join("sessions/b.jsonl")), "{\"n\":1}\n");
        assert_eq!(read(&new.join("notes.txt")), "no newline at the end");
    }

    #[test]
    fn skips_runtime_files_and_browser_caches() {
        let (_tmp, old, new) = folders();
        let profile = old.join("gemini-web/browser-profile");
        write(&old.join("daemon.json"), "{\"port\":1}");
        write(&old.join("logs/daemon.log"), "log\n");
        write(&old.join("gemini-web/cookies.json"), "{}");
        write(&profile.join("SingletonLock"), "x");
        write(&profile.join("Default/Cache/Cache_Data/data_0"), "c");
        write(&profile.join("Default/Local Storage/leveldb/LOCK"), "");
        write(&profile.join("Default/Local Storage/leveldb/000003.log"), "kv");
        let report = migrate_part(Part::Data, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(!new.join("daemon.json").exists(), "never attach to the old daemon");
        assert_eq!(read(&new.join("logs/daemon.log")), "log\n");
        assert_eq!(read(&new.join("gemini-web/cookies.json")), "{}");
        let copied = new.join("gemini-web/browser-profile");
        assert!(!copied.join("SingletonLock").exists());
        assert!(!copied.join("Default/Cache").exists());
        assert!(!copied.join("Default/Local Storage/leveldb/LOCK").exists());
        assert_eq!(read(&copied.join("Default/Local Storage/leveldb/000003.log")), "kv");
    }

    #[test]
    fn free_conversations_point_to_the_new_scratch_folder_in_the_copies() {
        assert_eq!(SCRATCH_DIR_NAME, axecode_daemon::scratch::SCRATCH_DIR);
        let (tmp, old, new) = folders();
        let path = |p: &Path| p.to_string_lossy().to_string();
        let old_scratch = old.canonicalize().unwrap().join(SCRATCH_DIR_NAME);
        let (root, s1) = (path(&old_scratch), path(&old_scratch.join("s1")));
        let other = path(&tmp.path().join("projet"));
        let scratchy = format!("{root}y");
        let created = |ws: &str| format!("{}\n", json!({"kind": "session_created", "workspace_id": ws}));
        let said = |text: &str| format!("{}\n", json!({"kind": "message", "text": text}));
        write(&old.join("sessions/s1.jsonl"), &[created(&s1), said(&s1), created(&other), created(&scratchy)].concat());
        let live = Connection::open(old.join("desktop-state.sqlite3")).unwrap();
        live.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
             CREATE TABLE conversations(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);",
        )
        .unwrap();
        for (id, ws) in [("a", &root), ("b", &s1), ("c", &other), ("d", &scratchy)] {
            live.execute("INSERT INTO conversations VALUES (?1, ?2)", [id, ws.as_str()]).unwrap();
        }
        let before = snapshot(&old);
        let report = migrate_part(Part::Data, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        let new_scratch = new.canonicalize().unwrap().join(SCRATCH_DIR_NAME);
        let n1 = path(&new_scratch.join("s1"));
        let expected = [created(&n1), said(&s1), created(&other), created(&scratchy)].concat();
        assert_eq!(read(&new.join("sessions/s1.jsonl")), expected);
        {
            let copy = Connection::open(new.join("desktop-state.sqlite3")).unwrap();
            let ws = |id: &str| -> String {
                copy.query_row("SELECT workspace_id FROM conversations WHERE id = ?1", [id], |r| r.get(0)).unwrap()
            };
            assert_eq!(ws("a"), path(&new_scratch));
            assert_eq!(ws("b"), n1);
            assert_eq!(ws("c"), other);
            assert_eq!(ws("d"), scratchy);
        }
        assert_eq!(snapshot(&old), before, "old folder changed");
        let kept: String = live
            .query_row("SELECT workspace_id FROM conversations WHERE id = 'b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, s1);
    }

    #[test]
    fn windows_paths_rewritten_only_at_a_folder_boundary() {
        let rewrite = Rewrite {
            prefixes: vec![(r"\\?\C:\U\old-app\data\scratch".into(), r"\\?\C:\U\new-app\data\scratch".into())],
        };
        let line = |ws: &str| json!({"kind": "session_created", "workspace_id": ws}).to_string();
        let text = [
            line(r"\\?\C:\U\old-app\data\scratch\abc"),
            line(r"\\?\C:\U\old-app\data\scratch"),
            line(r"\\?\C:\U\old-app\data\scratchy"),
            line(r"C:\elsewhere"),
        ]
        .join("\n");
        let expected = [
            line(r"\\?\C:\U\new-app\data\scratch\abc"),
            line(r"\\?\C:\U\new-app\data\scratch"),
            line(r"\\?\C:\U\old-app\data\scratchy"),
            line(r"C:\elsewhere"),
        ]
        .join("\n");
        assert_eq!(rewrite.journal(text.as_bytes()).as_deref(), Some(expected.as_str()));
        assert_eq!(rewrite.journal(line(r"C:\elsewhere").as_bytes()), None);
    }

    #[test]
    fn agents_part_copies_only_the_settings() {
        let (_tmp, old, new) = folders();
        write(&old.join(AGENTS_SETTINGS_FILE), "{\"modele\":\"x\"}");
        write(&old.join("desktop-state.sqlite3"), "not ours");
        let report = migrate_part(Part::Agents, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(read(&new.join(AGENTS_SETTINGS_FILE)), "{\"modele\":\"x\"}");
        assert!(!new.join("desktop-state.sqlite3").exists());
        assert!(migrate_part(Part::Agents, &old, &new).is_none());
    }

    #[test]
    fn webview_profile_copied_once_without_caches() {
        let (tmp, old, new) = folders();
        write(&old.join("Local State"), "{}");
        write(&old.join("Default/Local Storage/leveldb/000003.log"), "kv");
        write(&old.join("Default/Local Storage/leveldb/LOCK"), "");
        write(&old.join("Default/Cache/Cache_Data/data_0"), "c");
        write(&old.join("Default/Code Cache/js/index"), "c");
        write(&old.join("Default/GPUCache/data_1"), "c");
        write(&old.join("Default/Service Worker/CacheStorage/x"), "c");
        write(&old.join("Default/Service Worker/Database/CURRENT"), "db");
        let before = snapshot(&old);
        let report = migrate_part(Part::Webview, &old, &new).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(read(&new.join("Local State")), "{}");
        assert_eq!(read(&new.join("Default/Local Storage/leveldb/000003.log")), "kv");
        assert_eq!(read(&new.join("Default/Service Worker/Database/CURRENT")), "db");
        for cache in ["Default/Cache", "Default/Code Cache", "Default/GPUCache", "Default/Service Worker/CacheStorage"] {
            assert!(!new.join(cache).exists(), "{cache} copied");
        }
        assert!(!new.join("Default/Local Storage/leveldb/LOCK").exists());
        assert!(leftovers(tmp.path()).is_empty());
        assert_eq!(snapshot(&old), before, "old profile changed");
        assert!(migrate_part(Part::Webview, &old, &new).is_none());
        assert!(!new.join(Part::Webview.marker()).exists(), "nothing foreign in the profile");
        // A profile already created by the new app is never touched.
        let (_tmp2, old2, new2) = folders();
        write(&old2.join("Local State"), "{}");
        write(&new2.join("Preferences"), "new");
        assert!(migrate_part(Part::Webview, &old2, &new2).is_none());
        assert!(!new2.join("Local State").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_warns_in_a_profile_and_retries_in_the_data() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, old, new) = folders();
        let locked = old.join("Default/Network/Cookies");
        write(&locked, "secret");
        write(&old.join("Local State"), "{}");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if File::open(&locked).is_ok() {
            return; // run as root: every file is readable
        }
        let report = migrate_part(Part::Webview, &old, &new.join("profile")).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
        assert!(new.join("profile/Local State").is_file());
        // App data: an error, no marker, so the next start tries again.
        let data = new.join("data");
        let report = migrate_part(Part::Data, &old, &data).unwrap();
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(!data.join(Part::Data.marker()).exists());
        assert!(data.join(Part::Data.errors_file()).is_file());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        let report = migrate_part(Part::Data, &old, &data).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!((report.copied, report.kept), (1, 1));
        assert_eq!(read(&data.join("Default/Network/Cookies")), "secret");
        assert!(data.join(Part::Data.marker()).is_file());
        assert!(!data.join(Part::Data.errors_file()).exists());
    }

    #[test]
    fn run_skips_missing_folders() {
        let (tmp, old, new) = folders();
        write(&old.join("a.json"), "{}");
        let loc = Locations {
            old_data: Some(old.clone()),
            new_data: Some(new.clone()),
            old_home: Some(tmp.path().join("absent")),
            new_home: Some(tmp.path().join("home-new")),
            ..Locations::default()
        };
        let reports = run(&loc);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].0, Part::Data);
        assert!(!tmp.path().join("home-new").exists());
        assert_eq!(read(&new.join("a.json")), "{}");
    }

    /// The old rename script rewrote every old name found outside the
    /// `rebrand:keep` markers: the migration would then copy the new folders
    /// onto themselves. The expected values are built from pieces.
    #[test]
    fn old_names_survive_the_rebrand_script() {
        assert_eq!(OLD_APP_NAME, "ancienne-app");
        assert_eq!(OLD_AGENTS_APP_NAME, "ancienne-app-agents");
        assert_eq!(OLD_HOME_DIR, ".ancienne-app");
        assert_eq!(OLD_IDENTIFIER, "ancienne.app");
        for (before, after) in [
            (OLD_APP_NAME, NEW_APP_NAME),
            (OLD_HOME_DIR, NEW_HOME_DIR),
            (OLD_IDENTIFIER, NEW_IDENTIFIER),
        ] {
            assert_ne!(before, after);
        }
    }
}


/// SavIDE (ex-« Atelier ») : copie une seule fois les données de l'ancienne
/// édition vers les nouveaux dossiers, seulement quand le nouveau dossier
/// n'existe pas encore. Les anciens dossiers ne sont jamais modifiés.
fn reprise_atelier() {
    let mut paires: Vec<(PathBuf, PathBuf)> = Vec::new();
    if let Some(home) = directories::BaseDirs::new() {
        paires.push((home.home_dir().join(".atelier"), home.home_dir().join(".savide")));
        let local = home.data_local_dir();
        if let (Some(a), Some(b)) = (webview_profile(local, "fr.atelier.app"), webview_profile(local, "fr.savide.app")) {
            paires.push((a, b));
        }
    }
    if let (Some(a), Some(b)) = (
        directories::ProjectDirs::from("fr", "atelier", "atelier"),
        directories::ProjectDirs::from("fr", "savide", "savide"),
    ) {
        paires.push((a.config_dir().to_path_buf(), b.config_dir().to_path_buf()));
        paires.push((a.data_dir().to_path_buf(), b.data_dir().to_path_buf()));
        paires.push((a.data_local_dir().to_path_buf(), b.data_local_dir().to_path_buf()));
    }
    if let (Some(a), Some(b)) = (
        directories::ProjectDirs::from("", "", "atelier"),
        directories::ProjectDirs::from("", "", "savide"),
    ) {
        paires.push((a.data_dir().to_path_buf(), b.data_dir().to_path_buf()));
    }
    paires.sort();
    paires.dedup();
    for (ancien, nouveau) in paires {
        if ancien == nouveau || !ancien.is_dir() || nouveau.exists() {
            continue;
        }
        match copier_dossier(&ancien, &nouveau) {
            Ok(()) => tracing::info!(de = %ancien.display(), vers = %nouveau.display(), "reprise Atelier"),
            Err(e) => tracing::warn!(de = %ancien.display(), "reprise Atelier échouée : {e}"),
        }
    }
}

fn copier_dossier(de: &Path, vers: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(vers)?;
    for entree in std::fs::read_dir(de)? {
        let entree = entree?;
        let type_ = entree.file_type()?;
        let cible = vers.join(entree.file_name());
        if type_.is_dir() {
            copier_dossier(&entree.path(), &cible)?;
        } else if type_.is_file() {
            std::fs::copy(entree.path(), &cible)?;
        }
    }
    Ok(())
}
