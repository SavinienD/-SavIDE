//! axe:providers — declared OpenAI-compatible endpoints.
//!
//! The OpenAI crate speaks the Responses API; endpoints declared in
//! `<data_dir>/providers.json` speak plain `/chat/completions`. Rather than
//! duplicating a client, this module reuses the shared adapter of
//! `axecode-openrouter` (the one already serving the desktop app's custom
//! providers) and exposes it under the declared provider id.

use std::sync::Arc;

use axecode_core::{ModelCapabilities, Provider, Result};

pub use axecode_openrouter::Dialect;

/// Builds a provider for a declared endpoint. No network call is made here:
/// the adapter is only constructed, requests happen on the first turn.
pub fn compatible_provider(
    provider_id: impl Into<String>,
    base_url: impl Into<String>,
    api_key: impl Into<String>,
    models: Vec<ModelCapabilities>,
    dialect: Dialect,
) -> Result<Arc<dyn Provider>> {
    let config = axecode_openrouter::OpenRouterConfig::compatible(
        provider_id,
        base_url,
        api_key,
        models,
        dialect,
    );
    Ok(Arc::new(axecode_openrouter::OpenRouterProvider::new(config)?))
}
