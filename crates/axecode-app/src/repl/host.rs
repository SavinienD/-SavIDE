//! Built-in kernel host calls served by the REPL runtime: todo, context,
//! compact, web, images, question, session info. Harness / rlm / messages and
//! hook methods are routed before reaching this module.

use std::sync::Arc;

use serde_json::{json, Value};
use axecode_core::{JournalEntryKind, Part};

use super::runtime::{lock, Shared};
use crate::{
    tool_run::ToolRunResult, AppStore, CreateImageTool, TodoListState, WebFetchTool, WebSearchTool,
};

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
async fn mcp_registry(shared: &Arc<Shared>) -> Result<Arc<crate::McpToolRegistry>, String> {
    let existing = lock(&shared.mcp).clone();
    if let Some(registry) = existing {
        return Ok(registry);
    }
    let settings = AppStore::open_default()
        .and_then(|s| s.load_mcp_settings())
        .map_err(|e| e.to_string())?;
    let registry = Arc::new(crate::McpToolRegistry::new(settings));
    registry.refresh_catalog(&[]).await;
    *lock(&shared.mcp) = Some(registry.clone());
    Ok(registry)
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
            tool_json(tool.run(params).await)
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
