//! Socket server: accepts clients, dispatches requests, runs housekeeping
//! (inactive unload, automatic shutdown).

use std::{path::Path, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use axecode_core::{
    ChatMessage, CreateSessionRequest, EntryId, JournalEntryKind, ModelRef, SessionError,
    SessionHost, SessionMeta, SessionResult,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

use crate::{
    daemon::{lock, Daemon},
    journal,
    protocol::{self, methods, LockInfo, Request, Response, ServerLine},
    transport::{BoxStream, Listener},
    util::now_ms,
};

#[async_trait]
impl SessionHost for Daemon {
    async fn create_session(&self, request: CreateSessionRequest) -> SessionResult<SessionMeta> {
        self.create(request)
    }
    // axe:menage — the runtimes still see the archived sub-agents, and a
    // request on one of them restores it first (`wake_archived`).
    async fn get_session(&self, session_id: &str) -> SessionResult<SessionMeta> {
        self.wake_archived(session_id);
        self.meta(session_id)
    }
    async fn list_sessions(&self) -> Vec<SessionMeta> {
        self.host_sessions()
    }
    async fn send_user_message(&self, session_id: &str, text: String) -> SessionResult<EntryId> {
        self.wake_archived(session_id);
        self.send_user(session_id, ChatMessage::user_text(text))
    }
    async fn post_peer_message(
        &self,
        from: &str,
        to: &str,
        text: String,
    ) -> SessionResult<EntryId> {
        self.wake_archived(to);
        self.post_peer(from, to, text)
    }
    async fn record(&self, session_id: &str, kind: JournalEntryKind) -> SessionResult<EntryId> {
        self.wake_archived(session_id);
        self.append(session_id, kind)
    }
    async fn stop_turn(&self, session_id: &str) -> SessionResult<()> {
        self.wake_archived(session_id);
        self.stop(session_id)
    }
    async fn kernel_snapshot(&self, session_id: &str) -> Option<Vec<u8>> {
        std::fs::read(journal::snapshot_path(&self.config.data_dir, session_id)).ok()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdParams {
    session_id: String,
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> SessionResult<T> {
    serde_json::from_value(params).map_err(|e| SessionError::Protocol(e.to_string()))
}

fn sid(params: &Value) -> SessionResult<String> {
    parse::<IdParams>(params.clone()).map(|p| p.session_id)
}

fn opt_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

fn visible_session(daemon: &Daemon, id: &str) -> SessionResult<()> {
    if let Some(configured) = daemon.config.workspace_root.as_ref() {
        let root = configured
            .canonicalize()
            .map_err(|e| SessionError::Io(e.to_string()))?;
        let meta = daemon.meta(id)?;
        let path = Path::new(&meta.workspace_id)
            .canonicalize()
            .map_err(|_| SessionError::NotFound(id.to_owned()))?;
        if !path.starts_with(&root) {
            return Err(SessionError::NotFound(id.to_owned()));
        }
    }
    Ok(())
}

impl Daemon {
    /// Handles one request for client `client`.
    pub async fn dispatch(&self, client: u64, method: &str, params: Value) -> SessionResult<Value> {
        self.touch();
        // axe:menage — a request on an archived sub-agent restores it first,
        // except the requests that work on the archive itself.
        if method.starts_with("sessions.")
            && !matches!(
                method,
                methods::SESSIONS_LIST
                    | methods::SESSIONS_CREATE
                    | methods::SESSIONS_ARCHIVE
                    | methods::SESSIONS_DELETE
                    | methods::SESSIONS_RESTORE
                    // nothing to do on an archived session: no restore
                    | methods::SESSIONS_UNLOAD
                    | methods::SESSIONS_DETACH
            )
            && !(method == methods::SESSIONS_UPDATE
                && params.get("archived").and_then(Value::as_bool) == Some(false))
        {
            if let Some(id) = opt_str(&params, "sessionId").filter(|id| id != "*") {
                self.wake_archived(&id);
            }
        }
        if self.config.workspace_root.is_some()
            && method.starts_with("sessions.")
            && !matches!(
                method,
                methods::SESSIONS_LIST
                    | methods::SESSIONS_CREATE
                    | methods::SESSIONS_ENSURE
                    // axe:e3 — la suppression porte sur une conversation archivee,
                    // absente de la memoire : le controle de visibilite est fait
                    // dans le gestionnaire, sur la metadonnee relue de l'archive.
                    | methods::SESSIONS_DELETE
                    // axe:e3 — idem pour le retablissement : la conversation
                    // archivee n'est plus en memoire.
                    | methods::SESSIONS_RESTORE
                    // axe:v2-e12f — le retablissement passe aussi par
                    // `sessions.update {archived: false}` : la conversation
                    // archivee n'est pas en memoire, le controle de
                    // visibilite est fait dans `restore_archived`.
                    | methods::SESSIONS_UPDATE
            )
        {
            if let Some(id) = opt_str(&params, "sessionId") {
                if id != "*" {
                    visible_session(self, &id)?;
                }
            }
        }
        let ok = |v: Value| -> SessionResult<Value> { Ok(v) };
        match method {
            m if m.starts_with("fs.") || m.starts_with("git.") => {
                crate::workspace_rpc::dispatch(self, m, &params)
            }
            m if m.starts_with("share.") => crate::share_rpc::dispatch(self, m, &params),
            // v2-l2.4 — skills/harness of the service workspace (common brain)
            m if m.starts_with("skills.") || m.starts_with("harness.") => {
                crate::brain_rpc::dispatch(self, m, &params)
            }
            // v2-l7c — external agents (on-disk task queue under .axecode/agents)
            m if m.starts_with("agents.") => crate::agents_rpc::dispatch(self, m, &params),
            // axe:voix — dictée vocale : Whisper de la machine, nettoyage IA optionnel
            m if m.starts_with("voice.") => crate::voice_rpc::dispatch(self, m, &params).await,
            m if m.starts_with("term.") => {
                crate::term_rpc::dispatch(&self.arc(), client, m, &params)
            }
            methods::HELLO => {
                if let Some(name) = opt_str(&params, "client") {
                    self.set_client_name(client, name);
                }
                ok(self.status_json())
            }
            methods::STATUS => ok(self.status_json()),
            methods::SHUTDOWN => {
                let force = params
                    .get("force")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if self.any_running() && !force {
                    return Err(SessionError::Busy(
                        "sessions are running (use force)".into(),
                    ));
                }
                self.request_shutdown();
                ok(json!({"ok": true}))
            }
            methods::SESSIONS_LIST => {
                // axe:e3 — les conversations archivees ne sortent que si on les
                // demande : la liste active garde exactement son comportement.
                if params.get("archived").and_then(Value::as_bool) == Some(true) {
                    return self.list_archived_entries();
                }
                let root = self
                    .config
                    .workspace_root
                    .as_ref()
                    .map(|r| r.canonicalize())
                    .transpose()
                    .map_err(|e| SessionError::Io(e.to_string()))?;
                let mut sessions = self.list_metas();
                if root.is_some() {
                    sessions.retain(|m| visible_session(self, &m.id).is_ok());
                    let visible: std::collections::HashSet<String> =
                        sessions.iter().map(|m| m.id.clone()).collect();
                    for m in &mut sessions {
                        m.children.retain(|id| visible.contains(id));
                        if m.parent_id.as_ref().is_some_and(|id| !visible.contains(id)) {
                            m.parent_id = None;
                        }
                    }
                }
                ok(serde_json::to_value(sessions)?)
            }
            // axe:e3 — archiver : la conversation quitte les conversations actives
            // et part dans le dossier d'archive, dont le chemin n'est jamais montre.
            methods::SESSIONS_ARCHIVE => {
                let id = sid(&params)?;
                ok(self.archive(&id)?)
            }
            // axe:e3 — supprimer : refuse tant que la conversation n'est pas
            // archivee ; ensuite seulement, l'archive est effacee.
            methods::SESSIONS_DELETE => {
                let id = sid(&params)?;
                ok(self.delete_archived(&id)?)
            }
            // axe:e3 — retablir : une conversation archivee revient dans la
            // liste active (archiver n'est donc pas un aller simple).
            methods::SESSIONS_RESTORE => {
                let id = sid(&params)?;
                ok(self.restore_archived(&id)?)
            }
            methods::SESSIONS_GET => {
                let meta = self.meta(&sid(&params)?)?;
                if let Some(root) = self.config.workspace_root.as_ref() {
                    let root = root
                        .canonicalize()
                        .map_err(|e| SessionError::Io(e.to_string()))?;
                    let workspace = Path::new(&meta.workspace_id)
                        .canonicalize()
                        .map_err(|e| SessionError::Io(e.to_string()))?;
                    if !workspace.starts_with(&root) {
                        return Err(SessionError::NotFound(meta.id));
                    }
                }
                ok(serde_json::to_value(meta)?)
            }
            methods::SESSIONS_CREATE => {
                let request: CreateSessionRequest = parse(params)?;
                let meta = self.create(request)?;
                self.attach(client, &meta.id, true);
                ok(serde_json::to_value(meta)?)
            }
            methods::SESSIONS_ENSURE => {
                let id = sid(&params)?;
                let request: CreateSessionRequest =
                    parse(params.get("request").cloned().unwrap_or_default())?;
                let history: Vec<ChatMessage> = match params.get("history") {
                    Some(h) => parse(h.clone())?,
                    None => Vec::new(),
                };
                if self.meta(&id).is_ok() {
                    visible_session(self, &id)?;
                }
                let meta = self.ensure(&id, request, history)?;
                visible_session(self, &meta.id)?;
                ok(serde_json::to_value(meta)?)
            }
            // axe:freechat — a free conversation opened in a project folder
            methods::SESSIONS_RELOCATE => {
                let id = sid(&params)?;
                let workspace = opt_str(&params, "workspaceId").unwrap_or_default();
                let extra = opt_str(&params, "systemPromptExtra");
                ok(serde_json::to_value(
                    self.relocate(&id, workspace, extra).await?,
                )?)
            }
            // axe:freechat end
            methods::SESSIONS_ATTACH | methods::SESSIONS_DETACH => {
                let id = opt_str(&params, "sessionId").unwrap_or_else(|| "*".into());
                if id != "*" {
                    self.meta(&id)?;
                }
                self.attach(client, &id, method == methods::SESSIONS_ATTACH);
                ok(json!({"ok": true}))
            }
            methods::SESSIONS_SEND => {
                let id = sid(&params)?;
                let message: ChatMessage = match params.get("message") {
                    Some(m) => parse(m.clone())?,
                    None => ChatMessage::user_text(opt_str(&params, "text").unwrap_or_default()),
                };
                ok(json!({"entryId": self.send_user(&id, message)?}))
            }
            methods::SESSIONS_MESSAGE => {
                let to = sid(&params)?;
                let from = opt_str(&params, "from").unwrap_or_else(|| "user".into());
                let text = opt_str(&params, "text").unwrap_or_default();
                // axe:bg-a — `wake: false` : note système livrée au prochain tour, sans en lancer un.
                if params.get("wake").and_then(Value::as_bool) == Some(false) {
                    return ok(json!({"entryId": self.post_peer_quiet(&from, &to, text)?}));
                }
                ok(json!({"entryId": self.post_peer(&from, &to, text)?}))
            }
            methods::SESSIONS_STOP => {
                self.stop(&sid(&params)?)?;
                ok(json!({"ok": true}))
            }
            methods::SESSIONS_HISTORY => {
                let journal = self.journal(&sid(&params)?)?;
                let history = lock(&journal).history();
                ok(serde_json::to_value(history)?)
            }
            methods::SESSIONS_TREE => {
                let journal = self.journal(&sid(&params)?)?;
                let tree = lock(&journal).tree();
                ok(serde_json::to_value(tree)?)
            }
            methods::SESSIONS_MOVE_LEAF => {
                let id = sid(&params)?;
                let entry = opt_str(&params, "entryId")
                    .ok_or_else(|| SessionError::Protocol("missing entryId".into()))?;
                ok(json!({"entryId": self.move_leaf(&id, &entry, opt_str(&params, "label"))?}))
            }
            methods::SESSIONS_FORK => {
                let id = sid(&params)?;
                // axe:arriere-plan — parent du clone (ex. la conversation libérée).
                let parent = opt_str(&params, "parentId");
                if let Some(parent) = parent.as_deref() {
                    if self.config.workspace_root.is_some() {
                        visible_session(self, parent)?;
                    }
                }
                let meta = self.fork(
                    &id,
                    opt_str(&params, "entryId"),
                    opt_str(&params, "name"),
                    parent,
                )?;
                ok(serde_json::to_value(meta)?)
            }
            // axe:commandes — indicateurs /goal et /heartbeat (lecture, arrêt)
            methods::SESSIONS_COMMANDS_STATE => ok(crate::commandes_rpc::state(self, &sid(&params)?)?),
            methods::SESSIONS_COMMANDS_SET => {
                let op = opt_str(&params, "op").unwrap_or_default();
                ok(crate::commandes_rpc::set(self, &sid(&params)?, &op)?)
            }
            methods::SESSIONS_SET_MODEL => {
                let id = sid(&params)?;
                let model: ModelRef = parse(params.get("model").cloned().unwrap_or_default())?;
                self.set_model(&id, model)?;
                ok(json!({"ok": true}))
            }
            // axe:v2-e12f — une seule notion d'archive : le tiroir d'E3.
            // « archived: true » range la conversation (le journal quitte les
            // conversations actives : plus personne ne la lit, ni l'interface,
            // ni le harnais, ni un agent) ; « archived: false » la retablit.
            // L'ancien drapeau, qui rangeait sans deplacer, n'existe plus.
            methods::SESSIONS_UPDATE => {
                let id = sid(&params)?;
                let archived = params.get("archived").and_then(Value::as_bool);
                if archived != Some(false) {
                    // Toute autre modification porte sur une conversation
                    // active : le controle habituel s'applique.
                    visible_session(self, &id)?;
                }
                // Renommer d'abord : une fois archivee, le journal n'est plus
                // la ou `update` ecrit.
                if let Some(name) = opt_str(&params, "name") {
                    self.update(&id, Some(name), None)?;
                }
                match archived {
                    Some(true) => {
                        self.archive(&id)?;
                    }
                    Some(false) => {
                        self.restore_archived(&id)?;
                    }
                    None => {}
                }
                ok(json!({"ok": true}))
            }
            methods::SESSIONS_RECORD => {
                let id = sid(&params)?;
                let kind: JournalEntryKind =
                    parse(params.get("entry").cloned().unwrap_or_default())?;
                ok(json!({"entryId": self.append(&id, kind)?}))
            }
            methods::SESSIONS_UNLOAD => {
                self.unload(&sid(&params)?).await;
                ok(json!({"ok": true}))
            }
            // axe:webui — browser sessions (Settings > Interface web)
            m if m.starts_with("webui.") => crate::webui::dispatch(self, m, params),
            // axe:webui end
            other => Err(SessionError::Protocol(format!("unknown method {other}"))),
        }
    }

    pub fn request_shutdown(&self) {
        if !self
            .shutting_down
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            self.broadcast("daemon", None, json!({"state": "shutting_down"}));
            self.shutdown.notify_waiters();
            self.shutdown.notify_one();
        }
    }

    fn should_auto_shutdown(&self) -> bool {
        self.config.auto_shutdown
            && !self.any_running()
            && lock(&self.clients).is_empty()
            && lock(&self.last_activity).elapsed() >= self.config.shutdown_grace
    }
}

pub(crate) async fn serve_client(daemon: Arc<Daemon>, stream: BoxStream) {
    let (read, mut write) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let client = daemon.add_client("client".into(), tx.clone());
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = write.flush().await;
        }
    });
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(err) => {
                tracing::warn!(error = %err, "invalid request line");
                continue;
            }
        };
        let daemon = daemon.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let response = match daemon
                .dispatch(client, &request.method, request.params)
                .await
            {
                Ok(result) => Response {
                    id: request.id,
                    result: Some(result),
                    error: None,
                },
                Err(err) => Response {
                    id: request.id,
                    result: None,
                    error: Some(err.to_string()),
                },
            };
            if let Ok(mut text) = serde_json::to_string(&ServerLine::Response(response)) {
                text.push('\n');
                let _ = tx.send(text);
            }
        });
    }
    daemon.remove_client(client);
    writer.abort();
}

/// Binds the endpoint, writes the lock file and serves until shutdown.
pub async fn run(daemon: Arc<Daemon>) -> anyhow::Result<()> {
    let config = daemon.config.clone();
    std::fs::create_dir_all(&config.data_dir)?;
    let mut listener = Listener::bind(&config.endpoint)?;
    // axe:remote — optional network listener, closed by default.
    let remote = match &config.listen {
        Some(listen) => Some((crate::listen::bind(&daemon, listen).await?, listen.clone())),
        None => None,
    };
    // axe:remote end
    let pid = std::process::id();
    protocol::write_lock(
        &config.data_dir,
        &LockInfo {
            pid,
            endpoint: listener.endpoint().to_string(),
            version: config.version.clone(),
            protocol: protocol::PROTOCOL_VERSION,
            started_at_ms: now_ms(),
            listen: config.listen.as_ref().map(|l| l.addr.to_string()), // axe:remote
        },
    )?;
    tracing::info!(endpoint = %config.endpoint, pid, "axecode-daemon listening");
    // axe:remote
    let remote_task = remote.map(|(tcp, listen)| {
        tracing::info!(addr = %listen.addr, "remote WebSocket listener enabled");
        tokio::spawn(crate::listen::serve(daemon.clone(), tcp, listen))
    });
    // axe:remote end
    crate::webui::install(&config.data_dir); // axe:webui
                                             // v2-l7c — recover external agent tasks (ghost `en_cours` -> `erreur`).
    if let Err(error) = crate::agents_rpc::start(&daemon) {
        tracing::warn!(error = %error, "agents queue unavailable at startup");
    }

    let housekeeping = {
        let daemon = daemon.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(15));
            loop {
                tick.tick().await;
                daemon.housekeeping().await; // axe:menage
                if daemon.should_auto_shutdown() {
                    tracing::info!("no running session and no client: shutting down");
                    daemon.request_shutdown();
                    break;
                }
            }
        })
    };

    loop {
        tokio::select! {
            _ = daemon.shutdown.notified() => break,
            accepted = listener.accept() => match accepted {
                Ok(stream) => {
                    tokio::spawn(serve_client(daemon.clone(), stream));
                }
                Err(err) => {
                    tracing::warn!(error = %err, "accept failed");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            },
        }
    }
    housekeeping.abort();
    if let Some(task) = remote_task {
        task.abort(); // axe:remote
    }
    for meta in daemon.list_metas() {
        let _ = daemon.stop(&meta.id);
        daemon.unload(&meta.id).await;
    }
    protocol::remove_lock(&config.data_dir, pid);
    drop(listener);
    Ok(())
}
