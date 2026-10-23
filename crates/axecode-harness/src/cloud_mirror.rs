//! axe:shared-brain — read-only mirror of the Axe Cloud space's GLOBAL harness.
//!
//! The global harness lives on each PC (`~/.axecode/harness`): a colleague who
//! installs the app starts with nothing. When the `axe-cloud` connection is up,
//! the app fetches the space's global entries (`harness.list` RPC) and writes
//! them here (`~/.axecode/harness-cloud-mirror.json`, outside the harness
//! folder so the store never lists them as local entries). The per-turn layer
//! ([`crate::refine::harness_layer`]) merges them as globals; local entries win
//! on the same id or the same (kind, title). Skills are excluded: their Python
//! package is not on the PC.

use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{Entry, EntryKind, HarnessPaths, Scope};

pub const CLOUD_MIRROR_FILE_NAME: &str = "harness-cloud-mirror.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMirror {
    /// Connection the entries come from (`axe-cloud`).
    #[serde(default)]
    pub connection: String,
    /// Unix milliseconds of the last successful fetch.
    #[serde(default)]
    pub fetched_at: i64,
    #[serde(default)]
    pub entries: Vec<Entry>,
}

pub fn mirror_path(paths: &HarnessPaths) -> PathBuf {
    let root = paths.root(Scope::Global);
    root.parent().unwrap_or(root).join(CLOUD_MIRROR_FILE_NAME)
}

/// Tolerant read: missing or malformed file = no mirror.
pub fn read(paths: &HarnessPaths) -> CloudMirror {
    std::fs::read_to_string(mirror_path(paths))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Atomic write. Only global, non-skill entries are kept, marked `scope: global`
/// and with an `axe-cloud:` path (they are never files on the PC).
pub fn write(paths: &HarnessPaths, connection: &str, entries: Vec<Entry>) -> Result<CloudMirror> {
    let entries = entries
        .into_iter()
        .filter(|e| e.meta.scope == Scope::Global && e.meta.kind != EntryKind::Skill)
        .map(|mut e| {
            e.path = format!("{connection}:{}", e.meta.id);
            e.package_dir = None;
            e
        })
        .collect();
    let mirror = CloudMirror {
        connection: connection.to_string(),
        fetched_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        entries,
    };
    let path = mirror_path(paths);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&mirror)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(mirror)
}

pub fn clear(paths: &HarnessPaths) -> Result<()> {
    match std::fs::remove_file(mirror_path(paths)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Mirror entries not shadowed by a local entry (same id, or same kind+title).
pub fn merge_into(local: &mut Vec<Entry>, mirror: &CloudMirror) {
    let extra: Vec<Entry> = mirror
        .entries
        .iter()
        .filter(|m| m.meta.kind != EntryKind::Skill)
        .filter(|m| {
            !local.iter().any(|l| {
                l.meta.id == m.meta.id
                    || (l.meta.kind == m.meta.kind && l.meta.title.trim() == m.meta.title.trim())
            })
        })
        .cloned()
        .map(|mut e| {
            e.meta.scope = Scope::Global;
            e
        })
        .collect();
    local.extend(extra);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HarnessStore, NewEntry};

    #[test]
    fn mirror_roundtrip_and_merge() {
        let dir = std::env::temp_dir().join(format!("mirror-{}", uuid::Uuid::new_v4().simple()));
        let paths = HarnessPaths::with_home(dir.join("ws"), Some(dir.join("home")));
        let store = HarnessStore::new(paths.clone());
        let local = store
            .create(Scope::Global, EntryKind::PromptNote, NewEntry { title: "Same".into(), body: "local".into(), ..Default::default() })
            .unwrap();
        // Remote entries: one shadowed by title, one new, one skill (dropped).
        let mut shadow = local.clone();
        shadow.meta.id = "note_remote1".into();
        shadow.body = "remote".into();
        let mut fresh = local.clone();
        fresh.meta.id = "mem_remote2".into();
        fresh.meta.kind = EntryKind::Memory;
        fresh.meta.title = "Shared fact".into();
        let mut skill = local.clone();
        skill.meta.id = "skill_x".into();
        skill.meta.kind = EntryKind::Skill;
        write(&paths, "axe-cloud", vec![shadow, fresh, skill]).unwrap();
        let mirror = read(&paths);
        assert_eq!(mirror.entries.len(), 2);
        let mut all = store.load_all().unwrap();
        merge_into(&mut all, &mirror);
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|e| e.meta.id == "mem_remote2" && e.path == "axe-cloud:mem_remote2"));
        assert!(all.iter().all(|e| e.body != "remote"));
        let layer = crate::refine::harness_layer(&store).unwrap().unwrap();
        assert!(layer.contains("Shared fact"));
        clear(&paths).unwrap();
        assert!(read(&paths).entries.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
