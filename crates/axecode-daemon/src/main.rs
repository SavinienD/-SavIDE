//! Standalone daemon binary (development / tests). The shipped app runs the
//! same service from its own executable (`axecode --daemon serve`), wired
//! with the REPL runtime; this binary only has the echo runtime.
//!
//! `axecode-daemon serve [--data-dir DIR] [--foreground]`
//! `axecode-daemon status|shutdown [--data-dir DIR] [--force]`

use std::sync::Arc;

use axecode_daemon::stub::EchoFactory;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    axecode_daemon::cli::run(args, Arc::new(EchoFactory)).await
}
