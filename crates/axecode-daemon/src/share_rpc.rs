//! V2 L4 shared space: publish a personal item into the service-wide shared
//! repository, list it, read it, or remove it.
//!
//! The shared root is fixed by the deployment (`--shared-root`, root-owned)
//! and never comes from a client request. Personal items stay under the
//! workspace root; only an explicit `share.publish` copies them across.
use crate::workspace_rpc::{
    git_command, git_commit_transactional, git_commit_transactional_removal, resolve,
};
use crate::Daemon;
use serde_json::{json, Value};
use axecode_core::{SessionError, SessionResult};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Personal item families that can be shared.
pub const KINDS: [&str; 4] = ["skills", "recettes", "conversations", "harness"];
const MAX_NAME: usize = 100;
const MAX_FILES: usize = 2000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_READ: u64 = 512 * 1024;
const LOCK_DIR: &str = ".axe-share.lock";
const LOCK_STALE_SECS: u64 = 120;

fn shared_root(d: &Daemon) -> SessionResult<PathBuf> {
    let raw = d
        .config
        .shared_root
        .as_ref()
        .ok_or_else(|| SessionError::Protocol("shared space is not configured".into()))?;
    let root = raw
        .canonicalize()
        .map_err(|e| SessionError::Protocol(format!("shared space unavailable: {e}")))?;
    if !root.is_dir() {
        return Err(SessionError::Protocol(
            "shared space is not a directory".into(),
        ));
    }
    if let Some(work) = d.config.workspace_root.as_ref() {
        if let Ok(work) = work.canonicalize() {
            if root.starts_with(&work) || work.starts_with(&root) {
                return Err(SessionError::Protocol(
                    "shared space must be outside the personal workspace".into(),
                ));
            }
        }
    }
    Ok(root)
}

fn kind_of(p: &Value) -> SessionResult<String> {
    let k = p
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| SessionError::Protocol("kind is required".into()))?;
    if !KINDS.contains(&k) {
        return Err(SessionError::Protocol(format!(
            "unknown kind {k} (expected one of {})",
            KINDS.join(", ")
        )));
    }
    Ok(k.to_string())
}

/// A published item name: one path component, no hidden/`.`/`..` entry.
fn name_of(p: &Value) -> SessionResult<String> {
    let n = p
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| SessionError::Protocol("name is required".into()))?;
    if n.is_empty()
        || n.len() > MAX_NAME
        || n.starts_with('.')
        || n.contains('\\')
        || n.contains(':')
        || n.contains('/')
        || n.chars().any(|c| c.is_control())
        || n == "."
        || n == ".."
    {
        return Err(SessionError::Protocol("invalid item name".into()));
    }
    Ok(n.to_string())
}

fn author_of(p: &Value) -> String {
    p.get("author")
        .and_then(Value::as_str)
        .map(|a| {
            a.chars()
                .filter(|c| !c.is_control() && *c != '<' && *c != '>')
                .take(120)
                .collect::<String>()
        })
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "axecode".into())
}

/// Serialises shared-repository writes between the services of every account.
/// `git` also has its own index lock; this only makes the retry deterministic.
struct ShareLock(PathBuf);

impl ShareLock {
    fn acquire(root: &Path) -> SessionResult<Self> {
        let path = root.join(LOCK_DIR);
        for _ in 0..100 {
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        let stale = meta
                            .modified()
                            .ok()
                            .and_then(|m| m.elapsed().ok())
                            .is_some_and(|age| age.as_secs() > LOCK_STALE_SECS);
                        if stale {
                            let _ = std::fs::remove_dir(&path);
                            continue;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(SessionError::Io(e.to_string())),
            }
        }
        Err(SessionError::Protocol(
            "shared space is busy, try again".into(),
        ))
    }
}

impl Drop for ShareLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// Creates the shared Git repository on first use (identity set locally so the
/// daemon never depends on a global Git configuration).
fn ensure_repo(root: &Path) -> SessionResult<()> {
    if root.join(".git").is_dir() {
        return Ok(());
    }
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.name", "SavIDE"],
        vec!["config", "user.email", "savide@localhost"],
    ] {
        let out = git_command(root)
            .args(&args)
            .output()
            .map_err(|e| SessionError::Io(e.to_string()))?;
        if !out.status.success() {
            return Err(SessionError::Protocol(format!(
                "shared repository setup failed ({})",
                args.join(" ")
            )));
        }
    }
    Ok(())
}

fn commit(root: &Path, paths: &[String], msg: &str) -> SessionResult<String> {
    let idx = git_command(root)
        .args(["diff", "--cached", "--name-only", "-z"])
        .output()
        .map_err(|e| SessionError::Io(e.to_string()))?;
    if !idx.status.success() {
        return Err(SessionError::Protocol(
            "unable to inspect the shared Git index".into(),
        ));
    }
    if !idx.stdout.is_empty() {
        return Err(SessionError::Protocol(
            "shared Git index is not empty".into(),
        ));
    }
    git_commit_transactional(root, paths, msg)
}

/// Copies a personal item into the shared repository. Symbolic links, special
/// files and oversized trees are refused; the executable bit is the only mode
/// bit carried over.
fn publish(
    root: &Path,
    shared: &Path,
    kind: &str,
    name: &str,
    author: &str,
) -> SessionResult<Value> {
    let work = root.to_path_buf();
    let source_rel = format!("{kind}/{name}");
    let source = resolve(&work, &source_rel, false)?;
    let kind_dir = shared.join(kind);
    let target = kind_dir.join(name);
    if target.exists() {
        return Err(SessionError::Protocol(format!(
            "{source_rel} is already shared; remove it first"
        )));
    }
    // Never follow a symlink placed in the shared root by another writer.
    if !kind_dir.exists() {
        std::fs::create_dir_all(&kind_dir).map_err(|e| SessionError::Io(e.to_string()))?;
    }
    let kind_meta =
        std::fs::symlink_metadata(&kind_dir).map_err(|e| SessionError::Io(e.to_string()))?;
    if !kind_meta.is_dir() || kind_meta.file_type().is_symlink() {
        return Err(SessionError::Protocol(
            "shared category is not a folder".into(),
        ));
    }
    let mut files = 0usize;
    let mut bytes = 0u64;
    if let Err(err) = copy_tree(&source, &target, &mut files, &mut bytes) {
        // A refused item must not leave a partial copy in the shared space.
        let _ = if target.is_dir() {
            std::fs::remove_dir_all(&target)
        } else {
            std::fs::remove_file(&target)
        };
        return Err(err);
    }
    let repo_paths = vec![source_rel.clone()];
    let message = format!("publish {source_rel} by {author}\n\nfiles: {files}, bytes: {bytes}\n");
    let output = commit(shared, &repo_paths, message.trim_end())?;
    Ok(json!({
        "kind": kind, "name": name, "files": files, "bytes": bytes, "output": output,
    }))
}

fn copy_tree(
    source: &Path,
    target: &Path,
    files: &mut usize,
    bytes: &mut u64,
) -> SessionResult<()> {
    let meta = std::fs::symlink_metadata(source).map_err(|e| SessionError::Io(e.to_string()))?;
    if meta.file_type().is_symlink() {
        return Err(SessionError::Protocol(
            "symbolic links cannot be shared".into(),
        ));
    }
    if meta.is_dir() {
        std::fs::create_dir_all(target).map_err(|e| SessionError::Io(e.to_string()))?;
        let mut entries: Vec<_> = std::fs::read_dir(source)
            .map_err(|e| SessionError::Io(e.to_string()))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child = entry.path();
            if child.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            copy_tree(&child, &target.join(entry.file_name()), files, bytes)?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        return Err(SessionError::Protocol(
            "only regular files can be shared".into(),
        ));
    }
    *files += 1;
    if *files > MAX_FILES {
        return Err(SessionError::Protocol("too many files to share".into()));
    }
    let data = std::fs::read(source).map_err(|e| SessionError::Io(e.to_string()))?;
    *bytes += data.len() as u64;
    if *bytes > MAX_BYTES {
        return Err(SessionError::Protocol("shared item exceeds 64 MiB".into()));
    }
    std::fs::write(target, data).map_err(|e| SessionError::Io(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if meta.permissions().mode() & 0o111 != 0 {
            0o755
        } else {
            0o644
        };
        let _ = std::fs::set_permissions(target, std::fs::Permissions::from_mode(mode));
    }
    Ok(())
}

fn files_of(root: &Path) -> SessionResult<Vec<Value>> {
    let mut out = Vec::new();
    let mut walk = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = walk.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.filter_map(Result::ok) {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name == ".git" {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            let relative = if prefix.is_empty() {
                file_name.clone()
            } else {
                format!("{prefix}/{file_name}")
            };
            if meta.is_dir() {
                walk.push((path, relative));
            } else if meta.is_file() {
                out.push(json!({"path": relative, "bytes": meta.len()}));
                if out.len() > MAX_FILES {
                    return Err(SessionError::Protocol("shared item is too large".into()));
                }
            }
        }
    }
    out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(out)
}

pub fn dispatch(d: &Daemon, m: &str, p: &Value) -> SessionResult<Value> {
    let shared = shared_root(d)?;
    match m {
        "share.root" => Ok(json!({
            "path": "/shared",
            "name": "commun",
            "kinds": KINDS,
        })),
        "share.list" => {
            let mut items = Vec::new();
            for kind in KINDS {
                let dir = shared.join(kind);
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.filter_map(Result::ok) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        continue;
                    }
                    let Ok(meta) = entry.metadata() else { continue };
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    items.push(json!({
                        "kind": kind,
                        "name": name,
                        "directory": meta.is_dir(),
                        "bytes": if meta.is_file() { meta.len() } else { 0 },
                        "modifiedMs": modified,
                    }));
                }
            }
            items.sort_by(|a, b| {
                (a["kind"].as_str(), a["name"].as_str())
                    .cmp(&(b["kind"].as_str(), b["name"].as_str()))
            });
            Ok(json!({"path": "/shared", "items": items}))
        }
        "share.files" => {
            let kind = kind_of(p)?;
            let name = name_of(p)?;
            let item = shared.join(&kind).join(&name);
            if !item.exists() {
                return Err(SessionError::Protocol("shared item not found".into()));
            }
            let files = if item.is_dir() {
                files_of(&item)?
            } else {
                vec![json!({
                    "path": name,
                    "bytes": std::fs::metadata(&item).map(|m| m.len()).unwrap_or(0),
                })]
            };
            Ok(json!({"kind": kind, "name": name, "files": files}))
        }
        "share.read" => {
            let kind = kind_of(p)?;
            let name = name_of(p)?;
            let relative = p
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| SessionError::Protocol("path is required".into()))?;
            let item = shared.join(&kind).join(&name);
            if !item.is_dir() {
                return Err(SessionError::Protocol("shared item is not a folder".into()));
            }
            let file = resolve(&item, relative, false)?;
            let meta = std::fs::metadata(&file).map_err(|e| SessionError::Io(e.to_string()))?;
            if meta.len() > MAX_READ {
                return Err(SessionError::Protocol("file is too large to read".into()));
            }
            let content = std::fs::read_to_string(&file)
                .map_err(|_| SessionError::Protocol("file is not valid UTF-8 text".into()))?;
            Ok(json!({"kind": kind, "name": name, "path": relative, "content": content}))
        }
        "share.publish" => {
            let kind = kind_of(p)?;
            let name = name_of(p)?;
            let author = author_of(p);
            let root = crate::workspace_rpc::root(d)?;
            let _lock = ShareLock::acquire(&shared)?;
            ensure_repo(&shared)?;
            let result = publish(&root, &shared, &kind, &name, &author)?;
            d.broadcast(
                "shared_changed",
                None,
                json!({"action": "publish", "kind": kind, "name": name}),
            );
            Ok(result)
        }
        "share.unpublish" => {
            let kind = kind_of(p)?;
            let name = name_of(p)?;
            let author = author_of(p);
            let item = shared.join(&kind).join(&name);
            let _lock = ShareLock::acquire(&shared)?;
            ensure_repo(&shared)?;
            if !item.exists() {
                return Err(SessionError::Protocol("shared item not found".into()));
            }
            if item.is_dir() {
                std::fs::remove_dir_all(&item).map_err(|e| SessionError::Io(e.to_string()))?;
            } else {
                std::fs::remove_file(&item).map_err(|e| SessionError::Io(e.to_string()))?;
            }
            let path = format!("{kind}/{name}");
            let message = format!("unpublish {path} by {author}\n");
            let output = git_commit_transactional_removal(&shared, &[path], message.trim_end())?;
            d.broadcast(
                "shared_changed",
                None,
                json!({"action": "unpublish", "kind": kind, "name": name}),
            );
            Ok(json!({"kind": kind, "name": name, "output": output}))
        }
        "share.log" => {
            let limit = p
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 200);
            if !shared.join(".git").is_dir() {
                return Ok(json!({"entries": []}));
            }
            let out = git_command(&shared)
                .args([
                    "--no-pager",
                    "log",
                    &format!("-{limit}"),
                    "--format=%h%x09%an%x09%aI%x09%s",
                ])
                .output()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            if !out.status.success() {
                return Ok(json!({"entries": []}));
            }
            let entries: Vec<Value> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(4, '\t');
                    Some(json!({
                        "commit": parts.next()?,
                        "author": parts.next()?,
                        "date": parts.next()?,
                        "subject": parts.next()?,
                    }))
                })
                .collect();
            Ok(json!({"entries": entries}))
        }
        _ => Err(SessionError::Protocol("unknown shared-space method".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Fixture {
        base: PathBuf,
        work: PathBuf,
        shared: PathBuf,
        daemon: Option<Arc<Daemon>>,
    }

    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("l4-share-{}", uuid::Uuid::new_v4()));
            let work = base.join("work");
            let shared = base.join("commun");
            std::fs::create_dir_all(&work).unwrap();
            std::fs::create_dir_all(&shared).unwrap();
            let mut config = crate::DaemonConfig::new(base.join("data"));
            config.workspace_root = Some(work.clone());
            config.shared_root = Some(shared.clone());
            let daemon = Daemon::new(config, Arc::new(crate::stub::EchoFactory));
            Self {
                base,
                work,
                shared,
                daemon: Some(daemon),
            }
        }
        fn call(&self, method: &str, params: Value) -> SessionResult<Value> {
            dispatch(self.daemon.as_ref().unwrap(), method, &params)
        }
        fn seed(&self, relative: &str, content: &str) {
            let path = self.work.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.daemon = None;
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn publish_list_read_and_unpublish_roundtrip() {
        let f = Fixture::new();
        f.seed("skills/demo/SKILL.md", "---\nname: demo\n---\nbonjour\n");
        f.seed("skills/demo/notes.txt", "notes\n");
        assert_eq!(f.call("share.list", json!({})).unwrap()["items"], json!([]));
        let published = f
            .call(
                "share.publish",
                json!({"kind":"skills","name":"demo","author":"a@b.c"}),
            )
            .unwrap();
        assert_eq!(published["files"], 2);
        assert_eq!(published["bytes"], 33);
        let listed = f.call("share.list", json!({})).unwrap();
        assert_eq!(listed["items"][0]["kind"], "skills");
        assert_eq!(listed["items"][0]["name"], "demo");
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
        let files = f
            .call("share.files", json!({"kind":"skills","name":"demo"}))
            .unwrap();
        assert_eq!(files["files"].as_array().unwrap().len(), 2);
        let read = f
            .call(
                "share.read",
                json!({"kind":"skills","name":"demo","path":"SKILL.md"}),
            )
            .unwrap();
        assert!(read["content"].as_str().unwrap().contains("bonjour"));
        let log = f.call("share.log", json!({})).unwrap();
        assert_eq!(log["entries"].as_array().unwrap().len(), 1);
        assert!(log["entries"][0]["subject"]
            .as_str()
            .unwrap()
            .starts_with("publish skills/demo"));
        let removed = f
            .call("share.unpublish", json!({"kind":"skills","name":"demo"}))
            .unwrap();
        assert!(removed["output"].as_str().unwrap().contains("unpublish"));
        assert_eq!(f.call("share.list", json!({})).unwrap()["items"], json!([]));
        assert!(!f.shared.join("skills/demo").exists());
        let log = f.call("share.log", json!({})).unwrap();
        assert_eq!(log["entries"].as_array().unwrap().len(), 2);
        // The deletion is a real commit: the tree no longer holds the item.
        let out = git_command(&f.shared)
            .args(["ls-tree", "-r", "--name-only", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "");
        // The personal copy is untouched.
        assert!(f.work.join("skills/demo/SKILL.md").exists());
    }

    #[test]
    fn rejects_unknown_kind_and_invalid_names() {
        let f = Fixture::new();
        for params in [
            json!({"kind":"prive","name":"demo"}),
            json!({"name":"demo"}),
            json!({"kind":"skills","name":"../escape"}),
            json!({"kind":"skills","name":"a/b"}),
            json!({"kind":"skills","name":".git"}),
            json!({"kind":"skills","name":""}),
            json!({"kind":"skills","name":".hidden"}),
            json!({"kind":"skills","name":"a\\b"}),
        ] {
            assert!(
                f.call("share.publish", params.clone()).is_err(),
                "accepted {params}"
            );
            assert!(f.call("share.unpublish", params).is_err());
        }
        assert!(!f.shared.join(".git").exists(), "repository never created");
    }

    #[test]
    fn refuses_double_publish_and_missing_items() {
        let f = Fixture::new();
        f.seed("recettes/outil.sh", "#!/bin/sh\necho ok\n");
        #[cfg(unix)]
        {
            // Group-writable and executable: sharing keeps only the exec bit.
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                f.work.join("recettes/outil.sh"),
                std::fs::Permissions::from_mode(0o770),
            )
            .unwrap();
        }
        f.call(
            "share.publish",
            json!({"kind":"recettes","name":"outil.sh"}),
        )
        .unwrap();
        let again = f.call(
            "share.publish",
            json!({"kind":"recettes","name":"outil.sh"}),
        );
        assert!(again.is_err());
        assert!(f
            .call("share.publish", json!({"kind":"skills","name":"absent"}))
            .is_err());
        assert!(f
            .call("share.files", json!({"kind":"skills","name":"absent"}))
            .is_err());
        assert!(f
            .call(
                "share.read",
                json!({"kind":"recettes","name":"outil.sh","path":"x"})
            )
            .is_err());
        #[cfg(unix)]
        {
            // The executable bit travels, other mode bits do not.
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(f.shared.join("recettes/outil.sh"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_sources_and_escapes() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = f.base.join("secret.txt");
        std::fs::write(&outside, "sentinel").unwrap();
        std::fs::create_dir_all(f.work.join("skills/link")).unwrap();
        symlink(&outside, f.work.join("skills/link/inside.txt")).unwrap();
        assert!(f
            .call("share.publish", json!({"kind":"skills","name":"link"}))
            .is_err());
        assert!(!f.shared.join("skills/link").exists());
        std::fs::create_dir_all(f.work.join("skills/hidden")).unwrap();
        std::fs::write(f.work.join("skills/hidden/ok.txt"), "ok").unwrap();
        std::fs::create_dir_all(f.work.join("skills/hidden/.git")).unwrap();
        std::fs::write(f.work.join("skills/hidden/.git/config"), "[core]").unwrap();
        f.call("share.publish", json!({"kind":"skills","name":"hidden"}))
            .unwrap();
        assert!(!f.shared.join("skills/hidden/.git").exists());
        assert!(f
            .call(
                "share.read",
                json!({"kind":"skills","name":"hidden","path":"../secret.txt"})
            )
            .is_err());
    }

    #[test]
    fn shared_space_must_be_configured_and_outside_the_workspace() {
        let base = std::env::temp_dir().join(format!("l4-share-{}", uuid::Uuid::new_v4()));
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let mut config = crate::DaemonConfig::new(base.join("data"));
        config.workspace_root = Some(work.clone());
        let daemon = Daemon::new(config, Arc::new(crate::stub::EchoFactory));
        let err = dispatch(&daemon, "share.list", &json!({})).unwrap_err();
        assert!(err.to_string().contains("not configured"));
        let mut nested = crate::DaemonConfig::new(base.join("data2"));
        nested.workspace_root = Some(work.clone());
        nested.shared_root = Some(work.join("commun"));
        std::fs::create_dir_all(work.join("commun")).unwrap();
        let nested = Daemon::new(nested, Arc::new(crate::stub::EchoFactory));
        assert!(dispatch(&nested, "share.list", &json!({})).is_err());
        assert!(dispatch(&daemon, "share.root", &json!({})).is_err());
        drop(nested);
        drop(daemon);
        let _ = std::fs::remove_dir_all(&base);
    }
}
