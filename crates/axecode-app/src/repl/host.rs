//! Built-in kernel host calls served by the REPL runtime: todo, context,
//! compact, web, images, question, session info. Harness / rlm / messages and
//! hook methods are routed before reaching this module.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{json, Value};
use axecode_core::{JournalEntryKind, Part};

use super::runtime::{lock, Shared};
use crate::{
    tool_run::ToolRunResult, AppStore, CreateImageTool, TodoListState, WebFetchTool, WebSearchTool,
};

/// Moves the images saved by the image tool to the path asked by
/// `images.generate(path=...)` (relative to the workspace, or absolute). With
/// several images, `name.png` becomes `name-1.png`, `name-2.png`... The
/// result (paths, text, file changes) then names the new location.
fn place_generated_images(result: &mut ToolRunResult, workspace: &Path, requested: &str) -> Result<(), String> {
    let requested = PathBuf::from(requested);
    let target = if requested.is_absolute() { requested } else { workspace.join(requested) };
    let count = result.images.iter().filter(|i| i.path.is_some()).count();
    let mut index = 0;
    for image in result.images.iter_mut() {
        let Some(source) = image.path.clone().map(PathBuf::from) else { continue };
        index += 1;
        let mut dest = target.clone();
        if dest.extension().is_none() {
            if let Some(ext) = source.extension() {
                dest.set_extension(ext);
            }
        }
        if count > 1 {
            let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let name = match dest.extension() {
                Some(ext) => format!("{stem}-{index}.{}", ext.to_string_lossy()),
                None => format!("{stem}-{index}"),
            };
            dest.set_file_name(name);
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        if std::fs::rename(&source, &dest).is_err() {
            std::fs::copy(&source, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            let _ = std::fs::remove_file(&source);
        }
        let rel = |p: &Path| p.strip_prefix(workspace).unwrap_or(p).to_string_lossy().replace('\\', "/");
        let (old_rel, new_rel) = (rel(&source), rel(&dest));
        result.content = result.content.replace(&old_rel, &new_rel);
        let mut known = false;
        for change in result.file_changes.iter_mut() {
            if change.relative_path.replace('\\', "/") == old_rel {
                change.relative_path = new_rel.clone();
                known = true;
            }
        }
        if !known && dest.starts_with(workspace) {
            result.file_changes.push(crate::tool_run::FileChange {
                relative_path: new_rel.clone(),
                kind: crate::tool_run::FileChangeKind::Added,
                summary: "Added generated image".into(),
                binary: true,
                added_lines: 0,
                removed_lines: 0,
                truncated: false,
                lines: Vec::new(),
            });
        }
        image.path = Some(dest.display().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod place_tests {
    use super::*;
    use crate::tool_run::ToolRunImage;

    fn generated(workspace: &Path, names: &[&str]) -> ToolRunResult {
        let dir = workspace.with_extension("donnees").join("images");
        std::fs::create_dir_all(&dir).unwrap();
        let images = names
            .iter()
            .map(|name| {
                std::fs::write(dir.join(name), b"png").unwrap();
                ToolRunImage { media_type: "image/png".into(), data: String::new(), path: Some(dir.join(name).display().to_string()) }
            })
            .collect();
        let content = names.iter().map(|n| format!("- {}", dir.join(n).display())).collect::<Vec<_>>().join("\n");
        ToolRunResult::ok_with_images(content, images, Vec::new())
    }

    #[test]
    fn generate_respects_the_requested_path() {
        let ws = std::env::temp_dir().join(format!("axecode-place-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        let mut one = generated(&ws, &["1-1.png"]);
        place_generated_images(&mut one, &ws, "sorties/logo").unwrap();
        assert!(ws.join("sorties/logo.png").exists());
        assert!(!ws.with_extension("donnees").join("images/1-1.png").exists());
        assert!(!ws.join(".axecode").exists(), "no hidden folder in the project");
        assert_eq!(one.file_changes.len(), 1);
        assert_eq!(one.file_changes[0].relative_path, "sorties/logo.png");
        assert!(one.content.contains("sorties/logo.png"), "{}", one.content);
        assert_eq!(one.images[0].path.as_deref(), Some(ws.join("sorties/logo.png").display().to_string().as_str()));

        let mut two = generated(&ws, &["2-1.png", "2-2.png"]);
        place_generated_images(&mut two, &ws, "b.png").unwrap();
        assert!(ws.join("b-1.png").exists() && ws.join("b-2.png").exists());
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(ws.with_extension("donnees"));
    }
}

fn tool_json(result: ToolRunResult) -> Result<Value, String> {
    if result.is_error {
        return Err(result.content);
    }
    let images: Vec<Value> = result
        .images
        .iter()
        .map(|image| json!({"path": image.path, "mediaType": image.media_type}))
        .collect();
    Ok(json!({"content": result.content, "images": images, "meta": result.meta}))
}

/// MCP registry of the session, connected lazily on first use.
/// axe:mcp-supprimer — rebuilt when the stored MCP config changed (server
/// deleted or disabled in Réglages > MCP): a deleted server is never relaunched.
async fn mcp_registry(shared: &Arc<Shared>) -> Result<Arc<crate::McpToolRegistry>, String> {
    let settings = AppStore::open_default()
        .and_then(|s| s.load_mcp_settings())
        .map_err(|e| e.to_string())?;
    let existing = lock(&shared.mcp).clone();
    if let Some(registry) = existing {
        if same_mcp_settings(registry.settings(), &settings) {
            return Ok(registry);
        }
    }
    let registry = Arc::new(crate::McpToolRegistry::new(settings));
    registry.refresh_catalog(&[]).await;
    *lock(&shared.mcp) = Some(registry.clone());
    Ok(registry)
}

fn same_mcp_settings(a: &crate::McpSettings, b: &crate::McpSettings) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}

pub(crate) async fn dispatch(shared: &Arc<Shared>, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "session.info" => {
            let meta = shared.meta();
            Ok(json!({
                "id": meta.id, "name": meta.name, "workspace": meta.workspace_id,
                "model": meta.model, "parentId": meta.parent_id,
            }))
        }
        "todo.get" => Ok(serde_json::to_value(lock(&shared.todo).clone()).unwrap_or_default()),
        "todo.set" => {
            let mut state: TodoListState =
                serde_json::from_value(params).map_err(|e| format!("invalid todo list: {e}"))?;
            state.normalize();
            *lock(&shared.todo) = state.clone();
            let payload = serde_json::to_value(&state).unwrap_or_default();
            shared
                .record(JournalEntryKind::Extension { name: "todo".into(), payload: payload.clone() })
                .await?;
            Ok(payload)
        }
        "context.entries" => {
            let entries = shared.journal_entries();
            let kinds: Option<Vec<String>> = params
                .get("kinds")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect());
            let filtered: Vec<Value> = entries
                .into_iter()
                .filter_map(|e| serde_json::to_value(e).ok())
                .filter(|e| match &kinds {
                    Some(kinds) => e
                        .get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(|k| kinds.iter().any(|x| x == k)),
                    None => true,
                })
                .collect();
            Ok(Value::Array(filtered))
        }
        "compact.request" => {
            let directive = params
                .get("directive")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|d| !d.trim().is_empty());
            *lock(&shared.compact_request) = Some(directive);
            Ok(json!({"scheduled": true, "note": "Compaction runs before the next model call of this turn."}))
        }
        "web.search" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_tool_settings())
                .map_err(|e| e.to_string())?;
            let tool = WebSearchTool::with_settings(settings.web_search_provider, settings.linkup_api_key());
            tool_json(tool.run(params).await)
        }
        "web.fetch" => tool_json(WebFetchTool::new().run(params).await),
        "images.generate" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_tool_settings())
                .map_err(|e| e.to_string())?;
            let tool = CreateImageTool::with_settings(
                shared.workspace(),
                settings.image_provider,
                settings.openai_image_use_subscription,
                settings.openai_image_api_key(),
                settings.nano_banana_api_key(),
            );
            // `path` is a kernel-side option (images.generate(path=...)): the
            // tool saves in the app data (never the project), the file is then
            // MOVED to `path` (no copy left anywhere).
            let mut params = params;
            let requested = params
                .as_object_mut()
                .and_then(|p| p.remove("path"))
                .and_then(|p| p.as_str().map(str::to_string))
                .filter(|p| !p.trim().is_empty());
            let mut result = tool.run(params).await;
            if let Some(requested) = requested.filter(|_| !result.is_error) {
                place_generated_images(&mut result, &shared.workspace(), &requested)?;
            }
            tool_json(result)
        }
        "question.ask" => {
            // Questions are asked through the chat: the turn ends with the
            // question as the final message and the answer arrives as the
            // next user message.
            shared
                .record(JournalEntryKind::Extension { name: "question".into(), payload: params.clone() })
                .await?;
            let sink = lock(&shared.sink).clone();
            if let Some(sink) = sink {
                sink.emit(json!({"type": "question", "question": params})).await;
            }
            Ok(json!({
                "delivered": true,
                "instruction": "End your turn now with the question as your final message; the user's answer will arrive as the next message."
            }))
        }
        "session.history" => {
            let id = lock(&shared.session).id.clone();
            let _ = id;
            let entries = shared.journal_entries();
            let mut out = Vec::new();
            for entry in entries {
                if let JournalEntryKind::Message { message, .. } = entry.kind {
                    let text: String = message
                        .parts
                        .iter()
                        .filter_map(|p| match p {
                            Part::Text { text, .. } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    out.push(json!({"id": entry.id, "ts": entry.ts, "role": message.role, "text": text}));
                }
            }
            Ok(Value::Array(out))
        }
        "skills.list" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_skill_settings())
                .unwrap_or_default();
            let skills: Vec<Value> = crate::list_installed_skills(shared.workspace(), &settings)
                .into_iter()
                .filter(|s| s.enabled)
                .map(|s| json!({"name": s.name, "description": s.description, "path": s.absolute_path, "kind": "markdown"}))
                .collect();
            Ok(Value::Array(skills))
        }
        "skills.load" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_skill_settings())
                .unwrap_or_default();
            let tool = crate::SkillTool::with_settings(shared.workspace(), settings);
            tool_json(tool.run(params).await)
        }
        "mcp.list" => {
            let registry = mcp_registry(shared).await?;
            let tools: Vec<Value> = registry
                .catalog()
                .await
                .into_iter()
                .map(|(name, server, tool, description)| {
                    json!({"name": name, "server": server, "tool": tool, "description": description})
                })
                .collect();
            Ok(Value::Array(tools))
        }
        "mcp.schema" => {
            let registry = mcp_registry(shared).await?;
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            registry
                .schema(name)
                .await
                .ok_or_else(|| format!("unknown MCP tool `{name}`"))
        }
        "mcp.call" => {
            let registry = mcp_registry(shared).await?;
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            match registry.call_direct(&name, arguments).await {
                Some(result) => tool_json(result),
                None => Err(format!("unknown MCP tool `{name}`")),
            }
        }
        other => Err(format!("unknown host method `{other}` (module disabled or not available)")),
    }
}
