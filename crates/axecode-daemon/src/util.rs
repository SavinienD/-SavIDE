use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Local data directory shared with the desktop app (same ProjectDirs).
pub fn default_data_dir() -> anyhow::Result<PathBuf> {
    let dirs = directories::ProjectDirs::from("fr", "savide", "savide")
        .ok_or_else(|| anyhow::anyhow!("unable to resolve local data directory"))?;
    let dir = dirs.data_local_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
