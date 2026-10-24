use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
#[cfg(target_os = "macos")]
use objc2::{
    ffi::class_addMethod,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    MainThreadMarker,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use axecode_anthropic::{
    delete_default_auth as delete_default_anthropic_auth,
    exchange_oauth_code as exchange_anthropic_oauth_code, generate_pkce as generate_anthropic_pkce,
    generate_state as generate_anthropic_state,
    load_default_auth_status as load_default_anthropic_auth_status,
    oauth_authorize_url as anthropic_oauth_authorize_url, AnthropicAuthStatus, AnthropicProvider,
    PkceCodes as AnthropicPkceCodes, MODEL_ID as ANTHROPIC_MODEL_ID,
};
use axecode_app::{
    checkpoint_from_snapshots, clean_context_descriptor, compact_conversation_history,
    copy_workspace_entries, create_installed_skill, create_workspace_directory,
    create_workspace_file, delete_mcp_oauth, delete_workspace_entry, discover_mcp_oauth,
    exchange_mcp_oauth_code, import_workspace_paths, list_installed_skills, list_workspace_entries,
    list_workspace_files, mcp_oauth_connected, normalize_workspace_root, probe_mcp_servers,
    read_external_file, read_workspace_file, rename_workspace_entry, resolve_terminal_path,
    restore_turn_checkpoints, restore_workspace_deleted_entries, run_turn, search_workspace_files,
    shell_system_prompt, snapshot_workspace_for_checkpoint, start_mcp_oauth_login,
    subagent_system_prompt, system_prompt_for_mode_with_plan_prompt, system_prompt_with_todo,
    todo_list_from_history, tool_settings_view, trash_workspace_entry,
    validate_turn_checkpoints_restorable, write_workspace_file, AgentEvent, AgentMode, AppStore,
    BashTool, ConversationEvent, ConversationSummary, CreateImageTool, EditFileTool, GlobTool,
    GoalWorkflowState, GrepTool, ImportedEntry, InstalledSkill, McpOAuthLoginPlan, McpOAuthOutcome,
    McpOAuthStatus, McpSettings, McpToolRegistry, ModeModelSettings, OpenRouterModelRecord,
    PlanArtifactState, PlanWorkflowState, QuestionTool, ReadTool, SavedConversation, SkillSettings,
    SkillTool, StartMcpOAuthLoginOutput, SubAgentConfig, SubAgentTool,
    TeamTool, TerminalPathResolution, ToDoListTool, TodoListState, ToolSettings,
    ToolSettingsView, TurnCancel, TurnContext, WebFetchTool, WebSearchTool, WorkspaceBootstrap,
    WorkspaceCopyOperation, WorkspaceDeletedEntry, WorkspaceFileChangeEvent, WorkspaceSearchResult,
    WriteFileTool, MCP_OAUTH_CALLBACK_PATH, MCP_OAUTH_REDIRECT_PORT,
};
use axecode_core::{
    ChatMessage, Effort, ModelCapabilities, ModelRef, Part, Provider, ProviderRequest, Role,
    ServiceTier, ToolDescriptor,
};
use axecode_google::{
    delete_default_auth as delete_default_google_auth,
    exchange_oauth_code as exchange_google_oauth_code, generate_pkce as generate_google_pkce,
    generate_state as generate_google_state,
    load_default_auth_status as load_default_google_auth_status,
    oauth_authorize_url as google_oauth_authorize_url,
    purge_legacy_oauth_if_needed as purge_legacy_google_oauth, GoogleAuthStatus, GoogleProvider,
    PkceCodes as GooglePkceCodes, MODEL_ID as GOOGLE_MODEL_ID,
};
use axecode_kimi::{
    delete_default_auth as delete_default_kimi_auth, generate_state as generate_kimi_state,
    load_default_auth_status as load_default_kimi_auth_status,
    request_device_authorization as request_kimi_device_authorization,
    wait_for_device_token as wait_for_kimi_device_token,
    DeviceAuthorization as KimiDeviceAuthorization, KimiAuthStatus, KimiProvider,
    MODEL_ID as KIMI_MODEL_ID,
};
use axecode_openai::{
    delete_default_auth, exchange_oauth_code, generate_pkce, generate_state,
    load_default_auth_status, oauth_authorize_url, OpenAiAuthStatus, OpenAiProvider, PkceCodes,
    MODEL_ID as OPENAI_MODEL_ID,
};
use axecode_openrouter::{
    delete_default_auth as delete_default_openrouter_auth,
    fetch_model_catalog as fetch_openrouter_model_catalog,
    load_default_api_key as load_default_openrouter_api_key,
    load_default_auth_status as load_default_openrouter_auth_status,
    save_default_api_key as save_default_openrouter_api_key,
    touch_default_auth_validation as touch_default_openrouter_auth_validation,
    validate_api_key as validate_openrouter_api_key_remote, OpenRouterAuthStatus,
    OpenRouterCatalogModel, OpenRouterProvider, PROVIDER_ID as OPENROUTER_PROVIDER_ID,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, Mutex, Notify},
};

mod context;
// axe:voix - ouvre la dictee Windows (Win+H) : secours de la dictee Whisper (voix.rs, src/axe/voix).
#[tauri::command]
fn voice_dictation() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let ps = "Add-Type -Name K -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b,byte s,uint f,System.UIntPtr e);'; [W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)";
        std::process::Command::new("powershell").args(["-NoProfile", "-Command", ps])
            .creation_flags(0x08000000).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    Err("dictée Windows uniquement".into())
}
mod conversations;
mod voix; // axe:voix
mod custom_providers; // axe:providers
mod daemon_client; // axe:daemon
mod freechat; // axe:freechat
mod gemini_web; // axe:gemini-web
mod connections; // axe:remote
mod cloud; // axe:cloud
mod repl_settings; // axe:repl
mod quota; // axe:providers
mod skill_sync; // axe:e4
mod import_dossier; // axe:import
mod git;
mod harness; // axe:harness
mod harness_backup; // axe:cleanup
mod models;
mod offline; // axe:v2-l6
mod platform;
mod prime_term; // axe:v2-e12
mod providers;
mod remote;
mod remote_workspace; // axe:cloud L2
mod state;
mod terminal;
#[cfg(test)]
mod tests;
mod turns;
mod updater;
/// Édition SavIDE : 100 % locale (cloud, miroir VM et mise à jour coupés).
pub(crate) const EDITION_LOCALE: bool = true;
/// Mise à jour automatique active (endpoint : tauri.conf.json, dépôt GitHub public).
pub(crate) const MAJ_AUTO: bool = true;
mod viewers; // axe:viewers
mod workflow;
mod workspace;

use context::*;
use models::*;
use platform::*;
use providers::*;
use remote::*;
use state::*;
use turns::*;
use workflow::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // axe:daemon — `axecode --daemon serve` runs the background service.
    if daemon_client::run_daemon_if_requested() {
        return;
    }
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .try_init();

    // axe:migration — data of the old name copied once into the new folders,
    // before the store, the daemon and the webview open them. Never fatal.
    axecode_app::migration::run_at_startup();

    let store = AppStore::open_default().expect("unable to open app store");
    let openrouter_models = store.load_openrouter_models().unwrap_or_default();
    // axe:cleanup — Settings > Agents profiles become global harness subagent_spec entries.
    match axecode_app::rlm::migrate_settings_profiles(&store) {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "migrated sub-agent profiles to the harness"),
        Err(error) => tracing::warn!(%error, "sub-agent profile migration failed"),
    }
    let mut providers: HashMap<String, Arc<dyn Provider>> = HashMap::new();
    if let Ok(provider) = AnthropicProvider::from_default_sources() {
        providers.insert("anthropic".into(), Arc::new(provider) as Arc<dyn Provider>);
    }
    if let Ok(provider) = OpenAiProvider::from_default_sources() {
        providers.insert("openai".into(), Arc::new(provider) as Arc<dyn Provider>);
    }
    if let Ok(provider) = GoogleProvider::from_default_sources() {
        providers.insert("google".into(), Arc::new(provider) as Arc<dyn Provider>);
    }
    if let Ok(provider) = KimiProvider::from_default_sources() {
        providers.insert("kimi".into(), Arc::new(provider) as Arc<dyn Provider>);
    }
    // axe:gemini-web
    if let Ok(provider) = axecode_gemini_web::GeminiWebProvider::from_default_sources() {
        providers.insert(axecode_gemini_web::PROVIDER_ID.into(), Arc::new(provider) as Arc<dyn Provider>);
    }
    if let Ok(provider) =
        OpenRouterProvider::from_default_sources(openrouter_capabilities(&openrouter_models))
    {
        providers.insert(
            OPENROUTER_PROVIDER_ID.into(),
            Arc::new(provider) as Arc<dyn Provider>,
        );
    }

    let default_model = if providers.contains_key("anthropic") {
        ModelRef::new("anthropic", ANTHROPIC_MODEL_ID).with_effort(Effort::Max)
    } else if providers.contains_key("openai") {
        ModelRef::new("openai", OPENAI_MODEL_ID).with_effort(Effort::Medium)
    } else if providers.contains_key("kimi") {
        ModelRef::new("kimi", KIMI_MODEL_ID).with_effort(Effort::High)
    } else if providers.contains_key(OPENROUTER_PROVIDER_ID) {
        openrouter_models
            .first()
            .map(default_openrouter_model_ref)
            .unwrap_or_else(|| ModelRef::new("google", GOOGLE_MODEL_ID).with_effort(Effort::Medium))
    } else {
        ModelRef::new("google", GOOGLE_MODEL_ID).with_effort(Effort::Medium)
    };

    let remote = RemoteRuntime::from_store(&store);

    let providers = Arc::new(StdMutex::new(providers));
    // axe:providers — configurable instances (custom, Mistral, DeepSeek, …).
    if let Err(err) = custom_providers::install_custom_providers(&providers) {
        tracing::warn!(error = %err, "unable to install configurable providers");
    }

    let state = DesktopState {
        providers,
        store,
        default_model,
        system_prompt: DEFAULT_SYSTEM_PROMPT.into(),
        max_tool_rounds: 2000,
        active_turns: Arc::new(Mutex::new(HashMap::new())),
        active_turn_details: Arc::new(StdMutex::new(HashMap::new())),
        remote,
        file_watchers: Arc::new(Mutex::new(HashMap::new())),
        terminal_sessions: Arc::new(Mutex::new(HashMap::new())),
        openai_login: Arc::new(Mutex::new(None)),
        anthropic_login: Arc::new(Mutex::new(None)),
        google_login: Arc::new(Mutex::new(None)),
        kimi_login: Arc::new(Mutex::new(None)),
        mcp_login: Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Updater plugin is desktop-only (no iOS / Android support upstream).
        .plugin({
            #[cfg(desktop)]
            {
                tauri_plugin_updater::Builder::new().build()
            }
            #[cfg(not(desktop))]
            {
                // No-op plugin so the chain stays uniform on mobile builds.
                tauri::plugin::Builder::new("updater-stub").build()
            }
        })
        .setup(|app| {
            daemon_client::attach_on_startup(app.handle()); // axe:daemon
            #[cfg(target_os = "windows")]
            let _ = app;

            // One-shot purge of legacy Google OAuth tokens so users coming from
            // pre-0.1.14 builds reconnect against the fixed Antigravity flow.
            match purge_legacy_google_oauth() {
                Ok(true) => {
                    tracing::info!("purged legacy Google OAuth state (forced re-login)");
                }
                Ok(false) => {}
                Err(err) => {
                    tracing::warn!(error = %err, "google auth migration check failed");
                }
            }

            #[cfg(target_os = "macos")]
            {
                install_macos_dock_menu(app.handle());
            }

            #[cfg(not(target_os = "windows"))]
            {
                install_desktop_menu(app.handle())?;
            }
            start_remote_if_enabled(app.handle());
            harness_backup::start_harness_backup_loop(); // axe:cleanup
            // axe:providers — background Ollama / LM Studio detection.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let registry = handle.state::<DesktopState>().providers.clone();
                    match custom_providers::detect_local_servers(&registry).await {
                        Ok(probes) if probes.iter().any(|probe| probe.updated) => {
                            let _ = handle.emit("axe://providers-changed", ());
                        }
                        Ok(_) => {}
                        Err(err) => tracing::warn!(error = %err, "local provider detection failed"),
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                remove_window_workspace(&window.app_handle(), window.label().to_string());
            }
            tauri::WindowEvent::Focused(true) => {
                focus_window_workspace(&window.app_handle(), window.label().to_string());
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            if event.id() == CLOSE_ACTIVE_TAB_MENU_ID {
                let windows = app.webview_windows();
                let target = windows
                    .values()
                    .find(|window| window.is_focused().unwrap_or(false))
                    .or_else(|| windows.values().next());
                if let Some(window) = target {
                    let _ = window.emit(CLOSE_ACTIVE_TAB_EVENT_NAME, ());
                }
            } else if event.id() == NEW_WINDOW_MENU_ID {
                create_new_window_detached(app);
            } else if event.id() == TERMINAL_OPEN_MENU_ID {
                let focused = app
                    .webview_windows()
                    .into_values()
                    .find(|window| window.is_focused().unwrap_or(false));
                if let Some(window) = focused {
                    let _ = window.emit(TERMINAL_OPEN_EVENT_NAME, ());
                } else {
                    let _ = app.emit(TERMINAL_OPEN_EVENT_NAME, ());
                }
            }
        })
        .manage(state)
        .manage(updater::UpdaterState::new())
        .manage(daemon_client::DaemonState::default()) // axe:daemon
        .manage(daemon_client::Bridge::default()) // axe:repl
        .manage(connections::ConnectionsState::default()) // axe:remote
        .manage(cloud::CloudState::default()) // axe:cloud
        .manage(prime_term::PrimeTerms::default()) // axe:v2-e12
        .invoke_handler(tauri::generate_handler![
            voice_dictation,
            voix::voix_transcrire, // axe:voix
            voix::voix_annuler,
            voix::voix_etat,
            import_dossier::push_folder_cloud,
            // axe:daemon
            daemon_client::daemon_status,
            daemon_client::daemon_shutdown,
            daemon_client::daemon_sessions,
            daemon_client::daemon_call,
            // axe:gemini-web
            gemini_web::gemini_web_status,
            gemini_web::gemini_web_login,
            gemini_web::gemini_web_logout,
            // axe:freechat
            freechat::freechat_index,
            freechat::freechat_open,
            freechat::freechat_relocate,
            // axe:remote
            connections::connections_list,
            connections::connections_save,
            connections::connections_delete,
            connections::connections_set_active,
            connections::connections_test,
            connections::connections_state,
            // axe:remote end
            // axe:cloud
            cloud::cloud_login,
            cloud::cloud_login_cancel,
            cloud::cloud_login_reopen,
            cloud::cloud_state,
            cloud::cloud_logout,
            cloud::cloud_api,
            cloud::cloud_open_web,
            // axe:cloud end
            // axe:v2-l6 — mode désynchronisé (journal local + resynchronisation)
            offline::offline_status,
            offline::offline_prepare,
            offline::offline_list,
            offline::offline_read,
            offline::offline_write,
            offline::offline_create_file,
            offline::offline_create_dir,
            offline::offline_delete,
            offline::offline_rename,
            offline::offline_journal,
            offline::offline_sync,
            offline::offline_resolve,
            offline::offline_forget,
            // axe:v2-l6 end
            // axe:viewers
            viewers::viewer_read_bytes,
            viewers::viewer_zip_list,
            viewers::viewer_zip_extract,
            viewers::viewer_zip_read,
            viewers::viewer_sqlite_tables,
            viewers::viewer_sqlite_rows,
            // axe:repl
            repl_settings::repl_settings_get,
            repl_settings::repl_settings_save,
            repl_settings::repl_catalog,
            // axe:harness
            harness::harness_paths,
            harness::harness_list,
            harness::harness_get,
            harness::harness_create,
            harness::harness_update,
            harness::harness_delete,
            harness::harness_promote,
            harness::harness_demote,
            harness::harness_refinements,
            harness::harness_rollback,
            harness::harness_brain_detect,
            harness::harness_brain_import,
            harness::harness_refine_start,
            harness::harness_refine_status,
            harness::harness_refine_cancel,
            harness::harness_cloud_sync,
            harness::harness_cloud_status,
            harness::harness_cloud_publish,
            // axe:harness end
            // axe:providers
            custom_providers::provider_settings_get,
            custom_providers::provider_settings_save,
            custom_providers::provider_discover_models,
            custom_providers::provider_detect_local,
            custom_providers::provider_set_model_override,
            quota::provider_quota,
            skill_sync::shared_skills_fingerprints, // axe:e4
            import_dossier::local_folder_files, // axe:import
            harness_backup::harness_backup_get,
            harness_backup::harness_backup_set,
            harness_backup::harness_backup_run,
            // axe:providers end
            remote_workspace::remote_workspace_info,
            remote_workspace::remote_workspace_entries,
            remote_workspace::remote_workspace_read,
            remote_workspace::remote_workspace_write,
            remote_workspace::remote_workspace_create_file,
            remote_workspace::remote_workspace_create_directory,
            remote_workspace::remote_workspace_rename,
            remote_workspace::remote_workspace_delete,
            remote_workspace::remote_workspace_search,
            remote_workspace::remote_git_status,
            remote_workspace::remote_git_commit,
            remote_workspace::remote_git_repos,
            remote_workspace::remote_term_open,
            remote_workspace::remote_term_write,
            remote_workspace::remote_term_resize,
            remote_workspace::remote_term_attach,
            remote_workspace::remote_term_list,
            remote_workspace::remote_term_close,
            remote_workspace::remote_share_list,
            remote_workspace::remote_share_files,
            remote_workspace::remote_share_read,
            remote_workspace::remote_share_publish,
            remote_workspace::remote_share_unpublish,
            remote_workspace::remote_share_log,
            workspace::open_workspace,
            workspace::open_cloud_workspace, // axe:v2-l2.3
            workspace::open_new_window,
            workspace::reset_window_title,
            workspace::watch_workspace_command,
            workspace::unwatch_workspace_command,
            workspace::list_workspace_entries_command,
            workspace::list_workspace_files_command,
            workspace::search_workspace_files_command,
            workspace::read_workspace_file_command,
            workspace::write_workspace_file_command,
            workspace::create_workspace_file_command,
            workspace::create_workspace_directory_command,
            workspace::rename_workspace_entry_command,
            workspace::delete_workspace_entry_command,
            workspace::trash_workspace_entry_command,
            workspace::restore_workspace_deleted_entries_command,
            workspace::reveal_workspace_entry_command,
            workspace::reveal_absolute_path_command,
            workspace::resolve_terminal_path_command,
            workspace::read_external_file_command,
            workspace::delete_skill_command,
            workspace::create_skill_command,
            workspace::update_skill_content_command,
            workspace::open_external_url_command,
            workspace::open_path_with_default_app_command,
            workspace::copy_file_to_path_command,
            workspace::copy_workspace_entries_command,
            workspace::import_workspace_paths_command,
            workspace::save_clipboard_image_attachment_command,
            workspace::read_clipboard_file_paths_command,
            conversations::list_conversations,
            conversations::create_conversation,
            conversations::load_conversation,
            conversations::rename_conversation,
            conversations::delete_conversation,
            conversations::archive_local, // axe:archive-locale
            conversations::list_archived_local,
            conversations::restore_local,
            conversations::delete_archived_local,
            conversations::set_conversation_mode,
            conversations::set_conversation_model_preference,
            conversations::list_mcp_settings,
            conversations::save_mcp_settings,
            conversations::list_tool_settings,
            conversations::save_tool_settings,
            remote::remote_get_status,
            remote::remote_set_enabled,
            remote::remote_start_pairing,
            remote::remote_stop_pairing,
            remote::remote_revoke_device,
            providers::list_configured_model_providers,
            providers::get_openai_provider_status,
            providers::start_openai_oauth_login,
            providers::cancel_openai_oauth_login,
            providers::disconnect_openai_provider,
            providers::get_anthropic_provider_status,
            providers::start_anthropic_oauth_login,
            providers::cancel_anthropic_oauth_login,
            providers::disconnect_anthropic_provider,
            providers::get_google_provider_status,
            providers::start_google_oauth_login,
            providers::cancel_google_oauth_login,
            providers::disconnect_google_provider,
            providers::get_kimi_provider_status,
            providers::start_kimi_oauth_login,
            providers::cancel_kimi_oauth_login,
            providers::disconnect_kimi_provider,
            providers::get_openrouter_provider_status,
            providers::validate_openrouter_api_key,
            providers::disconnect_openrouter_provider,
            providers::list_openrouter_models,
            providers::search_openrouter_models,
            providers::add_openrouter_model,
            providers::remove_openrouter_model,
            conversations::probe_mcp_tools,
            conversations::get_mcp_oauth_status,
            conversations::start_mcp_oauth_login_command,
            conversations::cancel_mcp_oauth_login,
            conversations::disconnect_mcp_oauth,
            conversations::list_installed_skills_command,
            conversations::save_skill_settings,
            turns::check_rewrite_workspace_restore,
            turns::send_message,
            turns::answer_question,
            turns::reject_question,
            turns::compact_conversation,
            turns::list_active_turns,
            turns::replay_active_turn_events,
            context::estimate_context,
            context::estimate_sub_agent_context,
            turns::cancel_turn,
            terminal::run_terminal_command,
            terminal::spawn_terminal,
            terminal::write_terminal,
            terminal::resize_terminal,
            terminal::kill_terminal,
            // axe:v2-e12 — onglet « Prime Agent » epingle (session de production du portail)
            prime_term::prime_term_open,
            prime_term::prime_term_write,
            prime_term::prime_term_resize,
            prime_term::prime_term_close,
            git::git_repository_snapshot_command,
            git::git_init_command,
            git::git_create_worktree_command,
            git::git_remove_worktree_command,
            git::git_create_branch_command,
            git::git_delete_branch_command,
            git::git_rename_branch_command,
            git::git_commit_command,
            git::git_push_command,
            git::git_pull_command,
            git::git_create_pull_request_command,
            updater::updater_check,
            updater::updater_download_and_install,
            updater::updater_restart,
            updater::updater_current_version,
        ])
        .build(tauri::generate_context!())
        .expect("error while building axecode desktop")
        .run(|app, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (&app, &event);

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if !focus_existing_window(app) {
                    create_new_window_detached(app);
                }
            }
        })
}
