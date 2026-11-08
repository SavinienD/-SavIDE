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

/// compact169 — réponses de `compact.run()` (en français, sans ambiguïté).
pub const COMPACT_PROGRAMME: &str = "Compaction programmée : elle sera faite avant la prochaine requête. N'appelle plus compact.run() dans ce tour : termine ton tour maintenant (réponse courte, sans autre outil).";
pub const COMPACT_IGNORE: &str = "compact.run() a déjà été appelé dans ce tour : appel ignoré. La compaction est faite ou programmée ; termine ton tour maintenant sans rappeler compact.run().";
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
                summary: "Added generated media".into(),
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

fn take_str(params: &mut Value, key: &str) -> Option<String> {
    params
        .as_object_mut()
        .and_then(|p| p.remove(key))
        .and_then(|p| p.as_str().map(str::to_string))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// fournisseur d'images d'un appel (`provider=`) ou des réglages.
#[derive(Debug)]
enum ImageChoice {
    BuiltIn(crate::store::ImageProvider),
    Custom(crate::media::MediaProviderConfig),
}

fn custom_names(settings: &crate::store::ToolSettings) -> String {
    let names: Vec<String> = settings.media_providers.iter().map(|p| format!("« {} »", p.name)).collect();
    if names.is_empty() {
        "aucune API personnalisée (Réglages > REPL > Recherche web et images)".into()
    } else {
        format!("API personnalisées : {}", names.join(", "))
    }
}

fn image_choice(settings: &crate::store::ToolSettings, provider: Option<&str>) -> Result<ImageChoice, String> {
    use crate::store::ImageProvider;
    let Some(name) = provider else {
        if settings.image_provider == ImageProvider::Custom {
            return settings
                .default_media_provider(crate::media::MediaKind::Image)
                .cloned()
                .map(ImageChoice::Custom)
                .ok_or_else(|| format!("images : aucune API personnalisée d'images ; {}", custom_names(settings)));
        }
        return Ok(ImageChoice::BuiltIn(settings.image_provider));
    };
    let key: String = name.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if let Some(cfg) = settings.media_provider(name) {
        return Ok(ImageChoice::Custom(cfg.clone()));
    }
    match key.as_str() {
        "openai" | "gptimage2" | "gptimage" | "chatgpt" => Ok(ImageChoice::BuiltIn(ImageProvider::GptImage2)),
        "nanobanana" | "nanobanana2" | "gemini" => Ok(ImageChoice::BuiltIn(ImageProvider::NanoBanana2)),
        _ => Err(format!(
            "fournisseur d'images inconnu « {name} » : « openai », « nano-banana » ou {}",
            custom_names(settings)
        )),
    }
}

fn video_choice(settings: &crate::store::ToolSettings, provider: Option<&str>) -> Result<crate::media::MediaProviderConfig, String> {
    match provider {
        Some(name) => settings
            .media_provider(name)
            .cloned()
            .ok_or_else(|| format!("fournisseur vidéo inconnu « {name} » ; {}", custom_names(settings))),
        None => settings.default_media_provider(crate::media::MediaKind::Video).cloned().ok_or_else(|| {
            "aucune API vidéo : ajoutez une API personnalisée de type Vidéo dans Réglages > REPL > Recherche web et images > API personnalisées (URL, clé, modèle), ou passez provider=\"nom\".".to_string()
        }),
    }
}

fn media_providers_view(settings: &crate::store::ToolSettings) -> Vec<Value> {
    let image_default = (settings.image_provider == crate::store::ImageProvider::Custom)
        .then(|| settings.default_media_provider(crate::media::MediaKind::Image).map(|p| p.name.clone()))
        .flatten();
    let video_default = settings.default_media_provider(crate::media::MediaKind::Video).map(|p| p.name.clone());
    settings
        .media_providers
        .iter()
        .map(|p| {
            let mut view = p.public_view();
            let default = Some(&p.name) == image_default.as_ref() || Some(&p.name) == video_default.as_ref();
            view["default"] = json!(default);
            view
        })
        .collect()
}

#[cfg(test)]
mod media_choice_tests {
    use super::*;
    use crate::media::{MediaKind, MediaProviderConfig};
    use crate::store::{ImageProvider, ToolSettings};

    fn reglages() -> ToolSettings {
        let mut s = ToolSettings::default();
        s.media_providers = vec![
            MediaProviderConfig { name: "flux".into(), kind: MediaKind::Image, url: "https://img.example/v1".into(), api_key: "k1".into(), ..Default::default() },
            MediaProviderConfig { name: "Kling".into(), kind: MediaKind::Video, url: "https://queue.fal.run/kling".into(), ..Default::default() },
        ];
        s
    }

    #[test]
    fn provider_names_pick_builtin_or_custom_apis() {
        let s = reglages();
        assert!(matches!(image_choice(&s, None).unwrap(), ImageChoice::BuiltIn(ImageProvider::GptImage2)));
        assert!(matches!(image_choice(&s, Some("Nano-Banana")).unwrap(), ImageChoice::BuiltIn(ImageProvider::NanoBanana2)));
        assert!(matches!(image_choice(&s, Some("FLUX")).unwrap(), ImageChoice::Custom(c) if c.name == "flux"));
        let err = image_choice(&s, Some("inconnu")).unwrap_err();
        assert!(err.contains("« flux »") && err.contains("« Kling »"), "{err}");
        let mut custom = s.clone();
        custom.image_provider = ImageProvider::Custom;
        assert!(matches!(image_choice(&custom, None).unwrap(), ImageChoice::Custom(c) if c.name == "flux"));
    }

    #[test]
    fn videos_use_the_first_video_api_or_say_what_to_add() {
        let s = reglages();
        assert_eq!(video_choice(&s, None).unwrap().name, "Kling");
        assert_eq!(video_choice(&s, Some("kling")).unwrap().name, "Kling");
        let err = video_choice(&ToolSettings::default(), None).unwrap_err();
        assert!(err.contains("API personnalisées"), "{err}");
        let vue = media_providers_view(&s);
        assert_eq!(vue[1]["default"], true);
        assert_eq!(vue[0]["key"], "configurée");
        assert_eq!(vue[1]["key"], "absente");
        assert!(!serde_json::to_string(&vue).unwrap().contains("k1"), "clé exposée");
    }

    #[test]
    fn saved_settings_get_unique_provider_names() {
        let mut s = ToolSettings::default();
        s.media_providers = vec![MediaProviderConfig::default(), MediaProviderConfig { name: " api-1 ".into(), ..Default::default() }];
        let s = s.normalized();
        assert_eq!(s.media_providers[0].name, "api-1");
        assert_eq!(s.media_providers[1].name, "api-1-2");
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
/// mcp-supprimer — rebuilt when the stored MCP config changed (server
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
            // compact169 — un seul compact.run() par tour : sinon une IA qui relit
            // la consigne boucle (capture du 26/10 : 9 appels, tour sans fin).
            let deja = {
                let mut n = lock(&shared.compact_calls);
                *n += 1;
                *n > 1
            };
            if deja {
                return Ok(json!({"scheduled": false, "ignored": true, "note": COMPACT_IGNORE}));
            }
            *lock(&shared.compact_request) = Some(directive);
            Ok(json!({"scheduled": true, "note": COMPACT_PROGRAMME}))
        }
        "web.search" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_tool_settings())
                .map_err(|e| e.to_string())?;
            let tool = WebSearchTool::from_settings(&settings);
            tool_json(tool.run(params).await)
        }
        "web.fetch" => tool_json(WebFetchTool::new().run(params).await),
        // Agents en ligne de commande (module `agents_cli` du noyau).
        m if crate::orchestre::est_appel_cli(m) => crate::orchestre::appel_cli(&shared.workspace(), m, params).await,
        "images.generate" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_tool_settings())
                .map_err(|e| e.to_string())?;
            // `path` and `provider` are kernel-side options (images.generate(path=...,
            // provider=...)): the tool saves in the app data (never the project), the
            // file is then MOVED to `path` (no copy left anywhere).
            let mut params = params;
            let requested = take_str(&mut params, "path");
            let provider = take_str(&mut params, "provider");
            let mut result = match image_choice(&settings, provider.as_deref())? {
                ImageChoice::BuiltIn(kind) => {
                    let mut settings = settings.clone();
                    settings.image_provider = kind;
                    CreateImageTool::from_settings(shared.workspace(), &settings).run(params).await
                }
                ImageChoice::Custom(cfg) => crate::media::run_tool(&cfg, &shared.workspace(), params).await,
            };
            if let Some(requested) = requested.filter(|_| !result.is_error) {
                place_generated_images(&mut result, &shared.workspace(), &requested)?;
            }
            tool_json(result)
        }
        // videos.generate(prompt, path=None, provider=None, **options).
        "videos.generate" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_tool_settings())
                .map_err(|e| e.to_string())?;
            let mut params = params;
            let requested = take_str(&mut params, "path");
            let provider = take_str(&mut params, "provider");
            let cfg = video_choice(&settings, provider.as_deref())?;
            let mut result = crate::media::run_tool(&cfg, &shared.workspace(), params).await;
            if let Some(requested) = requested.filter(|_| !result.is_error) {
                place_generated_images(&mut result, &shared.workspace(), &requested)?;
            }
            tool_json(result)
        }
        "media.providers" => {
            let settings = AppStore::open_default()
                .and_then(|s| s.load_tool_settings())
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(media_providers_view(&settings)))
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
