mod auth;
mod client;
// providers — declared OpenAI-compatible endpoints.
pub mod compatible;
mod model_info;
pub mod models_list;
mod responses_stream;
mod stream;
mod websocket;
mod wire;

pub use auth::{
    delete_default_auth, exchange_oauth_code, generate_pkce, generate_state,
    load_default_auth_status, oauth_authorize_url, BearerToken, Credential, OpenAiAuthStatus,
    PkceCodes,
};
// several ChatGPT accounts, each in its own file.
pub use auth::{exchange_oauth_code_into, load_auth_status};
pub use client::{OpenAiConfig, OpenAiProvider};
pub use compatible::{compatible_provider, Dialect};
pub use model_info::{MODEL_ID, MODEL_MAX_OUTPUT, MODEL_WINDOW};
