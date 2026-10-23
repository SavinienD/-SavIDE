//! `harness_*` IPC commands (Continual Harness, chantier D).

use std::path::PathBuf;

use serde::Deserialize;
use axecode_harness::{
    import::{self, BrainDetection, BrainImportOptions, BrainImportReport},
    refine::{self, RefinementRecord},
    Entry, EntryKind, EntryPatch, HarnessStore, NewEntry, Scope,
};

type IpcResult<T> = std::result::Result<T, String>;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn workspace_root(path: &str) -> IpcResult<PathBuf> {
    axecode_app::workspace::normalize_workspace_root(path).map_err(err)
}

fn store_for(path: &str) -> IpcResult<HarnessStore> {
    Ok(HarnessStore::open(workspace_root(path)?))
}

fn parse<T: std::str::FromStr<Err = String>>(value: Option<&str>) -> IpcResult<Option<T>> {
    value.filter(|v| !v.trim().is_empty()).map(str::parse).transpose()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessListInput {
    workspace_path: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessIdInput {
    workspace_path: String,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessCreateInput {
    workspace_path: String,
    kind: String,
    scope: String,
    entry: NewEntry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessUpdateInput {
    workspace_path: String,
    id: String,
    patch: EntryPatch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessBrainInput {
    workspace_path: String,
    #[serde(default)]
    options: BrainImportOptions,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessPathsView {
    global_root: String,
    project_root: String,
}

#[tauri::command]
pub(super) async fn harness_paths(workspace_path: String) -> IpcResult<HarnessPathsView> {
    let store = store_for(&workspace_path)?;
    let display_path =
        |path: &std::path::Path| axecode_app::workspace::os_path(path).display().to_string();
    Ok(HarnessPathsView {
        global_root: display_path(store.paths().root(Scope::Global)),
        project_root: display_path(store.paths().root(Scope::Project)),
    })
}

#[tauri::command]
pub(super) async fn harness_list(input: HarnessListInput) -> IpcResult<Vec<Entry>> {
    let store = store_for(&input.workspace_path)?;
    let kind: Option<EntryKind> = parse(input.kind.as_deref())?;
    let scope: Option<Scope> = parse(input.scope.as_deref())?;
    store.list(kind, scope).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_get(input: HarnessIdInput) -> IpcResult<Option<Entry>> {
    store_for(&input.workspace_path)?.get(&input.id).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_create(input: HarnessCreateInput) -> IpcResult<Entry> {
    let store = store_for(&input.workspace_path)?;
    let kind: EntryKind = input.kind.parse()?;
    let scope: Scope = input.scope.parse()?;
    let mut entry = input.entry;
    entry.source.get_or_insert_with(|| "user".to_string());
    store.create(scope, kind, entry).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_update(input: HarnessUpdateInput) -> IpcResult<Entry> {
    store_for(&input.workspace_path)?
        .update(&input.id, input.patch)
        .map_err(err)
}

#[tauri::command]
pub(super) async fn harness_delete(input: HarnessIdInput) -> IpcResult<Entry> {
    store_for(&input.workspace_path)?.delete(&input.id).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_promote(input: HarnessIdInput) -> IpcResult<Entry> {
    store_for(&input.workspace_path)?.promote(&input.id).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_demote(input: HarnessIdInput) -> IpcResult<Entry> {
    store_for(&input.workspace_path)?.demote(&input.id).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_refinements(workspace_path: String) -> IpcResult<Vec<RefinementRecord>> {
    let store = store_for(&workspace_path)?;
    refine::history(&store).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_rollback(input: HarnessIdInput) -> IpcResult<RefinementRecord> {
    let store = store_for(&input.workspace_path)?;
    refine::rollback(&store, &input.id).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_brain_detect(input: HarnessBrainInput) -> IpcResult<BrainDetection> {
    let root = workspace_root(&input.workspace_path)?;
    let store = HarnessStore::open(&root);
    import::detect(&store, &root, input.options.memory_scope).map_err(err)
}

#[tauri::command]
pub(super) async fn harness_brain_import(input: HarnessBrainInput) -> IpcResult<BrainImportReport> {
    let root = workspace_root(&input.workspace_path)?;
    let store = HarnessStore::open(&root);
    import::import(&store, &root, &input.options).map_err(err)
}

// ---------------------------------------------------------------------------
// /refine (D3): background planning, application at the next turn.
// ---------------------------------------------------------------------------

static REFINE_RUNNER: std::sync::OnceLock<refine::RefineRunner> = std::sync::OnceLock::new();

pub(super) fn refine_runner() -> &'static refine::RefineRunner {
    REFINE_RUNNER.get_or_init(refine::RefineRunner::new)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessRefineInput {
    workspace_path: String,
    conversation_id: String,
    #[serde(default)]
    focus: Option<String>,
    #[serde(default)]
    trigger: Option<String>,
}

/// Start planning a refinement from the conversation trajectory. Returns
/// `false` when one is already planning for this conversation.
#[tauri::command]
pub(super) async fn harness_refine_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::DesktopState>,
    input: HarnessRefineInput,
) -> IpcResult<bool> {
    let root = workspace_root(&input.workspace_path)?;
    let workspace_id = root.display().to_string();
    let conversation = state
        .store
        .load_conversation(&workspace_id, &input.conversation_id)
        .map_err(err)?
        .ok_or_else(|| "conversation introuvable".to_string())?;
    let provider = crate::provider_from_registry(&state, &conversation.model.provider)?;
    let focus = input.focus.filter(|f| !f.trim().is_empty());
    // REPL mode: the session service owns the transcript, and turns never go
    // through `turn_harness_layer`, so apply the plan as soon as it is ready.
    let repl = crate::daemon_client::repl_agent_enabled();
    let history = if repl {
        match crate::daemon_client::daemon_call_value(
            &app,
            "sessions.history",
            serde_json::json!({ "sessionId": input.conversation_id }),
        )
        .await
        .and_then(|v| serde_json::from_value(v).map_err(err))
        {
            Ok(history) => history,
            Err(_) => conversation.history,
        }
    } else {
        conversation.history
    };
    let started = refine_runner().start(
        provider,
        conversation.model.clone(),
        HarnessStore::open(&root),
        input.conversation_id.clone(),
        history,
        input.trigger.unwrap_or_else(|| "user:/refine".into()),
        focus,
    );
    if started && repl {
        let conversation_id = input.conversation_id;
        tauri::async_runtime::spawn(async move {
            let store = HarnessStore::open(&root);
            for _ in 0..600 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let Some(result) = refine_runner().apply_pending(&store, &conversation_id) else {
                    continue;
                };
                let entry = match result {
                    Ok(record) => serde_json::json!({
                        "kind": "refinement",
                        "refinement_id": record.id,
                        "trigger": record.trigger,
                        "evidence": record.evidence.join("\n"),
                        "result": record.summary,
                    }),
                    Err(error) => serde_json::json!({
                        "kind": "extension",
                        "name": "refine_error",
                        "payload": { "error": format!("{error:#}") },
                    }),
                };
                let _ = crate::daemon_client::daemon_call_value(
                    &app,
                    "sessions.record",
                    serde_json::json!({ "sessionId": conversation_id, "entry": entry }),
                )
                .await;
                break;
            }
        });
    }
    Ok(started)
}

#[tauri::command]
pub(super) async fn harness_refine_status(input: HarnessRefineInput) -> IpcResult<serde_json::Value> {
    let store = store_for(&input.workspace_path)?;
    refine::status_json(refine_runner(), &store, &input.conversation_id).map_err(err)
}

/// Per-turn harness layer (D2): apply a ready refinement, then render the
/// notes/memories/skills/sub-agent layer appended to the base prompt.
pub(super) fn turn_harness_layer(workspace_root: &std::path::Path, conversation_id: &str) -> Option<String> {
    let store = HarnessStore::open(workspace_root);
    let notice = match refine_runner().apply_pending(&store, conversation_id) {
        Some(Ok(record)) => Some(refine::render_applied_notice(&record)),
        Some(Err(error)) => Some(format!("A background harness refinement failed: {error:#}")),
        None => None,
    };
    let layer = match refine::harness_layer(&store) {
        Ok(layer) => layer,
        Err(error) => {
            tracing::warn!("harness layer unavailable: {error:#}");
            None
        }
    };
    match (layer, notice) {
        (None, None) => None,
        (Some(layer), None) => Some(layer),
        (None, Some(notice)) => Some(format!("# Harness\n\n{notice}")),
        (Some(layer), Some(notice)) => Some(format!("{layer}\n\n## Latest refinement\n{notice}")),
    }
}

// ---------------------------------------------------------------------------
// axe:shared-brain — one brain: the Axe Cloud space's global harness.
// ---------------------------------------------------------------------------

fn global_paths() -> axecode_harness::HarnessPaths {
    // Only the global root matters here (it depends on the home, not the workspace).
    axecode_harness::HarnessPaths::for_workspace(std::env::temp_dir())
}

fn connection_or_default(connection: Option<String>) -> String {
    connection
        .filter(|c| !c.trim().is_empty() && c != "local")
        .unwrap_or_else(|| "axe-cloud".to_string())
}

async fn remote_globals(app: &tauri::AppHandle, connection: &str) -> IpcResult<Vec<Entry>> {
    let value = crate::connections::call_on(
        app,
        Some(connection),
        "harness.list",
        serde_json::json!({ "scope": "global" }),
    )
    .await?;
    serde_json::from_value(value).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessCloudInput {
    #[serde(default)]
    connection: Option<String>,
}

/// Fetch the space's global entries and refresh the local mirror injected
/// into every turn (local and local-daemon REPL turns).
#[tauri::command]
pub(super) async fn harness_cloud_sync(
    app: tauri::AppHandle,
    input: HarnessCloudInput,
) -> IpcResult<axecode_harness::cloud_mirror::CloudMirror> {
    let connection = connection_or_default(input.connection);
    let entries = remote_globals(&app, &connection).await?;
    axecode_harness::cloud_mirror::write(&global_paths(), &connection, entries).map_err(err)
}

/// The mirror as last fetched (works offline).
#[tauri::command]
pub(super) async fn harness_cloud_status() -> IpcResult<axecode_harness::cloud_mirror::CloudMirror> {
    Ok(axecode_harness::cloud_mirror::read(&global_paths()))
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublishReport {
    created: Vec<String>,
    updated: Vec<String>,
    unchanged: Vec<String>,
    errors: Vec<String>,
}

/// Push the PC's global harness to the space: same (kind, title) -> update
/// when body/tags differ, otherwise create in the space's global scope.
/// Never deletes anything remotely.
#[tauri::command]
pub(super) async fn harness_cloud_publish(
    app: tauri::AppHandle,
    input: HarnessCloudInput,
) -> IpcResult<PublishReport> {
    let connection = connection_or_default(input.connection);
    let store = HarnessStore::new(global_paths());
    let local = store.load_scope(Scope::Global).map_err(err)?;
    let remote = remote_globals(&app, &connection).await?;
    let mut report = PublishReport::default();
    for entry in local {
        let label = format!("{} « {} »", entry.meta.kind, entry.meta.title);
        let code = entry
            .package_dir
            .as_ref()
            .and_then(|dir| std::fs::read_to_string(std::path::Path::new(dir).join("__init__.py")).ok());
        let existing = remote.iter().find(|r| {
            r.meta.kind == entry.meta.kind && r.meta.title.trim() == entry.meta.title.trim()
        });
        let result = match existing {
            Some(r) if r.body == entry.body && r.meta.tags == entry.meta.tags && code.is_none() => {
                report.unchanged.push(label);
                continue;
            }
            Some(r) => crate::connections::call_on(
                &app,
                Some(&connection),
                "harness.update",
                serde_json::json!({
                    "id": r.meta.id,
                    "patch": {
                        "body": entry.body,
                        "tags": entry.meta.tags,
                        "evidence": entry.meta.evidence,
                        "code": code,
                    }
                }),
            )
            .await
            .map(|_| true),
            None => crate::connections::call_on(
                &app,
                Some(&connection),
                "harness.create",
                serde_json::json!({
                    "kind": entry.meta.kind.to_string(),
                    "scope": "global",
                    "entry": {
                        "title": entry.meta.title,
                        "body": entry.body,
                        "evidence": entry.meta.evidence,
                        "tags": entry.meta.tags,
                        "source": format!("publish:{}", entry.meta.source),
                        "code": code,
                    }
                }),
            )
            .await
            .map(|_| false),
        };
        match result {
            Ok(true) => report.updated.push(label),
            Ok(false) => report.created.push(label),
            Err(e) => report.errors.push(format!("{label} : {e}")),
        }
    }
    // Refresh the mirror so the next turn sees the space as it is now.
    if let Ok(entries) = remote_globals(&app, &connection).await {
        let _ = axecode_harness::cloud_mirror::write(&global_paths(), &connection, entries);
    }
    Ok(report)
}
