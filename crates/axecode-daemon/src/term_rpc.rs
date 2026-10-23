//! V2 L3 terminal RPC: a PTY running inside the service, confined to the
//! workspace root (cwd) with a minimal environment. Output is streamed only to
//! the client that owns the terminal; a reconnecting client takes it over with
//! `term.attach`. With tmux available the shell survives a service restart.
use crate::{
    daemon::lock,
    protocol::{Event, ServerLine},
    Daemon,
};
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use axecode_core::{SessionError, SessionResult};
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_TERMINALS: usize = 8;
const MAX_WRITE: usize = 64 * 1024;

pub(crate) struct Term {
    owner: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

fn root(d: &Daemon) -> SessionResult<PathBuf> {
    let configured = d
        .config
        .workspace_root
        .as_ref()
        .ok_or_else(|| SessionError::Protocol("terminal requires a workspace root (service sans AXECODE_WORKSPACE_ROOT : voir /etc/axe/atelier/<compte>.env)".into()))?;
    configured
        .canonicalize()
        .map_err(|e| SessionError::Io(e.to_string()))
}

fn cwd(root: &Path, raw: &str) -> SessionResult<PathBuf> {
    if raw.is_empty() {
        return Ok(root.to_path_buf());
    }
    let rel = Path::new(raw);
    if rel.is_absolute()
        || raw.contains('\\')
        || rel.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(SessionError::Protocol("invalid cwd".into()));
    }
    let p = root
        .join(rel)
        .canonicalize()
        .map_err(|_| SessionError::Protocol("cwd not found".into()))?;
    if !p.starts_with(root) || !p.is_dir() {
        return Err(SessionError::Protocol("cwd escapes workspace root".into()));
    }
    Ok(p)
}

fn size(p: &Value) -> PtySize {
    let n = |k: &str, d: u16| {
        p.get(k)
            .and_then(Value::as_u64)
            .filter(|v| (1..=1000).contains(v))
            .map(|v| v as u16)
            .unwrap_or(d)
    };
    PtySize {
        rows: n("rows", 24),
        cols: n("cols", 80),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn id_of(p: &Value) -> SessionResult<String> {
    let id = p
        .get("terminalId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(SessionError::Protocol("invalid terminal id".into()));
    }
    Ok(id.to_string())
}

fn send(d: &Daemon, client: u64, terminal: &str, kind: &str, data: Value) {
    let line = ServerLine::Event(Event {
        event: "terminal".into(),
        session_id: None,
        data: json!({"terminalId": terminal, "kind": kind, "data": data}),
    });
    let Ok(mut text) = serde_json::to_string(&line) else {
        return;
    };
    text.push('\n');
    if let Some(c) = lock(&d.clients).get(&client) {
        let _ = c.tx.send(text);
    }
}

fn owner_of(d: &Daemon, id: &str) -> Option<u64> {
    lock(&d.terminals).get(id).map(|t| t.owner)
}

/// axe:e8 — onglets epingles : nom de session et binaire de l'agent a y
/// lancer. Le portail (`~/portail-prime/terminal.py`) utilise les memes noms
/// sur le meme socket : un onglet epingle ouvre donc **la meme session**, donc
/// le meme agent, que le terminal du portail.
fn mode(id: &str) -> Option<(&'static str, &'static str)> {
    match id {
        "prime" => Some(("axe", ".local/bin/assistant")),
        "opencode" => Some(("axe", ".opencode/bin/opencode")),
        _ => None,
    }
}

/// Socket tmux et commande a lancer dans la session : la session du portail
/// pour un mode epingle (si le binaire existe), sinon une session a nous.
fn tmux_target(home: &Path, id: &str) -> (String, Option<String>) {
    if let Some((socket, rel)) = mode(id) {
        let bin = home.join(rel);
        if bin.exists() {
            return (
                socket.to_string(),
                Some(format!("{}; exec bash -l", bin.display())),
            );
        }
    }
    ("axecode".to_string(), None)
}

/// Configuration tmux du portail, si elle est presente : la session a la meme
/// configuration que l'un ou l'autre des clients l'ait creee.
fn portal_conf(home: &Path) -> Option<PathBuf> {
    let conf = home.join("portail-prime/tmux/axe-tmux.conf");
    if conf.exists() {
        Some(conf)
    } else {
        None
    }
}

fn command(root: &Path, dir: &Path, id: &str, tmux: bool) -> CommandBuilder {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.to_path_buf());
    let mut c = if tmux {
        let (socket, run) = tmux_target(&home, id);
        let mut c = CommandBuilder::new("tmux");
        c.arg("-L");
        c.arg(socket);
        if let Some(conf) = portal_conf(&home) {
            c.arg("-f");
            c.arg(conf);
        }
        c.arg("new-session");
        c.arg("-A");
        c.arg("-s");
        c.arg(id);
        c.arg("-c");
        c.arg(dir);
        if let Some(run) = run {
            c.arg(run);
        }
        c
    } else {
        let mut c = CommandBuilder::new("bash");
        c.arg("-l");
        c
    };
    c.env_clear();
    c.env("HOME", home.as_os_str().to_owned());
    // axe:e8 — l'agent de l'espace a ses binaires dans ~/.local/bin et ~/.opencode/bin.
    c.env(
        "PATH",
        format!(
            "{}/.local/bin:{}/.opencode/bin:/usr/local/bin:/usr/bin:/bin",
            home.display(),
            home.display()
        ),
    );
    c.env("TERM", "xterm-256color");
    c.env("COLORTERM", "truecolor");
    c.env(
        "LANG",
        std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".into()),
    );
    c.env("SHELL", "/bin/bash");
    c.env("AXECODE_WORKSPACE", root.as_os_str());
    c.cwd(dir);
    c
}

pub fn dispatch(d: &Arc<Daemon>, client: u64, m: &str, p: &Value) -> SessionResult<Value> {
    let r = root(d)?;
    match m {
        "term.open" => {
            if lock(&d.terminals).len() >= MAX_TERMINALS {
                return Err(SessionError::Protocol("too many terminals".into()));
            }
            let dir = cwd(&r, p.get("cwd").and_then(Value::as_str).unwrap_or(""))?;
            // A client may name the terminal to re-open the same tmux session later.
            let id = match p.get("name").and_then(Value::as_str) {
                Some(name) if !name.is_empty() => id_of(&json!({ "terminalId": name }))?,
                _ => uuid::Uuid::new_v4().to_string(),
            };
            if lock(&d.terminals).contains_key(&id) {
                return Err(SessionError::Protocol("terminal already open".into()));
            }
            let tmux = p.get("tmux").and_then(Value::as_bool).unwrap_or(true) && which_tmux();
            let pair = native_pty_system()
                .openpty(size(p))
                .map_err(|e| SessionError::Io(e.to_string()))?;
            let child = pair
                .slave
                .spawn_command(command(&r, &dir, &id, tmux))
                .map_err(|e| SessionError::Io(e.to_string()))?;
            drop(pair.slave);
            let mut reader = pair
                .master
                .try_clone_reader()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            let writer = pair
                .master
                .take_writer()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            lock(&d.terminals).insert(
                id.clone(),
                Term {
                    owner: client,
                    master: pair.master,
                    writer: Arc::new(Mutex::new(writer)),
                    child: Arc::new(Mutex::new(child)),
                },
            );
            let daemon = Arc::clone(d);
            let tid = id.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let Some(owner) = owner_of(&daemon, &tid) else {
                                break;
                            };
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            send(&daemon, owner, &tid, "output", json!(b64));
                        }
                    }
                }
                let code = lock(&daemon.terminals)
                    .get(&tid)
                    .and_then(|t| lock(&t.child).wait().ok())
                    .map(|s| s.exit_code());
                if let Some(owner) = owner_of(&daemon, &tid) {
                    send(&daemon, owner, &tid, "exit", json!(code));
                }
                lock(&daemon.terminals).remove(&tid);
            });
            Ok(
                json!({"terminalId": id, "tmux": tmux, "cwd": format!("/work{}", dir.strip_prefix(&r).map(|x| if x.as_os_str().is_empty() { String::new() } else { format!("/{}", x.display()) }).unwrap_or_default())}),
            )
        }
        "term.write" => {
            let id = id_of(p)?;
            let data = p.get("data").and_then(Value::as_str).unwrap_or_default();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| SessionError::Protocol("data must be base64".into()))?;
            if bytes.len() > MAX_WRITE {
                return Err(SessionError::Protocol("write too large".into()));
            }
            let writer = {
                let terms = lock(&d.terminals);
                let t = terms
                    .get(&id)
                    .ok_or_else(|| SessionError::NotFound(id.clone()))?;
                if t.owner != client {
                    return Err(SessionError::Protocol(
                        "terminal owned by another client".into(),
                    ));
                }
                Arc::clone(&t.writer)
            };
            let mut w = lock(&writer);
            w.write_all(&bytes)
                .and_then(|_| w.flush())
                .map_err(|e| SessionError::Io(e.to_string()))?;
            Ok(json!({"ok": true}))
        }
        "term.resize" => {
            let id = id_of(p)?;
            let terms = lock(&d.terminals);
            let t = terms
                .get(&id)
                .ok_or_else(|| SessionError::NotFound(id.clone()))?;
            if t.owner != client {
                return Err(SessionError::Protocol(
                    "terminal owned by another client".into(),
                ));
            }
            t.master
                .resize(size(p))
                .map_err(|e| SessionError::Io(e.to_string()))?;
            Ok(json!({"ok": true}))
        }
        "term.attach" => {
            // Any authenticated client of this per-user service may take over.
            // If the in-memory PTY handle is gone (daemon restart), reconnect
            // to the named tmux session in a fresh PTY instead.
            let id = id_of(p)?;
            {
                let mut terms = lock(&d.terminals);
                if let Some(t) = terms.get_mut(&id) {
                    t.owner = client;
                    return Ok(json!({"ok": true, "terminalId": id, "resumed": true}));
                }
            }
            let r = root(d)?;
            if !which_tmux() {
                return Err(SessionError::NotFound(id));
            }
            if lock(&d.terminals).len() >= MAX_TERMINALS {
                return Err(SessionError::Protocol("too many terminals".into()));
            }
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| SessionError::Io(e.to_string()))?;
            let child = pair
                .slave
                .spawn_command(command(&r, &r, &id, true))
                .map_err(|e| SessionError::Io(e.to_string()))?;
            drop(pair.slave);
            let mut reader = pair
                .master
                .try_clone_reader()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            let writer = pair
                .master
                .take_writer()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            lock(&d.terminals).insert(
                id.clone(),
                Term {
                    owner: client,
                    master: pair.master,
                    writer: Arc::new(Mutex::new(writer)),
                    child: Arc::new(Mutex::new(child)),
                },
            );
            let daemon = Arc::clone(d);
            let tid = id.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let Some(owner) = owner_of(&daemon, &tid) else {
                                break;
                            };
                            send(
                                &daemon,
                                owner,
                                &tid,
                                "output",
                                json!(base64::engine::general_purpose::STANDARD.encode(&buf[..n])),
                            );
                        }
                    }
                }
                let code = lock(&daemon.terminals)
                    .get(&tid)
                    .and_then(|t| lock(&t.child).wait().ok())
                    .map(|s| s.exit_code());
                if let Some(owner) = owner_of(&daemon, &tid) {
                    send(&daemon, owner, &tid, "exit", json!(code));
                }
                lock(&daemon.terminals).remove(&tid);
            });
            Ok(json!({"ok": true, "terminalId": id, "resumed": true, "tmux": true}))
        }
        "term.close" => {
            let id = id_of(p)?;
            let child = {
                let terms = lock(&d.terminals);
                let t = terms
                    .get(&id)
                    .ok_or_else(|| SessionError::NotFound(id.clone()))?;
                if t.owner != client {
                    return Err(SessionError::Protocol(
                        "terminal owned by another client".into(),
                    ));
                }
                Arc::clone(&t.child)
            };
            let _ = lock(&child).kill();
            Ok(json!({"ok": true}))
        }
        "term.list" => {
            let terms = lock(&d.terminals);
            let ids: Vec<Value> = terms
                .iter()
                .map(|(id, t)| json!({"terminalId": id, "mine": t.owner == client}))
                .collect();
            Ok(Value::Array(ids))
        }
        _ => Err(SessionError::Protocol("unknown terminal method".into())),
    }
}

fn which_tmux() -> bool {
    ["/usr/bin/tmux", "/usr/local/bin/tmux", "/bin/tmux"]
        .iter()
        .any(|p| Path::new(p).exists())
}

/// Called when a client disconnects: terminals keep running (tmux reprise),
/// nothing is sent until a client attaches again.
pub(crate) fn client_gone(d: &Daemon, client: u64) {
    for t in lock(&d.terminals).values_mut() {
        if t.owner == client {
            t.owner = u64::MAX;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// axe:e8 — un onglet epingle vise la session du portail ; tout autre nom
    /// reste une session a nous ; binaire absent = simple shell (pas de mensonge).
    #[test]
    fn pinned_tabs_use_the_portal_session() {
        let absent = std::env::temp_dir().join(format!("absent-{}", uuid::Uuid::new_v4()));
        // binaire absent : on ne fait pas semblant, c'est un simple shell chez nous
        assert_eq!(
            tmux_target(&absent, "prime"),
            ("axecode".to_string(), None)
        );
        assert_eq!(
            tmux_target(&absent, "axe-main"),
            ("axecode".to_string(), None)
        );
        let home = std::env::temp_dir().join(format!("axe-e8-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        std::fs::write(home.join(".local/bin/assistant"), "#!/bin/sh\n").unwrap();
        let (socket, run) = tmux_target(&home, "prime");
        assert_eq!(socket, "axe");
        assert!(run.unwrap().contains("assistant; exec bash -l"));
    }

    struct Fixture {
        base: PathBuf,
        daemon: Arc<Daemon>,
        client: u64,
        rx: mpsc::UnboundedReceiver<String>,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("l3-term-{}", uuid::Uuid::new_v4()));
            let root = base.join("work");
            std::fs::create_dir_all(root.join("sub")).unwrap();
            let mut config = crate::DaemonConfig::new(base.join("data"));
            config.workspace_root = Some(root);
            let daemon = Daemon::new(config, Arc::new(crate::stub::EchoFactory));
            let (tx, rx) = mpsc::unbounded_channel();
            let client = daemon.add_client("test".into(), tx);
            Self {
                base,
                daemon,
                client,
                rx,
            }
        }
        fn call(&self, m: &str, p: Value) -> SessionResult<Value> {
            dispatch(&self.daemon, self.client, m, &p)
        }
        fn wait_output(&mut self, needle: &str) -> bool {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut seen = String::new();
            while std::time::Instant::now() < deadline {
                match self.rx.try_recv() {
                    Ok(line) => {
                        let v: Value = serde_json::from_str(&line).unwrap();
                        if v["data"]["kind"] == "output" {
                            let b = base64::engine::general_purpose::STANDARD
                                .decode(v["data"]["data"].as_str().unwrap())
                                .unwrap();
                            seen.push_str(&String::from_utf8_lossy(&b));
                            if seen.contains(needle) {
                                return true;
                            }
                        }
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
                }
            }
            false
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn cwd_is_confined() {
        let f = Fixture::new();
        for bad in ["/tmp", "../x", "sub/..", "a\\b", "missing"] {
            assert!(
                f.call("term.open", json!({"cwd": bad, "tmux": false}))
                    .is_err(),
                "{bad}"
            );
        }
        assert!(f
            .call("term.write", json!({"terminalId": "nope", "data": ""}))
            .is_err());
        assert!(f
            .call("term.open", json!({"name": "bad id!", "tmux": false}))
            .is_err());
    }

    #[test]
    fn terminal_can_be_attached_by_name_after_client_disconnect() {
        let mut f = Fixture::new();
        let opened = f
            .call("term.open", json!({"name":"recover-me", "tmux":false}))
            .unwrap();
        let id = opened["terminalId"].as_str().unwrap().to_string();
        assert_eq!(id, "recover-me");
        f.daemon.remove_client(f.client);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let next = f.daemon.add_client("reconnected".into(), tx);
        let attached = dispatch(&f.daemon, next, "term.attach", &json!({"terminalId":id})).unwrap();
        assert_eq!(attached["resumed"], true);
        let command = base64::engine::general_purpose::STANDARD.encode("echo ATTACHED-OK\n");
        dispatch(
            &f.daemon,
            next,
            "term.write",
            &json!({"terminalId":id,"data":command}),
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if let Ok(line) = rx.try_recv() {
                let v: Value = serde_json::from_str(&line).unwrap();
                if v["data"]["kind"] == "output" {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(v["data"]["data"].as_str().unwrap())
                        .unwrap();
                    if String::from_utf8_lossy(&bytes).contains("ATTACHED-OK") {
                        found = true;
                        break;
                    }
                }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
        assert!(found, "attached client did not receive terminal output");
        dispatch(&f.daemon, next, "term.close", &json!({"terminalId":id})).unwrap();
    }

    #[test]
    fn bash_runs_in_root_and_output_reaches_owner_only() {
        let mut f = Fixture::new();
        let opened = f
            .call(
                "term.open",
                json!({"cwd": "sub", "tmux": false, "cols": 100, "rows": 30}),
            )
            .unwrap();
        let id = opened["terminalId"].as_str().unwrap().to_string();
        assert_eq!(opened["cwd"], "/work/sub");
        let cmd = base64::engine::general_purpose::STANDARD.encode("pwd; echo MARK-$((20+22))\n");
        f.call("term.write", json!({"terminalId": id, "data": cmd}))
            .unwrap();
        assert!(f.wait_output("MARK-42"), "no output received");
        // Another client cannot write or close, but can attach (same user service).
        let (tx2, _rx2) = mpsc::unbounded_channel();
        let other = f.daemon.add_client("other".into(), tx2);
        assert!(dispatch(
            &f.daemon,
            other,
            "term.write",
            &json!({"terminalId": id, "data": ""})
        )
        .is_err());
        assert!(dispatch(&f.daemon, other, "term.close", &json!({"terminalId": id})).is_err());
        assert_eq!(
            f.call("term.list", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        f.call(
            "term.resize",
            json!({"terminalId": id, "cols": 120, "rows": 40}),
        )
        .unwrap();
        f.call("term.close", json!({"terminalId": id})).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while lock(&f.daemon.terminals).contains_key(&id) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            !lock(&f.daemon.terminals).contains_key(&id),
            "terminal not reaped"
        );
    }
}
