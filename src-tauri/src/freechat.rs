// axe:freechat — free conversations (no project folder), ChatGPT style.
//
// In the IDE every free conversation lives in one shared workspace, the
// scratch root `<data>/scratch`, so the conversation list, the streaming
// state and ChatPane work unchanged. In the background service each session
// works in its own private folder `<data>/scratch/<session-id>/` (REPL
// kernel, generated files); see `axecode_daemon::scratch`.

use crate::*;

use rusqlite::{params, Connection};

/// Canonical scratch root (created on demand).
pub(crate) fn scratch_root() -> std::result::Result<PathBuf, String> {
    let data_dir = axecode_daemon::util::default_data_dir().map_err(error_to_string)?;
    let root = axecode_daemon::scratch::scratch_root(&data_dir);
    fs::create_dir_all(&root).map_err(error_to_string)?;
    normalize_workspace_root(&root).map_err(error_to_string)
}

/// Whether `workspace_root` (canonical) is the shared scratch root.
pub(crate) fn is_scratch_root(workspace_root: &Path) -> bool {
    scratch_root().is_ok_and(|root| root == workspace_root)
}

/// Folder of the service session of a conversation: the private scratch
/// folder for a free conversation, the project folder otherwise.
pub(crate) fn session_workspace(workspace_root: &Path, conversation_id: &str) -> PathBuf {
    if is_scratch_root(workspace_root) {
        workspace_root.join(conversation_id)
    } else {
        workspace_root.to_path_buf()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationRow {
    id: String,
    workspace_id: String,
    title: String,
    updated_at_ms: i64,
    message_count: i64,
}

fn conversation_rows(
    state: &DesktopState,
    workspace_id: Option<&str>,
) -> std::result::Result<Vec<ConversationRow>, String> {
    let conn = Connection::open(state.store.path()).map_err(error_to_string)?;
    let mut statement = conn
        .prepare(
            "select c.id, c.workspace_id, c.title, c.updated_at_ms,
                    (select count(*) from messages m where m.conversation_id = c.id)
             from conversations c
             where ?1 is null or c.workspace_id = ?1
             order by c.updated_at_ms desc",
        )
        .map_err(error_to_string)?;
    let rows = statement
        .query_map(params![workspace_id], |row| {
            Ok(ConversationRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                title: row.get(2)?,
                updated_at_ms: row.get(3)?,
                message_count: row.get(4)?,
            })
        })
        .map_err(error_to_string)?;
    Ok(rows.filter_map(std::result::Result::ok).collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FreechatIndex {
    /// IDE workspace id of free conversations (the scratch root).
    scratch_root: String,
    /// Every conversation of every folder, most recent first.
    conversations: Vec<ConversationRow>,
}

/// Every conversation (free and per project), for the home screen and the
/// sidebar of the free conversation view.
#[tauri::command]
pub(crate) async fn freechat_index(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> std::result::Result<FreechatIndex, String> {
    let root = scratch_root()?;
    sync_quickly(&app, &state, &root).await;
    Ok(FreechatIndex {
        scratch_root: root.display().to_string(),
        conversations: conversation_rows(&state, None)?,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FreechatOpenInput {
    #[serde(default)]
    conversation_id: Option<String>,
    /// Start a new conversation (the latest one is reused while it is empty).
    #[serde(default)]
    fresh: bool,
}

/// Opens the free conversation workspace (optionally on one conversation).
#[tauri::command]
pub(crate) async fn freechat_open(
    app: AppHandle,
    state: State<'_, DesktopState>,
    window: tauri::WebviewWindow,
    input: FreechatOpenInput,
) -> std::result::Result<WorkspaceBootstrap, String> {
    let root = scratch_root()?;
    let workspace_id = root.display().to_string();
    sync_quickly(&app, &state, &root).await;
    if input.fresh {
        let latest = conversation_rows(&state, Some(&workspace_id))?.into_iter().next();
        if latest.is_none_or(|row| row.message_count > 0) {
            state
                .store
                .create_conversation(&workspace_id, &state.default_model, &state.system_prompt)
                .map_err(error_to_string)?;
        }
    }
    let mut bootstrap = state
        .store
        .bootstrap_workspace(&root, &state.default_model, &state.system_prompt)
        .map_err(error_to_string)?;
    if let Some(id) = input.conversation_id.filter(|id| *id != bootstrap.active_conversation.id) {
        if let Some(conversation) = state
            .store
            .load_conversation(&workspace_id, &id)
            .map_err(error_to_string)?
        {
            bootstrap.active_conversation = conversation;
        }
    }
    apply_window_title(&window, "");
    update_current_workspace(&window.app_handle(), window.label().to_string(), workspace_id);
    Ok(bootstrap)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FreechatRelocateInput {
    conversation_id: String,
    workspace_path: String,
}

/// "Ouvrir un dossier pour cette conversation": moves a free conversation
/// to a project folder (IDE store + service session). The caller then opens
/// the folder; the conversation is the most recent one there.
#[tauri::command]
pub(crate) async fn freechat_relocate(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: FreechatRelocateInput,
) -> std::result::Result<(), String> {
    let root = scratch_root()?;
    let target = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    if target.starts_with(&root) {
        return Err("Choisissez un dossier de projet.".into());
    }
    let id = input.conversation_id;
    let running = state.active_turns.lock().await.contains_key(&id)
        || state.active_turn_details.lock().map(|a| a.contains_key(&id)).unwrap_or(false);
    if running {
        return Err("Une réponse est en cours : arrêtez-la avant d'ouvrir un dossier.".into());
    }
    let target_id = target.display().to_string();
    // The service session follows (when it exists): the next turn restarts
    // the kernel in the project, its variables come back from the snapshot.
    if crate::daemon_client::daemon_call_value(&app, "sessions.get", json!({"sessionId": id}))
        .await
        .is_ok()
    {
        let extra = system_prompt_for_workspace(&target, "").unwrap_or_default();
        crate::daemon_client::daemon_call_value(
            &app,
            "sessions.relocate",
            json!({"sessionId": id, "workspaceId": target_id, "systemPromptExtra": extra.trim()}),
        )
        .await?;
    }
    let conn = Connection::open(state.store.path()).map_err(error_to_string)?;
    let changed = conn
        .execute(
            "update conversations set workspace_id = ?2, updated_at_ms = ?3 where id = ?1 and workspace_id = ?4",
            params![id, target_id, now_ms(), root.display().to_string()],
        )
        .map_err(error_to_string)?;
    if changed == 0 {
        return Err("Conversation libre introuvable.".into());
    }
    Ok(())
}

// ----- service -> IDE store -------------------------------------------------

/// Copies a service session into the IDE store under the same id (a free
/// conversation started from the web interface or the Agents view).
fn import_conversation(
    state: &DesktopState,
    workspace_id: &str,
    id: &str,
) -> std::result::Result<SavedConversation, String> {
    let conn = Connection::open(state.store.path()).map_err(error_to_string)?;
    let taken: i64 = conn
        .query_row("select count(*) from conversations where id = ?1", params![id], |row| row.get(0))
        .map_err(error_to_string)?;
    if taken > 0 {
        return Err(format!("conversation {id} already exists in another folder"));
    }
    let created = state
        .store
        .create_conversation(workspace_id, &state.default_model, &state.system_prompt)
        .map_err(error_to_string)?;
    // A brand-new conversation has no messages nor checkpoints: renaming its
    // primary key is safe.
    if let Err(err) = conn.execute(
        "update conversations set id = ?2 where id = ?1",
        params![created.id, id],
    ) {
        let _ = state.store.delete_conversation(workspace_id, &created.id);
        return Err(error_to_string(err));
    }
    state
        .store
        .load_conversation(workspace_id, id)
        .map_err(error_to_string)?
        .ok_or_else(|| "conversation importée introuvable".to_string())
}

/// The service is the source of truth of free conversations: imports the
/// ones created elsewhere and refreshes the history of the ones continued
/// elsewhere (newer in the service than in the IDE store). Best effort.
async fn sync_from_service(app: &AppHandle, state: &DesktopState, root: &Path) {
    let workspace_id = root.display().to_string();
    let Ok(list) = crate::daemon_client::daemon_call_value(app, "sessions.list", json!({})).await else {
        return;
    };
    let Ok(metas) = serde_json::from_value::<Vec<Value>>(list) else { return };
    let local: HashMap<String, i64> = conversation_rows(state, Some(&workspace_id))
        .unwrap_or_default()
        .into_iter()
        .map(|row| (row.id, row.updated_at_ms))
        .collect();
    for meta in metas {
        let flag = |key: &str| meta.get(key).and_then(Value::as_bool).unwrap_or(false);
        let is_root = meta.get("parentId").is_none_or(Value::is_null);
        let running = meta.get("status").and_then(Value::as_str) == Some("running");
        if !flag("scratch") || !is_root || flag("archived") {
            continue;
        }
        let Some(id) = meta.get("id").and_then(Value::as_str) else { continue };
        let updated = meta.get("updatedAtMs").and_then(Value::as_i64).unwrap_or(0);
        let known = local.get(id).copied();
        // A running session is imported (history so far) but not refreshed:
        // the next sync after the turn brings the rest.
        if known.is_some_and(|local_updated| running || local_updated >= updated) {
            continue;
        }
        let Ok(history) =
            crate::daemon_client::daemon_call_value(app, "sessions.history", json!({"sessionId": id})).await
        else {
            continue;
        };
        let Ok(history) = serde_json::from_value::<Vec<ChatMessage>>(history) else { continue };
        if history.is_empty() {
            continue;
        }
        let conversation = match known {
            Some(_) => state.store.load_conversation(&workspace_id, id).ok().flatten(),
            None => import_conversation(state, &workspace_id, id).ok(),
        };
        let Some(mut conversation) = conversation else { continue };
        if known.is_none() {
            if let Some(name) = meta.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()) {
                conversation.title = name.to_string();
            }
            if let Some(model) = meta.get("model").and_then(|m| serde_json::from_value::<ModelRef>(m.clone()).ok()) {
                conversation.model = model;
            }
        }
        conversation.history = history;
        let _ = state.store.save_conversation(&conversation);
    }
}

/// `sync_from_service` without blocking the UI on a slow service start.
async fn sync_quickly(app: &AppHandle, state: &DesktopState, root: &Path) {
    let _ = tokio::time::timeout(Duration::from_secs(3), sync_from_service(app, state, root)).await;
}

// ----- IDE store -> service -------------------------------------------------

/// Name of a new service session: the conversation title, or the first
/// words of the first message while the title is still the default one.
pub(crate) fn session_name(title: &str, first_text: &str) -> String {
    let title = title.trim();
    if !title.is_empty() && title != "New conversation" {
        return title.to_string();
    }
    let text = first_text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = text.chars().collect();
    match chars.len() {
        0 => "Nouvelle conversation".into(),
        n if n <= 48 => text,
        _ => format!("{}...", chars[..45].iter().collect::<String>()),
    }
}

/// A free conversation deleted in the IDE is archived in the service, so
/// that `sync_from_service` does not bring it back (it stays readable).
pub(crate) async fn forget_session(app: &AppHandle, workspace_root: &Path, conversation_id: &str) {
    if !is_scratch_root(workspace_root) {
        return;
    }
    let _ = crate::daemon_client::daemon_call_value(
        app,
        "sessions.update",
        json!({"sessionId": conversation_id, "archived": true}),
    )
    .await;
}

/// A free conversation renamed in the IDE keeps the same name in the web
/// interface and the Agents view.
pub(crate) async fn mirror_rename(app: &AppHandle, workspace_root: &Path, conversation_id: &str, title: &str) {
    if !is_scratch_root(workspace_root) {
        return;
    }
    let _ = crate::daemon_client::daemon_call_value(
        app,
        "sessions.update",
        json!({"sessionId": conversation_id, "name": title}),
    )
    .await;
}
