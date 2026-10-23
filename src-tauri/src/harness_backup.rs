// axe:cleanup — periodic harness backup (Settings > Harness > Sauvegarde).
//
// Copies the global harness (`~/.axecode/harness/`) and the project harness
// of every workspace registered here into `<dir>/<timestamp>/{global,projects/<name>}`.
// Config: `<data>/harness-backup.json`. Keeps the N most recent snapshots.

use crate::*;

use directories::ProjectDirs;
use axecode_harness::{store::copy_dir_recursive, HarnessStore, Scope};

const CONFIG_FILE: &str = "harness-backup.json";
const TICK: Duration = Duration::from_secs(60);

fn default_interval() -> u32 {
    60
}
fn default_keep() -> u32 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessBackupConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    dir: String,
    #[serde(default = "default_interval")]
    interval_minutes: u32,
    #[serde(default = "default_keep")]
    keep: u32,
    #[serde(default)]
    workspaces: Vec<String>,
    #[serde(default)]
    last_backup_ms: Option<i64>,
    #[serde(default)]
    last_error: Option<String>,
}

impl Default for HarnessBackupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            dir: String::new(),
            interval_minutes: default_interval(),
            keep: default_keep(),
            workspaces: Vec::new(),
            last_backup_ms: None,
            last_error: None,
        }
    }
}

fn config_path() -> std::result::Result<PathBuf, String> {
    ProjectDirs::from("fr", "savide", "savide")
        .map(|dirs| dirs.data_local_dir().join(CONFIG_FILE))
        .ok_or_else(|| "dossier de données local introuvable".to_string())
}

fn load_config() -> HarnessBackupConfig {
    config_path()
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_config(config: &HarnessBackupConfig) -> std::result::Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|err| err.to_string())?;
    fs::write(path, bytes).map_err(|err| err.to_string())
}

fn safe_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".into());
    let mut hash: u32 = 2166136261;
    for b in path.to_string_lossy().bytes() {
        hash = (hash ^ b as u32).wrapping_mul(16777619);
    }
    format!("{name}-{hash:08x}")
}

fn run_backup(config: &HarnessBackupConfig) -> std::result::Result<PathBuf, String> {
    let dir = PathBuf::from(config.dir.trim());
    if config.dir.trim().is_empty() {
        return Err("aucun dossier de sauvegarde choisi".into());
    }
    let stamp = format!("harness-{}", now_ms());
    let target = dir.join(&stamp);
    let mut copied = 0;
    let global = HarnessStore::open(std::env::temp_dir());
    let global_root = global.paths().root(Scope::Global).to_path_buf();
    if global_root.is_dir() {
        copy_dir_recursive(&global_root, &target.join("global")).map_err(|err| err.to_string())?;
        copied += 1;
    }
    for workspace in &config.workspaces {
        let root = PathBuf::from(workspace);
        let project = HarnessStore::open(&root).paths().root(Scope::Project).to_path_buf();
        if project.is_dir() {
            copy_dir_recursive(&project, &target.join("projects").join(safe_name(&root)))
                .map_err(|err| err.to_string())?;
            copied += 1;
        }
    }
    if copied == 0 {
        return Err("aucun harnais à sauvegarder".into());
    }
    prune(&dir, config.keep.max(1) as usize);
    Ok(target)
}

fn prune(dir: &Path, keep: usize) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut snapshots: Vec<PathBuf> = read
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("harness-")))
        .collect();
    snapshots.sort();
    while snapshots.len() > keep {
        let old = snapshots.remove(0);
        let _ = fs::remove_dir_all(old);
    }
}

fn record(result: &std::result::Result<PathBuf, String>) -> HarnessBackupConfig {
    let mut config = load_config();
    match result {
        Ok(_) => {
            config.last_backup_ms = Some(now_ms());
            config.last_error = None;
        }
        Err(err) => config.last_error = Some(err.clone()),
    }
    let _ = save_config(&config);
    config
}

/// Background loop: back up when enabled and the interval elapsed.
pub(crate) fn start_harness_backup_loop() {
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(TICK).await;
            let config = load_config();
            if !config.enabled || config.dir.trim().is_empty() {
                continue;
            }
            let due = config
                .last_backup_ms
                .map(|last| now_ms() - last >= i64::from(config.interval_minutes.max(5)) * 60_000)
                .unwrap_or(true);
            if due {
                let result = tauri::async_runtime::spawn_blocking(move || run_backup(&config))
                    .await
                    .unwrap_or_else(|err| Err(err.to_string()));
                record(&result);
            }
        }
    });
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessBackupInput {
    workspace_path: Option<String>,
    enabled: bool,
    dir: String,
    interval_minutes: u32,
    keep: u32,
}

fn register_workspace(config: &mut HarnessBackupConfig, workspace_path: Option<&str>) {
    if let Some(path) = workspace_path.filter(|p| !p.trim().is_empty()) {
        if let Ok(root) = normalize_workspace_root(path) {
            let root = root.display().to_string();
            if !config.workspaces.contains(&root) {
                config.workspaces.push(root);
            }
        }
    }
}

#[tauri::command]
pub(crate) fn harness_backup_get(workspace_path: Option<String>) -> HarnessBackupConfig {
    let mut config = load_config();
    let before = config.workspaces.len();
    register_workspace(&mut config, workspace_path.as_deref());
    if config.workspaces.len() != before {
        let _ = save_config(&config);
    }
    config
}

#[tauri::command]
pub(crate) fn harness_backup_set(input: HarnessBackupInput) -> std::result::Result<HarnessBackupConfig, String> {
    let mut config = load_config();
    config.enabled = input.enabled;
    config.dir = input.dir.trim().to_string();
    config.interval_minutes = input.interval_minutes.clamp(5, 7 * 24 * 60);
    config.keep = input.keep.clamp(1, 500);
    register_workspace(&mut config, input.workspace_path.as_deref());
    save_config(&config)?;
    Ok(config)
}

#[tauri::command]
pub(crate) async fn harness_backup_run(workspace_path: Option<String>) -> std::result::Result<HarnessBackupConfig, String> {
    let mut config = load_config();
    register_workspace(&mut config, workspace_path.as_deref());
    save_config(&config)?;
    let result = tauri::async_runtime::spawn_blocking(move || run_backup(&config))
        .await
        .map_err(|err| err.to_string())?;
    let config = record(&result);
    result.map(|_| config)
}
