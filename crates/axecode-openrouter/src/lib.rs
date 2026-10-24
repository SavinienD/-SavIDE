mod auth;
mod client;
mod model_info;
mod ollama;
mod stream;
mod wire;

pub use auth::{
    delete_default_auth, load_default_api_key, load_default_auth_status, save_default_api_key,
    touch_default_auth_validation, Credential, OpenRouterAuthStatus,
};
pub use client::{
    discover_compatible_models, fetch_model_catalog, validate_api_key, CompatibleModel, Dialect,
    OpenRouterCatalogModel, OpenRouterConfig, OpenRouterProvider,
};
pub use ollama::humanize_local_error;
pub use stream::{StreamLimits, DEFAULT_IDLE_TIMEOUT};
pub use model_info::{capabilities_from_catalog_model, capabilities_from_parts, PROVIDER_ID};
