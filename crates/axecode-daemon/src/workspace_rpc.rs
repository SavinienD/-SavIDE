//! V2 L2 workspace RPC helpers. Client paths are relative to the service-configured root.
use crate::Daemon;
use serde_json::{json, Value};
use axecode_core::{SessionError, SessionResult};
use std::{
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_EDIT: usize = 1024 * 1024;
pub(crate) fn root(d: &Daemon) -> SessionResult<PathBuf> {
    let raw = d
        .config
        .workspace_root
        .as_ref()
        .ok_or_else(|| SessionError::Protocol("workspace root is not configured".into()))?;
    let p = raw
        .canonicalize()
        .map_err(|e| SessionError::Io(e.to_string()))?;
    if !p.is_dir() {
        return Err(SessionError::Protocol(
            "workspace root is not a directory".into(),
        ));
    }
    Ok(p)
}
pub(crate) fn rel(s: &str) -> SessionResult<PathBuf> {
    let p = Path::new(s);
    if s.is_empty()
        || p.is_absolute()
        || s.contains('\\')
        || s.contains(':')
        || s.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
        })
    {
        return Err(SessionError::Protocol("invalid relative path".into()));
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(x) if x != ".git" => out.push(x),
            _ => return Err(SessionError::Protocol("invalid relative path".into())),
        }
    }
    Ok(out)
}
pub(crate) fn resolve(root: &Path, s: &str, missing: bool) -> SessionResult<PathBuf> {
    let relative = rel(s)?;
    let mut walk = root.to_path_buf();
    for component in relative.components() {
        if let Component::Normal(part) = component {
            walk.push(part);
            match std::fs::symlink_metadata(&walk) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(SessionError::Protocol(
                        "symbolic links are disabled in the remote workspace".into(),
                    ))
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(SessionError::Io(e.to_string())),
            }
        }
    }
    let joined = root.join(relative);
    let p = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| SessionError::Io(e.to_string()))?
    } else if missing {
        let par = joined
            .parent()
            .ok_or_else(|| SessionError::Protocol("invalid path".into()))?
            .canonicalize()
            .map_err(|e| SessionError::Io(e.to_string()))?;
        if !par.starts_with(root) {
            return Err(SessionError::Protocol("path escapes workspace root".into()));
        }
        joined
    } else {
        return Err(SessionError::Protocol("path not found".into()));
    };
    if !p.starts_with(root) {
        return Err(SessionError::Protocol("path escapes workspace root".into()));
    }
    Ok(p)
}
pub(crate) fn git_command(repo: &Path) -> Command {
    let mut command = Command::new("git");
    // Do not inherit Git routing/config overrides from the daemon environment.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .arg("-C")
        .arg(repo)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "core.pager=cat",
        ]);
    command
}
/// Commit `paths` through a private temporary index: the user's real index is
/// never modified by the transaction, and HEAD only moves by compare-and-swap.
pub(crate) fn git_commit_transactional(
    repo: &Path,
    paths: &[String],
    msg: &str,
) -> SessionResult<String> {
    git_commit_inner(repo, paths, msg, false)
}

/// Same transaction, but stages removals as well (V2 L4 `share.unpublish`).
pub(crate) fn git_commit_transactional_removal(
    repo: &Path,
    paths: &[String],
    msg: &str,
) -> SessionResult<String> {
    git_commit_inner(repo, paths, msg, true)
}

fn git_commit_inner(
    repo: &Path,
    paths: &[String],
    msg: &str,
    add_all: bool,
) -> SessionResult<String> {
    fn run(mut c: Command, what: &str) -> SessionResult<Vec<u8>> {
        let o = c.output().map_err(|e| SessionError::Io(e.to_string()))?;
        if !o.status.success() {
            return Err(SessionError::Protocol(format!("git {what} failed")));
        }
        Ok(o.stdout)
    }
    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8_lossy(&bytes).trim().to_string()
    }
    let head = git_command(repo)
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .output()
        .map_err(|e| SessionError::Io(e.to_string()))?;
    let old_head = if head.status.success() {
        Some(text(head.stdout))
    } else {
        None
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_index = repo
        .join(".git")
        .join(format!("axe-index-{}-{}", std::process::id(), nanos));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let mut lock = self.0.clone().into_os_string();
            lock.push(".lock");
            let _ = std::fs::remove_file(lock);
        }
    }
    let _cleanup = Cleanup(tmp_index.clone());
    let tx = |args: &[&str]| {
        let mut c = git_command(repo);
        c.env("GIT_INDEX_FILE", &tmp_index);
        c.args(args);
        c
    };
    match &old_head {
        Some(h) => run(tx(&["read-tree", h]), "read-tree")?,
        None => run(tx(&["read-tree", "--empty"]), "read-tree")?,
    };
    let mut add = if add_all {
        tx(&["add", "-A", "--"])
    } else {
        tx(&["add", "--"])
    };
    for x in paths {
        add.arg(x);
    }
    run(add, "add")?;
    let tree = text(run(tx(&["write-tree"]), "write-tree")?);
    if tree.is_empty() {
        return Err(SessionError::Protocol("git write-tree failed".into()));
    }
    let mut ct = tx(&["commit-tree", &tree, "-m", msg]);
    if let Some(h) = &old_head {
        ct.args(["-p", h]);
    }
    let commit = text(run(ct, "commit-tree")?);
    if commit.is_empty() {
        return Err(SessionError::Protocol("git commit-tree failed".into()));
    }
    let expected = old_head.clone().unwrap_or_default();
    let mut upd = git_command(repo);
    upd.args([
        "update-ref",
        "-m",
        "axecode commit",
        "HEAD",
        &commit,
        &expected,
    ]);
    run(upd, "update-ref (HEAD changed concurrently)")?;
    // Align the real index entries of the committed paths with the new HEAD so
    // the user's index does not show the commit as reversed staged changes.
    let mut sync = git_command(repo);
    sync.args(["reset", "-q", "--"]);
    for x in paths {
        sync.arg(x);
    }
    let _ = sync.output();
    Ok(format!(
        "[{}] {}\n",
        &commit[..commit.len().min(7)],
        msg.lines().next().unwrap_or("")
    ))
}
fn git_root(root: &Path) -> SessionResult<PathBuf> {
    // Linked worktrees/submodules may redirect Git metadata outside the root.
    let metadata = std::fs::symlink_metadata(root.join(".git"))
        .map_err(|_| SessionError::Protocol("workspace requires a local Git directory".into()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(SessionError::Protocol(
            "external Git directories are disabled".into(),
        ));
    }
    // Fail closed for executable filters and repository redirections. This is
    // intentionally stricter than a desktop Git client until isolated Git is available.
    let unsafe_config = git_command(root).args([
        "config", "--local", "--no-includes", "--get-regexp",
        r"^(include\.|includeif\.|filter\.|diff\.|merge\.|core\.(worktree|sshcommand)|extensions\.)",
    ]).output().map_err(|_| SessionError::Protocol("unable to inspect Git configuration".into()))?;
    if unsafe_config.status.code() != Some(1) {
        return Err(SessionError::Protocol(
            "repository configuration requires unsupported Git features".into(),
        ));
    }
    for entry in ["index", "HEAD", "config", "objects", "refs", "commondir"] {
        let path = root.join(".git").join(entry);
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() || entry == "commondir" {
                return Err(SessionError::Protocol(
                    "redirected Git metadata is disabled".into(),
                ));
            }
        }
    }
    if root.join(".git/objects/info/alternates").exists() {
        return Err(SessionError::Protocol(
            "alternate Git object stores are disabled".into(),
        ));
    }
    let output = git_command(root)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| SessionError::Io(e.to_string()))?;
    if !output.status.success() {
        return Err(SessionError::Protocol(
            "workspace is not a Git repository".into(),
        ));
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let repo = PathBuf::from(raw)
        .canonicalize()
        .map_err(|e| SessionError::Io(e.to_string()))?;
    if !repo.starts_with(root) {
        return Err(SessionError::Protocol(
            "Git repository root is outside the workspace".into(),
        ));
    }
    Ok(repo)
}

/// axe:v2-l4.1 — dépot ciblé : racine de l'espace par défaut, ou sous-dossier choisi par le client.
fn git_repo(root: &Path, p: &Value) -> SessionResult<PathBuf> {
    let raw = p.get("path").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let dir = if raw.is_empty() || raw == "." {
        root.to_path_buf()
    } else {
        resolve(root, &raw, false)?
    };
    git_root(&dir)
}

/// axe:v2-l4.1 — dépts Git sous la racine de l'espace (profondeur bornée), pour le selecteur de l'UI.
fn scan_repos(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if out.len() >= 50 {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "build" | "vendor"
            )
        {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        let git = std::fs::symlink_metadata(e.path().join(".git"));
        if git
            .map(|m| m.is_dir() && !m.file_type().is_symlink())
            .unwrap_or(false)
        {
            out.push(json!({
                "path": e.path().strip_prefix(root).unwrap_or(Path::new(""))
                    .to_string_lossy().replace('\\', "/"),
                "name": name,
                "isRepo": true
            }));
            continue;
        }
        if depth > 1 {
            scan_repos(root, &e.path(), depth - 1, out);
        }
    }
}

fn virt(root: &Path, p: &Path) -> String {
    let r = p
        .strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/");
    if r.is_empty() {
        "/work".into()
    } else {
        format!("/work/{r}")
    }
}
fn opt(p: &Value, k: &str) -> SessionResult<String> {
    p.get(k)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| SessionError::Protocol(format!("{k} is required")))
}

// axe:v2-l2.4 — index « ouvrir vite », corbeille réversible et Git complet.

const INDEX_DEFAULT_LIMIT: usize = 20_000;
const INDEX_MAX_LIMIT: usize = 50_000;
const INDEX_IGNORED: [&str; 9] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".next",
    ".cache",
];
/// Délai maximal d'une commande Git (push/pull distants compris).
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// `EXDEV` (Linux) : `rename` à travers deux volumes.
const EXDEV: i32 = 18;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Date UTC (année, mois, jour) d'un nombre de jours depuis l'époque Unix.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Identifiant de corbeille : `AAAAMMJJ-HHMMSS-xxxxxx` (UTC + suffixe court).
fn trash_id() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let suffix = (now.subsec_nanos() as u64 ^ (std::process::id() as u64)) & 0xFF_FFFF;
    format!("{y:04}{mo:02}{d:02}-{hh:02}{mm:02}{ss:02}-{suffix:06x}")
}

/// `true` si le chemin relatif est sous `.axecode/corbeille` (interdit).
fn under_trash(relative: &Path) -> bool {
    let mut it = relative.components().filter_map(|c| match c {
        Component::Normal(x) => x.to_str(),
        _ => None,
    });
    it.next() == Some(".axecode") && it.next() == Some("corbeille")
}

/// Corbeille d'un espace : dans les données du service, jamais dans le projet.
fn trash_root(d: &Daemon, r: &Path) -> PathBuf {
    axecode_harness::datadir::project_data_dir_in(d.data_dir(), r).join("corbeille")
}

/// Corbeilles lues : la nouvelle, puis l'ancienne `<projet>/.axecode/corbeille`
/// si elle existe déjà (jamais créée).
fn trash_roots(d: &Daemon, r: &Path) -> Vec<PathBuf> {
    vec![trash_root(d, r), r.join(".axecode").join("corbeille")]
}

/// Déplacement même-volume, avec repli copie+suppression hors volume.
fn move_entry(src: &Path, dst: &Path) -> SessionResult<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(EXDEV) => {
            copy_tree(src, dst)?;
            remove_entry(src)
        }
        Err(e) => Err(SessionError::Io(e.to_string())),
    }
}

fn copy_tree(src: &Path, dst: &Path) -> SessionResult<()> {
    let meta = std::fs::symlink_metadata(src).map_err(|e| SessionError::Io(e.to_string()))?;
    if meta.file_type().is_symlink() {
        return Err(SessionError::Protocol(
            "symbolic links are disabled in the remote workspace".into(),
        ));
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| SessionError::Io(e.to_string()))?;
        for entry in std::fs::read_dir(src).map_err(|e| SessionError::Io(e.to_string()))? {
            let entry = entry.map_err(|e| SessionError::Io(e.to_string()))?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| SessionError::Io(e.to_string()))?;
        }
        std::fs::copy(src, dst).map_err(|e| SessionError::Io(e.to_string()))?;
    }
    Ok(())
}

fn remove_entry(p: &Path) -> SessionResult<()> {
    let meta = std::fs::symlink_metadata(p).map_err(|e| SessionError::Io(e.to_string()))?;
    let res = if meta.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
    res.map_err(|e| SessionError::Io(e.to_string()))
}

/// Parcours récursif (sans suivre les liens) : ne conserve que les fichiers.
fn index_walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        if ft.is_dir() {
            if INDEX_IGNORED.contains(&name.to_string_lossy().as_ref()) {
                continue;
            }
            index_walk(root, &entry.path(), out);
        } else if ft.is_file() {
            if let Ok(relp) = entry.path().strip_prefix(root) {
                out.push(relp.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Dépôt ciblé par les RPC Git récentes : `repoPath` (avec repli `path`).
fn git_repo_at(root: &Path, p: &Value) -> SessionResult<PathBuf> {
    let raw = p
        .get("repoPath")
        .and_then(Value::as_str)
        .or_else(|| p.get("path").and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string();
    let dir = if raw.is_empty() || raw == "." {
        root.to_path_buf()
    } else {
        resolve(root, &raw, false)?
    };
    git_root(&dir)
}

/// Exécute `git -C <repo> <args>` (sans shell), avec délai maximal.
/// Renvoie `(code, stdout+stderr)`.
fn git_run(repo: &Path, args: &[&str]) -> SessionResult<(i32, String)> {
    let mut child = git_command(repo)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| SessionError::Io(e.to_string()))?;
    let mut out = child
        .stdout
        .take()
        .ok_or_else(|| SessionError::Protocol("git stdout unavailable".into()))?;
    let mut err = child
        .stderr
        .take()
        .ok_or_else(|| SessionError::Protocol("git stderr unavailable".into()))?;
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| SessionError::Io(e.to_string()))? {
            Some(s) => break s,
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(SessionError::Protocol("git command timed out".into()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    let mut text = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
    text.push_str(&String::from_utf8_lossy(&t_err.join().unwrap_or_default()));
    Ok((status.code().unwrap_or(-1), text))
}

fn git_current_branch(repo: &Path) -> SessionResult<String> {
    let (code, out) = git_run(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if code != 0 {
        return Err(SessionError::Protocol("git current branch failed".into()));
    }
    Ok(out.trim().to_string())
}

/// `[{"path","branch","head"}]` à partir de `git worktree list --porcelain`.
fn parse_worktrees(root: &Path, out: &str) -> Vec<Value> {
    let mut list = Vec::new();
    let mut cur: Option<(String, Option<String>, Option<String>)> = None;
    let flush = |cur: &mut Option<(String, Option<String>, Option<String>)>,
                 list: &mut Vec<Value>| {
        if let Some((path, head, branch)) = cur.take() {
            list.push(json!({
                "path": virt(root, Path::new(path.as_str())),
                "branch": branch,
                "head": head,
            }));
        }
    };
    for line in out.lines() {
        if line.is_empty() {
            flush(&mut cur, &mut list);
            continue;
        }
        if let Some(v) = line.strip_prefix("worktree ") {
            flush(&mut cur, &mut list);
            cur = Some((v.to_string(), None, None));
        } else if let Some(v) = line.strip_prefix("HEAD ") {
            if let Some(c) = cur.as_mut() {
                c.1 = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("branch ") {
            if let Some(c) = cur.as_mut() {
                c.2 = Some(v.strip_prefix("refs/heads/").unwrap_or(v).to_string());
            }
        } else if line == "detached" {
            if let Some(c) = cur.as_mut() {
                c.2 = None;
            }
        }
    }
    flush(&mut cur, &mut list);
    list
}

pub fn dispatch(d: &Daemon, m: &str, p: &Value) -> SessionResult<Value> {
    let r = root(d)?;
    match m {
        "fs.root" => Ok(json!({"path":"/work","name":"work"})),
        "fs.list" => {
            let raw = p.get("path").and_then(Value::as_str).unwrap_or("");
            let dir = if raw.is_empty() {
                r.clone()
            } else {
                resolve(&r, raw, false)?
            };
            if !dir.is_dir() {
                return Err(SessionError::Protocol("not a directory".into()));
            }
            let mut es = axecode_app::list_workspace_entries(
                &r,
                if raw.is_empty() { None } else { Some(raw) },
            )
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
            es.retain(|e| resolve(&r, &e.relative_path, false).is_ok());
            for e in &mut es {
                e.absolute_path = virt(&r, &r.join(&e.relative_path));
            }
            Ok(serde_json::to_value(es)?)
        }
        "fs.read" => {
            let s = opt(p, "path")?;
            let path = resolve(&r, &s, false)?;
            let mut doc = axecode_app::read_workspace_file(&r, &s)
                .map_err(|e| SessionError::Protocol(e.to_string()))?;
            doc.absolute_path = virt(&r, &path);
            Ok(serde_json::to_value(doc)?)
        }
        "fs.write" => {
            let s = opt(p, "path")?;
            let c = opt(p, "content")?;
            if c.len() > MAX_EDIT {
                return Err(SessionError::Protocol("file exceeds 1 MiB".into()));
            }
            let path = resolve(&r, &s, false)?;
            let mut doc = axecode_app::write_workspace_file(&r, &s, &c)
                .map_err(|e| SessionError::Protocol(e.to_string()))?;
            doc.absolute_path = virt(&r, &path);
            d.broadcast("workspace_changed", None, json!({"path":virt(&r,&path)}));
            Ok(serde_json::to_value(doc)?)
        }
        // axe:push-dossier - ecriture binaire par morceaux (base64), append pour les gros fichiers.
        "fs.write_bytes" => {
            use base64::Engine as _;
            let s = opt(p, "path")?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(opt(p, "data")?)
                .map_err(|e| SessionError::Protocol(e.to_string()))?;
            let append = p.get("append").and_then(Value::as_bool).unwrap_or(false);
            // axe:push-dossier - creer les dossiers parents AVANT resolve (sinon « path not found »).
            if let Some(par) = rel(&s)?.parent() { std::fs::create_dir_all(r.join(par)).map_err(|e| SessionError::Protocol(e.to_string()))?; }
            let path = resolve(&r, &s, true)?;
            if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| SessionError::Protocol(e.to_string()))?; }
            let mut f = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append)
                .open(&path).map_err(|e| SessionError::Protocol(e.to_string()))?;
            std::io::Write::write_all(&mut f, &data).map_err(|e| SessionError::Protocol(e.to_string()))?;
            Ok(json!({"ok": true, "bytes": data.len()}))
        }
        "fs.search" => {
            let q = p.get("query").and_then(Value::as_str).unwrap_or("");
            let mut v = serde_json::to_value(
                axecode_app::search_workspace_files(&r, q)
                    .map_err(|e| SessionError::Protocol(e.to_string()))?,
            )?;
            if let Some(fs) = v.get_mut("files").and_then(Value::as_array_mut) {
                for f in fs {
                    if let Some(x) = f
                        .get("relativePath")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                    {
                        f["absolutePath"] = json!(format!("/work/{x}"));
                    }
                }
            }
            Ok(v)
        }
        // axe:v2-l2.4 — index complet des fichiers de l'espace (« ouvrir vite »).
        "fs.index" => {
            let limit = p
                .get("limit")
                .and_then(Value::as_u64)
                .map(|n| n as usize)
                .unwrap_or(INDEX_DEFAULT_LIMIT)
                .min(INDEX_MAX_LIMIT);
            let mut paths = Vec::new();
            index_walk(&r, &r, &mut paths);
            paths.sort();
            let truncated = paths.len() > limit;
            paths.truncate(limit);
            Ok(json!({"paths": paths, "truncated": truncated}))
        }
        // axe:v2-l2.4 — suppression réversible : déplacement sous `.axecode/corbeille`.
        "fs.trash" => {
            let s = opt(p, "path")?;
            let relative = rel(&s)?;
            if under_trash(&relative) {
                return Err(SessionError::Protocol(
                    "cannot trash an entry from the trash".into(),
                ));
            }
            let src = resolve(&r, &s, false)?;
            let name = src
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| SessionError::Protocol("invalid name".into()))?
                .to_string();
            let id = trash_id();
            let dest_dir = trash_root(d, &r).join(&id);
            std::fs::create_dir_all(&dest_dir).map_err(|e| SessionError::Io(e.to_string()))?;
            let dest = dest_dir.join(&name);
            if let Err(e) = move_entry(&src, &dest) {
                let _ = std::fs::remove_dir_all(&dest_dir);
                return Err(e);
            }
            let trashed_at_ms = now_ms();
            let rel_str = relative.to_string_lossy().replace('\\', "/");
            let meta = json!({"path": rel_str, "trashedAtMs": trashed_at_ms});
            if let Err(e) = std::fs::write(dest_dir.join("meta.json"), serde_json::to_vec(&meta)?)
            {
                let _ = std::fs::remove_dir_all(&dest_dir);
                return Err(SessionError::Io(e.to_string()));
            }
            d.broadcast(
                "workspace_changed",
                None,
                json!({"path": format!("/work/{rel_str}")}),
            );
            Ok(json!({
                "id": id,
                "path": rel_str,
                "name": name,
                "trashedAtMs": trashed_at_ms,
            }))
        }
        // axe:v2-l2.4 — contenu de la corbeille, du plus récent au plus ancien.
        "fs.trash_list" => {
            let mut out = Vec::new();
            for dir in trash_roots(d, &r) {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let Ok(raw) = std::fs::read_to_string(path.join("meta.json")) else {
                        continue;
                    };
                    let Ok(meta) = serde_json::from_str::<Value>(&raw) else {
                        continue;
                    };
                    let (Some(rel_path), Some(ms)) = (
                        meta.get("path").and_then(Value::as_str),
                        meta.get("trashedAtMs").and_then(Value::as_u64),
                    ) else {
                        continue;
                    };
                    let name = rel_path.rsplit('/').next().unwrap_or(rel_path).to_string();
                    out.push(json!({
                        "id": entry.file_name().to_string_lossy(),
                        "path": rel_path,
                        "name": name,
                        "trashedAtMs": ms,
                    }));
                }
            }
            out.sort_by(|a, b| {
                b["trashedAtMs"]
                    .as_u64()
                    .cmp(&a["trashedAtMs"].as_u64())
            });
            Ok(Value::Array(out))
        }
        // axe:v2-l2.4 — restauration d'une entrée de la corbeille à sa place.
        "fs.restore" => {
            let id = opt(p, "id")?;
            let id_rel = rel(&id)?;
            if id_rel.components().count() != 1 || under_trash(&id_rel) {
                return Err(SessionError::Protocol("invalid trash id".into()));
            }
            let entry_dir = trash_roots(d, &r)
                .into_iter()
                .map(|root| root.join(&id_rel))
                .find(|dir| dir.join("meta.json").is_file())
                .unwrap_or_else(|| trash_root(d, &r).join(&id_rel));
            let raw = std::fs::read_to_string(entry_dir.join("meta.json"))
                .map_err(|_| SessionError::Protocol("trash entry not found".into()))?;
            let meta: Value = serde_json::from_str(&raw)
                .map_err(|_| SessionError::Protocol("unreadable trash entry".into()))?;
            let rel_path = meta
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| SessionError::Protocol("unreadable trash entry".into()))?
                .to_string();
            let relative = rel(&rel_path)?;
            let target = r.join(&relative);
            if std::fs::symlink_metadata(&target).is_ok() {
                return Err(SessionError::Protocol(
                    "restore target already exists".into(),
                ));
            }
            let parent = target
                .parent()
                .ok_or_else(|| SessionError::Protocol("invalid path".into()))?;
            if !parent.is_dir() {
                return Err(SessionError::Protocol(
                    "restore parent directory is gone".into(),
                ));
            }
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            if !canonical_parent.starts_with(&r) {
                return Err(SessionError::Protocol("path escapes workspace root".into()));
            }
            let name = relative
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| SessionError::Protocol("invalid name".into()))?;
            let src = entry_dir.join(name);
            if std::fs::symlink_metadata(&src).is_err() {
                return Err(SessionError::Protocol("trashed item is missing".into()));
            }
            move_entry(&src, &target)?;
            let _ = std::fs::remove_dir_all(&entry_dir);
            d.broadcast(
                "workspace_changed",
                None,
                json!({"path": format!("/work/{rel_path}")}),
            );
            Ok(json!({"path": rel_path}))
        }
        "fs.create_file" | "fs.mkdir" => {
            let s = opt(p, "path")?;
            resolve(&r, &s, true)?;
            let x = rel(&s)?;
            let parent = x
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .map(|p| p.to_string_lossy().into_owned());
            let name = x
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| SessionError::Protocol("invalid name".into()))?;
            let mut e = if m == "fs.mkdir" {
                axecode_app::create_workspace_directory(&r, parent.as_deref(), name)
            } else {
                axecode_app::create_workspace_file(&r, parent.as_deref(), name)
            }
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
            e.absolute_path = format!("/work/{}", e.relative_path);
            Ok(serde_json::to_value(e)?)
        }
        "fs.rename" => {
            let s = opt(p, "path")?;
            let n = opt(p, "newName")?;
            resolve(&r, &s, false)?;
            let name = rel(&n)?;
            if name.components().count() != 1 {
                return Err(SessionError::Protocol(
                    "newName must be a single filename".into(),
                ));
            }
            let destination = rel(&s)?.parent().unwrap_or(Path::new("")).join(&name);
            resolve(&r, &destination.to_string_lossy(), true)?;
            let mut e = axecode_app::rename_workspace_entry(&r, &s, &n)
                .map_err(|e| SessionError::Protocol(e.to_string()))?;
            e.absolute_path = format!("/work/{}", e.relative_path);
            Ok(serde_json::to_value(e)?)
        }
        "fs.delete" => {
            let s = opt(p, "path")?;
            resolve(&r, &s, false)?;
            axecode_app::delete_workspace_entry(&r, &s)
                .map_err(|e| SessionError::Protocol(e.to_string()))?;
            Ok(json!({"ok":true}))
        }
        "git.status" => {
            let repo = git_repo(&r, &p)?;
            let o = git_command(&repo)
                .args(["status", "--short", "--branch"])
                .output()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            if !o.status.success() {
                return Err(SessionError::Protocol("git status failed".into()));
            }
            Ok(json!({"output":String::from_utf8_lossy(&o.stdout),"workspacePath":"/work","repoPath":virt(&r,&repo)}))
        }
        "git.repos" => {
            let is_repo = |p: PathBuf| {
                std::fs::symlink_metadata(p)
                    .map(|m| m.is_dir() && !m.file_type().is_symlink())
                    .unwrap_or(false)
            };
            let mut out = vec![json!({
                "path": "",
                "name": "work",
                "isRepo": is_repo(r.join(".git"))
            })];
            let mut sub = Vec::new();
            scan_repos(&r, &r, 2, &mut sub);
            out.extend(sub);
            Ok(Value::Array(out))
        }
        "git.commit" => {
            let repo = git_repo(&r, &p)?;
            let msg = opt(p, "message")?;
            if msg.trim().is_empty() || msg.len() > 500 {
                return Err(SessionError::Protocol("invalid commit message".into()));
            }
            let a = p
                .get("paths")
                .and_then(Value::as_array)
                .ok_or_else(|| SessionError::Protocol("paths required".into()))?;
            if a.is_empty() || a.len() > 100 {
                return Err(SessionError::Protocol("select 1-100 paths".into()));
            }
            let mut paths = Vec::new();
            for v in a {
                let s = v
                    .as_str()
                    .ok_or_else(|| SessionError::Protocol("invalid path".into()))?;
                let _ = rel(s)?;
                let cible = resolve(&r, s, false)?;
                let rel_depot = cible.strip_prefix(&repo).map_err(|_| {
                    SessionError::Protocol("path is outside the chosen repository".into())
                })?;
                paths.push(rel_depot.to_string_lossy().replace('\\', "/"));
            }
            let idx = git_command(&repo)
                .args(["diff", "--cached", "--name-only", "-z"])
                .output()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            if !idx.status.success() {
                return Err(SessionError::Protocol("unable to inspect Git index".into()));
            }
            if !idx.stdout.is_empty() {
                return Err(SessionError::Protocol("Git index is not empty".into()));
            }
            let output = git_commit_transactional(&repo, &paths, &msg)?;
            Ok(json!({"message":"Commit created","output":output,"workspacePath":"/work"}))
        }
        // axe:v2-l2.4 — branches locales, branche courante et suivi amont.
        "git.branches" => {
            let repo = git_repo_at(&r, &p)?;
            let current = git_current_branch(&repo)?;
            let (code, out) = git_run(
                &repo,
                &[
                    "for-each-ref",
                    "--format=%(refname:short)|%(upstream:short)",
                    "refs/heads",
                ],
            )?;
            if code != 0 {
                return Err(SessionError::Protocol("git for-each-ref failed".into()));
            }
            let mut branches = Vec::new();
            for line in out.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let (name, upstream) = line.split_once('|').unwrap_or((line, ""));
                if name.is_empty() {
                    continue;
                }
                let upstream = if upstream.is_empty() {
                    Value::Null
                } else {
                    json!(upstream)
                };
                branches.push(json!({
                    "name": name,
                    "current": name == current,
                    "upstream": upstream,
                }));
            }
            Ok(json!({"current": current, "branches": branches}))
        }
        // axe:v2-l2.4 — changement de branche (avec création optionnelle).
        "git.checkout" => {
            let repo = git_repo_at(&r, &p)?;
            let branch = opt(p, "branch")?;
            if branch.trim().is_empty()
                || branch.chars().any(char::is_whitespace)
                || branch.starts_with('-')
            {
                return Err(SessionError::Protocol("invalid branch name".into()));
            }
            let create = p
                .get("create")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let args: Vec<&str> = if create {
                vec!["switch", "-c", &branch]
            } else {
                vec!["switch", &branch]
            };
            let (code, out) = git_run(&repo, &args)?;
            if code != 0 {
                return Err(SessionError::Protocol(format!(
                    "git switch failed: {}",
                    out.trim()
                )));
            }
            Ok(json!({"branch": git_current_branch(&repo)?}))
        }
        // axe:v2-l2.4 — push (l'échec est renvoyé, pas une erreur RPC).
        "git.push" => {
            let repo = git_repo_at(&r, &p)?;
            let set_upstream = p
                .get("setUpstream")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (code, out) = if set_upstream {
                let branch = git_current_branch(&repo)?;
                git_run(&repo, &["push", "--set-upstream", "origin", &branch])?
            } else {
                git_run(&repo, &["push"])?
            };
            Ok(json!({"ok": code == 0, "output": out}))
        }
        // axe:v2-l2.4 — pull en avance rapide uniquement.
        "git.pull" => {
            let repo = git_repo_at(&r, &p)?;
            let (code, out) = git_run(&repo, &["pull", "--ff-only"])?;
            Ok(json!({"ok": code == 0, "output": out}))
        }
        // axe:v2-l2.4 — worktrees du dépôt.
        "git.worktrees" => {
            let repo = git_repo_at(&r, &p)?;
            let (code, out) = git_run(&repo, &["worktree", "list", "--porcelain"])?;
            if code != 0 {
                return Err(SessionError::Protocol("git worktree list failed".into()));
            }
            Ok(Value::Array(parse_worktrees(&r, &out)))
        }
        _ => Err(SessionError::Protocol("unknown workspace method".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal() {
        for path in [
            "../x",
            "/etc/passwd",
            ".git/config",
            "a/../x",
            "a/./x",
            "a//x",
            "a/",
            "C:/x",
            "a\\x",
            ".GIT/config",
            "",
        ] {
            assert!(rel(path).is_err(), "accepted {path:?}");
        }
    }
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        daemon: std::sync::Arc<Daemon>,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("l2-fs-{}", uuid::Uuid::new_v4()));
            let root = base.join("work");
            std::fs::create_dir_all(&root).unwrap();
            let mut config = crate::DaemonConfig::new(base.join("data"));
            config.workspace_root = Some(root.clone());
            let daemon = Daemon::new(config, std::sync::Arc::new(crate::stub::EchoFactory));
            Self { base, root, daemon }
        }
        fn call(&self, method: &str, params: Value) -> SessionResult<Value> {
            dispatch(&self.daemon, method, &params)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }
    #[test]
    fn filesystem_roundtrip_and_virtual_paths() {
        let f = Fixture::new();
        assert_eq!(f.call("fs.list", json!({})).unwrap(), json!([]));
        f.call("fs.mkdir", json!({"path":"src"})).unwrap();
        f.call("fs.create_file", json!({"path":"src/demo.txt"}))
            .unwrap();
        let doc = f
            .call(
                "fs.write",
                json!({"path":"src/demo.txt","content":"hello cloud"}),
            )
            .unwrap();
        assert_eq!(doc["absolutePath"], "/work/src/demo.txt");
        let doc = f.call("fs.read", json!({"path":"src/demo.txt"})).unwrap();
        assert_eq!(doc["content"], "hello cloud");
        let found = f.call("fs.search", json!({"query":"hello"})).unwrap();
        assert_eq!(found["totalMatches"], 1);
        assert!(!found
            .to_string()
            .contains(&f.base.to_string_lossy().to_string()));
        f.call(
            "fs.rename",
            json!({"path":"src/demo.txt","newName":"renamed.txt"}),
        )
        .unwrap();
        f.call("fs.delete", json!({"path":"src/renamed.txt"}))
            .unwrap();
        assert!(!f.root.join("src/renamed.txt").exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_read_written_created_or_renamed_through() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = f.base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "outside sentinel").unwrap();
        symlink(&outside, f.root.join("link")).unwrap();
        symlink(outside.join("secret.txt"), f.root.join("alias.txt")).unwrap();
        for (method, params) in [
            ("fs.read", json!({"path":"alias.txt"})),
            ("fs.write", json!({"path":"alias.txt","content":"changed"})),
            ("fs.list", json!({"path":"link"})),
            ("fs.create_file", json!({"path":"link/new.txt"})),
            ("fs.mkdir", json!({"path":"link/newdir"})),
            (
                "fs.rename",
                json!({"path":"alias.txt","newName":"moved.txt"}),
            ),
            ("fs.delete", json!({"path":"alias.txt"})),
        ] {
            assert!(f.call(method, params).is_err(), "accepted {method}");
        }
        assert_eq!(f.call("fs.list", json!({})).unwrap(), json!([]));
        assert_eq!(
            f.call("fs.search", json!({"query":"sentinel"})).unwrap()["totalMatches"],
            0
        );
        assert_eq!(
            std::fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "outside sentinel"
        );
        assert!(!outside.join("new.txt").exists());
    }
    #[test]
    fn git_commit_preserves_preexisting_index_and_disables_hooks() {
        let f = Fixture::new();
        for args in [
            vec!["init"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&f.root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
        std::fs::write(f.root.join("first.txt"), "first").unwrap();
        f.call(
            "git.commit",
            json!({"message":"initial", "paths":["first.txt"]}),
        )
        .unwrap();
        std::fs::write(f.root.join("other.txt"), "other").unwrap();
        assert!(git_command(&f.root)
            .args(["add", "other.txt"])
            .output()
            .unwrap()
            .status
            .success());
        let before = std::fs::read(f.root.join(".git/index")).unwrap();
        std::fs::write(f.root.join("first.txt"), "changed").unwrap();
        assert!(f
            .call(
                "git.commit",
                json!({"message":"must fail", "paths":["first.txt"]})
            )
            .is_err());
        assert_eq!(before, std::fs::read(f.root.join(".git/index")).unwrap());
        assert!(git_command(&f.root)
            .args(["reset", "--", "other.txt"])
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let hook = f.root.join(".git/hooks/pre-commit");
            std::fs::write(&hook, "#!/bin/sh\nexit 91\n").unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        f.call(
            "git.commit",
            json!({"message":"targeted", "paths":["first.txt"]}),
        )
        .unwrap();
        let tracked = git_command(&f.root).args(["ls-files"]).output().unwrap();
        assert_eq!(String::from_utf8(tracked.stdout).unwrap(), "first.txt\n");
    }
    #[test]
    fn git_commit_is_transactional() {
        let f = Fixture::new();
        for args in [
            vec!["init"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&f.root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
        std::fs::write(f.root.join("a.txt"), "a").unwrap();
        f.call("git.commit", json!({"message":"a", "paths":["a.txt"]}))
            .unwrap();
        let head = |f: &Fixture| {
            let o = git_command(&f.root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8(o.stdout).unwrap()
        };
        let status = |f: &Fixture| {
            let o = git_command(&f.root)
                .args(["status", "--short"])
                .output()
                .unwrap();
            String::from_utf8(o.stdout).unwrap()
        };
        assert_eq!(status(&f), "");
        let before = head(&f);
        let index_before = std::fs::read(f.root.join(".git/index")).unwrap();
        std::fs::write(f.root.join("b.txt"), "b").unwrap();
        // One path does not exist: git add fails and nothing must change.
        assert!(f
            .call(
                "git.commit",
                json!({"message":"partial", "paths":["b.txt", "missing.txt"]})
            )
            .is_err());
        assert_eq!(before, head(&f));
        assert_eq!(
            index_before,
            std::fs::read(f.root.join(".git/index")).unwrap()
        );
        assert_eq!(status(&f), "?? b.txt\n");
        let leftovers: Vec<_> = std::fs::read_dir(f.root.join(".git"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("axe-index-"))
            .collect();
        assert!(leftovers.is_empty(), "temporary index left behind");
        f.call("git.commit", json!({"message":"b", "paths":["b.txt"]}))
            .unwrap();
        assert_ne!(before, head(&f));
        assert_eq!(status(&f), "");
        let log = git_command(&f.root)
            .args(["log", "--format=%s"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(log.stdout).unwrap(), "b\na\n");
    }
    #[test]
    fn git_rejects_filters_and_config_includes_before_execution() {
        let f = Fixture::new();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .arg("init")
            .output()
            .unwrap()
            .status
            .success());
        for (key, value) in [
            ("filter.demo.clean", "false"),
            ("include.path", "missing-config"),
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&f.root)
                .args(["config", key, value])
                .output()
                .unwrap()
                .status
                .success());
            assert!(f.call("git.status", json!({})).is_err());
            assert!(Command::new("git")
                .arg("-C")
                .arg(&f.root)
                .args(["config", "--unset", key])
                .output()
                .unwrap()
                .status
                .success());
        }
    }
    #[test]
    fn cloud_reload_excludes_historical_outside_sessions() {
        let f = Fixture::new();
        let config = crate::DaemonConfig::new(f.base.join("history-data"));
        let old = Daemon::new(
            config.clone(),
            std::sync::Arc::new(crate::stub::EchoFactory),
        );
        let outside = f.base.join("outside-project");
        std::fs::create_dir(&outside).unwrap();
        for path in [&f.root, &outside] {
            old.create(
                serde_json::from_value(json!({
                    "name":"history test", "workspaceId":path.to_string_lossy(),
                    "model":{"provider":"test","name":"echo"}
                }))
                .unwrap(),
            )
            .unwrap();
        }
        assert_eq!(old.list_metas().len(), 2);
        drop(old);
        let mut cloud_config = config;
        cloud_config.workspace_root = Some(f.root.clone());
        let cloud = Daemon::new(cloud_config, std::sync::Arc::new(crate::stub::EchoFactory));
        assert_eq!(cloud.list_metas().len(), 1);
        assert_eq!(cloud.status_json()["sessions"]["total"], 1);
        assert_eq!(cloud.list_metas()[0].workspace_id, f.root.to_string_lossy());
    }
    #[test]
    fn accepts_relative() {
        assert_eq!(rel("src/main.rs").unwrap(), PathBuf::from("src/main.rs"));
    }

    #[test]
    fn git_repos_are_listed_and_commits_are_scoped_to_the_chosen_repo() {
        let f = Fixture::new();
        let proj = f.root.join("portail-prime");
        std::fs::create_dir_all(proj.join("src")).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&proj)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
        let repos = f.call("git.repos", json!({})).unwrap();
        assert_eq!(repos[0]["isRepo"], false);
        assert_eq!(repos[1]["path"], "portail-prime");
        assert_eq!(repos[1]["isRepo"], true);
        // Racine de l'espace non-depot : erreur explicite (l'UI propose alors un depot).
        assert!(f.call("git.status", json!({})).is_err());
        let st = f.call("git.status", json!({"path":"portail-prime"})).unwrap();
        assert_eq!(st["repoPath"], "/work/portail-prime");
        // Commit cible : chemins donnes depuis la racine de l'espace.
        std::fs::write(proj.join("src/demo.txt"), "hello cloud").unwrap();
        f.call(
            "git.commit",
            json!({"message":"depuis le projet", "paths":["portail-prime/src/demo.txt"], "path":"portail-prime"}),
        )
        .unwrap();
        let tracked = git_command(&proj).args(["ls-files"]).output().unwrap();
        assert_eq!(String::from_utf8(tracked.stdout).unwrap(), "src/demo.txt\n");
        // Un chemin hors du depot choisi est refuse, index inchange.
        std::fs::write(f.root.join("hors.txt"), "hors").unwrap();
        assert!(f
            .call(
                "git.commit",
                json!({"message":"hors depot", "paths":["hors.txt"], "path":"portail-prime"})
            )
            .is_err());
        // Traversee refusee.
        assert!(f.call("git.status", json!({"path":"../etc"})).is_err());
    }

    // axe:v2-l2.4 — index « ouvrir vite ».
    #[test]
    fn index_lists_relative_files_and_skips_noise() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root.join("src")).unwrap();
        std::fs::create_dir_all(f.root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(f.root.join("target")).unwrap();
        std::fs::create_dir_all(f.root.join(".git")).unwrap();
        std::fs::write(f.root.join("a.txt"), "a").unwrap();
        std::fs::write(f.root.join("src/b.rs"), "b").unwrap();
        std::fs::write(f.root.join("node_modules/x.js"), "x").unwrap();
        std::fs::write(f.root.join("target/y"), "y").unwrap();
        let idx = f.call("fs.index", json!({})).unwrap();
        assert_eq!(idx["paths"], json!(["a.txt", "src/b.rs"]));
        assert_eq!(idx["truncated"], false);
        let idx = f.call("fs.index", json!({"limit":1})).unwrap();
        assert_eq!(idx["paths"], json!(["a.txt"]));
        assert_eq!(idx["truncated"], true);
    }

    #[cfg(unix)]
    #[test]
    fn index_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = f.base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, f.root.join("linkdir")).unwrap();
        std::fs::write(f.root.join("real.txt"), "real").unwrap();
        let idx = f.call("fs.index", json!({})).unwrap();
        assert_eq!(idx["paths"], json!(["real.txt"]));
    }

    // axe:v2-l2.4 — corbeille réversible.
    #[test]
    fn trash_list_and_restore_roundtrip() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root.join("src")).unwrap();
        std::fs::write(f.root.join("src/demo.txt"), "contenu").unwrap();
        let t = f.call("fs.trash", json!({"path":"src/demo.txt"})).unwrap();
        let id = t["id"].as_str().unwrap().to_string();
        assert_eq!(t["path"], "src/demo.txt");
        assert_eq!(t["name"], "demo.txt");
        assert!(t["trashedAtMs"].as_u64().unwrap() > 0);
        assert!(!f.root.join("src/demo.txt").exists());
        assert!(trash_root(&f.daemon, &f.root).join(&id).join("demo.txt").exists());
        assert!(!f.root.join(".axecode").exists(), "rien dans le projet");
        let list = f.call("fs.trash_list", json!({})).unwrap();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], id);
        assert_eq!(list[0]["path"], "src/demo.txt");
        assert_eq!(list[0]["name"], "demo.txt");
        // Un chemin deja dans la corbeille est refuse.
        assert!(f
            .call(
                "fs.trash",
                json!({"path": format!(".axecode/corbeille/{id}/demo.txt")})
            )
            .is_err());
        let restored = f.call("fs.restore", json!({"id": id})).unwrap();
        assert_eq!(restored["path"], "src/demo.txt");
        assert_eq!(
            std::fs::read_to_string(f.root.join("src/demo.txt")).unwrap(),
            "contenu"
        );
        assert!(!trash_root(&f.daemon, &f.root).join(&id).exists());
        assert_eq!(f.call("fs.trash_list", json!({})).unwrap(), json!([]));
    }

    #[test]
    fn restore_refuses_existing_target_or_missing_parent() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.root.join("src")).unwrap();
        std::fs::write(f.root.join("src/file.txt"), "x").unwrap();
        let t = f.call("fs.trash", json!({"path":"src/file.txt"})).unwrap();
        let id = t["id"].as_str().unwrap().to_string();
        std::fs::write(f.root.join("src/file.txt"), "occupe").unwrap();
        assert!(f.call("fs.restore", json!({"id": id})).is_err());
        std::fs::remove_file(f.root.join("src/file.txt")).unwrap();
        std::fs::remove_dir(f.root.join("src")).unwrap();
        assert!(f.call("fs.restore", json!({"id": id})).is_err());
        assert_eq!(
            f.call("fs.trash_list", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn trash_rejects_invalid_paths() {
        let f = Fixture::new();
        for params in [
            json!({"path":""}),
            json!({"path":"."}),
            json!({"path":"../outside"}),
            json!({"path":"/etc/passwd"}),
            json!({"path":".axecode/corbeille"}),
            json!({}),
        ] {
            assert!(f.call("fs.trash", params).is_err());
        }
        assert!(f.call("fs.restore", json!({"id":"../x"})).is_err());
        assert!(f.call("fs.restore", json!({"id":""})).is_err());
    }

    fn init_repo(dir: &Path) {
        for args in [
            vec!["init"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
        ] {
            assert!(Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
    }

    // axe:v2-l2.4 — branches locales et branche courante.
    #[test]
    fn git_branches_reports_current_and_upstream() {
        let f = Fixture::new();
        init_repo(&f.root);
        std::fs::write(f.root.join("a.txt"), "a").unwrap();
        f.call("git.commit", json!({"message":"init","paths":["a.txt"]}))
            .unwrap();
        let b = f.call("git.branches", json!({})).unwrap();
        let current = b["current"].as_str().unwrap();
        assert!(!current.is_empty());
        let branches = b["branches"].as_array().unwrap();
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0]["name"], json!(current));
        assert_eq!(branches[0]["current"], true);
        assert!(branches[0]["upstream"].is_null());
    }

    #[test]
    fn git_checkout_creates_branch_and_worktrees_lists() {
        let f = Fixture::new();
        init_repo(&f.root);
        std::fs::write(f.root.join("a.txt"), "a").unwrap();
        f.call("git.commit", json!({"message":"init","paths":["a.txt"]}))
            .unwrap();
        let co = f
            .call("git.checkout", json!({"branch":"feature/x","create":true}))
            .unwrap();
        assert_eq!(co["branch"], "feature/x");
        let b = f.call("git.branches", json!({})).unwrap();
        assert_eq!(b["current"], "feature/x");
        let list = f.call("git.worktrees", json!({})).unwrap();
        let list = list.as_array().unwrap();
        assert!(!list.is_empty());
        assert_eq!(list[0]["branch"], "feature/x");
        assert!(list[0]["head"].is_string());
        assert!(f.call("git.checkout", json!({"branch":"bad name"})).is_err());
        assert!(f.call("git.checkout", json!({"branch":""})).is_err());
    }

    #[test]
    fn git_branches_targets_sub_repository_and_confines_paths() {
        let f = Fixture::new();
        let proj = f.root.join("portail-prime");
        std::fs::create_dir_all(&proj).unwrap();
        init_repo(&proj);
        std::fs::write(proj.join("a.txt"), "a").unwrap();
        f.call(
            "git.commit",
            json!({"message":"init","paths":["portail-prime/a.txt"],"path":"portail-prime"}),
        )
        .unwrap();
        let b = f
            .call("git.branches", json!({"repoPath":"portail-prime"}))
            .unwrap();
        assert!(!b["current"].as_str().unwrap().is_empty());
        assert!(f.call("git.branches", json!({"repoPath":"../etc"})).is_err());
    }

    // axe:v2-l2.4 — push/pull : l'échec est une réponse, pas une erreur RPC.
    #[test]
    fn git_push_and_pull_report_failure_without_rpc_error() {
        let f = Fixture::new();
        init_repo(&f.root);
        std::fs::write(f.root.join("a.txt"), "a").unwrap();
        f.call("git.commit", json!({"message":"init","paths":["a.txt"]}))
            .unwrap();
        for m in ["git.push", "git.pull"] {
            let v = f.call(m, json!({})).unwrap();
            assert!(v["ok"].is_boolean(), "{m} ok");
            assert!(v["output"].is_string(), "{m} output");
            assert_eq!(v["ok"], false, "{m} must fail without a remote");
        }
    }
}
