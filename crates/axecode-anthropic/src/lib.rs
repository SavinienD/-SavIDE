mod auth;
mod cli_version;
mod client;
// providers
mod compat;
mod model_info;
mod stream;
mod wire;

pub use auth::{
    delete_default_auth, exchange_oauth_code, generate_pkce, generate_state,
    load_default_auth_status, load_default_oauth_access_token, oauth_authorize_url,
    AnthropicAuthStatus, Credential, PkceCodes,
};
// E-mail and plan of the connected Claude account.
pub use auth::{account_from_profile, ensure_account, ensure_default_account, fetch_account, AnthropicAccount};
// several Claude accounts, each in its own file.
pub use auth::{exchange_oauth_code_into, load_auth_status};
pub use client::{AnthropicConfig, AnthropicProvider};
// providers
pub use compat::{discover_models, fetch_oauth_usage};
// catalogue of the native provider.
pub use compat::{list_models, parse_listed_models, ListedModel};
pub use model_info::{apply_known_window, MODEL_ID, MODEL_MAX_OUTPUT, MODEL_WINDOW};
