//! V2 L2: Tauri commands bridging the UI to the remote workspace RPC (`fs.*`,
//! `git.*`) of a cloud connection. Paths are relative to the service root; the
//! service enforces confinement, this layer only forwards and pre-validates names.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

use crate::{connections, AppHandle};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteWorkspaceInput {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteEntriesInput {
    pub connection_id: String,
    pub relative_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemotePathInput {
    pub connection_id: String,
    pub relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteWriteInput {
    pub connection_id: String,
    pub relative_path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteCreateInput {
    pub connection_id: String,
    pub target_relative_path: Option<String>,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteRenameInput {
    pub connection_id: String,
    pub relative_path: String,
    pub new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteSearchInput {
    pub connection_id: String,
    pub query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteGitCommitInput {
    pub connection_id: String,
    pub message: String,
    pub paths: Vec<String>,
    /// V2 L4.1 — dépôt visé (chemin relatif à l'espace de travail) ; vide = racine de l'espace.
    pub repo: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteGitInput {
    pub connection_id: String,
    pub repo: Option<String>,
}

async fn api(
    app: &AppHandle,
    connection: &str,
    method: &str,
    params: Value,
) -> std::result::Result<Value, String> {
    if crate::EDITION_LOCALE {
        return Err("Édition locale : pas d'espace distant.".into());
    }
    if connection.trim().is_empty() || connection == connections::LOCAL_ID {
        return Err("l'espace de travail distant demande une connexion cloud".into());
    }
    connections::call_on(app, Some(connection), method, params).await
}

/// Validates a client-side relative path before it leaves the application.
pub(super) fn check_relative(path: &str) -> std::result::Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    if Path::new(path).is_absolute()
        || path.contains('\\')
        || path.contains('\0')
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == ".." || s.eq_ignore_ascii_case(".git"))
    {
        return Err("chemin relatif invalide".into());
    }
    Ok(())
}

fn join_relative(parent: Option<&str>, name: &str) -> std::result::Result<String, String> {
    if name.trim().is_empty() || name.contains('/') {
        return Err("nom invalide".into());
    }
    let out = match parent.filter(|p| !p.is_empty()) {
        Some(p) => format!("{p}/{name}"),
        None => name.to_string(),
    };
    check_relative(&out)?;
    Ok(out)
}

#[tauri::command]
pub(super) async fn remote_workspace_info(
    app: AppHandle,
    input: RemoteWorkspaceInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "fs.root", json!({})).await
}

#[tauri::command]
pub(super) async fn remote_workspace_entries(
    app: AppHandle,
    input: RemoteEntriesInput,
) -> std::result::Result<Value, String> {
    let path = input.relative_path.unwrap_or_default();
    check_relative(&path)?;
    api(&app, &input.connection_id, "fs.list", json!({ "path": path })).await
}

#[tauri::command]
pub(super) async fn remote_workspace_read(
    app: AppHandle,
    input: RemotePathInput,
) -> std::result::Result<Value, String> {
    check_relative(&input.relative_path)?;
    api(&app, &input.connection_id, "fs.read", json!({ "path": input.relative_path })).await
}

#[tauri::command]
pub(super) async fn remote_workspace_write(
    app: AppHandle,
    input: RemoteWriteInput,
) -> std::result::Result<Value, String> {
    check_relative(&input.relative_path)?;
    api(
        &app,
        &input.connection_id,
        "fs.write",
        json!({ "path": input.relative_path, "content": input.content }),
    )
    .await
}

#[tauri::command]
pub(super) async fn remote_workspace_create_file(
    app: AppHandle,
    input: RemoteCreateInput,
) -> std::result::Result<Value, String> {
    let path = join_relative(input.target_relative_path.as_deref(), &input.name)?;
    api(&app, &input.connection_id, "fs.create_file", json!({ "path": path })).await
}

#[tauri::command]
pub(super) async fn remote_workspace_create_directory(
    app: AppHandle,
    input: RemoteCreateInput,
) -> std::result::Result<Value, String> {
    let path = join_relative(input.target_relative_path.as_deref(), &input.name)?;
    api(&app, &input.connection_id, "fs.mkdir", json!({ "path": path })).await
}

#[tauri::command]
pub(super) async fn remote_workspace_rename(
    app: AppHandle,
    input: RemoteRenameInput,
) -> std::result::Result<Value, String> {
    check_relative(&input.relative_path)?;
    join_relative(None, &input.new_name)?;
    api(
        &app,
        &input.connection_id,
        "fs.rename",
        json!({ "path": input.relative_path, "newName": input.new_name }),
    )
    .await
}

#[tauri::command]
pub(super) async fn remote_workspace_delete(
    app: AppHandle,
    input: RemotePathInput,
) -> std::result::Result<(), String> {
    check_relative(&input.relative_path)?;
    api(&app, &input.connection_id, "fs.delete", json!({ "path": input.relative_path })).await?;
    Ok(())
}

#[tauri::command]
pub(super) async fn remote_workspace_search(
    app: AppHandle,
    input: RemoteSearchInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "fs.search", json!({ "query": input.query })).await
}

#[tauri::command]
pub(super) async fn remote_git_status(
    app: AppHandle,
    input: RemoteGitInput,
) -> std::result::Result<Value, String> {
    let repo = input.repo.unwrap_or_default();
    check_relative(&repo)?;
    api(&app, &input.connection_id, "git.status", json!({ "path": repo })).await
}

/// V2 L4.1 — dépôts Git de l'espace de travail (racine + sous-dossiers).
#[tauri::command]
pub(super) async fn remote_git_repos(
    app: AppHandle,
    input: RemoteWorkspaceInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "git.repos", json!({})).await
}

#[tauri::command]
pub(super) async fn remote_git_commit(
    app: AppHandle,
    input: RemoteGitCommitInput,
) -> std::result::Result<Value, String> {
    for p in &input.paths {
        if p.is_empty() {
            return Err("chemin vide".into());
        }
        check_relative(p)?;
    }
    let repo = input.repo.unwrap_or_default();
    check_relative(&repo)?;
    api(
        &app,
        &input.connection_id,
        "git.commit",
        json!({ "message": input.message, "paths": input.paths, "path": repo }),
    )
    .await
}

// ----- V2 L3: terminal in the service -------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTermOpenInput {
    pub connection_id: String,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTermIdInput {
    pub connection_id: String,
    pub terminal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTermWriteInput {
    pub connection_id: String,
    pub terminal_id: String,
    /// Base64-encoded bytes typed by the user.
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTermResizeInput {
    pub connection_id: String,
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub(super) async fn remote_term_open(
    app: AppHandle,
    input: RemoteTermOpenInput,
) -> std::result::Result<Value, String> {
    let cwd = input.cwd.unwrap_or_default();
    check_relative(&cwd)?;
    api(
        &app,
        &input.connection_id,
        "term.open",
        json!({ "cwd": cwd, "name": input.name, "cols": input.cols, "rows": input.rows }),
    )
    .await
}

#[tauri::command]
pub(super) async fn remote_term_write(
    app: AppHandle,
    input: RemoteTermWriteInput,
) -> std::result::Result<Value, String> {
    api(
        &app,
        &input.connection_id,
        "term.write",
        json!({ "terminalId": input.terminal_id, "data": input.data }),
    )
    .await
}

#[tauri::command]
pub(super) async fn remote_term_resize(
    app: AppHandle,
    input: RemoteTermResizeInput,
) -> std::result::Result<Value, String> {
    api(
        &app,
        &input.connection_id,
        "term.resize",
        json!({ "terminalId": input.terminal_id, "cols": input.cols, "rows": input.rows }),
    )
    .await
}

#[tauri::command]
pub(super) async fn remote_term_attach(
    app: AppHandle,
    input: RemoteTermIdInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "term.attach", json!({ "terminalId": input.terminal_id })).await
}

#[tauri::command]
pub(super) async fn remote_term_list(
    app: AppHandle,
    input: RemoteWorkspaceInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "term.list", json!({})).await
}

#[tauri::command]
pub(super) async fn remote_term_close(
    app: AppHandle,
    input: RemoteTermIdInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "term.close", json!({ "terminalId": input.terminal_id })).await
}

// ----- V2 L4: shared space (perso -> commun) -------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShareItemInput {
    pub connection_id: String,
    pub kind: String,
    pub name: String,
    pub author: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShareReadInput {
    pub connection_id: String,
    pub kind: String,
    pub name: String,
    pub relative_path: String,
}

/// Same families the service accepts; checked here so a typo never reaches it.
const SHARE_KINDS: [&str; 4] = ["skills", "recettes", "conversations", "harness"];

fn check_item(kind: &str, name: &str) -> std::result::Result<(), String> {
    if !SHARE_KINDS.contains(&kind) {
        return Err("catégorie inconnue".into());
    }
    if name.is_empty()
        || name.len() > 100
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        return Err("nom invalide".into());
    }
    Ok(())
}

fn item_params(input: &RemoteShareItemInput) -> Value {
    json!({ "kind": input.kind, "name": input.name, "author": input.author })
}

#[tauri::command]
pub(super) async fn remote_share_list(
    app: AppHandle,
    input: RemoteWorkspaceInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "share.list", json!({})).await
}

#[tauri::command]
pub(super) async fn remote_share_files(
    app: AppHandle,
    input: RemoteShareItemInput,
) -> std::result::Result<Value, String> {
    check_item(&input.kind, &input.name)?;
    api(&app, &input.connection_id, "share.files", item_params(&input)).await
}

#[tauri::command]
pub(super) async fn remote_share_read(
    app: AppHandle,
    input: RemoteShareReadInput,
) -> std::result::Result<Value, String> {
    check_item(&input.kind, &input.name)?;
    check_relative(&input.relative_path)?;
    api(
        &app,
        &input.connection_id,
        "share.read",
        json!({
            "kind": input.kind,
            "name": input.name,
            "path": input.relative_path,
        }),
    )
    .await
}

#[tauri::command]
pub(super) async fn remote_share_publish(
    app: AppHandle,
    input: RemoteShareItemInput,
) -> std::result::Result<Value, String> {
    check_item(&input.kind, &input.name)?;
    api(&app, &input.connection_id, "share.publish", item_params(&input)).await
}

#[tauri::command]
pub(super) async fn remote_share_unpublish(
    app: AppHandle,
    input: RemoteShareItemInput,
) -> std::result::Result<Value, String> {
    check_item(&input.kind, &input.name)?;
    api(&app, &input.connection_id, "share.unpublish", item_params(&input)).await
}

#[tauri::command]
pub(super) async fn remote_share_log(
    app: AppHandle,
    input: RemoteWorkspaceInput,
) -> std::result::Result<Value, String> {
    api(&app, &input.connection_id, "share.log", json!({ "limit": 50 })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_prevalidated() {
        assert!(check_relative("").is_ok());
        assert!(check_relative("src/a.txt").is_ok());
        for bad in ["/etc", "a/../b", "./a", "a//b", "a\\b", ".git/config", "x/.GIT"] {
            assert!(check_relative(bad).is_err(), "{bad}");
        }
        assert_eq!(join_relative(Some("src"), "a.txt").unwrap(), "src/a.txt");
        assert_eq!(join_relative(None, "a.txt").unwrap(), "a.txt");
        assert!(join_relative(Some("src"), "..").is_err());
        assert!(join_relative(None, "a/b").is_err());
    }
}
