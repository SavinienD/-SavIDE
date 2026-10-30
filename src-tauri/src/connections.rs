// axe:remote — registry of service connections (Settings > Connexions).
//
// `Local` is implicit and always present. `Distante` connects to a remote
// service over WebSocket (`--listen`), `SSH` opens a tunnel with the user's
// own ssh client/keys to a service listening on the remote loopback and can
// start it. Non-secret fields live in `<data>/connections.json`; passwords
// and tokens in `<data>/connection-secrets.json` (0600), never sent back to
// the frontend.

use crate::*;

use axecode_daemon::client::DaemonClient;

pub(crate) const LOCAL_ID: &str = "local";
const CONNECTIONS_FILE: &str = "connections.json";
const SECRETS_FILE: &str = "connection-secrets.json";
pub(crate) const DEFAULT_REMOTE_PORT: u16 = 9119;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConnectionKind {
    #[default]
    Remote,
    Ssh,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshTarget {
    pub user: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    /// Port of the service on the remote loopback.
    #[serde(default = "default_remote_port")]
    pub remote_port: u16,
    /// Optional private key (`-i`); the ssh agent / config is used otherwise.
    #[serde(default)]
    pub identity_file: Option<String>,
    /// Start `axecode --daemon serve --listen 127.0.0.1:<remote_port>`
    /// on the remote machine when nothing answers.
    #[serde(default = "default_true")]
    pub start_service: bool,
    /// Remote executable used to start the service.
    #[serde(default)]
    pub remote_command: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}
fn default_remote_port() -> u16 {
    DEFAULT_REMOTE_PORT
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection {
    pub id: String,
    pub name: String,
    pub kind: ConnectionKind,
    /// Remote: service URL (`wss://host`, `https://host:9119`, `host:9119`).
    #[serde(default)]
    pub url: String,
    /// Remote / SSH: user name for Basic auth (empty = token auth).
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub ssh: Option<SshTarget>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionsFile {
    #[serde(default)]
    pub active: String,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionSecret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

fn data_dir() -> std::result::Result<PathBuf, String> {
    axecode_daemon::util::default_data_dir().map_err(|e| e.to_string())
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> std::result::Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("impossible d'écrire {} : {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| format!("impossible d'écrire {} : {e}", path.display()))
}

pub(crate) fn load_file() -> ConnectionsFile {
    let mut file: ConnectionsFile = data_dir()
        .map(|dir| read_json(&dir.join(CONNECTIONS_FILE)))
        .unwrap_or_default();
    if file.active.is_empty() || !file.connections.iter().any(|c| c.id == file.active) {
        file.active = LOCAL_ID.into();
    }
    file
}

pub(crate) fn save_file(file: &ConnectionsFile) -> std::result::Result<(), String> {
    write_json(&data_dir()?.join(CONNECTIONS_FILE), file)
}

pub(crate) fn load_secrets() -> HashMap<String, ConnectionSecret> {
    data_dir()
        .map(|dir| read_json(&dir.join(SECRETS_FILE)))
        .unwrap_or_default()
}

pub(crate) fn save_secrets(secrets: &HashMap<String, ConnectionSecret>) -> std::result::Result<(), String> {
    write_json(&data_dir()?.join(SECRETS_FILE), secrets)
}

pub(crate) fn find(id: &str) -> Option<Connection> {
    load_file().connections.into_iter().find(|c| c.id == id)
}

/// `Authorization` header value for a connection, if any secret is stored.
fn authorization(connection: &Connection) -> Option<String> {
    let secret = load_secrets().remove(&connection.id)?;
    if let Some(token) = secret.token.filter(|t| !t.trim().is_empty()) {
        return Some(format!("Bearer {}", token.trim()));
    }
    let password = secret.password.filter(|p| !p.is_empty())?;
    if connection.username.trim().is_empty() {
        return None;
    }
    Some(format!(
        "Basic {}",
        BASE64_STANDARD.encode(format!("{}:{password}", connection.username.trim()))
    ))
}

/// axe:v2-e12 — meme en-tete, pour une connexion nommee (l'onglet Prime Agent s'en sert).
pub(crate) fn authorization_for(id: &str) -> Option<String> {
    authorization(&find(id)?)
}

/// Normalises a user-entered URL to the WebSocket endpoint (`…/ws`).
pub(crate) fn ws_url(raw: &str) -> std::result::Result<String, String> {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("URL manquante".into());
    }
    let (scheme, rest) = match raw.split_once("://") {
        Some(("https" | "wss", rest)) => ("wss", rest),
        Some(("http" | "ws", rest)) => ("ws", rest),
        Some((other, _)) => return Err(format!("schéma non pris en charge : {other}")),
        None => ("ws", raw),
    };
    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, format!("/{p}")),
        None => (rest, String::new()),
    };
    let path = if path.is_empty() { "/ws".to_string() } else { path };
    Ok(format!("{scheme}://{authority}{path}"))
}

// ----- live clients and SSH tunnels ----------------------------------------

#[derive(Default)]
pub(crate) struct ConnectionsState {
    pub(crate) clients: Mutex<HashMap<String, DaemonClient>>,
    tunnels: StdMutex<HashMap<String, (u16, std::process::Child)>>,
}

impl Drop for ConnectionsState {
    fn drop(&mut self) {
        if let Ok(mut tunnels) = self.tunnels.lock() {
            for (_, (_, mut child)) in tunnels.drain() {
                let _ = child.kill();
            }
        }
    }
}

fn hidden(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn ssh_base(target: &SshTarget) -> std::process::Command {
    let mut command = __nw_std("ssh");
    command
        .arg("-p")
        .arg(target.port.to_string())
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
    if let Some(key) = target.identity_file.as_deref().filter(|k| !k.trim().is_empty()) {
        command.arg("-i").arg(key.trim());
    }
    hidden(&mut command);
    command
}

fn ssh_destination(target: &SshTarget) -> std::result::Result<String, String> {
    let host = target.host.trim();
    let user = target.user.trim();
    let valid = |s: &str| !s.is_empty() && !s.starts_with('-') && !s.chars().any(char::is_whitespace);
    if !valid(host) || (!user.is_empty() && !valid(user)) {
        return Err("hôte SSH invalide".into());
    }
    Ok(if user.is_empty() { host.to_string() } else { format!("{user}@{host}") })
}

/// Runs a remote command over ssh (blocking; call from spawn_blocking).
fn ssh_exec(target: &SshTarget, remote: &str) -> std::result::Result<String, String> {
    let output = ssh_base(target)
        .arg(ssh_destination(target)?)
        .arg(remote)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("ssh introuvable : {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Starts the remote service on its loopback when it does not answer.
fn ensure_remote_service(target: &SshTarget) -> std::result::Result<(), String> {
    let exe = target
        .remote_command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("axecode");
    let status = ssh_exec(target, &format!("{exe} --daemon status"))?;
    if serde_json::from_str::<Value>(status.trim())
        .ok()
        .and_then(|v| v.get("listen").cloned())
        .is_some_and(|l| l.is_string())
    {
        return Ok(());
    }
    if status.contains("\"running\":true") || status.contains("\"pid\"") {
        return Err("un service tourne déjà sur la machine distante sans --listen ; redémarrez-le avec --listen 127.0.0.1:<port>".into());
    }
    ssh_exec(
        target,
        &format!(
            "nohup {exe} --daemon serve --listen 127.0.0.1:{} >/dev/null 2>&1 &",
            target.remote_port
        ),
    )?;
    std::thread::sleep(Duration::from_millis(1500));
    Ok(())
}

fn free_local_port() -> std::result::Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

/// Returns the local port of a live tunnel, opening one if needed.
fn ensure_tunnel(state: &ConnectionsState, id: &str, target: &SshTarget) -> std::result::Result<u16, String> {
    let mut tunnels = state.tunnels.lock().map_err(|_| "tunnels poisoned")?;
    if let Some((port, child)) = tunnels.get_mut(id) {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(*port);
        }
    }
    tunnels.remove(id);
    let port = free_local_port()?;
    let child = ssh_base(target)
        .args(["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30"])
        .arg("-L")
        .arg(format!("127.0.0.1:{port}:127.0.0.1:{}", target.remote_port))
        .arg(ssh_destination(target)?)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("ssh introuvable : {e}"))?;
    tunnels.insert(id.to_string(), (port, child));
    Ok(port)
}

fn close_tunnel(state: &ConnectionsState, id: &str) {
    if let Ok(mut tunnels) = state.tunnels.lock() {
        if let Some((_, mut child)) = tunnels.remove(id) {
            let _ = child.kill();
        }
    }
}

/// Connects (or reuses the client of) a non-local connection.
pub(crate) async fn connect_remote(app: &AppHandle, id: &str) -> std::result::Result<DaemonClient, String> {
    let state = app.state::<ConnectionsState>();
    let mut clients = state.clients.lock().await;
    if let Some(client) = clients.get(id).filter(|c| !c.is_closed()) {
        return Ok(client.clone());
    }
    let connection = find(id).ok_or_else(|| format!("connexion inconnue : {id}"))?;
    let client = open(app, &state, &connection, true).await?;
    clients.insert(id.to_string(), client.clone());
    Ok(client)
}

/// Opens a fresh client; `forward_events` re-emits daemon events tagged
/// with the connection id on `axe://daemon`.
async fn open(
    app: &AppHandle,
    state: &ConnectionsState,
    connection: &Connection,
    forward_events: bool,
) -> std::result::Result<DaemonClient, String> {
    let url = match connection.kind {
        ConnectionKind::Remote => ws_url(&connection.url)?,
        ConnectionKind::Ssh => {
            let target = connection.ssh.clone().ok_or("cible SSH manquante")?;
            if target.start_service {
                let t = target.clone();
                tokio::task::spawn_blocking(move || ensure_remote_service(&t))
                    .await
                    .map_err(|e| e.to_string())??;
            }
            let port = ensure_tunnel(state, &connection.id, &target)?;
            // The tunnel needs a moment to come up.
            let mut ready = false;
            for _ in 0..50 {
                if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                    ready = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if !ready {
                close_tunnel(state, &connection.id);
                return Err("le tunnel SSH ne s'est pas ouvert (clé, hôte ou port ?)".into());
            }
            format!("ws://127.0.0.1:{port}/ws")
        }
    };
    let auth = authorization(connection);
    let events = if forward_events {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<axecode_daemon::protocol::Event>();
        let app = app.clone();
        let connection_id = connection.id.clone();
        let source = format!("{}:{}", connection.id, crate::daemon_client::next_source_id());
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                // axe:un-seul-espace - les evenements du daemon distant alimentent le chat.
                crate::daemon_client::bridge_event(&app, &event, &source);
                let mut payload = serde_json::to_value(&event).unwrap_or_default();
                payload["connectionId"] = json!(connection_id);
                let _ = app.emit(crate::daemon_client::DAEMON_EVENT, payload);
            }
            let _ = app.emit(
                crate::daemon_client::DAEMON_EVENT,
                json!({"event": "connection", "connectionId": connection_id, "data": {"state": "closed"}}),
            );
        });
        Some(tx)
    } else {
        None
    };
    let client = DaemonClient::connect_ws(&url, auth.as_deref(), events).await.map_err(|err| {
        if err.contains("401") {
            "authentification refusée (identifiant, mot de passe ou jeton)".to_string()
        } else if err.contains("421") {
            "hôte refusé par le service (ajoutez --allow-host <nom> côté serveur)".to_string()
        } else {
            err
        }
    })?;
    let _ = client
        .call("hello", json!({"client": format!("ide:{}:{}", hostname(), std::process::id())}))
        .await;
    if forward_events {
        let _ = client.call("sessions.attach", json!({"sessionId": "*"})).await;
    }
    Ok(client)
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "ide".into())
}

/// Calls a method on any connection (`local` goes through the local pipe).
pub(crate) async fn call_on(
    app: &AppHandle,
    connection_id: Option<&str>,
    method: &str,
    params: Value,
) -> std::result::Result<Value, String> {
    match connection_id.filter(|id| !id.is_empty() && *id != LOCAL_ID) {
        None => crate::daemon_client::daemon_call_value(app, method, params).await,
        Some(id) => {
            let client = connect_remote(app, id).await?;
            let result = client.call(method, params).await;
            if client.is_closed() {
                app.state::<ConnectionsState>().clients.lock().await.remove(id);
            }
            result
        }
    }
}

// ----- IPC -------------------------------------------------------------------

/// Connection as shown to the frontend (secrets reduced to flags).
fn view(connection: &Connection, secrets: &HashMap<String, ConnectionSecret>) -> Value {
    let secret = secrets.get(&connection.id);
    let mut value = serde_json::to_value(connection).unwrap_or_default();
    value["hasPassword"] = json!(secret.and_then(|s| s.password.as_ref()).is_some_and(|p| !p.is_empty()));
    value["hasToken"] = json!(secret.and_then(|s| s.token.as_ref()).is_some_and(|t| !t.is_empty()));
    value
}

#[tauri::command]
pub(crate) async fn connections_list() -> std::result::Result<Value, String> {
    let file = load_file();
    let secrets = load_secrets();
    let mut list = vec![json!({"id": LOCAL_ID, "name": "Local", "kind": "local"})];
    list.extend(file.connections.iter().map(|c| view(c, &secrets)));
    Ok(json!({"active": file.active, "connections": list}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionSaveInput {
    connection: Connection,
    /// `Some("")` clears, `None` keeps the stored value.
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    token: Option<String>,
}

fn validate(connection: &mut Connection) -> std::result::Result<(), String> {
    connection.name = connection.name.trim().to_string();
    if connection.name.is_empty() {
        return Err("nom requis".into());
    }
    match connection.kind {
        ConnectionKind::Remote => {
            ws_url(&connection.url)?;
            connection.ssh = None;
        }
        ConnectionKind::Ssh => {
            let target = connection.ssh.as_mut().ok_or("cible SSH manquante")?;
            target.host = target.host.trim().to_string();
            target.user = target.user.trim().to_string();
            ssh_destination(target)?;
            if let Some(cmd) = &target.remote_command {
                if cmd.chars().any(|c| matches!(c, ';' | '&' | '|' | '`' | '$' | '\n' | '<' | '>')) {
                    return Err("commande distante invalide".into());
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn connections_save(
    app: AppHandle,
    input: ConnectionSaveInput,
) -> std::result::Result<Value, String> {
    let mut connection = input.connection;
    // axe:cloud — the Axe Cloud connection (URL + token) is managed by the
    // sign-in only: editing it here could send its token to another host.
    if connection.id == crate::cloud::CLOUD_CONNECTION_ID {
        return Err("connexion gérée par la connexion Axe Cloud (menu du compte)".into());
    }
    validate(&mut connection)?;
    let mut file = load_file();
    if connection.id.is_empty() || connection.id == LOCAL_ID {
        connection.id = format!("conn-{}", &axecode_daemon::util::new_id()[..8]);
    }
    file.connections.retain(|c| c.id != connection.id);
    file.connections.push(connection.clone());
    save_file(&file)?;
    let mut secrets = load_secrets();
    let entry = secrets.entry(connection.id.clone()).or_default();
    if let Some(password) = input.password {
        entry.password = Some(password).filter(|p| !p.is_empty());
    }
    if let Some(token) = input.token {
        entry.token = Some(token.trim().to_string()).filter(|t| !t.is_empty());
    }
    save_secrets(&secrets)?;
    // Credentials or target may have changed: drop the live client.
    disconnect(&app, &connection.id).await;
    Ok(view(&connection, &secrets))
}

pub(crate) async fn disconnect(app: &AppHandle, id: &str) {
    let state = app.state::<ConnectionsState>();
    state.clients.lock().await.remove(id);
    close_tunnel(&state, id);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionIdInput {
    id: String,
}

#[tauri::command]
pub(crate) async fn connections_delete(
    app: AppHandle,
    input: ConnectionIdInput,
) -> std::result::Result<(), String> {
    let mut file = load_file();
    file.connections.retain(|c| c.id != input.id);
    if file.active == input.id {
        file.active = LOCAL_ID.into();
    }
    save_file(&file)?;
    let mut secrets = load_secrets();
    secrets.remove(&input.id);
    save_secrets(&secrets)?;
    disconnect(&app, &input.id).await;
    let _ = app.emit("axe://connection-active", json!({"active": file.active}));
    Ok(())
}

#[tauri::command]
pub(crate) async fn connections_set_active(
    app: AppHandle,
    input: ConnectionIdInput,
) -> std::result::Result<(), String> {
    let mut file = load_file();
    if input.id != LOCAL_ID && !file.connections.iter().any(|c| c.id == input.id) {
        return Err("connexion inconnue".into());
    }
    file.active = input.id.clone();
    save_file(&file)?;
    let _ = app.emit("axe://connection-active", json!({"active": input.id}));
    Ok(())
}

/// Tests a connection (saved, by id) and returns the service status.
#[tauri::command]
pub(crate) async fn connections_test(
    app: AppHandle,
    input: ConnectionIdInput,
) -> std::result::Result<Value, String> {
    let started = std::time::Instant::now();
    let mut status = call_on(&app, Some(&input.id), "status", json!({})).await?;
    status["latencyMs"] = json!(started.elapsed().as_millis() as u64);
    Ok(status)
}

/// Connection state of every live client (no network round-trip).
#[tauri::command]
pub(crate) async fn connections_state(app: AppHandle) -> std::result::Result<Value, String> {
    let state = app.state::<ConnectionsState>();
    let clients = state.clients.lock().await;
    let mut out = serde_json::Map::new();
    for connection in load_file().connections {
        let connected = clients.get(&connection.id).is_some_and(|c| !c.is_closed());
        out.insert(connection.id, json!(if connected { "connected" } else { "disconnected" }));
    }
    Ok(Value::Object(out))
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
