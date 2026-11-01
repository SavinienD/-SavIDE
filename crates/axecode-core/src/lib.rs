// providers — providers declared in `<data_dir>/providers.json`.
pub mod declared_providers;
pub mod env; // migration
pub mod error;
pub mod image_fit;
pub mod message;
pub mod model;
pub mod provider;
// providers
pub mod provider_config;
// daemon
pub mod session;
pub mod stream;
pub mod tool;

pub use error::{AppError, Result};
pub use message::{ChatMessage, Part, Role, StopReason, ToolResultImage, Usage};
pub use model::{Effort, EffortMode, ModelCapabilities, ModelRef};
pub use provider::{Provider, ProviderRequest, ServiceTier, TokenEstimate};
// providers
pub use declared_providers::{
    DeclaredModel, DeclaredProvider, DeclaredProviders, PROVIDERS_FILE,
};
// providers
pub use provider_config::{
    model_override_key, ModelCatalogEntry, ModelDefinition, ModelOverride, ProviderConfig,
    ProviderKind, ProviderSettings,
};
// daemon
pub use session::{
    CreateSessionRequest, EntryId, JournalBranch, JournalEntry, JournalEntryKind, JournalTree, KernelSnapshot,
    PeerMessage, RuntimeContext, SessionError, SessionId, SessionMeta, SessionResult,
    SessionHost, SessionRuntime, SessionRuntimeFactory, SessionStatus, TurnInput, TurnOutcome, TurnRequest,
    TurnSink,
};
pub use stream::{PartKind, ProviderStream, StreamEvent, ToolCallIntro};
pub use tool::{ToolDescriptor, ToolResultPayload};
