//! SavIDE background session service.
//!
//! The daemon owns every session (journal + runtime + kernel), survives the
//! IDE and exits on its own when nothing runs and no client is attached.

pub mod auth; // axe:remote
pub mod cli;
pub mod client;
pub mod daemon;
pub mod journal;
pub mod keep_awake; // axe:eveil
pub mod listen; // axe:remote
pub mod menage; // axe:menage
pub mod migrate;
pub mod protocol;
pub mod scratch; // axe:freechat
pub mod server;
pub mod sessions;
pub mod stub;
pub mod transport;
pub mod util;
pub mod webui; // axe:webui
pub mod worker;
pub mod workspace_rpc;
pub mod share_rpc; // v2-l4
pub mod brain_rpc; // v2-l2.4
pub mod agents_rpc; // v2-l7c
pub mod voice_rpc; // axe:voix
pub mod commandes_rpc; // axe:commandes
mod term_rpc; // v2-l3
 // v2-l2 confined remote filesystem/Git

pub use client::{ensure_daemon, DaemonClient};
pub use daemon::{Daemon, DaemonConfig};
pub use journal::Journal;
