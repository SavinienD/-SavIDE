// axe:providers — configurable provider instances (OpenAI/Anthropic-compatible,
// Mistral, DeepSeek, xAI, Groq, Prime Inference, Ollama, LM Studio).
//
// Settings live in `<data>/providers.json`; API keys in a separate
// `<data>/provider-keys.json` so they never reach the frontend. Every
// OpenAI-compatible kind is served by the shared chat-completions adapter in
// `axecode-openrouter` (see `Dialect`); Anthropic-compatible instances reuse
// `axecode-anthropic` with an API-key credential.

use crate::*;

use directories::ProjectDirs;
use axecode_anthropic::AnthropicConfig;
use axecode_core::{ModelDefinition, ProviderConfig, ProviderKind, ProviderSettings};
use axecode_openrouter::{Dialect, OpenRouterConfig};

type Registry = Arc<StdMutex<HashMap<String, Arc<dyn Provider>>>>;

const SETTINGS_FILE: &str = "providers.json";
const KEYS_FILE: &str = "provider-keys.json";
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);
const REMOTE_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

fn data_dir() -> std::result::Result<PathBuf, String> {
    ProjectDirs::from("fr", "savide", "savide")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .ok_or_else(|| "dossier de données local introuvable".to_string())
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> std::result::Result<T, String> {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(T::default()),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|err| format!("invalid {}: {err}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(err) => Err(format!("impossible de lire {} : {err}", path.display())),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> std::result::Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|err| format!("impossible d'écrire {} : {err}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|err| format!("impossible d'écrire {} : {err}", path.display()))
}

pub(crate) fn load_provider_settings() -> std::result::Result<ProviderSettings, String> {
    let settings: ProviderSettings = read_json(&data_dir()?.join(SETTINGS_FILE))?;
    Ok(settings.normalized())
}

fn save_provider_settings(settings: &ProviderSettings) -> std::result::Result<(), String> {
    write_json(&data_dir()?.join(SETTINGS_FILE), settings)
}

/// Latest modification time of the files providers are built from. The
/// background service rebuilds its providers when it changes, so a key, URL
/// or login changed in Settings is used without restarting the service.
pub(crate) fn settings_stamp() -> Option<std::time::SystemTime> {
    let dir = data_dir().ok()?;
    [
        SETTINGS_FILE,
        KEYS_FILE,
        "anthropic-auth.json",
        "openai-auth.json",
        "google-auth.json",
        "kimi-auth.json",
        "openrouter-auth.json",
    ]
    .iter()
    .filter_map(|name| fs::metadata(dir.join(name)).and_then(|meta| meta.modified()).ok())
    .max()
}

fn load_keys() -> std::result::Result<HashMap<String, String>, String> {
    read_json(&data_dir()?.join(KEYS_FILE))
}

/// axe:voix — URL de base et clé d'une instance activée qui pointe sur l'API
/// OpenAI (api.openai.com) : repli de la dictée (gpt-4o-transcribe / whisper-1).
pub(crate) fn openai_api_credentials() -> Option<(String, String)> {
    let settings = load_provider_settings().ok()?;
    let keys = load_keys().ok()?;
    settings
        .providers
        .iter()
        .filter(|config| config.enabled && config.base_url.contains("api.openai.com"))
        .find_map(|config| {
            keys.get(&config.id)
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty())
                .map(|key| (openai_base_url(config), key))
        })
}

fn save_keys(keys: &HashMap<String, String>) -> std::result::Result<(), String> {
    write_json(&data_dir()?.join(KEYS_FILE), keys)
}

/// Assign stable ids before normalisation: built-in kinds use their fixed id,
/// custom instances get `custom-<slug>-<n>` when the frontend sent none.
fn assign_ids(settings: &mut ProviderSettings) {
    let mut taken: HashSet<String> = settings
        .providers
        .iter()
        .map(|provider| provider.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    for provider in &mut settings.providers {
        if let Some(id) = provider.kind.builtin_id() {
            provider.id = id.to_string();
            continue;
        }
        if !provider.id.trim().is_empty() {
            continue;
        }
        let slug: String = provider
            .name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let base = if slug.is_empty() { "custom".to_string() } else { format!("custom-{slug}") };
        let mut candidate = base.clone();
        let mut n = 2;
        while taken.contains(&candidate) || is_native_provider_id(&candidate) {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        taken.insert(candidate.clone());
        provider.id = candidate;
    }
}

pub(crate) fn is_native_provider_id(id: &str) -> bool {
    matches!(id, "anthropic" | "openai" | "google" | "kimi" | "gemini-web") || id == OPENROUTER_PROVIDER_ID
}

fn dialect_for(kind: ProviderKind) -> Dialect {
    match kind {
        // xAI grok-4 rejects `reasoning_effort`; it reasons natively.
        ProviderKind::OpenAiCompatible | ProviderKind::Groq | ProviderKind::Prime => Dialect::OpenAi,
        _ => Dialect::Plain,
    }
}

/// Maintained default catalog for native adapters, used to prefill a newly
/// added provider (the user can still run discovery or edit capabilities).
/// DeepSeek streams `reasoning_content`, parsed by the shared adapter.
pub(crate) fn default_catalog(kind: ProviderKind) -> Vec<ModelDefinition> {
    // (id, label, context, max output, reasoning, vision)
    let rows: &[(&str, &str, u32, u32, bool, bool)] = match kind {
        ProviderKind::Mistral => &[
            ("mistral-large-latest", "Mistral Large", 128_000, 32_000, false, true),
            ("mistral-medium-latest", "Mistral Medium", 128_000, 32_000, false, true),
            ("devstral-medium-latest", "Devstral Medium", 128_000, 32_000, false, false),
            ("codestral-latest", "Codestral", 256_000, 32_000, false, false),
            ("magistral-medium-latest", "Magistral Medium", 128_000, 32_000, true, false),
        ],
        ProviderKind::DeepSeek => &[
            ("deepseek-chat", "DeepSeek Chat", 128_000, 8_192, false, false),
            ("deepseek-reasoner", "DeepSeek Reasoner", 128_000, 64_000, true, false),
        ],
        ProviderKind::Xai => &[
            ("grok-4", "Grok 4", 256_000, 32_000, true, true),
            ("grok-code-fast-1", "Grok Code Fast", 256_000, 32_000, true, false),
            ("grok-3-mini", "Grok 3 Mini", 131_072, 16_384, true, false),
        ],
        ProviderKind::Groq => &[
            ("openai/gpt-oss-120b", "GPT-OSS 120B", 131_072, 32_768, true, false),
            ("moonshotai/kimi-k2-instruct", "Kimi K2", 131_072, 16_384, false, false),
            ("qwen/qwen3-32b", "Qwen3 32B", 131_072, 40_960, true, false),
            ("llama-3.3-70b-versatile", "Llama 3.3 70B", 131_072, 32_768, false, false),
        ],
        _ => &[],
    };
    rows.iter()
        .map(|(id, label, window, output, reasoning, vision)| ModelDefinition {
            id: (*id).to_string(),
            label: (*label).to_string(),
            context_window: *window,
            max_output_tokens: *output,
            supports_tools: true,
            supports_reasoning: *reasoning,
            supports_vision: *vision,
        })
        .collect()
}

/// Base URL of the OpenAI-compatible `/chat/completions` + `/models` routes.
fn openai_base_url(config: &ProviderConfig) -> String {
    let base = config.base_url.trim_end_matches('/');
    if config.kind == ProviderKind::Ollama && !base.ends_with("/v1") {
        format!("{base}/v1")
    } else {
        base.to_string()
    }
}

fn capabilities_for(config: &ProviderConfig, settings: &ProviderSettings) -> Vec<ModelCapabilities> {
    config
        .models
        .iter()
        .map(|model| {
            let mut caps = model.capabilities(&config.id);
            // axe:compaction — real window of a known Claude model.
            if config.kind.uses_anthropic_wire() {
                axecode_anthropic::apply_known_window(&mut caps);
            }
            if let Some(overrides) = settings.override_for(&caps.model) {
                overrides.apply(&mut caps);
            }
            caps
        })
        .collect()
}

fn build_provider(
    config: &ProviderConfig,
    settings: &ProviderSettings,
    api_key: Option<&str>,
) -> std::result::Result<Option<Arc<dyn Provider>>, String> {
    if !config.enabled || config.models.is_empty() || config.base_url.is_empty() {
        return Ok(None);
    }
    let key = api_key.unwrap_or("").trim().to_string();
    if key.is_empty() && config.kind.requires_api_key() {
        return Ok(None);
    }
    let caps = capabilities_for(config, settings);
    let provider: Arc<dyn Provider> = if config.kind.uses_anthropic_wire() {
        let anthropic = AnthropicConfig::compatible(&config.id, &config.base_url, key, caps);
        Arc::new(AnthropicProvider::new(anthropic).map_err(error_to_string)?)
    } else {
        let openai = OpenRouterConfig::compatible(
            &config.id,
            openai_base_url(config),
            key,
            caps,
            dialect_for(config.kind),
        );
        Arc::new(OpenRouterProvider::new(openai).map_err(error_to_string)?)
    };
    Ok(Some(provider))
}

/// Rebuild every configurable provider in the registry from settings + keys.
/// Native providers (OAuth + OpenRouter) are never touched.
pub(crate) fn install_custom_providers(registry: &Registry) -> std::result::Result<Vec<String>, String> {
    let settings = load_provider_settings()?;
    let keys = load_keys()?;
    let mut built = Vec::new();
    for config in &settings.providers {
        if is_native_provider_id(&config.id) {
            continue;
        }
        match build_provider(config, &settings, keys.get(&config.id).map(String::as_str)) {
            Ok(Some(provider)) => built.push((config.id.clone(), provider)),
            Ok(None) => {}
            Err(err) => tracing::warn!(provider = %config.id, error = %err, "unable to build provider"),
        }
    }
    let mut guard = registry
        .lock()
        .map_err(|_| "registre des fournisseurs indisponible".to_string())?;
    guard.retain(|id, _| is_native_provider_id(id));
    let ids = built.iter().map(|(id, _)| id.clone()).collect();
    for (id, provider) in built {
        guard.insert(id, provider);
    }
    Ok(ids)
}

fn guess_definition(id: &str, context_window: Option<u32>, kind: ProviderKind) -> ModelDefinition {
    let lower = id.to_ascii_lowercase();
    let mut def = ModelDefinition::new(id);
    if let Some(window) = context_window {
        def.context_window = window;
    } else if kind == ProviderKind::DeepSeek {
        def.context_window = 128_000;
    } else if kind.is_local() {
        def.context_window = 32_768;
    }
    def.max_output_tokens = def.max_output_tokens.min(def.context_window);
    def.supports_reasoning = ["reason", "r1", "think", "qwq", "o1", "o3", "o4", "magistral", "grok-4", "-mini"]
        .iter()
        .any(|needle| lower.contains(needle))
        || lower == "deepseek-reasoner";
    def.supports_vision = ["vision", "-vl", "vl-", "llava", "gpt-4o", "gpt-4.1", "gpt-5", "pixtral", "gemma3", "grok-4", "llama-4"]
        .iter()
        .any(|needle| lower.contains(needle));
    def.supports_tools = !lower.contains("embed") && !lower.contains("whisper") && !lower.contains("tts");
    def
}

async fn discover(
    kind: ProviderKind,
    base_url: &str,
    api_key: &str,
) -> std::result::Result<Vec<ModelDefinition>, String> {
    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { kind.default_base_url() } else { base };
    if kind.uses_anthropic_wire() {
        return axecode_anthropic::discover_models(base, api_key)
            .await
            .map_err(error_to_string);
    }
    let timeout = if kind.is_local() { LOCAL_PROBE_TIMEOUT } else { REMOTE_PROBE_TIMEOUT };
    let (url, route) = match kind {
        ProviderKind::Ollama => (base.trim_end_matches("/v1").to_string(), Some("/api/tags")),
        _ => (base.to_string(), None),
    };
    let models = axecode_openrouter::discover_compatible_models(&url, api_key, route, timeout)
        .await
        .map_err(error_to_string)?;
    let mut defs: Vec<ModelDefinition> = models
        .into_iter()
        .map(|model| guess_definition(&model.id, model.context_window, kind))
        .filter(|def| def.supports_tools || kind.is_local())
        .collect();
    defs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(defs)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderKindInfo {
    kind: ProviderKind,
    label: &'static str,
    builtin_id: Option<&'static str>,
    default_base_url: &'static str,
    requires_api_key: bool,
    local: bool,
    default_models: Vec<ModelDefinition>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderInstanceView {
    #[serde(flatten)]
    config: ProviderConfig,
    has_api_key: bool,
    installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderSettingsView {
    providers: Vec<ProviderInstanceView>,
    model_overrides: HashMap<String, axecode_core::ModelOverride>,
    kinds: Vec<ProviderKindInfo>,
}

fn settings_view(state: &DesktopState) -> std::result::Result<ProviderSettingsView, String> {
    let settings = load_provider_settings()?;
    let keys = load_keys()?;
    let installed: HashSet<String> = state
        .providers
        .lock()
        .map_err(|_| "registre des fournisseurs indisponible".to_string())?
        .keys()
        .cloned()
        .collect();
    Ok(ProviderSettingsView {
        providers: settings
            .providers
            .into_iter()
            .map(|config| ProviderInstanceView {
                has_api_key: keys.get(&config.id).is_some_and(|key| !key.trim().is_empty()),
                installed: installed.contains(&config.id),
                config,
            })
            .collect(),
        model_overrides: settings.model_overrides,
        kinds: ProviderKind::ALL
            .iter()
            .map(|kind| ProviderKindInfo {
                kind: *kind,
                label: kind.label(),
                builtin_id: kind.builtin_id(),
                default_base_url: kind.default_base_url(),
                requires_api_key: kind.requires_api_key(),
                local: kind.is_local(),
                default_models: default_catalog(*kind),
            })
            .collect(),
    })
}

fn emit_providers_changed(app: &AppHandle) {
    let _ = app.emit("axe://providers-changed", ());
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveProviderSettingsInput {
    settings: ProviderSettings,
    /// Per-provider key updates: absent = keep, empty string = delete.
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

#[tauri::command]
pub(crate) fn provider_settings_get(
    state: State<'_, DesktopState>,
) -> std::result::Result<ProviderSettingsView, String> {
    settings_view(&state)
}

#[tauri::command]
pub(crate) fn provider_settings_save(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: SaveProviderSettingsInput,
) -> std::result::Result<ProviderSettingsView, String> {
    let mut settings = input.settings;
    assign_ids(&mut settings);
    let settings = settings.normalized();
    if let Some(bad) = settings.providers.iter().find(|p| is_native_provider_id(&p.id)) {
        return Err(format!("identifiant de fournisseur `{}` réservé", bad.id));
    }
    let mut keys = load_keys()?;
    for (id, key) in input.api_keys {
        let key = key.trim().to_string();
        if key.is_empty() {
            keys.remove(&id);
        } else {
            keys.insert(id, key);
        }
    }
    let live: HashSet<&str> = settings.providers.iter().map(|p| p.id.as_str()).collect();
    keys.retain(|id, _| live.contains(id.as_str()));
    save_provider_settings(&settings)?;
    save_keys(&keys)?;
    refresh_overrides(&settings);
    install_custom_providers(&state.providers)?;
    emit_providers_changed(&app);
    settings_view(&state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoverModelsInput {
    kind: ProviderKind,
    #[serde(default)]
    base_url: String,
    /// Key typed in the form; falls back to the stored key of `provider_id`.
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    provider_id: Option<String>,
}

#[tauri::command]
pub(crate) async fn provider_discover_models(
    input: DiscoverModelsInput,
) -> std::result::Result<Vec<ModelDefinition>, String> {
    let key = match input.api_key.filter(|key| !key.trim().is_empty()) {
        Some(key) => key,
        None => match input.provider_id {
            Some(id) => load_keys()?.remove(&id).unwrap_or_default(),
            None => String::new(),
        },
    };
    discover(input.kind, &input.base_url, &key).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalServerProbe {
    kind: ProviderKind,
    base_url: String,
    available: bool,
    models: Vec<ModelDefinition>,
    /// True when the probe found new models and merged them into settings.
    pub(crate) updated: bool,
}

/// Probe Ollama and LM Studio. Reachable servers are added (or their model
/// list refreshed) in settings; unreachable ones are left untouched.
pub(crate) async fn detect_local_servers(
    registry: &Registry,
) -> std::result::Result<Vec<LocalServerProbe>, String> {
    let mut settings = load_provider_settings()?;
    let mut probes = Vec::new();
    let mut changed = false;
    for kind in [ProviderKind::Ollama, ProviderKind::LmStudio] {
        let id = kind.builtin_id().unwrap_or_default();
        let existing = settings.provider(id).cloned();
        let base_url = existing
            .as_ref()
            .map(|config| config.base_url.clone())
            .unwrap_or_else(|| kind.default_base_url().to_string());
        let found = discover(kind, &base_url, "").await;
        let mut probe = LocalServerProbe {
            kind,
            base_url: base_url.clone(),
            available: found.is_ok(),
            models: Vec::new(),
            updated: false,
        };
        if let Ok(models) = found {
            let merged = match existing {
                Some(mut config) => {
                    // Keep user-edited capabilities for models that still exist.
                    let mut next = Vec::new();
                    for model in &models {
                        next.push(config.model(&model.id).cloned().unwrap_or_else(|| model.clone()));
                    }
                    let differs = next.iter().map(|m| &m.id).ne(config.models.iter().map(|m| &m.id));
                    config.models = next;
                    (config, differs)
                }
                None if !models.is_empty() => (
                    ProviderConfig {
                        id: id.to_string(),
                        name: kind.label().to_string(),
                        kind,
                        base_url,
                        enabled: true,
                        models: models.clone(),
                    },
                    true,
                ),
                None => {
                    probes.push(probe);
                    continue;
                }
            };
            if merged.1 {
                settings.providers.retain(|config| config.id != id);
                settings.providers.push(merged.0);
                changed = true;
                probe.updated = true;
            }
            probe.models = models;
        }
        probes.push(probe);
    }
    if changed {
        save_provider_settings(&settings.normalized())?;
    }
    install_custom_providers(registry)?;
    Ok(probes)
}

#[tauri::command]
pub(crate) async fn provider_detect_local(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> std::result::Result<Vec<LocalServerProbe>, String> {
    let probes = detect_local_servers(&state.providers).await?;
    if probes.iter().any(|probe| probe.updated) {
        emit_providers_changed(&app);
    }
    Ok(probes)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetModelOverrideInput {
    provider: String,
    model: String,
    #[serde(default)]
    context_window: Option<u32>,
    #[serde(default)]
    max_output_tokens: Option<u32>,
}

#[tauri::command]
pub(crate) fn provider_set_model_override(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: SetModelOverrideInput,
) -> std::result::Result<ProviderSettingsView, String> {
    let mut settings = load_provider_settings()?;
    let key = axecode_core::model_override_key(&ModelRef::new(input.provider, input.model));
    let value = axecode_core::ModelOverride {
        context_window: input.context_window.filter(|v| *v > 0),
        max_output_tokens: input.max_output_tokens.filter(|v| *v > 0),
    };
    if value.is_empty() {
        settings.model_overrides.remove(&key);
    } else {
        settings.model_overrides.insert(key, value);
    }
    save_provider_settings(&settings)?;
    refresh_overrides(&settings);
    install_custom_providers(&state.providers)?;
    emit_providers_changed(&app);
    settings_view(&state)
}

// ---------------------------------------------------------------------------
// modelOverrides.<provider:model>.contextWindow for every provider (native too)

static OVERRIDES: std::sync::OnceLock<std::sync::RwLock<HashMap<String, axecode_core::ModelOverride>>> =
    std::sync::OnceLock::new();

fn overrides_cell() -> &'static std::sync::RwLock<HashMap<String, axecode_core::ModelOverride>> {
    OVERRIDES.get_or_init(|| {
        std::sync::RwLock::new(
            load_provider_settings()
                .map(|settings| settings.model_overrides)
                .unwrap_or_default(),
        )
    })
}

fn refresh_overrides(settings: &ProviderSettings) {
    if let Ok(mut guard) = overrides_cell().write() {
        *guard = settings.model_overrides.clone();
    }
}

/// Decorates a provider so its advertised capabilities honour user overrides.
struct OverriddenProvider(Arc<dyn Provider>);

#[async_trait::async_trait]
impl Provider for OverriddenProvider {
    fn name(&self) -> &str {
        self.0.name()
    }

    fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities> {
        let mut caps = self.0.capabilities(model)?;
        if let Ok(guard) = overrides_cell().read() {
            if let Some(value) = guard.get(&axecode_core::model_override_key(model)) {
                value.apply(&mut caps);
            }
        }
        Some(caps)
    }

    async fn estimate_tokens(
        &self,
        request: ProviderRequest,
    ) -> axecode_core::Result<axecode_core::TokenEstimate> {
        self.0.estimate_tokens(request).await
    }

    async fn stream(&self, request: ProviderRequest) -> axecode_core::Result<axecode_core::ProviderStream> {
        self.0.stream(request).await
    }
}

/// Wrap a registry entry with the override decorator (cheap: one Arc).
pub(crate) fn with_overrides(provider: Arc<dyn Provider>) -> Arc<dyn Provider> {
    let empty = overrides_cell().read().map(|guard| guard.is_empty()).unwrap_or(true);
    if empty {
        provider
    } else {
        Arc::new(OverriddenProvider(provider))
    }
}

#[cfg(test)]
mod compaction_window_tests {
    use super::*;
    use axecode_core::{model_override_key, ModelOverride, ModelRef};

    fn meter_settings() -> ProviderSettings {
        // Same shape as the SavIDE's providers.json (models declared at 200 000).
        serde_json::from_value(serde_json::json!({"providers": [{
            "id": "axe-cloud", "name": "Axe Cloud", "kind": "anthropic_compatible",
            "baseUrl": "https://agent.example/v1", "enabled": true,
            "models": [{"id": "claude-opus-5-5", "contextWindow": 200000, "maxOutputTokens": 32000},
                       {"id": "claude-sonnet-5-5", "contextWindow": 200000, "maxOutputTokens": 32000},
                       {"id": "house-model", "contextWindow": 64000}]}]}))
        .expect("settings")
    }

    #[test]
    fn known_claude_models_on_the_meter_keep_their_real_window() {
        let settings = meter_settings();
        let caps = capabilities_for(&settings.providers[0], &settings);
        let windows: Vec<u32> = caps.iter().map(|c| c.context_window).collect();
        assert_eq!(windows, vec![1_000_000, 1_000_000, 64_000]);
        assert_eq!(caps[0].max_output_tokens, 32_000);
    }

    #[test]
    fn a_user_override_still_wins() {
        let mut settings = meter_settings();
        let key = model_override_key(&ModelRef::new("axe-cloud", "claude-sonnet-5-5"));
        settings.model_overrides.insert(
            key,
            ModelOverride { context_window: Some(300_000), max_output_tokens: None },
        );
        let caps = capabilities_for(&settings.providers[0], &settings);
        assert_eq!(caps[1].context_window, 300_000);
    }
}
