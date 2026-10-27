// axe:providers — providers declared in `<data_dir>/providers.json`.
pub mod declared_providers;
pub mod env; // axe:migration
pub mod error;
pub mod image_fit;
pub mod message;
pub mod model;
pub mod provider;
// axe:providers
pub mod provider_config;
// axe:daemon
pub mod session;
pub mod stream;
pub mod tool;

pub use error::{AppError, Result};
pub use message::{ChatMessage, Part, Role, StopReason, ToolResultImage, Usage};
pub use model::{Effort, EffortMode, ModelCapabilities, ModelRef};
pub use provider::{Provider, ProviderRequest, ServiceTier, TokenEstimate};
// axe:providers
pub use declared_providers::{
    DeclaredModel, DeclaredProvider, DeclaredProviders, PROVIDERS_FILE,
};
// axe:providers
pub use provider_config::{
    model_override_key, ModelCatalogEntry, ModelDefinition, ModelOverride, ProviderConfig,
    ProviderKind, ProviderSettings,
};
// axe:daemon
pub use session::{
    CreateSessionRequest, EntryId, JournalBranch, JournalEntry, JournalEntryKind, JournalTree, KernelSnapshot,
    PeerMessage, RuntimeContext, SessionError, SessionId, SessionMeta, SessionResult,
    SessionHost, SessionRuntime, SessionRuntimeFactory, SessionStatus, TurnInput, TurnOutcome, TurnRequest,
    TurnSink,
};
pub use stream::{PartKind, ProviderStream, StreamEvent, ToolCallIntro};
pub use tool::{ToolDescriptor, ToolResultPayload};
