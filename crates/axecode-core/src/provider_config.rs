// providers — user-configurable provider instances and model catalogs.
//
// These types are shared between the desktop app (persistence + IPC), the
// provider crates (which build a `Provider` from a `ProviderConfig`) and the
// frontend (serialized as camelCase JSON).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{EffortMode, ModelCapabilities, ModelRef};

/// Wire family / vendor of a configurable provider instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// Any endpoint speaking the OpenAI `/chat/completions` protocol.
    OpenAiCompatible,
    /// Any endpoint speaking the Anthropic `/v1/messages` protocol.
    AnthropicCompatible,
    Mistral,
    DeepSeek,
    Xai,
    Groq,
    /// Prime Intellect inference (OpenAI-compatible).
    Prime,
    /// Local Ollama server (auto-detected).
    Ollama,
    /// Local LM Studio server (auto-detected).
    LmStudio,
}

impl ProviderKind {
    pub const ALL: &'static [ProviderKind] = &[
        ProviderKind::OpenAiCompatible,
        ProviderKind::AnthropicCompatible,
        ProviderKind::Mistral,
        ProviderKind::DeepSeek,
        ProviderKind::Xai,
        ProviderKind::Groq,
        ProviderKind::Prime,
        ProviderKind::Ollama,
        ProviderKind::LmStudio,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "OpenAI-compatible",
            Self::AnthropicCompatible => "Anthropic-compatible",
            Self::Mistral => "Mistral",
            Self::DeepSeek => "DeepSeek",
            Self::Xai => "xAI",
            Self::Groq => "Groq",
            Self::Prime => "Prime Inference",
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
        }
    }

    /// Native adapters and local servers are single-instance; their provider
    /// id is fixed so model refs stay stable across reconfiguration.
    pub fn builtin_id(self) -> Option<&'static str> {
        match self {
            Self::OpenAiCompatible | Self::AnthropicCompatible => None,
            Self::Mistral => Some("mistral"),
            Self::DeepSeek => Some("deepseek"),
            Self::Xai => Some("xai"),
            Self::Groq => Some("groq"),
            Self::Prime => Some("prime"),
            Self::Ollama => Some("ollama"),
            Self::LmStudio => Some("lmstudio"),
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "",
            Self::AnthropicCompatible => "https://api.anthropic.com",
            Self::Mistral => "https://api.mistral.ai/v1",
            Self::DeepSeek => "https://api.deepseek.com",
            Self::Xai => "https://api.x.ai/v1",
            Self::Groq => "https://api.groq.com/openai/v1",
            Self::Prime => "https://api.pinference.ai/api/v1",
            Self::Ollama => "http://localhost:11434",
            Self::LmStudio => "http://localhost:1234/v1",
        }
    }

    pub fn is_local(self) -> bool {
        matches!(self, Self::Ollama | Self::LmStudio)
    }

    pub fn requires_api_key(self) -> bool {
        !self.is_local() && !matches!(self, Self::OpenAiCompatible | Self::AnthropicCompatible)
    }

    pub fn uses_anthropic_wire(self) -> bool {
        matches!(self, Self::AnthropicCompatible)
    }

    /// fenetre-locale — serveur de modèles sur ce PC : Ollama, LM Studio, ou un point d'accès
    /// compatible OpenAI sur localhost / 127.0.0.1 (llama.cpp, vLLM…). Un point d'accès compatible
    /// Anthropic sur localhost est un relais vers des modèles du cloud (compteur des espaces,
    /// 127.0.0.1:8096) : il reste « cloud ».
    pub fn is_local_endpoint(self, base_url: &str) -> bool {
        self.is_local() || (!self.uses_anthropic_wire() && is_local_url(base_url))
    }
}

/// Fenêtre par défaut d'un modèle du cloud qui n'annonce pas la sienne.
pub const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;

/// Marque écrite à côté de `providers.json` quand [`migrate_local_windows_once`] est passée.
pub const LOCAL_WINDOW_MARK: &str = "providers-fenetre-locale.ok";

/// fenetre-locale — fenêtre par défaut d'un modèle local : Ollama réserve la RAM de toute la
/// fenêtre (`num_ctx`) ; à 128 000 jetons, qwen3:4b prenait 22 Go.
pub const LOCAL_CONTEXT_WINDOW: u32 = 32_768;

/// Adresse de ce PC (localhost, 127.x.x.x, [::1], 0.0.0.0), avec ou sans schéma, port, identifiants.
pub fn is_local_url(url: &str) -> bool {
    let url = url.trim();
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host).to_ascii_lowercase();
    let name = if host.starts_with('[') {
        host.split_once(']').map(|(h, _)| format!("{h}]")).unwrap_or(host.clone())
    } else {
        host.split(':').next().unwrap_or("").to_string()
    };
    name == "localhost" || name.starts_with("127.") || name == "[::1]" || name == "0.0.0.0"
}

/// fenetre-locale — fenêtre donnée à un modèle ajouté : locale = 32 768, ou moins si le
/// serveur annonce moins (Ollama `/api/show`) ; cloud = la valeur annoncée, sinon 128 000.
pub fn default_context_window_for(local: bool, announced: Option<u32>) -> u32 {
    let announced = announced.filter(|value| *value > 0);
    if local {
        announced.map_or(LOCAL_CONTEXT_WINDOW, |value| value.min(LOCAL_CONTEXT_WINDOW))
    } else {
        announced.unwrap_or(DEFAULT_CONTEXT_WINDOW)
    }
}

/// Sortie maximale par défaut : 16 384, et jamais plus de la moitié de la fenêtre (le reste
/// pour l'invite ; sinon la compaction automatique se déclenche à chaque tour).
pub fn default_max_output_for(context_window: u32) -> u32 {
    default_max_output_tokens().min((context_window / 2).max(1))
}

/// fenetre-locale (0.1.78) — « Saisir » donnait 128 000 à tout modèle ajouté, et Ollama
/// réservait alors la RAM de 128 000 jetons. À faire une seule fois (l'appelant garde une marque) :
/// un modèle d'un fournisseur local resté à cette ancienne valeur par défaut (ou sans fenêtre, ce
/// qui revenait au même) passe à 32 768 ; une autre valeur, choisie à la main, ne bouge pas. Agit
/// sur le JSON brut de `providers.json` : les autres sections (dont `fournisseurs`) restent
/// intactes. Rend le nombre de modèles changés.
pub fn lower_legacy_local_windows(root: &mut Value) -> usize {
    let Some(providers) = root.get_mut("providers").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut changed = 0;
    for provider in providers {
        let Some(kind) = provider
            .get("kind")
            .and_then(|kind| serde_json::from_value::<ProviderKind>(kind.clone()).ok())
        else {
            continue;
        };
        let base_url = provider.get("baseUrl").and_then(Value::as_str).unwrap_or("");
        let base_url = if base_url.trim().is_empty() { kind.default_base_url() } else { base_url };
        if !kind.is_local_endpoint(base_url) {
            continue;
        }
        let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) else {
            continue;
        };
        for model in models.iter_mut().filter_map(Value::as_object_mut) {
            let legacy = match model.get("contextWindow") {
                None | Some(Value::Null) => true,
                Some(value) => value.as_u64() == Some(u64::from(DEFAULT_CONTEXT_WINDOW)),
            };
            if !legacy {
                continue;
            }
            model.insert("contextWindow".into(), Value::from(LOCAL_CONTEXT_WINDOW));
            let limit = u64::from(default_max_output_for(LOCAL_CONTEXT_WINDOW));
            if model.get("maxOutputTokens").and_then(Value::as_u64).is_some_and(|out| out > limit) {
                model.insert("maxOutputTokens".into(), Value::from(limit));
            }
            changed += 1;
        }
    }
    changed
}

/// fenetre-locale (0.1.78) — [`lower_legacy_local_windows`] appliqué UNE fois au
/// `providers.json` du dossier `dir` (marque [`LOCAL_WINDOW_MARK`]) ; copie de l'ancien fichier
/// dans `providers.json.avant-0178` quand il change. Fichier absent : seule la marque est
/// écrite. Fichier illisible : erreur, pas de marque (nouvel essai au prochain chargement).
/// Rend le nombre de modèles passés à 32 768.
pub fn migrate_local_windows_once(dir: &Path) -> std::io::Result<usize> {
    let mark = dir.join(LOCAL_WINDOW_MARK);
    if mark.exists() {
        return Ok(0);
    }
    let path = dir.join(crate::declared_providers::PROVIDERS_FILE);
    let mut changed = 0;
    match std::fs::read(&path) {
        Ok(bytes) if !bytes.iter().all(u8::is_ascii_whitespace) => {
            let mut root: Value = serde_json::from_slice(&bytes)
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
            changed = lower_legacy_local_windows(&mut root);
            if changed > 0 {
                std::fs::write(dir.join("providers.json.avant-0178"), &bytes)?;
                let text = serde_json::to_vec_pretty(&root)
                    .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
                let tmp = path.with_extension("json.tmp");
                std::fs::write(&tmp, text)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
                }
                std::fs::rename(&tmp, &path)?;
            }
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(&mark, b"0.1.78\n")?;
    Ok(changed)
}

fn default_true() -> bool {
    true
}

fn default_context_window() -> u32 {
    DEFAULT_CONTEXT_WINDOW
}

fn default_max_output_tokens() -> u32 {
    16_384
}

/// A model exposed by a configurable provider, with declared capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDefinition {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_context_window")]
    pub context_window: u32,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32,
    #[serde(default = "default_true")]
    pub supports_tools: bool,
    #[serde(default)]
    pub supports_reasoning: bool,
    #[serde(default)]
    pub supports_vision: bool,
}

impl ModelDefinition {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: String::new(),
            context_window: default_context_window(),
            max_output_tokens: default_max_output_tokens(),
            supports_tools: true,
            supports_reasoning: false,
            supports_vision: false,
        }
    }

    pub fn display_label(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.id
        } else {
            &self.label
        }
    }

    /// Trim identifiers and clamp token budgets; returns `None` when the id is empty.
    pub fn normalized(mut self) -> Option<Self> {
        self.id = self.id.trim().to_string();
        if self.id.is_empty() {
            return None;
        }
        self.label = self.label.trim().to_string();
        self.context_window = self.context_window.max(1);
        self.max_output_tokens = self.max_output_tokens.max(1).min(self.context_window);
        Some(self)
    }

    pub fn capabilities(&self, provider_id: &str) -> ModelCapabilities {
        let context_window = self.context_window.max(1);
        ModelCapabilities {
            model: ModelRef::new(provider_id, self.id.clone()),
            context_window,
            preferred_window: preferred_window(context_window),
            max_output_tokens: self.max_output_tokens.max(1).min(context_window),
            supports_thinking: self.supports_reasoning,
            visible_thinking: self.supports_reasoning,
            supports_tools: self.supports_tools,
            supports_images: self.supports_vision,
            effort_mode: if self.supports_reasoning {
                EffortMode::Tier
            } else {
                EffortMode::None
            },
        }
    }
}

pub fn preferred_window(context_window: u32) -> u32 {
    ((context_window as u64 * 9) / 10)
        .max(1)
        .min(u32::MAX as u64) as u32
}

/// One configured provider instance. API keys are stored separately and never
/// travel inside this struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub base_url: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ModelDefinition>,
}

impl ProviderConfig {
    pub fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            self.name = self.kind.label().to_string();
        }
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        if self.base_url.is_empty() {
            self.base_url = self.kind.default_base_url().to_string();
        }
        let mut seen = std::collections::HashSet::new();
        self.models = self
            .models
            .drain(..)
            .filter_map(ModelDefinition::normalized)
            .filter(|model| seen.insert(model.id.clone()))
            .collect();
        self
    }

    pub fn model(&self, id: &str) -> Option<&ModelDefinition> {
        self.models.iter().find(|model| model.id == id)
    }
}

/// Per-model overrides applied on top of whatever a provider advertises.
/// Keyed by `"{provider}:{model}"` in [`ProviderSettings::model_overrides`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
}

impl ModelOverride {
    pub fn is_empty(&self) -> bool {
        self.context_window.is_none() && self.max_output_tokens.is_none()
    }

    pub fn apply(&self, caps: &mut ModelCapabilities) {
        if let Some(window) = self.context_window.filter(|value| *value > 0) {
            caps.context_window = window;
            caps.preferred_window = preferred_window(window);
        }
        if let Some(output) = self.max_output_tokens.filter(|value| *value > 0) {
            caps.max_output_tokens = output;
        }
        caps.max_output_tokens = caps.max_output_tokens.max(1).min(caps.context_window.max(1));
    }
}

pub fn model_override_key(model: &ModelRef) -> String {
    format!("{}:{}", model.provider, model.name)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub model_overrides: HashMap<String, ModelOverride>,
}

impl ProviderSettings {
    pub fn normalized(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        self.providers = self
            .providers
            .drain(..)
            .map(ProviderConfig::normalized)
            .filter(|provider| !provider.id.is_empty() && seen.insert(provider.id.clone()))
            .collect();
        self.model_overrides.retain(|_, value| !value.is_empty());
        self
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.iter().find(|provider| provider.id == id)
    }

    pub fn override_for(&self, model: &ModelRef) -> Option<&ModelOverride> {
        self.model_overrides.get(&model_override_key(model))
    }
}

/// Flattened entry for the unified model selector.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub provider_id: String,
    pub provider_label: String,
    pub provider_kind: ProviderKind,
    pub model_id: String,
    pub label: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub supports_tools: bool,
    pub supports_reasoning: bool,
    pub supports_vision: bool,
    pub local: bool,
}

impl ModelCatalogEntry {
    pub fn from_definition(provider: &ProviderConfig, model: &ModelDefinition) -> Self {
        Self {
            provider_id: provider.id.clone(),
            provider_label: provider.name.clone(),
            provider_kind: provider.kind,
            model_id: model.id.clone(),
            label: model.display_label().to_string(),
            context_window: model.context_window,
            max_output_tokens: model.max_output_tokens,
            supports_tools: model.supports_tools,
            supports_reasoning: model.supports_reasoning,
            supports_vision: model.supports_vision,
            local: provider.kind.is_local(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_drops_empty_and_duplicate_models() {
        let config = ProviderConfig {
            id: " custom-1 ".into(),
            name: "".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://example.com/v1/".into(),
            enabled: true,
            models: vec![
                ModelDefinition::new("a"),
                ModelDefinition::new(" "),
                ModelDefinition::new("a"),
            ],
        }
        .normalized();
        assert_eq!(config.id, "custom-1");
        assert_eq!(config.name, "OpenAI-compatible");
        assert_eq!(config.base_url, "https://example.com/v1");
        assert_eq!(config.models.len(), 1);
    }

    // fenetre-locale — Ollama, LM Studio et localhost : 32 768 (ou moins si annoncé) ; cloud inchangé.
    #[test]
    fn local_endpoints_and_their_default_window() {
        assert!(ProviderKind::Ollama.is_local_endpoint("http://192.168.1.20:11434"));
        assert!(ProviderKind::LmStudio.is_local_endpoint(""));
        for url in ["http://localhost:8080/v1", "http://127.0.0.1:8000/v1", "http://[::1]:5000/v1", "localhost:1234", "http://0.0.0.0:8000"] {
            assert!(ProviderKind::OpenAiCompatible.is_local_endpoint(url), "{url}");
        }
        for url in ["https://api.openai.com/v1", "https://localhost.example.com/v1", "https://api.mistral.ai/v1", "http://10.0.0.5:8000/v1"] {
            assert!(!ProviderKind::OpenAiCompatible.is_local_endpoint(url), "{url}");
        }
        assert!(!ProviderKind::Mistral.is_local_endpoint(ProviderKind::Mistral.default_base_url()));
        // Relais Anthropic local (compteur des espaces) : modèles du cloud.
        assert!(!ProviderKind::AnthropicCompatible.is_local_endpoint("http://127.0.0.1:8096"));

        assert_eq!(default_context_window_for(true, None), 32_768);
        assert_eq!(default_context_window_for(true, Some(262_144)), 32_768);
        assert_eq!(default_context_window_for(true, Some(8_192)), 8_192);
        assert_eq!(default_context_window_for(true, Some(0)), 32_768);
        assert_eq!(default_context_window_for(false, None), 128_000);
        assert_eq!(default_context_window_for(false, Some(262_144)), 262_144);
        assert_eq!(default_max_output_for(32_768), 16_384);
        assert_eq!(default_max_output_for(8_192), 4_096);
        assert_eq!(default_max_output_for(128_000), 16_384);
    }

    #[test]
    fn legacy_local_windows_are_lowered_once_and_only_there() {
        let mut root = serde_json::json!({
            "providers": [
                {"id": "ollama", "kind": "ollama", "baseUrl": "http://localhost:11434", "models": [
                    {"id": "qwen3:4b", "contextWindow": 128000, "maxOutputTokens": 32000},
                    {"id": "llama3.1:8b", "contextWindow": 65536},
                    {"id": "sans-fenetre"}
                ]},
                {"id": "custom-llama-cpp", "kind": "open_ai_compatible", "baseUrl": "http://127.0.0.1:8080/v1",
                 "models": [{"id": "local-gguf", "contextWindow": 128000}]},
                {"id": "mistral", "kind": "mistral", "baseUrl": "https://api.mistral.ai/v1",
                 "models": [{"id": "mistral-large-latest", "contextWindow": 128000}]},
                {"id": "axe-cloud", "kind": "anthropic_compatible", "baseUrl": "http://127.0.0.1:8096",
                 "models": [{"id": "house-model", "contextWindow": 128000}]}
            ],
            "modelOverrides": {"ollama:qwen3:4b": {"maxOutputTokens": 4096}},
            "fournisseurs": [{"id": "garde", "url": "https://example.com/v1"}]
        });
        assert_eq!(lower_legacy_local_windows(&mut root), 3);
        let models = |i: usize| root["providers"][i]["models"].clone();
        assert_eq!(models(0)[0]["contextWindow"], 32_768);
        assert_eq!(models(0)[0]["maxOutputTokens"], 16_384);
        assert_eq!(models(0)[1]["contextWindow"], 65_536, "valeur choisie à la main");
        assert_eq!(models(0)[2]["contextWindow"], 32_768);
        assert_eq!(models(1)[0]["contextWindow"], 32_768);
        assert_eq!(models(2)[0]["contextWindow"], 128_000, "cloud inchangé");
        assert_eq!(models(3)[0]["contextWindow"], 128_000, "relais Anthropic local inchangé");
        assert_eq!(root["fournisseurs"][0]["id"], "garde", "autres sections intactes");
        assert_eq!(root["modelOverrides"]["ollama:qwen3:4b"]["maxOutputTokens"], 4_096);
        assert_eq!(lower_legacy_local_windows(&mut root), 0);
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("axecode-fenetre-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn migration_runs_once_and_keeps_a_copy() {
        let dir = temp_dir("une-fois");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");
        let before = serde_json::json!({"providers": [{"id": "ollama", "name": "Ollama", "kind": "ollama",
            "baseUrl": "http://localhost:11434", "enabled": true,
            "models": [{"id": "qwen3:4b", "label": "", "contextWindow": 128000, "maxOutputTokens": 16384}]}]});
        std::fs::write(&path, serde_json::to_vec(&before).unwrap()).unwrap();
        assert_eq!(migrate_local_windows_once(&dir).unwrap(), 1);
        let after: ProviderSettings = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(after.providers[0].models[0].context_window, 32_768);
        assert!(dir.join(LOCAL_WINDOW_MARK).exists());
        let copy: Value = serde_json::from_slice(&std::fs::read(dir.join("providers.json.avant-0178")).unwrap()).unwrap();
        assert_eq!(copy, before);
        // Remis ensuite à 128 000 à la main : la migration ne repasse pas.
        std::fs::write(&path, serde_json::to_vec(&before).unwrap()).unwrap();
        assert_eq!(migrate_local_windows_once(&dir).unwrap(), 0);
        let again: ProviderSettings = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(again.providers[0].models[0].context_window, 128_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_without_file_writes_the_mark_and_unreadable_file_is_retried() {
        let dir = temp_dir("sans-fichier");
        assert_eq!(migrate_local_windows_once(&dir).unwrap(), 0);
        assert!(dir.join(LOCAL_WINDOW_MARK).exists());
        assert!(!dir.join("providers.json").exists());
        let dir2 = temp_dir("illisible");
        std::fs::create_dir_all(&dir2).unwrap();
        std::fs::write(dir2.join("providers.json"), b"{ pas du json").unwrap();
        assert!(migrate_local_windows_once(&dir2).is_err());
        assert!(!dir2.join(LOCAL_WINDOW_MARK).exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn override_clamps_output_to_window() {
        let mut caps = ModelDefinition::new("m").capabilities("p");
        ModelOverride {
            context_window: Some(8_000),
            max_output_tokens: None,
        }
        .apply(&mut caps);
        assert_eq!(caps.context_window, 8_000);
        assert_eq!(caps.max_output_tokens, 8_000);
        assert_eq!(caps.preferred_window, 7_200);
    }
}
