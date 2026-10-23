// axe:repl — Settings > Outils (REPL modules/functions), compaction threshold
// and per-model output caps. Shared with the daemon through
// `<data>/repl-settings.json`.

use crate::*;

use axecode_app::repl::ReplSettings;
use axecode_repl::{python, HostHandler, Kernel, KernelSpec};

fn data_dir() -> std::result::Result<PathBuf, String> {
    axecode_daemon::util::default_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn repl_settings_get() -> std::result::Result<ReplSettings, String> {
    Ok(ReplSettings::load(&data_dir()?))
}

#[derive(Deserialize)]
pub(crate) struct ReplSettingsSaveInput {
    settings: ReplSettings,
}

#[tauri::command]
pub(crate) fn repl_settings_save(input: ReplSettingsSaveInput) -> std::result::Result<ReplSettings, String> {
    let dir = data_dir()?;
    input.settings.save(&dir).map_err(|e| e.to_string())?;
    Ok(ReplSettings::load(&dir))
}

struct NoHost;

#[async_trait::async_trait]
impl HostHandler for NoHost {
    async fn call(&self, method: &str, _params: Value, _exec: Option<String>) -> std::result::Result<Value, String> {
        Err(format!("{method} : indisponible en mode catalogue"))
    }
}

/// Full module catalog (enabled or not) with default docstrings, read from a
/// short-lived kernel with every module enabled.
#[tauri::command]
pub(crate) async fn repl_catalog(app: AppHandle) -> std::result::Result<Value, String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir);
    }
    let python = python::find_python(&dirs).ok_or("aucun interpréteur Python trouvé")?;
    let package_dir = python::find_package_dir(&dirs).ok_or("paquet axecode_kernel introuvable")?;
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let spec = KernelSpec {
        python: python.clone(),
        package_dir,
        workspace: std::env::temp_dir(),
        session_id: "catalog".into(),
        modules: json!({}),
        sys_path: vec![],
        env: vec![],
    };
    let kernel = Kernel::start(spec, Arc::new(NoHost), tx).await.map_err(|e| e.to_string())?;
    let catalog = kernel.catalog(true).await.map_err(|e| e.to_string());
    let info = kernel.info.clone();
    kernel.shutdown().await;
    Ok(json!({"modules": catalog?, "python": python, "kernel": info}))
}
