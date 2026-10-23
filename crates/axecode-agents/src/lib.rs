//! External agents for SavIDE: a task queue on disk.
//!
//! One folder per task under `<workspace>/.axecode/agents/<id>`, holding the
//! brief (`tache.md`), the state (`etat.json`), the agent output
//! (`journal.log`) and its report (`resultat.md`). The service launches only
//! commands declared in its configuration, each in its own process group, and
//! supervises them (concurrency cap, deadline, stop).

pub mod config;
mod store;

pub use config::{AgentsConfig, DEFAULT_MODELE};
pub use store::{
    atomic_write, pid_alive, AgentStore, AgentSummary, ResultView, SpawnRequest, Spawned, Statut,
    StatusView, TaskState,
};

/// Errors surfaced to the RPC layer; messages are part of the frozen contract.
#[derive(Debug, thiserror::Error)]
pub enum AgentsError {
    #[error("agents: tache inconnue")]
    UnknownTask,
    #[error("agents: commande inconnue")]
    UnknownCommand,
    #[error("agents: brief obligatoire")]
    MissingBrief,
    #[error("agents: brief trop long (maximum 64 Ko)")]
    BriefTooLong,
    #[error("agents: espace de travail non configure")]
    NoWorkspace,
    #[error("agents: chemin de tache invalide")]
    InvalidTask,
    #[error("agents: {0}")]
    Io(String),
    #[error("agents: lancement impossible: {0}")]
    Launch(String),
}

impl From<std::io::Error> for AgentsError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<serde_json::Error> for AgentsError {
    fn from(value: serde_json::Error) -> Self {
        Self::Io(value.to_string())
    }
}
