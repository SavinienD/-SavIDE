// axe:daemon — the app executable doubles as the background service
// (`axecode --daemon serve`) and, in IDE mode, as a client attached to it.

use crate::*;

use axecode_app::repl::{ProviderResolver, ReplDeps, ReplFactory};
use axecode_daemon::{client::DaemonClient, protocol::Event as DaemonEvent};

pub(crate) const DAEMON_FLAG: &str = "--daemon";
pub(crate) const DAEMON_EVENT: &str = "axe://daemon";

// ----- daemon mode ----------------------------------------------------------

type Registry = Arc<StdMutex<HashMap<String, Arc<dyn Provider>>>>;

fn daemon_registry() -> Registry {
    let mut providers: HashMap<String, Arc<dyn Provider>> = HashMap::new();
    if let Ok(provider) = AnthropicProvider::from_default_sources() {
        providers.insert("anthropic".into(), Arc::new(provider));
    }
    if let Ok(provider) = OpenAiProvider::from_default_sources() {
        providers.insert("openai".into(), Arc::new(provider));
    }
    if let Ok(provider) = GoogleProvider::from_default_sources() {
        providers.insert("google".into(), Arc::new(provider));
    }
    if let Ok(provider) = KimiProvider::from_default_sources() {
        providers.insert("kimi".into(), Arc::new(provider));
    }
    // axe:gemini-web
    if let Ok(provider) = axecode_gemini_web::GeminiWebProvider::from_default_sources() {
        providers.insert(axecode_gemini_web::PROVIDER_ID.into(), Arc::new(provider));
    }
    let openrouter_models = AppStore::open_default()
        .and_then(|store| store.load_openrouter_models())
        .unwrap_or_default();
    if let Ok(provider) =
        OpenRouterProvider::from_default_sources(openrouter_capabilities(&openrouter_models))
    {
        providers.insert(OPENROUTER_PROVIDER_ID.into(), Arc::new(provider));
    }
    let registry = Arc::new(StdMutex::new(providers));
    if let Err(err) = custom_providers::install_custom_providers(&registry) {
        tracing::warn!(error = %err, "unable to install configurable providers");
    }
    registry
}

/// Providers are rebuilt on a miss, and when the provider settings, keys or
/// a provider login changed on disk, so that what is done in the IDE after the
/// daemon started is picked up without restarting it.
struct DaemonProviders {
    registry: StdMutex<Registry>,
    stamp: StdMutex<Option<std::time::SystemTime>>,
}

impl DaemonProviders {
    fn new() -> Self {
        Self {
            stamp: StdMutex::new(custom_providers::settings_stamp()),
            registry: StdMutex::new(daemon_registry()),
        }
    }
}

impl ProviderResolver for DaemonProviders {
    fn provider(&self, provider_id: &str) -> std::result::Result<Arc<dyn Provider>, String> {
        let lookup = |registry: &Registry| {
            registry
                .lock()
                .ok()
                .and_then(|providers| providers.get(provider_id).cloned())
        };
        let stamp = custom_providers::settings_stamp();
        let changed = self.stamp.lock().map(|known| *known != stamp).unwrap_or(true);
        let current = self.registry.lock().map_err(|_| "registre indisponible (verrou)")?.clone();
        if !changed {
            if let Some(provider) = lookup(&current) {
                return Ok(custom_providers::with_overrides(provider));
            }
        }
        if let Ok(mut known) = self.stamp.lock() {
            *known = stamp;
        }
        let fresh = daemon_registry();
        let found = lookup(&fresh);
        if let Ok(mut slot) = self.registry.lock() {
            *slot = fresh;
        }
        found
            .map(custom_providers::with_overrides)
            .ok_or_else(|| format!("provider `{provider_id}` is not configured or missing credentials"))
    }
}

/// Resource directories next to the executable (Windows/Linux installers
/// and the macOS bundle layout).
fn resource_dirs() -> Vec<PathBuf> {
    let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) else {
        return Vec::new();
    };
    vec![
        dir.clone(),
        dir.join("resources"),
        dir.join("../Resources"),
        dir.join("../lib/axecode"),
        dir.join("../lib/SavIDE"),
        // axe:migration - installation of before the rename (read only).
    ]
}

/// Returns true when the process was started in daemon mode (and ran it).
pub(crate) fn run_daemon_if_requested() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some(DAEMON_FLAG) {
        return false;
    }
    let deps = Arc::new(ReplDeps {
        providers: Arc::new(DaemonProviders::new()),
        resource_dirs: resource_dirs(),
        hooks: daemon_hooks(),
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    if let Err(err) = runtime.block_on(axecode_daemon::cli::run(args[1..].to_vec(), Arc::new(ReplFactory { deps }))) {
        eprintln!("axecode daemon: {err:#}");
        std::process::exit(1);
    }
    true
}

/// Turn hooks contributed by other chantiers (goal, heartbeat, refine...).
fn daemon_hooks() -> Vec<Arc<dyn axecode_app::repl::TurnHook>> {
    // axe:goal — /goal, /autonomous, /heartbeat, /refine, /compact.
    let providers: Arc<dyn ProviderResolver> =
        Arc::new(DaemonProviders::new());
    vec![axecode_app::session_commands::SessionCommandsHook::new(providers)]
    // axe:goal end
}

// ----- IDE client -----------------------------------------------------------

#[derive(Default)]
pub(crate) struct DaemonState {
    pub(crate) client: Mutex<Option<DaemonClient>>,
}

fn data_dir() -> std::result::Result<PathBuf, String> {
    axecode_daemon::util::default_data_dir().map_err(|e| e.to_string())
}

async fn connect(app: &AppHandle) -> std::result::Result<DaemonClient, String> {
    // Pendant une installation, ne jamais relancer le démon (ni son python.exe).
    crate::updater::demon_autorise()?;
    let state = app.state::<DaemonState>();
    let mut slot = state.client.lock().await;
    if let Some(client) = slot.as_ref().filter(|c| !c.is_closed()) {
        return Ok(client.clone());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DaemonEvent>();
    let client = axecode_daemon::ensure_daemon(&data_dir()?, &exe, &[DAEMON_FLAG], Some(tx)).await?;
    let _ = client
        .call("hello", json!({"client": format!("ide:{}", std::process::id())}))
        .await;
    let _ = client.call("sessions.attach", json!({"sessionId": "*"})).await;
    let app_events = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            bridge_event(&app_events, &event);
            let _ = app_events.emit(DAEMON_EVENT, &event);
        }
    });
    *slot = Some(client.clone());
    Ok(client)
}

/// Starts (or attaches to) the daemon at IDE startup, in the background.
// axe:miroir-vm - option (b) : les conversations locales tournent sur le PC mais sont
// recopiees sur la VM (espace axe-cloud, dossier .axe-conversations/) toutes les 60 s.
fn start_vm_mirror(app: &AppHandle) {
    if crate::EDITION_LOCALE {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use base64::Engine as _;
        let mut since: i64 = 0;
        let mut dossier_ok = false;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            let state = app.state::<crate::DesktopState>();
            let Ok(list) = state.store.conversations_updated_since(since) else { continue };
            let (mut ok_max, mut echec_min) = (since, i64::MAX);
            for (ws, id, upd) in list {
                if ws.starts_with("axe-cloud://") { continue; }
                let Ok(Some(conv)) = state.store.load_conversation(&ws, &id) else { continue };
                let body = serde_json::json!({"workspace": ws, "conversation": conv}).to_string().into_bytes();
                // axe:miroir-vm - creation du dossier tant qu'elle n'a pas reussi.
                if !dossier_ok {
                    dossier_ok = crate::connections::call_on(&app, Some("axe-cloud"), "fs.mkdir",
                        json!({"path": ".axe-conversations"})).await.is_ok();
                }
                // axe:sub-n - grosses conversations (> 1 Mo) : la trame unique bloquait le miroir.
                // Envoi en morceaux de 512 Ko (1er tronque, suivants en append) ; un fichier
                // incomplet est reecrit au tour suivant car `since` n'avance que si TOUT a reussi.
                let part = format!(".axe-conversations/{id}.json");
                let mut res: std::result::Result<(), String> = Ok(());
                for (i, morceau) in body.chunks(512 * 1024).enumerate() {
                    let data = base64::engine::general_purpose::STANDARD.encode(morceau);
                    let r = tokio::time::timeout(std::time::Duration::from_secs(60),
                        crate::connections::call_on(&app, Some("axe-cloud"), "fs.write_bytes",
                            json!({"path": &part, "data": data, "append": i > 0}))).await;
                    match r {
                        Ok(Ok(_)) => {}
                        Ok(Err(e)) => { res = Err(format!("morceau {i}: {e}")); break; }
                        Err(_) => { res = Err(format!("morceau {i}: delai depasse (60 s)")); break; }
                    }
                }
                if let Err(e) = &res { tracing::warn!(conversation = %id, error = %e, "miroir VM"); }
                // axe:miroir-vm - etat visible dans l'appli (badge) : ok / erreur exacte.
                let _ = tauri::Emitter::emit(&app, "axe://mirror-status", json!({
                    "ok": res.is_ok(), "id": id, "error": res.as_ref().err(),
                    "atMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)}));
                if res.is_ok() { ok_max = ok_max.max(upd); } else { echec_min = echec_min.min(upd); }
            }
            // axe:sub-n - ne pas depasser une conversation en echec : on la retentera.
            since = since.max(if echec_min == i64::MAX { ok_max } else { ok_max.min(echec_min - 1) });
        }
    });
}

pub(crate) fn attach_on_startup(app: &AppHandle) {
    start_vm_mirror(app);
    // axe:providers — in-session model changes are journaled (model_switch)
    // when the conversation already lives in the daemon.
    let listener_app = app.clone();
    tauri::Listener::listen(app, "axe://model-switch", move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else { return };
        let (Some(id), Some(to)) = (
            payload.get("conversationId").and_then(Value::as_str).map(str::to_string),
            payload.get("to").cloned(),
        ) else {
            return;
        };
        let app = listener_app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(client) = connect(&app).await {
                if client.call("sessions.get", json!({"sessionId": id})).await.is_ok() {
                    let _ = client
                        .call("sessions.set_model", json!({"sessionId": id, "model": to}))
                        .await;
                }
            }
        });
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = connect(&app).await {
            tracing::warn!(error = %err, "unable to attach to the background service");
        }
    });
}

#[tauri::command]
pub(crate) async fn daemon_status(
    app: AppHandle,
    connection: Option<String>, // axe:remote
) -> std::result::Result<Value, String> {
    // axe:remote
    if let Some(id) = connection.as_deref().filter(|id| *id != crate::connections::LOCAL_ID) {
        let mut status = crate::connections::call_on(&app, Some(id), "status", json!({})).await?;
        status["running"] = json!(true);
        status["remote"] = json!(true);
        return Ok(status);
    }
    // axe:remote end
    let lock = axecode_daemon::protocol::read_lock(&data_dir()?);
    let state = app.state::<DaemonState>();
    let connected = state.client.lock().await.as_ref().is_some_and(|c| !c.is_closed());
    if !connected && lock.is_none() {
        return Ok(json!({"running": false}));
    }
    let client = connect(&app).await?;
    let mut status = client.call("status", json!({})).await?;
    status["running"] = json!(true);
    Ok(status)
}

#[derive(Deserialize)]
pub(crate) struct DaemonShutdownInput {
    #[serde(default)]
    force: bool,
    #[serde(default)]
    connection: Option<String>, // axe:remote
}

#[tauri::command]
pub(crate) async fn daemon_shutdown(
    app: AppHandle,
    input: DaemonShutdownInput,
) -> std::result::Result<Value, String> {
    // axe:remote
    if let Some(id) = input.connection.as_deref().filter(|id| *id != crate::connections::LOCAL_ID) {
        return crate::connections::call_on(&app, Some(id), "shutdown", json!({"force": input.force})).await;
    }
    // axe:remote end
    let client = connect(&app).await?;
    let result = client.call("shutdown", json!({"force": input.force})).await?;
    *app.state::<DaemonState>().client.lock().await = None;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn daemon_sessions(
    app: AppHandle,
    connection: Option<String>, // axe:remote
) -> std::result::Result<Value, String> {
    crate::connections::call_on(&app, connection.as_deref(), "sessions.list", json!({})).await
}

#[derive(Deserialize)]
pub(crate) struct DaemonCallInput {
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    connection: Option<String>, // axe:remote
}

/// Generic passthrough for the Agents view, `/tree`, etc.
#[tauri::command]
pub(crate) async fn daemon_call(
    app: AppHandle,
    input: DaemonCallInput,
) -> std::result::Result<Value, String> {
    crate::connections::call_on(&app, input.connection.as_deref(), &input.method, input.params).await
}

/// axe:harness — direct daemon call for other IDE modules.
pub(crate) async fn daemon_call_value(
    app: &AppHandle,
    method: &str,
    params: Value,
) -> std::result::Result<Value, String> {
    connect(app).await?.call(method, params).await
}

// ----- chat bridge: IDE conversations run as daemon REPL sessions ----------

#[derive(Default)]
pub(crate) struct BridgeTurn {
    workspace_id: String,
    in_text: bool,
    in_thinking: bool,
    /// axe:parcours-collegue — dernière erreur affichée (journal puis flux : une seule fois).
    last_error: Option<String>,
}

#[derive(Default)]
pub(crate) struct Bridge {
    turns: StdMutex<HashMap<String, BridgeTurn>>,
    /// axe:commandes — conversation -> dossier, pour suivre les tours lancés par le
    /// service lui-même (réveil /heartbeat, /autonomous) : avant, ils étaient ignorés.
    known: StdMutex<HashMap<String, String>>,
}

/// axe:commandes — `(message, at_ms)` si l'entrée de journal est un réveil /heartbeat.
pub(crate) fn heartbeat_from_entry(data: &Value) -> Option<(String, i64)> {
    if data.get("kind").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = data.get("message")?;
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let text: String = message
        .get("parts")?
        .as_array()?
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect();
    let (body, at_ms) = axecode_app::session_commands::parse_heartbeat_text(&text)?;
    Some((body, at_ms.or_else(|| data.get("ts").and_then(Value::as_i64)).unwrap_or(0)))
}

/// axe:commandes — un tour que l'IDE n'a pas lancé commence (réveil, continuation) :
/// il faut le suivre si la conversation est connue de ce poste.
fn adopts_turn(event: &DaemonEvent) -> bool {
    match event.event.as_str() {
        "entry" => heartbeat_from_entry(&event.data).is_some(),
        "status" => event.data.get("status").and_then(Value::as_str) == Some("running"),
        _ => false,
    }
}

fn bridge(app: &AppHandle) -> tauri::State<'_, Bridge> {
    app.state::<Bridge>()
}

/// Whether chat turns go through the REPL agent (Settings > Outils).
pub(crate) fn repl_agent_enabled() -> bool {
    data_dir()
        .map(|dir| axecode_app::repl::ReplSettings::load(&dir).agent_enabled)
        .unwrap_or(true)
}

// axe:v2-l2.4c — espace cloud : l'IDE travaille sur un identifiant virtuel
// `axe-cloud://<connexion>/<racine>` qui n'existe pas sur le poste. L'agent doit
// alors tourner sur le service, dans le dossier réel exposé par `fs.root`.

/// Identifiant de connexion d'un chemin d'espace virtuel cloud (le segment
/// entre `axe-cloud://` et le `/` suivant), ou `None` pour un dossier local.
pub(crate) fn cloud_connection_id(workspace_path: &Path) -> Option<String> {
    let raw = workspace_path.to_string_lossy();
    let rest = raw.strip_prefix("axe-cloud://")?;
    let connection = rest.split('/').next().unwrap_or("").trim();
    if connection.is_empty() {
        None
    } else {
        Some(connection.to_string())
    }
}

/// Chemin réel côté service d'un espace cloud, par un appel `fs.root` sur la
/// connexion. `None` quand le chemin n'est pas cloud ou que l'appel échoue.
pub(crate) async fn cloud_service_workspace(
    app: &AppHandle,
    workspace_path: &Path,
) -> Option<PathBuf> {
    let connection = cloud_connection_id(workspace_path)?;
    let root = crate::connections::call_on(app, Some(&connection), "fs.root", json!({}))
        .await
        .ok()?;
    let path = root.get("path").and_then(Value::as_str).map(str::trim)?;
    if path.is_empty() {
        None
    } else {
        // axe:cloud-sous-dossier — `axe-cloud://<connexion>/<racine>/<sous/dossier>` ouvert
        // depuis l'accueil : l'agent travaille dans le sous-dossier, pas à la racine.
        let mut out = PathBuf::from(path);
        for part in cloud_subdir_parts(workspace_path).unwrap_or_default() {
            out.push(part);
        }
        Some(out)
    }
}

/// Segments du sous-dossier d'un chemin virtuel cloud (après `<connexion>/<racine>`).
/// `None` si un segment est dangereux (`..`, `.`, `\`, `:`).
pub(crate) fn cloud_subdir_parts(workspace_path: &Path) -> Option<Vec<String>> {
    let raw = workspace_path.to_string_lossy();
    let rest = raw.strip_prefix("axe-cloud://")?;
    let parts: Vec<String> = rest
        .split('/')
        .filter(|p| !p.is_empty())
        .skip(2)
        .map(str::to_string)
        .collect();
    if parts
        .iter()
        .any(|p| p == "." || p == ".." || p.contains('\\') || p.contains(':'))
    {
        return None;
    }
    Some(parts)
}

pub(crate) fn is_bridged(app: &AppHandle, conversation_id: &str) -> bool {
    bridge(app)
        .turns
        .lock()
        .map(|t| t.contains_key(conversation_id))
        .unwrap_or(false)
}

/// Runs a chat turn in the daemon. `conversation_id` is the session id.
pub(crate) async fn send_repl_message(
    app: AppHandle,
    state: &DesktopState,
    input: &SendMessageInput,
) -> std::result::Result<(), String> {
    let workspace_root = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let workspace_id = workspace_root.display().to_string();
    let stored = state
        .store
        .load_conversation(&workspace_id, &input.conversation_id)
        .map_err(error_to_string)?;
    // axe:parcours-collegue — conversation d'espace créée par « + » : pas de ligne locale.
    let (mut conversation, adopted) = conversation_to_send(
        stored,
        cloud_connection_id(&workspace_root).is_some(),
        &workspace_id,
        &input.conversation_id,
        &state.default_model,
    )?;
    let model = model_with_optional_selection(
        &conversation.model,
        input.model.as_ref().map(|m| ModelInput { provider: m.provider.clone(), name: m.name.clone() }),
        input.thinking,
    );
    // axe:v2-l2.4c — sur un chemin virtuel cloud, le prompt additionnel peut
    // rester vide : cela ne doit pas bloquer l'envoi.
    let extra = system_prompt_for_workspace(&workspace_root, "").unwrap_or_default();
    let message = build_user_message(
        input.text.trim(),
        &input.attachments,
        &workspace_root,
        None,
        input.message_visibility.unwrap_or(MessageVisibilityInput::Normal),
    );
    // axe:un-seul-espace - conversation d'un espace cloud : le tour part sur le daemon
    // de la VM (avant : daemon LOCAL du PC, d'ou les messages sans reponse).
    let client = match cloud_connection_id(&workspace_root) {
        Some(id) => crate::connections::connect_remote(&app, &id).await?,
        None => connect(&app).await?,
    };
    // axe:v2-l2.4c — espace cloud : l'agent tourne sur le service, dans le
    // chemin réel (`fs.root`) ; l'IDE ne garde que l'identifiant virtuel.
    // axe:freechat — sinon, une conversation libre travaille dans son dossier privé.
    let session_workspace = match cloud_service_workspace(&app, &workspace_root).await {
        Some(service_root) => service_root,
        None => crate::freechat::session_workspace(&workspace_root, &conversation.id),
    };
    let session_name = crate::freechat::session_name(&conversation.title, input.text.trim());
    client
        .call(
            "sessions.ensure",
            json!({
                "sessionId": conversation.id,
                "request": {
                    "name": session_name,
                    "workspaceId": session_workspace.display().to_string(),
                    "model": model,
                    "systemPromptExtra": extra.trim(),
                },
                "history": conversation.history,
            }),
        )
        .await?;
    // axe:parcours-collegue — conversation adoptée : son modèle n'est connu que du service,
    // le modèle choisi dans le compositeur lui est toujours appliqué.
    if adopted || conversation.model != model {
        client
            .call("sessions.set_model", json!({"sessionId": conversation.id, "model": model}))
            .await?;
    }
    if let Ok(mut known) = bridge(&app).known.lock() {
        known.insert(conversation.id.clone(), workspace_id.clone());
    }
    if let Ok(mut turns) = bridge(&app).turns.lock() {
        turns.insert(
            conversation.id.clone(),
            BridgeTurn { workspace_id: workspace_id.clone(), ..Default::default() },
        );
    }
    register_active_turn(&app, state, &workspace_id, &conversation.id).await;
    let _ = emit_agent_event(&app, &workspace_id, &conversation.id, &AgentEvent::TurnStarted);
    // Mirror the user message in the legacy store right away (titles, lists).
    conversation.history.push(message.clone());
    conversation.model = model;
    if !adopted {
        let _ = state.store.save_conversation(&conversation);
    }
    client
        .call("sessions.send", json!({"sessionId": conversation.id, "message": message}))
        .await?;
    Ok(())
}

/// axe:parcours-collegue — la conversation à envoyer, et si elle est « adoptée ».
/// Une conversation d'un espace Axe Cloud créée par « + » (`sessions.create` sur la VM)
/// n'a pas de ligne dans le magasin du PC : avant, l'envoi s'arrêtait sur
/// « conversation introuvable ». Le service la connaît (historique, titre) : on l'envoie
/// telle quelle, sans l'écrire dans le magasin du PC. Hors espace cloud, rien ne change.
pub(crate) fn conversation_to_send(
    stored: Option<SavedConversation>,
    cloud_workspace: bool,
    workspace_id: &str,
    conversation_id: &str,
    default_model: &ModelRef,
) -> std::result::Result<(SavedConversation, bool), String> {
    match stored {
        Some(conversation) => Ok((conversation, false)),
        None if cloud_workspace => Ok((
            SavedConversation {
                id: conversation_id.to_string(),
                workspace_id: workspace_id.to_string(),
                title: String::new(),
                model: default_model.clone(),
                mode_model_settings: ModeModelSettings::new(default_model),
                system_prompt: String::new(),
                todo_list: TodoListState::default(),
                plan_workflow: PlanWorkflowState::default(),
                goal_workflow: GoalWorkflowState::default(),
                history: Vec::new(),
            },
            true,
        )),
        None => Err("conversation introuvable".into()),
    }
}

/// axe:parcours-collegue — message d'une entrée de journal « turn_error » (événement `entry`).
pub(crate) fn journal_turn_error(data: &Value) -> Option<String> {
    if data.get("kind").and_then(Value::as_str) != Some("extension")
        || data.get("name").and_then(Value::as_str) != Some("turn_error")
    {
        return None;
    }
    let message = data
        .get("payload")
        .and_then(|payload| payload.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    (!message.is_empty()).then(|| message.to_string())
}

/// axe:parcours-collegue — la même erreur arrive deux fois (entrée de journal puis flux) :
/// elle n'est transmise qu'une fois.
fn first_turn_error(turn: &mut BridgeTurn, message: String) -> Option<String> {
    if turn.last_error.as_deref() == Some(message.as_str()) {
        return None;
    }
    turn.last_error = Some(message.clone());
    Some(message)
}

pub(crate) async fn cancel_repl_turn(app: &AppHandle, conversation_id: &str) -> bool {
    // axe:un-seul-espace - arreter aussi le tour s'il tourne sur la VM.
    let ids: Vec<String> = app.state::<crate::connections::ConnectionsState>().clients.lock().await.keys().cloned().collect();
    let mut stopped = false;
    for id in ids {
        if let Ok(c) = crate::connections::connect_remote(app, &id).await {
            stopped |= c.call("sessions.stop", json!({"sessionId": conversation_id})).await.is_ok();
        }
    }
    if stopped { return true; }
    match connect(app).await {
        Ok(client) => client
            .call("sessions.stop", json!({"sessionId": conversation_id}))
            .await
            .is_ok(),
        Err(_) => false,
    }
}

fn close_open_parts(app: &AppHandle, conversation_id: &str, turn: &mut BridgeTurn) {
    if turn.in_text {
        let _ = emit_agent_event(app, &turn.workspace_id, conversation_id, &AgentEvent::TextFinished);
        turn.in_text = false;
    }
    if turn.in_thinking {
        let _ = emit_agent_event(app, &turn.workspace_id, conversation_id, &AgentEvent::ThinkingFinished);
        turn.in_thinking = false;
    }
}

/// Translates daemon events of bridged sessions into chat `AgentEvent`s.
pub(crate) fn bridge_event(app: &AppHandle, event: &DaemonEvent) {
    let Some(session_id) = event.session_id.as_deref() else { return };
    let mut events: Vec<AgentEvent> = Vec::new();
    let mut finished = false;
    let workspace_id = {
        let bridge = bridge(app);
        let Ok(mut turns) = bridge.turns.lock() else { return };
        // axe:commandes — tour lancé par le service (réveil /heartbeat, /autonomous).
        if !turns.contains_key(session_id) && adopts_turn(event) {
            let known = bridge.known.lock().ok().and_then(|k| k.get(session_id).cloned());
            let workspace = known.or_else(|| {
                app.state::<DesktopState>().store.conversation_workspace_by_id(session_id).ok().flatten()
            });
            if let Some(workspace_id) = workspace {
                turns.insert(session_id.to_string(), BridgeTurn { workspace_id, ..Default::default() });
                events.push(AgentEvent::TurnStarted);
            }
        }
        let Some(turn) = turns.get_mut(session_id) else { return };
        match event.event.as_str() {
            "stream" => {
                let data = event.data.get("event").cloned().unwrap_or_default();
                let kind = data.get("type").and_then(Value::as_str).unwrap_or("");
                let text = |key: &str| data.get(key).and_then(Value::as_str).unwrap_or("").to_string();
                match kind {
                    "text_delta" => {
                        if turn.in_thinking {
                            events.push(AgentEvent::ThinkingFinished);
                            turn.in_thinking = false;
                        }
                        if !turn.in_text {
                            events.push(AgentEvent::TextStarted);
                            turn.in_text = true;
                        }
                        events.push(AgentEvent::TextChunk { delta: text("delta") });
                    }
                    "thinking_delta" => {
                        if !turn.in_thinking {
                            events.push(AgentEvent::ThinkingStarted);
                            turn.in_thinking = true;
                        }
                        events.push(AgentEvent::ThinkingChunk { delta: text("delta") });
                    }
                    "repl_start" => {
                        if turn.in_text {
                            events.push(AgentEvent::TextFinished);
                            turn.in_text = false;
                        }
                        if turn.in_thinking {
                            events.push(AgentEvent::ThinkingFinished);
                            turn.in_thinking = false;
                        }
                        let id = text("callId");
                        let code = text("code");
                        let summary = code.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
                        events.push(AgentEvent::ToolStarted { id: id.clone(), name: "python".into() });
                        events.push(AgentEvent::ToolReady { id, summary, args_pretty: code });
                    }
                    "repl_stream" => events.push(AgentEvent::ToolOutputDelta {
                        id: text("callId"),
                        delta: text("text"),
                    }),
                    "repl_done" => {
                        let output = [text("stdout"), text("stderr")]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n");
                        events.push(AgentEvent::ToolFinished {
                            id: text("callId"),
                            output,
                            is_error: data.get("isError").and_then(Value::as_bool).unwrap_or(false),
                            file_changes: Vec::new(),
                            images: Vec::new(),
                            meta: Some(json!({"repl": data})),
                        });
                        for change in data.get("fileChanges").and_then(Value::as_array).into_iter().flatten() {
                            if let Some(path) = change.get("path").and_then(Value::as_str) {
                                emit_workspace_file_change(app, Path::new(&turn.workspace_id), path);
                            }
                        }
                    }
                    "turn_error" => {
                        if let Some(message) = first_turn_error(turn, text("error")) {
                            events.push(AgentEvent::Error { message });
                        }
                    }
                    // axe:reprise — stream cut, the daemon sends the request
                    // again: the live message starts over.
                    "stream_retry" => {
                        turn.in_text = false;
                        turn.in_thinking = false;
                        events.push(AgentEvent::StreamRetry);
                    }
                    _ => {}
                }
            }
            // axe:parcours-collegue — erreur de tour seulement journalisée (fournisseur absent de
            // l'espace, moteur Python arrêté, worker relancé trop souvent : daemon worker.rs) :
            // avant, le tour se terminait sans rien afficher.
            "entry" => {
                if let Some((message, at_ms)) = heartbeat_from_entry(&event.data) {
                    events.push(AgentEvent::HeartbeatReceived { message, at_ms });
                }
                if let Some(message) = journal_turn_error(&event.data) {
                    if let Some(message) = first_turn_error(turn, message) {
                        events.push(AgentEvent::Error { message });
                    }
                }
            }
            "status" => {
                if event.data.get("status").and_then(Value::as_str) != Some("running") {
                    finished = true;
                }
            }
            _ => {}
        }
        if finished {
            let mut turn = turns.remove(session_id).unwrap_or_default();
            close_open_parts(app, session_id, &mut turn);
            turn.workspace_id
        } else {
            turn.workspace_id.clone()
        }
    };
    for agent_event in &events {
        let _ = emit_agent_event(app, &workspace_id, session_id, agent_event);
    }
    if finished {
        let app = app.clone();
        let session_id = session_id.to_string();
        tauri::async_runtime::spawn(async move { finish_turn(app, workspace_id, session_id).await });
    }
}

/// Mirrors the journal transcript into the legacy store and closes the turn.
async fn finish_turn(app: AppHandle, workspace_id: String, session_id: String) {
    let state = app.state::<DesktopState>();
    if let Ok(client) = connect(&app).await {
        if let Ok(history) = client.call("sessions.history", json!({"sessionId": session_id})).await {
            if let Ok(history) = serde_json::from_value::<Vec<ChatMessage>>(history) {
                if let Ok(Some(mut conversation)) = state.store.load_conversation(&workspace_id, &session_id) {
                    conversation.history = history;
                    let _ = state.store.save_conversation(&conversation);
                }
            }
        }
    }
    let _ = emit_agent_event(&app, &workspace_id, &session_id, &AgentEvent::TurnFinished { duration_ms: None });
    state
        .active_turn_details
        .lock()
        .map(|mut active| active.remove(&session_id))
        .ok();
    emit_active_turns_changed(&app, &state.active_turn_details).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    // axe:v2-l2.4c — analyse pure du chemin d'espace virtuel cloud.
    #[test]
    fn cloud_connection_id_reads_the_virtual_path() {
        assert_eq!(
            cloud_connection_id(Path::new("axe-cloud://axe-cloud/work")).as_deref(),
            Some("axe-cloud")
        );
        assert_eq!(
            cloud_connection_id(Path::new("axe-cloud://conn-abcd/srv/projet")).as_deref(),
            Some("conn-abcd")
        );
        // Racine absente ou vide : on ne garde que la connexion connue.
        assert_eq!(
            cloud_connection_id(Path::new("axe-cloud://conn-abcd")).as_deref(),
            Some("conn-abcd")
        );
        assert_eq!(
            cloud_connection_id(Path::new("axe-cloud://conn-abcd/")).as_deref(),
            Some("conn-abcd")
        );
        // Connexion vide : pas un espace cloud exploitable.
        assert_eq!(cloud_connection_id(Path::new("axe-cloud://")), None);
        assert_eq!(cloud_connection_id(Path::new("axe-cloud:///work")), None);
        // Chemins locaux ignorés.
        assert_eq!(cloud_connection_id(Path::new("/home/user/projet")), None);
        assert_eq!(cloud_connection_id(Path::new("C:\\projets\\axe")), None);
    }
}

#[cfg(test)]
mod bridge_turn_error_tests {
    use super::*;

    // Entrée diffusée par un vrai démon dont l'espace n'a pas le fournisseur axe-cloud
    // (22/10, scripts/faux-compteur/essai-demon.mjs) : aucun événement de flux, seulement
    // `entry` (worker_restart x3 puis turn_error), puis `status: idle`.
    fn entree(error: &str) -> Value {
        json!({"id": "a8950def", "parent": "bcf21100", "ts": 1792666695889u64,
               "kind": "extension", "name": "turn_error", "payload": {"error": error}})
    }

    #[test]
    fn reveil_heartbeat_reconnu_dans_le_journal() {
        let entry = json!({"kind": "message", "ts": 5, "message": {"role": "user", "parts": [
            {"type": "text", "text": axecode_app::session_commands::heartbeat_text("coucou", 42)}]}});
        assert_eq!(heartbeat_from_entry(&entry), Some(("coucou".to_string(), 42)));
        let nu = json!({"kind": "message", "ts": 5, "message": {"role": "user", "parts": [
            {"type": "text", "text": "<heartbeat>\ncoucou\n</heartbeat>"}]}});
        assert_eq!(heartbeat_from_entry(&nu), Some(("coucou".to_string(), 5)));
        let normal = json!({"kind": "message", "message": {"role": "user", "parts": [{"type": "text", "text": "bonjour"}]}});
        assert_eq!(heartbeat_from_entry(&normal), None);
        let assistant = json!({"kind": "message", "message": {"role": "assistant", "parts": [{"type": "text", "text": "<heartbeat>\nx\n</heartbeat>"}]}});
        assert_eq!(heartbeat_from_entry(&assistant), None);
    }

    #[test]
    fn erreur_seulement_journalisee_est_transmise() {
        assert_eq!(
            journal_turn_error(&entree("runtime error: provider `axe-cloud` is not declared")).as_deref(),
            Some("runtime error: provider `axe-cloud` is not declared")
        );
        let relance = json!({"kind": "extension", "name": "worker_restart", "payload": {"attempt": 1}});
        assert_eq!(journal_turn_error(&relance), None);
        let message = json!({"kind": "message", "message": {"role": "user", "parts": []}});
        assert_eq!(journal_turn_error(&message), None);
        assert_eq!(journal_turn_error(&entree("  ")), None);
    }

    #[test]
    fn meme_erreur_journal_puis_flux_une_seule_fois() {
        // 401 du compteur : le démon envoie l'entrée de journal PUIS l'événement de flux.
        let mut turn = BridgeTurn::default();
        let m = "auth error: Anthropic rejected the API key (authentication_error: Clé Axe invalide ou révoquée.). Check the key in Settings > Providers.".to_string();
        assert_eq!(first_turn_error(&mut turn, m.clone()), Some(m.clone()));
        assert_eq!(first_turn_error(&mut turn, m.clone()), None);
        assert_eq!(first_turn_error(&mut turn, "autre".into()).as_deref(), Some("autre"));
    }
}

#[cfg(test)]
mod conversation_to_send_tests {
    use super::*;

    fn model() -> ModelRef {
        ModelRef::new("google", "gemini-3.8-flash")
    }

    // axe:parcours-collegue — « + » dans l'espace d'un collègue : session créée sur la VM,
    // aucune ligne dans le magasin du PC. Avant : « conversation not found ».
    #[test]
    fn espace_cloud_conversation_absente_du_pc_est_envoyee() {
        let ws = "axe-cloud://axe-cloud/home/collegue/work";
        let (conversation, adopted) = conversation_to_send(None, true, ws, "8b198dda", &model())
            .expect("une conversation d'espace doit pouvoir recevoir un message");
        assert!(adopted);
        assert_eq!(conversation.id, "8b198dda");
        assert_eq!(conversation.workspace_id, ws);
        assert!(conversation.history.is_empty());
    }

    #[test]
    fn conversation_du_pc_inchangee() {
        let stored = conversation_to_send(None, true, "axe-cloud://c/work", "a", &model()).unwrap().0;
        let mut local = stored.clone();
        local.title = "Locale".into();
        let (conversation, adopted) =
            conversation_to_send(Some(local), false, "C:/projets/x", "a", &model()).unwrap();
        assert!(!adopted);
        assert_eq!(conversation.title, "Locale");
    }

    #[test]
    fn hors_espace_cloud_toujours_introuvable() {
        let err = conversation_to_send(None, false, "C:/projets/x", "zz", &model()).unwrap_err();
        assert_eq!(err, "conversation introuvable");
    }
}

#[cfg(test)]
mod cloud_subdir_tests {
    use super::cloud_subdir_parts;
    use std::path::Path;

    #[test]
    fn subdir_follows_virtual_path() {
        assert_eq!(cloud_subdir_parts(Path::new("axe-cloud://axe-cloud/work")), Some(vec![]));
        assert_eq!(
            cloud_subdir_parts(Path::new("axe-cloud://axe-cloud/work/portail/src")),
            Some(vec!["portail".to_string(), "src".to_string()])
        );
        assert_eq!(cloud_subdir_parts(Path::new("axe-cloud://axe-cloud/work/../etc")), None);
        assert_eq!(cloud_subdir_parts(Path::new("/home/x")), None);
    }
}
