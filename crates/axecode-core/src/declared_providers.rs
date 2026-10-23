//! Declared providers: the `fournisseurs` section of
//! `<data_dir>/providers.json`.
//!
//! Users can plug any OpenAI-compatible endpoint (and its models) without
//! recompiling. API keys are never stored in the file: `cleEnv` only names an
//! environment variable.
//!
//! Parsing is deliberately forgiving: an invalid entry (empty id, non-http(s)
//! URL, model without id, duplicate id, corrupted object) is skipped and
//! reported in [`DeclaredProviders::warnings`] so the caller can log it
//! without failing startup. An absent file, or a file without `fournisseurs`
//! (for instance the desktop app's legacy `providers` section), yields an
//! empty set and leaves the existing providers untouched.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::model::ModelCapabilities;
use crate::provider_config::{ModelCatalogEntry, ModelDefinition, ProviderConfig, ProviderKind};

/// File shared with the desktop app, inside the account data directory.
pub const PROVIDERS_FILE: &str = "providers.json";
const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;
const SUPPORTED_COMPATIBILITY: &str = "openai";

/// One model declared under a provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredModel {
    pub id: String,
    pub label: String,
    pub context_window: u32,
    pub supports_tools: bool,
}

impl DeclaredModel {
    /// Core model definition, reusing the provider catalogue's capabilities.
    pub fn definition(&self) -> ModelDefinition {
        let mut definition = ModelDefinition::new(self.id.clone());
        definition.label = self.label.clone();
        definition.context_window = self.context_window.max(1);
        definition.supports_tools = self.supports_tools;
        definition
    }

    pub fn capabilities(&self, provider_id: &str) -> ModelCapabilities {
        self.definition().capabilities(provider_id)
    }
}

/// One declared OpenAI-compatible provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredProvider {
    pub id: String,
    pub label: String,
    pub base_url: String,
    /// Name of the environment variable holding the API key (never the key).
    pub api_key_env: Option<String>,
    pub models: Vec<DeclaredModel>,
}

impl DeclaredProvider {
    pub fn api_key_env(&self) -> Option<&str> {
        self.api_key_env.as_deref()
    }

    pub fn model(&self, id: &str) -> Option<&DeclaredModel> {
        self.models.iter().find(|model| model.id == id)
    }

    /// Catalogue view, so declared models appear next to configured ones.
    pub fn config(&self) -> ProviderConfig {
        ProviderConfig {
            id: self.id.clone(),
            name: self.label.clone(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: self.base_url.clone(),
            enabled: true,
            models: self.models.iter().map(DeclaredModel::definition).collect(),
        }
    }

    pub fn capabilities(&self) -> Vec<ModelCapabilities> {
        self.models
            .iter()
            .map(|model| model.capabilities(&self.id))
            .collect()
    }

    pub fn catalog(&self) -> Vec<ModelCatalogEntry> {
        let config = self.config();
        config
            .models
            .iter()
            .map(|model| ModelCatalogEntry::from_definition(&config, model))
            .collect()
    }
}

/// The declared providers of one data directory, with their warnings.
#[derive(Debug, Clone, Default)]
pub struct DeclaredProviders {
    providers: Vec<DeclaredProvider>,
    warnings: Vec<String>,
}

impl DeclaredProviders {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(PROVIDERS_FILE)
    }

    /// Reads `<data_dir>/providers.json`; a missing file is not an error.
    pub fn load(data_dir: &Path) -> Self {
        match std::fs::read(Self::path(data_dir)) {
            Ok(bytes) => Self::parse(&bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(err) => Self {
                providers: Vec::new(),
                warnings: vec![format!(
                    "{} illisible, ignoré: {err}",
                    Self::path(data_dir).display()
                )],
            },
        }
    }

    pub fn parse(bytes: &[u8]) -> Self {
        let mut out = Self::default();
        let root: Value = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(err) => {
                out.warn(format!("providers.json invalide, ignoré: {err}"));
                return out;
            }
        };
        let Some(entries) = root.get("fournisseurs") else {
            // No declared section: keep the current behaviour untouched.
            return out;
        };
        let Some(entries) = entries.as_array() else {
            out.warn("providers.json: `fournisseurs` doit être une liste, ignoré");
            return out;
        };
        let mut seen = std::collections::HashSet::new();
        for (index, value) in entries.iter().enumerate() {
            match parse_provider(value) {
                Ok((provider, warnings)) => {
                    for warning in warnings {
                        out.warn(warning);
                    }
                    if !seen.insert(provider.id.clone()) {
                        out.warn(format!(
                            "fournisseur `{}` ignoré: identifiant en double",
                            provider.id
                        ));
                        continue;
                    }
                    out.providers.push(provider);
                }
                Err(reason) => out.warn(format!("fournisseur #{} ignoré: {reason}", index + 1)),
            }
        }
        out
    }

    pub fn providers(&self) -> &[DeclaredProvider] {
        &self.providers
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&DeclaredProvider> {
        self.providers.iter().find(|provider| provider.id == id)
    }

    /// Drops entries whose id belongs to a built-in provider, so the native
    /// adapters keep exactly the same behaviour.
    pub fn ignore_ids(&mut self, ids: &[&str]) {
        let mut kept = Vec::with_capacity(self.providers.len());
        for provider in self.providers.drain(..) {
            if ids.contains(&provider.id.as_str()) {
                self.warnings.push(format!(
                    "fournisseur `{}` ignoré: identifiant réservé à un fournisseur intégré",
                    provider.id
                ));
            } else {
                kept.push(provider);
            }
        }
        self.providers = kept;
    }

    /// Flattened catalogue of every declared model.
    pub fn catalog(&self) -> Vec<ModelCatalogEntry> {
        self.providers
            .iter()
            .flat_map(DeclaredProvider::catalog)
            .collect()
    }

    pub fn model_capabilities(&self, provider: &str, model: &str) -> Option<ModelCapabilities> {
        self.get(provider)?
            .model(model)
            .map(|model| model.capabilities(provider))
    }

    fn warn(&mut self, warning: impl Into<String>) {
        self.warnings.push(warning.into());
    }
}

#[derive(Deserialize)]
struct RawProvider {
    #[serde(default)]
    id: String,
    #[serde(default)]
    libelle: String,
    #[serde(default)]
    compatibilite: Option<String>,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "cleEnv")]
    cle_env: Option<String>,
    #[serde(default)]
    modeles: Option<Value>,
}

#[derive(Deserialize)]
struct RawModel {
    #[serde(default)]
    id: String,
    #[serde(default)]
    libelle: String,
    #[serde(default, rename = "fenetreContexte")]
    fenetre_contexte: Option<u32>,
    #[serde(default)]
    outils: Option<bool>,
}

fn parse_provider(value: &Value) -> Result<(DeclaredProvider, Vec<String>), String> {
    let raw: RawProvider =
        serde_json::from_value(value.clone()).map_err(|err| format!("entrée corrompue ({err})"))?;

    let id = raw.id.trim().to_string();
    if id.is_empty() {
        return Err("identifiant vide".into());
    }
    if id.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err(format!("identifiant `{id}` invalide (ni espace ni `/`)"));
    }

    let compatibility = raw
        .compatibilite
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(SUPPORTED_COMPATIBILITY);
    if !compatibility.eq_ignore_ascii_case(SUPPORTED_COMPATIBILITY) {
        return Err(format!(
            "compatibilité `{compatibility}` non prise en charge (attendu: openai)"
        ));
    }

    let url = raw.url.trim().to_string();
    if !is_http_url(&url) {
        return Err(format!("url `{url}` invalide (http(s) attendu)"));
    }

    let label = {
        let label = raw.libelle.trim();
        if label.is_empty() {
            id.clone()
        } else {
            label.to_string()
        }
    };

    let api_key_env = raw
        .cle_env
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);

    let (models, warnings) = match raw.modeles {
        None | Some(Value::Null) => (Vec::new(), Vec::new()),
        Some(Value::Array(items)) => parse_models(&items),
        Some(_) => return Err("`modeles` doit être une liste".into()),
    };
    Ok((
        DeclaredProvider {
            id,
            label,
            base_url: url,
            api_key_env,
            models,
        },
        warnings,
    ))
}

fn parse_models(items: &[Value]) -> (Vec<DeclaredModel>, Vec<String>) {
    let mut models = Vec::new();
    let mut warnings = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (index, value) in items.iter().enumerate() {
        let raw: RawModel = match serde_json::from_value(value.clone()) {
            Ok(raw) => raw,
            Err(err) => {
                warnings.push(format!(
                    "modèle #{} ignoré: entrée corrompue ({err})",
                    index + 1
                ));
                continue;
            }
        };
        let id = raw.id.trim().to_string();
        if id.is_empty() {
            warnings.push(format!("modèle #{} ignoré: identifiant vide", index + 1));
            continue;
        }
        if !seen.insert(id.clone()) {
            warnings.push(format!("modèle `{id}` ignoré: identifiant en double"));
            continue;
        }
        let label = {
            let label = raw.libelle.trim();
            if label.is_empty() {
                id.clone()
            } else {
                label.to_string()
            }
        };
        models.push(DeclaredModel {
            id,
            label,
            context_window: raw
                .fenetre_contexte
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_CONTEXT_WINDOW),
            supports_tools: raw.outils.unwrap_or(true),
        });
    }
    (models, warnings)
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    rest.is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: Value) -> DeclaredProviders {
        DeclaredProviders::parse(&serde_json::to_vec(&value).unwrap())
    }

    fn provider(id: &str, url: &str) -> Value {
        serde_json::json!({
            "id": id,
            "libelle": id,
            "compatibilite": "openai",
            "url": url,
            "cleEnv": "TEST_API_KEY",
            "modeles": [{"id": "m", "fenetreContexte": 200_000, "outils": true}]
        })
    }

    #[test]
    fn parses_a_valid_declaration() {
        let parsed = parse(serde_json::json!({
            "fournisseurs": [{
                "id": "opencode",
                "libelle": "OpenCode (DeepSeek)",
                "compatibilite": "openai",
                "url": "https://opencode.ai/zen/v1",
                "cleEnv": "OPENCODE_API_KEY",
                "modeles": [{
                    "id": "deepseek-v4.1-flash-free",
                    "libelle": "DeepSeek V4.1 Flash (gratuit)",
                    "fenetreContexte": 200000,
                    "outils": true
                }]
            }]
        }));

        assert!(parsed.warnings().is_empty(), "{:?}", parsed.warnings());
        assert_eq!(parsed.providers().len(), 1);
        let provider = &parsed.providers()[0];
        assert_eq!(provider.id, "opencode");
        assert_eq!(provider.label, "OpenCode (DeepSeek)");
        assert_eq!(provider.base_url, "https://opencode.ai/zen/v1");
        assert_eq!(provider.api_key_env(), Some("OPENCODE_API_KEY"));
        assert_eq!(provider.models.len(), 1);
        let model = &provider.models[0];
        assert_eq!(model.id, "deepseek-v4.1-flash-free");
        assert_eq!(model.context_window, 200_000);
        assert!(model.supports_tools);

        let caps = parsed
            .model_capabilities("opencode", "deepseek-v4.1-flash-free")
            .expect("declared model");
        assert_eq!(caps.context_window, 200_000);
        assert_eq!(caps.preferred_window, 180_000);
        assert!(caps.supports_tools);

        let catalog = parsed.catalog();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].provider_id, "opencode");
        assert_eq!(catalog[0].provider_label, "OpenCode (DeepSeek)");
        assert_eq!(catalog[0].provider_kind, ProviderKind::OpenAiCompatible);
        assert_eq!(catalog[0].model_id, "deepseek-v4.1-flash-free");
        assert_eq!(catalog[0].label, "DeepSeek V4.1 Flash (gratuit)");
    }

    #[test]
    fn accepts_a_key_variable_without_value() {
        for cle in [serde_json::json!(""), serde_json::json!(null)] {
            let parsed = parse(serde_json::json!({
                "fournisseurs": [{
                    "id": "local",
                    "url": "http://127.0.0.1:1234/v1",
                    "cleEnv": cle,
                    "modeles": [{"id": "m"}]
                }]
            }));
            assert!(parsed.warnings().is_empty(), "{:?}", parsed.warnings());
            assert_eq!(parsed.providers().len(), 1);
            assert_eq!(parsed.providers()[0].api_key_env(), None);
            assert_eq!(parsed.providers()[0].label, "local");
            assert_eq!(parsed.providers()[0].models[0].label, "m");
            assert!(parsed.providers()[0].models[0].supports_tools);
        }
    }

    #[test]
    fn skips_corrupted_entries_and_keeps_the_others() {
        let parsed = parse(serde_json::json!({
            "fournisseurs": [
                "not a provider",
                {"id": 42, "url": "https://example.com"},
                provider("good", "https://example.com/v1")
            ]
        }));
        assert_eq!(parsed.providers().len(), 1);
        assert_eq!(parsed.providers()[0].id, "good");
        assert_eq!(parsed.warnings().len(), 2, "{:?}", parsed.warnings());
    }

    #[test]
    fn ignores_duplicate_provider_ids() {
        let parsed = parse(serde_json::json!({
            "fournisseurs": [
                provider("dup", "https://first.example/v1"),
                provider("dup", "https://second.example/v1")
            ]
        }));
        assert_eq!(parsed.providers().len(), 1);
        assert_eq!(parsed.providers()[0].base_url, "https://first.example/v1");
        assert!(
            parsed.warnings().iter().any(|w| w.contains("double")),
            "{:?}",
            parsed.warnings()
        );
    }

    #[test]
    fn ignores_non_http_urls_and_empty_ids() {
        let parsed = parse(serde_json::json!({
            "fournisseurs": [
                provider("", "https://example.com/v1"),
                provider("ftp", "ftp://example.com/v1"),
                provider("relative", "example.com/v1"),
                provider("ok", "https://example.com/v1")
            ]
        }));
        assert_eq!(parsed.providers().len(), 1);
        assert_eq!(parsed.providers()[0].id, "ok");
        assert_eq!(parsed.warnings().len(), 3, "{:?}", parsed.warnings());
    }

    #[test]
    fn ignores_models_without_id_and_duplicate_models() {
        let parsed = parse(serde_json::json!({
            "fournisseurs": [{
                "id": "p",
                "url": "https://example.com/v1",
                "modeles": [
                    {"id": " "},
                    {"id": "m"},
                    {"id": "m", "libelle": "other"},
                    {"id": 7}
                ]
            }]
        }));
        let provider = &parsed.providers()[0];
        assert_eq!(provider.models.len(), 1);
        assert_eq!(provider.models[0].id, "m");
        assert_eq!(provider.models[0].context_window, DEFAULT_CONTEXT_WINDOW);
        assert_eq!(parsed.warnings().len(), 3, "{:?}", parsed.warnings());
    }

    #[test]
    fn rejects_unsupported_compatibility_and_bad_models_list() {
        let parsed = parse(serde_json::json!({
            "fournisseurs": [
                {"id": "a", "url": "https://example.com", "compatibilite": "anthropic"},
                {"id": "b", "url": "https://example.com", "modeles": "nope"}
            ]
        }));
        assert!(parsed.providers().is_empty());
        assert_eq!(parsed.warnings().len(), 2, "{:?}", parsed.warnings());
    }

    #[test]
    fn absent_or_foreign_file_leaves_the_catalogue_unchanged() {
        let dir = std::env::temp_dir().join(format!("axecode-declared-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let parsed = DeclaredProviders::load(&dir);
        assert!(parsed.is_empty());
        assert!(parsed.warnings().is_empty());

        // Desktop app's existing schema: `providers`, camelCase.
        std::fs::write(
            dir.join(PROVIDERS_FILE),
            br#"{"providers":[{"id":"x","name":"X","kind":"open_ai_compatible","baseUrl":"https://example.com","models":[{"id":"m"}]}]}"#,
        )
        .unwrap();
        let parsed = DeclaredProviders::load(&dir);
        assert!(parsed.is_empty());
        assert!(parsed.warnings().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_json_is_ignored_with_a_warning() {
        let parsed = DeclaredProviders::parse(b"{not json");
        assert!(parsed.is_empty());
        assert_eq!(parsed.warnings().len(), 1);
    }

    #[test]
    fn reserved_ids_are_dropped() {
        let mut parsed = parse(serde_json::json!({
            "fournisseurs": [provider("anthropic", "https://example.com")]
        }));
        assert_eq!(parsed.providers().len(), 1);
        parsed.ignore_ids(&["anthropic"]);
        assert!(parsed.is_empty());
        assert_eq!(parsed.warnings().len(), 1);
    }
}
