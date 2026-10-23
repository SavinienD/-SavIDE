//! Shared command line of the daemon (`serve`, `status`, `shutdown`), used by
//! the standalone `axecode-daemon` binary and by the app executable in
//! `--daemon` mode.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::json;
use axecode_core::SessionRuntimeFactory;

use crate::{client, server, util, Daemon, DaemonConfig};

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

// axe:remote
fn arg_values(args: &[String], flag: &str) -> Vec<String> {
    args.windows(2)
        .filter(|w| w[0] == flag)
        .map(|w| w[1].clone())
        .collect()
}
// axe:remote end

// axe:migration
fn is_default_data_dir(data_dir: &std::path::Path) -> bool {
    let default = directories::ProjectDirs::from("fr", "savide", "savide")
        .and_then(|dirs| dirs.data_local_dir().canonicalize().ok());
    default.is_some() && default == data_dir.canonicalize().ok()
}

/// `args` excludes the program name (and the `--daemon` marker).
pub async fn run(args: Vec<String>, factory: Arc<dyn SessionRuntimeFactory>) -> anyhow::Result<()> {
    let command = args.first().cloned().unwrap_or_else(|| "serve".into());
    let data_dir = match arg_value(&args, "--data-dir") {
        Some(dir) => PathBuf::from(dir),
        None => util::default_data_dir()?,
    };
    match command.as_str() {
        "serve" => {
            let log_dir = data_dir.join("logs");
            std::fs::create_dir_all(&log_dir)?;
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_dir.join("daemon.log"))?;
            let _ = tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "info".into()),
                )
                .with_writer(Mutex::new(log))
                .with_ansi(false)
                .try_init();
            if client::connect_existing(&data_dir, None).await.is_some() {
                tracing::info!("a daemon is already running for this data dir");
                return Ok(());
            }
            // axe:migration — a service started without the desktop app (spaces
            // of the VM) migrates the data of the old name itself: a no-op once
            // done, skipped for any other data folder (tests).
            if is_default_data_dir(&data_dir) {
                axecode_app::migration::run_at_startup();
            }
            let mut config = DaemonConfig::new(data_dir.clone());
            config.auto_shutdown = !args.iter().any(|a| a == "--foreground");
            // axe:v2-l2 — set by the service unit or the environment, never by a client request.
            let workspace_root = arg_value(&args, "--workspace-root")
                .or_else(|| axecode_core::env::var("AXECODE_WORKSPACE_ROOT").ok())
                .filter(|v| !v.trim().is_empty());
            if let Some(root) = workspace_root {
                let root = PathBuf::from(root).canonicalize()?;
                anyhow::ensure!(root.is_dir(), "--workspace-root must be a directory");
                config.workspace_root = Some(root);
            }
            // axe:v2-l4 — service-wide shared space, same rule.
            let shared_root = arg_value(&args, "--shared-root")
                .or_else(|| axecode_core::env::var("AXECODE_SHARED_ROOT").ok())
                .filter(|v| !v.trim().is_empty());
            if let Some(root) = shared_root {
                let root = PathBuf::from(root).canonicalize()?;
                anyhow::ensure!(root.is_dir(), "--shared-root must be a directory");
                config.shared_root = Some(root);
            }
            // axe:remote — `--listen host:port [--allow-host name]...`
            if let Some(addr) = arg_value(&args, "--listen") {
                let hosts = arg_values(&args, "--allow-host");
                config.listen = Some(crate::listen::ListenConfig::parse(&addr, hosts)?);
                // A network service must outlive its clients.
                config.auto_shutdown = false;
            }
            // axe:remote end
            crate::migrate::import_legacy_once(&data_dir);
            let daemon = Daemon::new(config, factory);
            server::run(daemon).await
        }
        "status" | "shutdown" => {
            let Some(client) = client::connect_existing(&data_dir, None).await else {
                println!("{}", json!({"running": false}));
                return Ok(());
            };
            let result = if command == "status" {
                client.call("status", json!({})).await
            } else {
                let force = args.iter().any(|a| a == "--force");
                client.call("shutdown", json!({"force": force})).await
            };
            match result {
                Ok(value) => println!("{value}"),
                Err(err) => anyhow::bail!(err),
            }
            Ok(())
        }
        // axe:remote
        "set-password" | "token" | "auth" => crate::auth::run_cli(&command, &args, &data_dir),
        // axe:remote end
        other => anyhow::bail!("unknown command {other}"),
    }
}
