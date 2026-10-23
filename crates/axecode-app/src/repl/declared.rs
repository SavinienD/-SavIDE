//! axe:providers — declared providers wired into the REPL runtime.
//!
//! `ReplRuntime::new` wraps the host resolver in a [`DeclaredProviderResolver`]
//! built from the session's `data_dir`, so the service can use models declared
//! in `<data_dir>/providers.json` without the desktop app being rebuilt. The
//! wrapper only steps in for ids the host resolver does not know; every
//! existing provider goes through the host unchanged.

use std::{collections::HashMap, sync::Arc};

use axecode_core::{
    DeclaredProvider, DeclaredProviders, ModelCapabilities, ModelCatalogEntry, Provider,
    ProviderKind,
};
use axecode_openai::{compatible_provider, Dialect};

use super::ProviderResolver;

/// Built-in ids: a declaration never shadows a native adapter.
pub const RESERVED_IDS: &[&str] = &[
    "anthropic",
    "openai",
    "google",
    "kimi",
    "openrouter",
    "gemini-web",
];

/// Host resolver plus the providers declared in `<data_dir>/providers.json`.
///
/// The host registry is always consulted first: declarations can never change
/// the behaviour of an existing provider, even when they reuse its id.
/// The file is re-read when its modification time changes, so adding a model
/// does not require restarting the service.
pub struct DeclaredProviderResolver {
    inner: Arc<dyn ProviderResolver>,
    path: Option<std::path::PathBuf>,
    stamp: std::sync::Mutex<Option<std::time::SystemTime>>,
    declared: std::sync::Mutex<DeclaredProviders>,
    live: std::sync::Mutex<HashMap<String, Arc<dyn Provider>>>,
}

impl DeclaredProviderResolver {
    /// Loads the declarations of `data_dir`. Warnings are logged, never fatal.
    pub fn load(inner: Arc<dyn ProviderResolver>, data_dir: &std::path::Path) -> Self {
        let path = DeclaredProviders::path(data_dir);
        let mut declared = DeclaredProviders::load(data_dir);
        declared.ignore_ids(RESERVED_IDS);
        log_warnings(&declared);
        Self {
            inner,
            stamp: std::sync::Mutex::new(file_stamp(&path)),
            path: Some(path),
            declared: std::sync::Mutex::new(declared),
            live: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn new(inner: Arc<dyn ProviderResolver>, declared: DeclaredProviders) -> Self {
        Self {
            inner,
            path: None,
            stamp: std::sync::Mutex::new(None),
            declared: std::sync::Mutex::new(declared),
            live: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn declared(&self) -> DeclaredProviders {
        self.refresh_if_changed();
        self.declared.lock().map(|d| d.clone()).unwrap_or_default()
    }

    /// Catalogue entries of the declared models (same shape as the app's
    /// unified model selector).
    pub fn catalog(&self) -> Vec<ModelCatalogEntry> {
        self.declared().catalog()
    }

    /// Reloads `providers.json` when it changed on disk (new or edited file).
    fn refresh_if_changed(&self) {
        let (Some(path), Ok(mut known)) = (&self.path, self.stamp.lock()) else {
            return;
        };
        let current = file_stamp(path);
        if *known == current {
            return;
        }
        *known = current;
        let mut declared = DeclaredProviders::load(path.parent().unwrap_or(path));
        declared.ignore_ids(RESERVED_IDS);
        log_warnings(&declared);
        if let Ok(mut slot) = self.declared.lock() {
            *slot = declared;
        }
        if let Ok(mut live) = self.live.lock() {
            live.clear();
        }
    }

    fn build(&self, provider: &DeclaredProvider) -> Result<Arc<dyn Provider>, String> {
        let api_key = provider
            .api_key_env()
            .map(|name| std::env::var(name).unwrap_or_default())
            .unwrap_or_default();
        let models: Vec<ModelCapabilities> = provider.capabilities();
        compatible_provider(
            provider.id.clone(),
            provider.base_url.clone(),
            api_key,
            models,
            Dialect::OpenAi,
        )
        .map_err(|err| err.to_string())
    }

    fn declared_provider(&self, provider_id: &str) -> Result<Arc<dyn Provider>, String> {
        let provider = self
            .declared
            .lock()
            .ok()
            .and_then(|declared| declared.get(provider_id).cloned());
        let Some(provider) = provider else {
            return Err(format!("provider `{provider_id}` is not declared"));
        };
        if let Ok(mut live) = self.live.lock() {
            if let Some(built) = live.get(provider_id) {
                return Ok(built.clone());
            }
            let built = self.build(&provider)?;
            live.insert(provider_id.to_string(), built.clone());
            return Ok(built);
        }
        self.build(&provider)
    }
}

impl ProviderResolver for DeclaredProviderResolver {
    fn provider(&self, provider_id: &str) -> Result<Arc<dyn Provider>, String> {
        // Existing providers keep exactly the same behaviour.
        if let Ok(provider) = self.inner.provider(provider_id) {
            return Ok(provider);
        }
        self.refresh_if_changed();
        self.declared_provider(provider_id)
    }
}

fn file_stamp(path: &std::path::Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}

fn log_warnings(declared: &DeclaredProviders) {
    for warning in declared.warnings() {
        tracing::warn!(target: "providers", "{warning}");
    }
}

/// Catalogue of every model the service can run: declared models first (they
/// are what the user just added), then nothing else — the host resolver does
/// not expose its own catalogue. Useful to the service/UI when it needs to
/// list the declared models without building a provider.
pub fn declared_catalog(data_dir: &std::path::Path) -> Vec<ModelCatalogEntry> {
    let mut declared = DeclaredProviders::load(data_dir);
    declared.ignore_ids(RESERVED_IDS);
    declared.catalog()
}

/// Provider kind reported for declared models in the catalogue.
pub const DECLARED_KIND: ProviderKind = ProviderKind::OpenAiCompatible;

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use axecode_core::{
        ModelRef, ProviderRequest, ProviderStream, Result as CoreResult, TokenEstimate,
    };

    use super::*;

    struct Scripted {
        name: String,
    }

    #[async_trait]
    impl Provider for Scripted {
        fn name(&self) -> &str {
            &self.name
        }
        fn capabilities(&self, model: &ModelRef) -> Option<ModelCapabilities> {
            Some(ModelCapabilities {
                model: model.clone(),
                context_window: 1_000,
                preferred_window: 900,
                max_output_tokens: 100,
                supports_thinking: false,
                visible_thinking: false,
                supports_tools: true,
                supports_images: false,
                effort_mode: axecode_core::EffortMode::None,
            })
        }
        async fn estimate_tokens(&self, _request: ProviderRequest) -> CoreResult<TokenEstimate> {
            Ok(TokenEstimate {
                input_tokens: 0,
                exact: false,
            })
        }
        async fn stream(&self, _request: ProviderRequest) -> CoreResult<ProviderStream> {
            Err(axecode_core::AppError::Unsupported(
                "no network in tests".into(),
            ))
        }
    }

    struct Host {
        built: Mutex<Vec<String>>,
    }

    impl ProviderResolver for Host {
        fn provider(&self, provider_id: &str) -> Result<Arc<dyn Provider>, String> {
            self.built.lock().unwrap().push(provider_id.to_string());
            if provider_id == "anthropic" {
                Ok(Arc::new(Scripted {
                    name: "anthropic".into(),
                }))
            } else {
                Err(format!("provider `{provider_id}` is not configured"))
            }
        }
    }

    fn data_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "axecode-declared-app-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_declared(dir: &std::path::Path) {
        std::fs::write(
            dir.join(PROVIDERS_FILE_NAME),
            serde_json::to_vec(&serde_json::json!({
                "fournisseurs": [{
                    "id": "opencode",
                    "libelle": "OpenCode (DeepSeek)",
                    "compatibilite": "openai",
                    "url": "https://opencode.ai/zen/v1",
                    "cleEnv": "AXECODE_TEST_DECLARED_KEY",
                    "modeles": [{
                        "id": "deepseek-v4.1-flash-free",
                        "libelle": "DeepSeek V4.1 Flash (gratuit)",
                        "fenetreContexte": 200000,
                        "outils": true
                    }]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    const PROVIDERS_FILE_NAME: &str = "providers.json";

    #[test]
    fn declared_model_is_resolvable_and_listed() {
        let dir = data_dir();
        write_declared(&dir);
        let host = Arc::new(Host {
            built: Mutex::new(Vec::new()),
        });
        let resolver = DeclaredProviderResolver::load(host.clone(), &dir);

        let provider = resolver.provider("opencode").expect("declared provider");
        assert_eq!(provider.name(), "opencode");

        let model = ModelRef::new("opencode", "deepseek-v4.1-flash-free");
        let caps = provider.capabilities(&model).expect("declared model");
        assert_eq!(caps.context_window, 200_000);
        assert_eq!(caps.preferred_window, 180_000);
        assert!(caps.supports_tools);

        let catalog = resolver.catalog();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].provider_id, "opencode");
        assert_eq!(catalog[0].model_id, "deepseek-v4.1-flash-free");
        assert_eq!(catalog[0].provider_kind, DECLARED_KIND);
        assert_eq!(catalog[0].provider_label, "OpenCode (DeepSeek)");

        // Existing providers are still served by the host, untouched.
        assert!(resolver.provider("anthropic").is_ok());
        assert_eq!(
            host.built.lock().unwrap().as_slice(),
            ["opencode", "anthropic"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_keeps_the_host_catalogue() {
        let dir = data_dir();
        let host = Arc::new(Host {
            built: Mutex::new(Vec::new()),
        });
        let resolver = DeclaredProviderResolver::load(host.clone(), &dir);
        assert!(resolver.catalog().is_empty());
        assert!(resolver.provider("opencode").is_err());
        assert!(resolver.provider("anthropic").is_ok());
        assert_eq!(
            host.built.lock().unwrap().as_slice(),
            ["opencode", "anthropic"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declarations_cannot_shadow_builtin_ids() {
        let dir = data_dir();
        std::fs::write(
            dir.join(PROVIDERS_FILE_NAME),
            serde_json::to_vec(&serde_json::json!({
                "fournisseurs": [{
                    "id": "anthropic",
                    "url": "https://example.com/v1",
                    "modeles": [{"id": "m"}]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let host = Arc::new(Host {
            built: Mutex::new(Vec::new()),
        });
        let resolver = DeclaredProviderResolver::load(host.clone(), &dir);
        assert!(resolver.catalog().is_empty());
        // The host's native adapter still answers.
        assert!(resolver.provider("anthropic").is_ok());
        assert_eq!(host.built.lock().unwrap().as_slice(), ["anthropic"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_subagent_spec_can_target_a_declared_model() {
        let dir = data_dir();
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        write_declared(&dir);

        // A `subagent_spec` entry whose tag selects the declared model.
        let store = axecode_harness::HarnessStore::open(&workspace);
        store
            .create(
                axecode_harness::Scope::Project,
                axecode_harness::EntryKind::SubagentSpec,
                axecode_harness::NewEntry {
                    title: "declared-worker".into(),
                    body: "Work on the task.".into(),
                    tags: vec!["model:opencode/deepseek-v4.1-flash-free".into()],
                    ..Default::default()
                },
            )
            .unwrap();

        // `FamilyHost` builds its profiles from the workspace harness.
        let profile = crate::rlm::profiles_from_harness(&workspace)
            .into_iter()
            .find(|profile| profile.name == "declared-worker")
            .expect("profile from harness");
        let model = profile.model.expect("model tag parsed");
        assert_eq!(model.provider, "opencode");
        assert_eq!(model.name, "deepseek-v4.1-flash-free");

        // The resolver used by `rlm.spawn` (and by the child's runtime) serves it.
        let host = Arc::new(Host {
            built: Mutex::new(Vec::new()),
        });
        let resolver = DeclaredProviderResolver::load(host, &dir);
        let provider = resolver
            .provider(&model.provider)
            .expect("declared provider");
        assert!(provider.capabilities(&model).is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declared_catalog_helper_lists_models_without_building() {
        let dir = data_dir();
        write_declared(&dir);
        let catalog = declared_catalog(&dir);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].provider_id, "opencode");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
