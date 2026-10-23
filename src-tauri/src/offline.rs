// axe:v2-l6 — mode désynchronisé (tranche 2, côté application).
//
// Quand le service d'un espace cloud est injoignable, l'IDE continue de le
// consulter et de le modifier à partir d'un MIROIR local :
//   <data>/offline/<connexion>/files/        copie de travail (une copie par fichier)
//   <data>/offline/<connexion>/base.json     empreintes de référence du service
//   <data>/offline/<connexion>/journal.json  opérations locales en attente
// Les lectures servent le miroir ; les écritures y écrivent ET journalisent une
// opération. `offline_sync` rejoue le journal sur le service au retour du
// réseau, et signale les conflits (le service a changé depuis la référence).
//
// Aucun chemin local du poste n'est utilisé pour un espace cloud : toutes les
// conversations avec le service passent par `connections::call_on`.

use crate::*;

use std::collections::BTreeMap;

/// Taille maximale d'un fichier copié dans le miroir (2 Mo).
const MAX_MIRROR_FILE_BYTES: u64 = 2 * 1024 * 1024;

// ----- helpers purs (testés) ------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.as_ref() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Identifiant de connexion extrait de `axe-cloud://<connexion>/<racine>`.
fn connection_from_workspace(workspace_path: &str) -> std::result::Result<String, String> {
    let connection = crate::daemon_client::cloud_connection_id(Path::new(workspace_path))
        .ok_or_else(|| "espace cloud requis".to_string())?;
    if connection == "."
        || connection == ".."
        || connection.contains('\\')
        || connection.contains(':')
        || connection.contains('\0')
    {
        return Err("connexion cloud invalide".into());
    }
    Ok(connection)
}

/// Racine du miroir d'une connexion (`<data>/offline/<connexion>`).
fn offline_root(connection: &str) -> std::result::Result<PathBuf, String> {
    Ok(axecode_daemon::util::default_data_dir()
        .map_err(|e| e.to_string())?
        .join("offline")
        .join(connection))
}

fn mirror_files(root: &Path) -> PathBuf {
    root.join("files")
}

fn base_path(root: &Path) -> PathBuf {
    root.join("base.json")
}

fn journal_path(root: &Path) -> PathBuf {
    root.join("journal.json")
}

/// Chemin relatif sûr : ni absolu, ni `..`, ni séparateur Windows, ni vide.
fn clean_rel(path: &str) -> std::result::Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty()
        || Path::new(trimmed).is_absolute()
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('\0')
        || trimmed.split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("chemin invalide : {path}"));
    }
    Ok(trimmed.to_string())
}

/// Dossiers parents d'un chemin (`a/b/c.txt` → `a`, `a/b`).
fn ancestor_dirs(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let mut out = Vec::new();
    let mut acc = String::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(part);
        out.push(acc.clone());
    }
    out
}

fn mirror_path(root: &Path, rel: &str) -> std::result::Result<PathBuf, String> {
    Ok(mirror_files(root).join(clean_rel(rel)?))
}

fn split_parent(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some((parent, name)) => (parent.to_string(), name.to_string()),
        None => (String::new(), path.to_string()),
    }
}

/// Écriture atomique (fichier temporaire + rename), jamais partielle.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::result::Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_file_name(format!(".tmp-{}", axecode_daemon::util::new_id()));
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    Ok(())
}

/// Nom du voisin qui garde la version locale : `rapport.md` → `rapport (copie).md`,
/// puis `rapport (copie 2).md`…
fn copy_suffix_path(rel: &str, n: usize) -> String {
    let (parent, name) = split_parent(rel);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (name.as_str(), String::new()),
    };
    let label = if n == 1 {
        "copie".to_string()
    } else {
        format!("copie {n}")
    };
    let candidate = format!("{stem} ({label}){ext}");
    if parent.is_empty() {
        candidate
    } else {
        format!("{parent}/{candidate}")
    }
}

/// Premier chemin voisin encore libre dans le miroir (pour garder les deux
/// versions : l'espace garde la sienne, la copie locale devient un voisin).
fn both_target(root: &Path, rel: &str) -> std::result::Result<String, String> {
    for n in 1..=99 {
        let candidate = copy_suffix_path(rel, n);
        if !mirror_path(root, &candidate)?.exists() {
            return Ok(candidate);
        }
    }
    Err("aucun nom de copie disponible".into())
}

// ----- journal --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Op {
    kind: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_path: Option<String>,
    at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Journal {
    #[serde(default)]
    ops: Vec<Op>,
}

/// Une seule opération par chemin : la dernière écrase la précédente ;
/// une suppression annule les écritures précédentes du même chemin.
fn coalesce(ops: &mut Vec<Op>, op: Op) {
    match op.kind.as_str() {
        "rename" => {
            let from = op.path.clone();
            let to = op.new_path.clone().unwrap_or_default();
            ops.retain(|existing| {
                existing.path != from
                    && existing.path != to
                    && existing.new_path.as_deref() != Some(from.as_str())
                    && existing.new_path.as_deref() != Some(to.as_str())
            });
            ops.push(op);
        }
        _ => {
            ops.retain(|existing| {
                existing.path != op.path && existing.new_path.as_deref() != Some(op.path.as_str())
            });
            ops.push(op);
        }
    }
}

fn push_op(root: &Path, op: Op) -> std::result::Result<(), String> {
    let mut journal = load_journal(root);
    coalesce(&mut journal.ops, op);
    save_journal(root, &journal)
}

// ----- base.json ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaseEntry {
    hash: String,
    at_ms: u64,
}

type Base = BTreeMap<String, BaseEntry>;

fn load_base(root: &Path) -> Base {
    fs::read(base_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_base(root: &Path, base: &Base) -> std::result::Result<(), String> {
    let bytes = serde_json::to_vec_pretty(base).map_err(|e| e.to_string())?;
    write_atomic(&base_path(root), &bytes)
}

fn load_journal(root: &Path) -> Journal {
    fs::read(journal_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_journal(root: &Path, journal: &Journal) -> std::result::Result<(), String> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(|e| e.to_string())?;
    write_atomic(&journal_path(root), &bytes)
}

fn open_mirror(workspace_path: &str) -> std::result::Result<(String, PathBuf), String> {
    let connection = connection_from_workspace(workspace_path)?;
    let root = offline_root(&connection)?;
    Ok((connection, root))
}

fn walk_files(dir: &Path, visit: &mut impl FnMut(u64)) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk_files(&entry.path(), visit);
        } else if file_type.is_file() {
            visit(entry.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
}

// ----- détection réseau (côté application) ---------------------------------

const SERVICE_PREFIXES: [&str; 21] = [
    "protocol error",
    "io error",
    "journal error",
    "session not found",
    "session busy",
    "runtime error",
    "turn cancelled",
    "invalid request",
    "auth error",
    "rate limited",
    "context window exceeded",
    "network error",
    "decode error",
    "stream error",
    "retryable stream error",
    "unsupported feature",
    "provider error",
    "authentification refusée",
    "hôte refusé",
    "cible ssh manquante",
    "connexion inconnue",
];

const TRANSPORT_MARKERS: [&str; 23] = [
    "daemon connection closed",
    "timed out",
    "cannot start daemon",
    "connection refused",
    "connection reset",
    "connection closed",
    "connection aborted",
    "connection terminated",
    "failed to connect",
    "connect error",
    "network is unreachable",
    "not connected",
    "tunnel ssh",
    "ssh introuvable",
    "tls error",
    "dns error",
    "failed to lookup address",
    "websocket protocol error",
    "unexpected eof",
    "early eof",
    "broken pipe",
    "certificate",
    "os error",
];

/// `true` quand l'erreur vient du transport (le service n'a rien répondu) et
/// non d'une réponse du service lui-même.
fn is_transport_error(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_lowercase();
    if SERVICE_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
        || lower.starts_with("http ")
    {
        return false;
    }
    TRANSPORT_MARKERS.iter().any(|marker| lower.contains(marker))
}

// ----- état du service (lecture) -------------------------------------------

#[derive(Debug, Clone)]
enum Lookup {
    Absent,
    Dir,
    File(String),
}

impl Lookup {
    fn hash(&self) -> Option<String> {
        match self {
            Lookup::Absent => None,
            Lookup::Dir => Some(String::new()),
            Lookup::File(hash) => Some(hash.clone()),
        }
    }
}

/// État courant d'un chemin côté service : absent, dossier, ou fichier (hash).
async fn server_lookup(
    app: &AppHandle,
    connection: &str,
    path: &str,
) -> std::result::Result<Lookup, String> {
    let (parent, name) = split_parent(path);
    let listing =
        crate::connections::call_on(app, Some(connection), "fs.list", json!({"path": parent})).await?;
    let found = listing
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name.as_str()));
    let Some(entry) = found else {
        return Ok(Lookup::Absent);
    };
    if entry.get("kind").and_then(Value::as_str) == Some("directory") {
        return Ok(Lookup::Dir);
    }
    let doc = crate::connections::call_on(app, Some(connection), "fs.read", json!({"path": path})).await?;
    let hash = doc
        .get("content")
        .and_then(Value::as_str)
        .map(|content| sha256_hex(content.as_bytes()))
        .unwrap_or_default();
    Ok(Lookup::File(hash))
}

fn classify(error: String) -> Step {
    if is_transport_error(&error) {
        Step::Stop(error)
    } else {
        Step::Keep(error)
    }
}

// ----- commandes ------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineWorkspaceInput {
    pub workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineListInput {
    pub workspace_path: String,
    #[serde(default)]
    pub relative_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflinePathInput {
    pub workspace_path: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineWriteInput {
    pub workspace_path: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineRenameInput {
    pub workspace_path: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineResolveInput {
    pub workspace_path: String,
    pub path: String,
    pub keep: String,
}

#[tauri::command]
pub(crate) fn offline_status(input: OfflineWorkspaceInput) -> std::result::Result<Value, String> {
    let (connection, root) = open_mirror(&input.workspace_path)?;
    let base = load_base(&root);
    let journal = load_journal(&root);
    let mut files = 0u64;
    let mut bytes = 0u64;
    walk_files(&mirror_files(&root), &mut |len| {
        files += 1;
        bytes += len;
    });
    let last_sync = base.values().map(|entry| entry.at_ms).max().unwrap_or(0);
    Ok(json!({
        "connection": connection,
        "mirrorReady": base_path(&root).is_file(),
        "files": files,
        "dirty": journal.ops.len(),
        "bytes": bytes,
        "lastSyncAtMs": last_sync,
    }))
}

/// Télécharge l'espace (fs.index + fs.read) dans le miroir et écrit base.json.
#[tauri::command]
pub(crate) async fn offline_prepare(
    app: AppHandle,
    input: OfflineWorkspaceInput,
) -> std::result::Result<Value, String> {
    let (connection, root) = open_mirror(&input.workspace_path)?;
    let index = crate::connections::call_on(
        &app,
        Some(&connection),
        "fs.index",
        json!({"limit": 20000}),
    )
    .await?;
    let paths: Vec<String> = index
        .get("paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let files_dir = mirror_files(&root);
    if files_dir.exists() {
        fs::remove_dir_all(&files_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&files_dir).map_err(|e| e.to_string())?;
    let now = now_ms();
    let mut base = Base::new();
    let mut files = 0u64;
    let mut bytes = 0u64;
    let mut skipped = 0u64;
    for path in paths {
        let rel = match clean_rel(&path) {
            Ok(rel) => rel,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let doc = match crate::connections::call_on(
            &app,
            Some(&connection),
            "fs.read",
            json!({"path": rel}),
        )
        .await
        {
            Ok(doc) => doc,
            Err(err) if is_transport_error(&err) => {
                return Err(format!("service injoignable pendant la copie : {err}"))
            }
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let size = doc.get("size").and_then(Value::as_u64).unwrap_or(0);
        let Some(content) = doc.get("content").and_then(Value::as_str) else {
            skipped += 1;
            continue;
        };
        if size > MAX_MIRROR_FILE_BYTES || content.len() as u64 > MAX_MIRROR_FILE_BYTES {
            skipped += 1;
            continue;
        }
        write_atomic(&files_dir.join(&rel), content.as_bytes())?;
        for dir in ancestor_dirs(&rel) {
            base.entry(dir).or_insert(BaseEntry {
                hash: String::new(),
                at_ms: now,
            });
        }
        base.insert(
            rel,
            BaseEntry {
                hash: sha256_hex(content.as_bytes()),
                at_ms: now,
            },
        );
        files += 1;
        bytes += content.len() as u64;
    }
    save_base(&root, &base)?;
    Ok(json!({"files": files, "bytes": bytes, "skipped": skipped}))
}

/// Liste le miroir (jamais le réseau) sous la forme des entrées de l'IDE.
#[tauri::command]
pub(crate) fn offline_list(input: OfflineListInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    let files_dir = mirror_files(&root);
    let rel = input.relative_path.unwrap_or_default();
    if rel.is_empty() && !files_dir.is_dir() {
        return Ok(json!([]));
    }
    if !rel.is_empty() {
        clean_rel(&rel)?;
    }
    let entries = axecode_app::list_workspace_entries(
        &files_dir,
        if rel.is_empty() { None } else { Some(rel.as_str()) },
    )
    .map_err(|e| e.to_string())?;
    let mut value = serde_json::to_value(entries).map_err(|e| e.to_string())?;
    let base = input.workspace_path.trim_end_matches('/');
    if let Some(list) = value.as_array_mut() {
        for entry in list {
            if let Some(relative) = entry.get("relativePath").and_then(Value::as_str).map(str::to_string) {
                entry["absolutePath"] = json!(format!("{base}/{relative}"));
            }
        }
    }
    Ok(value)
}

#[tauri::command]
pub(crate) fn offline_read(input: OfflinePathInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    let rel = clean_rel(&input.path)?;
    let bytes = fs::read(mirror_path(&root, &rel)?)
        .map_err(|_| "fichier absent du miroir".to_string())?;
    let content = String::from_utf8(bytes).map_err(|_| "contenu non textuel".to_string())?;
    let mirrored_at = load_base(&root).get(&rel).map(|entry| entry.at_ms).unwrap_or(0);
    Ok(json!({"path": rel, "content": content, "mirroredAtMs": mirrored_at}))
}

#[tauri::command]
pub(crate) fn offline_write(input: OfflineWriteInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    let rel = clean_rel(&input.path)?;
    write_atomic(&mirror_path(&root, &rel)?, input.content.as_bytes())?;
    let hash = sha256_hex(input.content.as_bytes());
    push_op(
        &root,
        Op {
            kind: "write".into(),
            path: rel.clone(),
            new_path: None,
            at_ms: now_ms(),
            hash: Some(hash.clone()),
        },
    )?;
    Ok(json!({"path": rel, "dirty": true, "hash": hash}))
}

#[tauri::command]
pub(crate) fn offline_create_file(input: OfflinePathInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    let rel = clean_rel(&input.path)?;
    let dest = mirror_path(&root, &rel)?;
    if dest.exists() {
        return Err("le fichier existe déjà dans le miroir".into());
    }
    write_atomic(&dest, b"")?;
    push_op(
        &root,
        Op {
            kind: "create".into(),
            path: rel.clone(),
            new_path: None,
            at_ms: now_ms(),
            hash: Some(sha256_hex(b"")),
        },
    )?;
    Ok(json!({"path": rel, "dirty": true}))
}

#[tauri::command]
pub(crate) fn offline_create_dir(input: OfflinePathInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    let rel = clean_rel(&input.path)?;
    fs::create_dir_all(mirror_path(&root, &rel)?).map_err(|e| e.to_string())?;
    push_op(
        &root,
        Op {
            kind: "create".into(),
            path: rel.clone(),
            new_path: None,
            at_ms: now_ms(),
            hash: None,
        },
    )?;
    Ok(json!({"path": rel, "dirty": true}))
}

#[tauri::command]
pub(crate) fn offline_delete(input: OfflinePathInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    let rel = clean_rel(&input.path)?;
    let dest = mirror_path(&root, &rel)?;
    let meta = fs::symlink_metadata(&dest).map_err(|_| "élément absent du miroir".to_string())?;
    let removed = if meta.is_dir() {
        fs::remove_dir_all(&dest)
    } else {
        fs::remove_file(&dest)
    };
    removed.map_err(|e| e.to_string())?;
    push_op(
        &root,
        Op {
            kind: "delete".into(),
            path: rel.clone(),
            new_path: None,
            at_ms: now_ms(),
            hash: None,
        },
    )?;
    Ok(json!({"path": rel, "dirty": true}))
}

#[tauri::command]
pub(crate) fn offline_rename(input: OfflineRenameInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    let from = clean_rel(&input.from)?;
    let to = clean_rel(&input.to)?;
    if from == to {
        return Err("les chemins source et destination sont identiques".into());
    }
    let src = mirror_path(&root, &from)?;
    let dst = mirror_path(&root, &to)?;
    if fs::symlink_metadata(&src).is_err() {
        return Err("source absente du miroir".into());
    }
    if dst.exists() {
        return Err("la destination existe déjà dans le miroir".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    push_op(
        &root,
        Op {
            kind: "rename".into(),
            path: from.clone(),
            new_path: Some(to.clone()),
            at_ms: now_ms(),
            hash: None,
        },
    )?;
    Ok(json!({"from": from, "to": to, "dirty": true}))
}

#[tauri::command]
pub(crate) fn offline_journal(input: OfflineWorkspaceInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    serde_json::to_value(load_journal(&root).ops).map_err(|e| e.to_string())
}

/// Jette le miroir et le journal (demande explicite de l'utilisateur).
fn forget_root(root: &Path) -> std::result::Result<bool, String> {
    let removed = root.exists();
    if removed {
        fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

#[tauri::command]
pub(crate) fn offline_forget(input: OfflineWorkspaceInput) -> std::result::Result<Value, String> {
    let (_connection, root) = open_mirror(&input.workspace_path)?;
    Ok(json!({"removed": forget_root(&root)?}))
}

// ----- synchronisation ------------------------------------------------------

enum Step {
    Applied,
    Drop,
    Conflict {
        local_hash: String,
        server_hash: String,
    },
    Keep(String),
    Stop(String),
}

fn conflict(local_hash: String, server: Option<String>) -> Step {
    Step::Conflict {
        local_hash,
        server_hash: server.unwrap_or_default(),
    }
}

fn read_mirror(root: &Path, rel: &str) -> std::result::Result<Vec<u8>, String> {
    fs::read(mirror_path(root, rel)?).map_err(|e| e.to_string())
}

async fn sync_content(
    app: &AppHandle,
    connection: &str,
    root: &Path,
    base: &mut Base,
    op: &Op,
) -> Step {
    let rel = &op.path;
    let dest = match mirror_path(root, rel) {
        Ok(dest) => dest,
        Err(err) => return Step::Keep(err),
    };
    if fs::symlink_metadata(&dest).map(|meta| meta.is_dir()).unwrap_or(false) {
        return sync_dir(app, connection, base, rel).await;
    }
    let content = match read_mirror(root, rel) {
        Ok(bytes) => bytes,
        Err(err) => return Step::Keep(err),
    };
    let local_hash = sha256_hex(&content);
    let lookup = match server_lookup(app, connection, rel).await {
        Ok(lookup) => lookup,
        Err(err) => return classify(err),
    };
    let reference = base.get(rel).map(|entry| entry.hash.clone());
    if lookup.hash() != reference {
        return conflict(local_hash, lookup.hash());
    }
    match lookup {
        Lookup::Dir => return Step::Keep("le chemin est un dossier côté service".into()),
        Lookup::Absent => {
            if let Err(err) =
                crate::connections::call_on(app, Some(connection), "fs.create_file", json!({"path": rel}))
                    .await
            {
                return classify(err);
            }
        }
        Lookup::File(_) => {}
    }
    let text = String::from_utf8_lossy(&content).into_owned();
    match crate::connections::call_on(
        app,
        Some(connection),
        "fs.write",
        json!({"path": rel, "content": text}),
    )
    .await
    {
        Ok(_) => {
            base.insert(
                rel.clone(),
                BaseEntry {
                    hash: local_hash,
                    at_ms: now_ms(),
                },
            );
            Step::Applied
        }
        Err(err) => classify(err),
    }
}

async fn sync_dir(
    app: &AppHandle,
    connection: &str,
    base: &mut Base,
    rel: &str,
) -> Step {
    let lookup = match server_lookup(app, connection, rel).await {
        Ok(lookup) => lookup,
        Err(err) => return classify(err),
    };
    match lookup {
        Lookup::File(_) => Step::Keep("un fichier occupe déjà ce chemin côté service".into()),
        Lookup::Dir => {
            base.entry(rel.to_string()).or_insert(BaseEntry {
                hash: String::new(),
                at_ms: now_ms(),
            });
            Step::Drop
        }
        Lookup::Absent => match crate::connections::call_on(
            app,
            Some(connection),
            "fs.mkdir",
            json!({"path": rel}),
        )
        .await
        {
            Ok(_) => {
                base.insert(
                    rel.to_string(),
                    BaseEntry {
                        hash: String::new(),
                        at_ms: now_ms(),
                    },
                );
                Step::Applied
            }
            Err(err) => classify(err),
        },
    }
}

async fn sync_delete(
    app: &AppHandle,
    connection: &str,
    base: &mut Base,
    op: &Op,
) -> Step {    let rel = &op.path;
    let lookup = match server_lookup(app, connection, rel).await {
        Ok(lookup) => lookup,
        Err(err) => return classify(err),
    };
    let reference = base.get(rel).map(|entry| entry.hash.clone());
    if lookup.hash() != reference {
        return conflict(String::new(), lookup.hash());
    }
    match lookup {
        Lookup::Absent => {
            base.remove(rel);
            Step::Drop
        }
        _ => match crate::connections::call_on(
            app,
            Some(connection),
            "fs.delete",
            json!({"path": rel}),
        )
        .await
        {
            Ok(_) => {
                base.remove(rel);
                Step::Applied
            }
            Err(err) => classify(err),
        },
    }
}

async fn sync_rename(
    app: &AppHandle,
    connection: &str,
    root: &Path,
    base: &mut Base,
    op: &Op,
) -> Step {
    let from = op.path.clone();
    let Some(to) = op.new_path.clone() else {
        return Step::Keep("renommage sans destination".into());
    };
    let from_lookup = match server_lookup(app, connection, &from).await {
        Ok(lookup) => lookup,
        Err(err) => return classify(err),
    };
    let reference = base.get(&from).map(|entry| entry.hash.clone());
    if from_lookup.hash() != reference {
        return conflict(String::new(), from_lookup.hash());
    }
    let to_lookup = match server_lookup(app, connection, &to).await {
        Ok(lookup) => lookup,
        Err(err) => return classify(err),
    };
    if !matches!(to_lookup, Lookup::Absent) {
        return conflict(String::new(), to_lookup.hash());
    }
    let content = match read_mirror(root, &to) {
        Ok(bytes) => bytes,
        Err(err) => return Step::Keep(err),
    };
    let hash = match from_lookup {
        Lookup::Dir => String::new(),
        _ => sha256_hex(&content),
    };
    let (from_parent, _) = split_parent(&from);
    let (to_parent, to_name) = split_parent(&to);
    let result = if from_parent == to_parent && !matches!(from_lookup, Lookup::Absent) {
        crate::connections::call_on(
            app,
            Some(connection),
            "fs.rename",
            json!({"path": from, "newName": to_name}),
        )
        .await
        .map(|_| ())
    } else if matches!(from_lookup, Lookup::Dir) {
        return Step::Keep("déplacement de dossier entre dossiers non pris en charge".into());
    } else {
        match write_remote_file(app, connection, &to, &content, matches!(to_lookup, Lookup::Absent)).await
        {
            Ok(()) if !matches!(from_lookup, Lookup::Absent) => crate::connections::call_on(
                app,
                Some(connection),
                "fs.delete",
                json!({"path": from}),
            )
            .await
            .map(|_| ()),
            Ok(()) => Ok(()),
            Err(err) => Err(err),
        }
    };
    match result {
        Ok(()) => {
            base.remove(&from);
            base.insert(
                to,
                BaseEntry {
                    hash,
                    at_ms: now_ms(),
                },
            );
            Step::Applied
        }
        Err(err) => classify(err),
    }
}

async fn write_remote_file(
    app: &AppHandle,
    connection: &str,
    path: &str,
    content: &[u8],
    create: bool,
) -> std::result::Result<(), String> {
    if create {
        crate::connections::call_on(app, Some(connection), "fs.create_file", json!({"path": path})).await?;
    }
    let text = String::from_utf8_lossy(content).into_owned();
    crate::connections::call_on(
        app,
        Some(connection),
        "fs.write",
        json!({"path": path, "content": text}),
    )
    .await?;
    Ok(())
}

async fn sync_op(
    app: &AppHandle,
    connection: &str,
    root: &Path,
    base: &mut Base,
    op: &Op,
) -> Step {
    match op.kind.as_str() {
        "write" | "create" => sync_content(app, connection, root, base, op).await,
        "delete" => sync_delete(app, connection, base, op).await,
        "rename" => sync_rename(app, connection, root, base, op).await,
        _ => Step::Drop,
    }
}

/// Rejoue le journal sur le service ; applique ce qui peut l'être, signale les
/// conflits, garde le journal en cas d'erreur réseau.
#[tauri::command]
pub(crate) async fn offline_sync(
    app: AppHandle,
    input: OfflineWorkspaceInput,
) -> std::result::Result<Value, String> {
    let (connection, root) = open_mirror(&input.workspace_path)?;
    let mut base = load_base(&root);
    let journal = load_journal(&root);
    let mut applied: Vec<String> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut remaining: Vec<Op> = Vec::new();
    let mut stopped = false;
    for op in journal.ops {
        if stopped {
            remaining.push(op);
            continue;
        }
        match sync_op(&app, &connection, &root, &mut base, &op).await {
            Step::Applied => applied.push(op.path.clone()),
            Step::Drop => {}
            Step::Conflict {
                local_hash,
                server_hash,
            } => {
                conflicts.push(json!({
                    "path": op.path,
                    "kind": op.kind,
                    "localHash": local_hash,
                    "serverHash": server_hash,
                }));
                remaining.push(op);
            }
            Step::Keep(error) => {
                failed.push(json!({"path": op.path, "error": error}));
                remaining.push(op);
            }
            Step::Stop(error) => {
                failed.push(json!({"path": op.path, "error": error}));
                remaining.push(op);
                stopped = true;
            }
        }
    }
    save_base(&root, &base)?;
    save_journal(&root, &Journal { ops: remaining })?;
    Ok(json!({"applied": applied, "conflicts": conflicts, "failed": failed}))
}

/// Résout un conflit : `keep = "server"` adopte la version de l'espace,
/// `keep = "local"` force l'écriture locale, `keep = "both"` garde les deux
/// versions (la copie locale devient un voisin, qui part tout seul au
/// prochain retour du réseau).
#[tauri::command]
pub(crate) async fn offline_resolve(
    app: AppHandle,
    input: OfflineResolveInput,
) -> std::result::Result<Value, String> {
    let (connection, root) = open_mirror(&input.workspace_path)?;
    let rel = clean_rel(&input.path)?;
    let keep = input.keep.trim().to_ascii_lowercase();
    let mut base = load_base(&root);
    let dest = mirror_path(&root, &rel)?;
    match keep.as_str() {
        "server" => {
            let lookup = server_lookup(&app, &connection, &rel).await.map_err(|err| {
                if is_transport_error(&err) {
                    format!("service injoignable : {err}")
                } else {
                    err
                }
            })?;
            match lookup {
                Lookup::Absent => {
                    if dest.is_dir() {
                        let _ = fs::remove_dir_all(&dest);
                    } else {
                        let _ = fs::remove_file(&dest);
                    }
                    base.remove(&rel);
                }
                Lookup::Dir => {
                    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                    base.insert(
                        rel.clone(),
                        BaseEntry {
                            hash: String::new(),
                            at_ms: now_ms(),
                        },
                    );
                }
                Lookup::File(hash) => {
                    let doc = crate::connections::call_on(
                        &app,
                        Some(&connection),
                        "fs.read",
                        json!({"path": rel}),
                    )
                    .await?;
                    let content = doc.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                    write_atomic(&dest, content.as_bytes())?;
                    base.insert(rel.clone(), BaseEntry { hash, at_ms: now_ms() });
                }
            }
        }
        "local" => {
            let meta = fs::symlink_metadata(&dest).map_err(|_| "élément absent du miroir".to_string())?;
            let lookup = server_lookup(&app, &connection, &rel).await.map_err(|err| {
                if is_transport_error(&err) {
                    format!("service injoignable : {err}")
                } else {
                    err
                }
            })?;
            if meta.is_dir() {
                let _ = crate::connections::call_on(
                    &app,
                    Some(&connection),
                    "fs.mkdir",
                    json!({"path": rel}),
                )
                .await;
                base.insert(
                    rel.clone(),
                    BaseEntry {
                        hash: String::new(),
                        at_ms: now_ms(),
                    },
                );
            } else {
                let content = fs::read(&dest).map_err(|e| e.to_string())?;
                write_remote_file(
                    &app,
                    &connection,
                    &rel,
                    &content,
                    matches!(lookup, Lookup::Absent),
                )
                .await?;
                base.insert(
                    rel.clone(),
                    BaseEntry {
                        hash: sha256_hex(&content),
                        at_ms: now_ms(),
                    },
                );
            }
        }
        "both" => {
            let meta = fs::symlink_metadata(&dest).map_err(|_| "élément absent du miroir".to_string())?;
            let lookup = server_lookup(&app, &connection, &rel).await.map_err(|err| {
                if is_transport_error(&err) {
                    format!("service injoignable : {err}")
                } else {
                    err
                }
            })?;
            let server_hash = match lookup {
                // Plus rien côté espace : la version locale reste seule.
                Lookup::Absent => None,
                Lookup::Dir => Some(String::new()),
                Lookup::File(hash) => Some(hash),
            };
            let Some(hash) = server_hash else {
                base.insert(rel.clone(), BaseEntry { hash: String::new(), at_ms: now_ms() });
                return Ok(json!({"path": rel, "dirty": false}));
            };
            // L'espace garde sa version : la copie locale devient un voisin,
            // enregistré dans le journal comme une création en attente.
            base.insert(rel.clone(), BaseEntry { hash, at_ms: now_ms() });
            let target = both_target(&root, &rel)?;
            fs::rename(&dest, mirror_path(&root, &target)?).map_err(|e| e.to_string())?;
            let local_hash = if meta.is_dir() {
                None
            } else {
                let content = fs::read(mirror_path(&root, &target)?).map_err(|e| e.to_string())?;
                Some(sha256_hex(&content))
            };
            push_op(
                &root,
                Op {
                    kind: "create".into(),
                    path: target,
                    new_path: None,
                    at_ms: now_ms(),
                    hash: local_hash,
                },
            )?;
        }
        _ => return Err("keep doit valoir \"local\", \"server\" ou \"both\"".into()),
    }
    save_base(&root, &base)?;
    let mut journal = load_journal(&root);
    journal
        .ops
        .retain(|op| op.path != rel && op.new_path.as_deref() != Some(rel.as_str()));
    let dirty = journal
        .ops
        .iter()
        .any(|op| op.path == rel || op.new_path.as_deref() == Some(rel.as_str()));
    save_journal(&root, &journal)?;
    Ok(json!({"path": rel, "dirty": dirty}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("offline-test-{}", axecode_daemon::util::new_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn op(kind: &str, path: &str, new_path: Option<&str>) -> Op {
        Op {
            kind: kind.into(),
            path: path.into(),
            new_path: new_path.map(str::to_string),
            at_ms: 1,
            hash: Some("h".into()),
        }
    }

    #[test]
    fn one_op_per_path_last_wins() {
        let mut ops = Vec::new();
        coalesce(&mut ops, op("write", "a.txt", None));
        coalesce(&mut ops, op("write", "a.txt", None));
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].kind, "write");
    }

    #[test]
    fn delete_cancels_previous_writes() {
        let mut ops = Vec::new();
        coalesce(&mut ops, op("write", "a.txt", None));
        coalesce(&mut ops, op("create", "b.txt", None));
        coalesce(&mut ops, op("delete", "a.txt", None));
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].path, "b.txt");
        assert_eq!(ops[1].kind, "delete");
        assert_eq!(ops[1].path, "a.txt");
    }

    #[test]
    fn rename_replaces_ops_on_both_ends() {
        let mut ops = Vec::new();
        coalesce(&mut ops, op("write", "from.txt", None));
        coalesce(&mut ops, op("write", "to.txt", None));
        coalesce(&mut ops, op("rename", "from.txt", Some("to.txt")));
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].kind, "rename");
        assert_eq!(ops[0].new_path.as_deref(), Some("to.txt"));
    }

    #[test]
    fn mirror_root_lives_under_offline() {
        let root = offline_root("axe-cloud").unwrap();
        assert!(root.ends_with("offline/axe-cloud"), "{}", root.display());
        assert_eq!(mirror_files(&root), root.join("files"));
        assert_eq!(base_path(&root), root.join("base.json"));
        assert_eq!(journal_path(&root), root.join("journal.json"));
    }

    #[test]
    fn connection_is_read_from_the_virtual_path() {
        assert_eq!(
            connection_from_workspace("axe-cloud://axe-cloud/work").unwrap(),
            "axe-cloud"
        );
        assert_eq!(
            connection_from_workspace("axe-cloud://conn-abcd/srv/projet").unwrap(),
            "conn-abcd"
        );
        assert!(connection_from_workspace("/home/user/projet").is_err());
        assert!(connection_from_workspace("axe-cloud://../etc").is_err());
        assert!(connection_from_workspace("axe-cloud://").is_err());
    }

    #[test]
    fn relative_paths_cannot_escape_the_mirror() {
        for bad in ["../x", "/etc/passwd", "a/../x", "a//b", "./a", "a\\b", "", "C:/x"] {
            assert!(clean_rel(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(clean_rel("src/demo.txt").unwrap(), "src/demo.txt");
    }

    #[test]
    fn atomic_write_and_json_roundtrip() {
        let root = temp_root();
        let base: Base = [(
            "a.txt".to_string(),
            BaseEntry {
                hash: "abc".into(),
                at_ms: 42,
            },
        )]
        .into_iter()
        .collect();
        save_base(&root, &base).unwrap();
        let loaded = load_base(&root);
        assert_eq!(loaded["a.txt"].hash, "abc");
        assert_eq!(loaded["a.txt"].at_ms, 42);
        let journal = Journal {
            ops: vec![op("write", "a.txt", None)],
        };
        save_journal(&root, &journal).unwrap();
        assert_eq!(load_journal(&root).ops.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn forget_removes_the_whole_mirror() {
        let root = temp_root();
        write_atomic(&mirror_files(&root).join("a.txt"), b"hello").unwrap();
        save_base(&root, &Base::new()).unwrap();
        assert!(forget_root(&root).unwrap());
        assert!(!root.exists());
        // Idempotent : un miroir absent n'est pas une erreur.
        assert!(!forget_root(&root).unwrap());
    }

    #[test]
    fn transport_errors_are_distinguished_from_service_errors() {
        assert!(is_transport_error("daemon connection closed"));
        assert!(is_transport_error("daemon request fs.read timed out"));
        assert!(is_transport_error("failed to connect: connection refused"));
        assert!(!is_transport_error("protocol error: path not found"));
        assert!(!is_transport_error("io error: permission denied"));
        assert!(!is_transport_error("auth error: token expired"));
    }

    #[test]
    fn sha256_hex_is_well_formed() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(sha256_hex(b"hello").len(), 64);
    }

    #[test]
    fn copy_suffix_path_appends_copy_label() {
        assert_eq!(copy_suffix_path("a.txt", 1), "a (copie).txt");
        assert_eq!(copy_suffix_path("a.txt", 2), "a (copie 2).txt");
        assert_eq!(copy_suffix_path("src/demo.md", 1), "src/demo (copie).md");
        assert_eq!(copy_suffix_path("noext", 3), "noext (copie 3)");
        assert_eq!(copy_suffix_path(".gitignore", 1), ".gitignore (copie)");
        assert_eq!(copy_suffix_path("archive.tar.gz", 1), "archive.tar (copie).gz");
    }

    #[test]
    fn both_target_skips_occupied_names() {
        let root = temp_root();
        let files = mirror_files(&root);
        fs::create_dir_all(&files).unwrap();
        write_atomic(&files.join("a.txt"), b"un").unwrap();
        write_atomic(&files.join("a (copie).txt"), b"deux").unwrap();
        assert_eq!(both_target(&root, "a.txt").unwrap(), "a (copie 2).txt");
        fs::remove_dir_all(&root).ok();
    }
}
