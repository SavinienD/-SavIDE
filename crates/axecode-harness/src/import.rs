//! One-shot import of the legacy "brain" kit (`<workspace>/brain/`) into the
//! harness. Idempotent: every imported entry carries `source:
//! import:brain:<relative path>` and is skipped when already present.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    model::{EntryKind, NewEntry, Scope},
    store::HarnessStore,
};

pub const BRAIN_DIR_NAME: &str = "brain";
pub const SOURCE_PREFIX: &str = "import:brain:";

/// One file the wizard proposes to import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainItem {
    /// Path relative to `brain/`, with forward slashes.
    pub relative_path: String,
    pub kind: EntryKind,
    pub scope: Scope,
    /// Whether the user may switch the scope (memory files).
    pub scope_choice: bool,
    pub title: String,
    pub bytes: u64,
    pub already_imported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainDetection {
    pub found: bool,
    pub brain_dir: String,
    pub items: Vec<BrainItem>,
    /// Plan files kept in place and referenced by a single prompt note.
    pub plans: Vec<String>,
    /// `AGENTS.md` still contains the legacy Setup-Brain ritual.
    pub agents_md_obsolete: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainImportOptions {
    /// Scope for `memory/memory.md` and `memory/corrections.md`.
    #[serde(default)]
    pub memory_scope: Option<Scope>,
    /// Relative paths to skip.
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainImportReport {
    pub created: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

pub fn agents_md_obsolete(workspace_root: &Path) -> bool {
    std::fs::read_to_string(workspace_root.join("AGENTS.md"))
        .map(|text| text.contains("Setup-Brain"))
        .unwrap_or(false)
}

fn classify(rel: &str, memory_scope: Scope) -> Option<(EntryKind, Scope, bool)> {
    let lower = rel.to_ascii_lowercase();
    if !lower.ends_with(".md") {
        return None;
    }
    if lower.starts_with("core/") {
        return Some((EntryKind::PromptNote, Scope::Global, false));
    }
    if lower == "memory/memory.md" || lower == "memory/corrections.md" {
        return Some((EntryKind::Memory, memory_scope, true));
    }
    if lower == "projects/active.md" || lower == "projects/next_session.md" || lower == "next_session.md" {
        return Some((EntryKind::Memory, Scope::Project, false));
    }
    if lower.starts_with("knowledge/") {
        return Some((EntryKind::PromptNote, Scope::Project, false));
    }
    None
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut rows: Vec<_> = read.flatten().collect();
    rows.sort_by_key(|e| e.file_name());
    for entry in rows {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, base, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push((rel.to_string_lossy().replace('\\', "/"), path));
        }
    }
}

fn title_for(rel: &str) -> String {
    let stem = rel.trim_end_matches(".md").trim_end_matches(".MD");
    format!("brain/{stem}")
}

fn imported_sources(store: &HarnessStore) -> Result<std::collections::HashSet<String>> {
    Ok(store
        .load_all()?
        .into_iter()
        .map(|entry| entry.meta.source)
        .filter(|source| source.starts_with(SOURCE_PREFIX))
        .collect())
}

pub fn detect(store: &HarnessStore, workspace_root: &Path, memory_scope: Option<Scope>) -> Result<BrainDetection> {
    let brain_dir = workspace_root.join(BRAIN_DIR_NAME);
    let mut detection = BrainDetection {
        found: brain_dir.is_dir(),
        brain_dir: brain_dir.display().to_string(),
        items: Vec::new(),
        plans: Vec::new(),
        agents_md_obsolete: agents_md_obsolete(workspace_root),
    };
    if !detection.found {
        return Ok(detection);
    }
    let done = imported_sources(store)?;
    let mut files = Vec::new();
    walk(&brain_dir, &brain_dir, &mut files);
    for (rel, path) in files {
        if rel.to_ascii_lowercase().starts_with("plans/") {
            detection.plans.push(rel);
            continue;
        }
        let Some((kind, scope, scope_choice)) = classify(&rel, memory_scope.unwrap_or(Scope::Global)) else {
            continue;
        };
        detection.items.push(BrainItem {
            already_imported: done.contains(&format!("{SOURCE_PREFIX}{rel}")),
            title: title_for(&rel),
            bytes: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            relative_path: rel,
            kind,
            scope,
            scope_choice,
        });
    }
    Ok(detection)
}

pub fn import(store: &HarnessStore, workspace_root: &Path, options: &BrainImportOptions) -> Result<BrainImportReport> {
    let detection = detect(store, workspace_root, options.memory_scope)?;
    let mut report = BrainImportReport::default();
    if !detection.found {
        return Ok(report);
    }
    let brain_dir = PathBuf::from(&detection.brain_dir);
    for item in &detection.items {
        if item.already_imported || options.exclude.contains(&item.relative_path) {
            report.skipped.push(item.relative_path.clone());
            continue;
        }
        let body = match std::fs::read_to_string(brain_dir.join(&item.relative_path)) {
            Ok(body) if !body.trim().is_empty() => body,
            Ok(_) => {
                report.skipped.push(item.relative_path.clone());
                continue;
            }
            Err(error) => {
                report.errors.push(format!("{}: {error}", item.relative_path));
                continue;
            }
        };
        let input = NewEntry {
            title: item.title.clone(),
            body: crate::model::parse_file(&body).body,
            source: Some(format!("{SOURCE_PREFIX}{}", item.relative_path)),
            evidence: vec![format!("brain/{}", item.relative_path)],
            tags: vec!["brain".into()],
            code: None,
        };
        match store.create(item.scope, item.kind, input) {
            Ok(entry) => report.created.push(entry.meta.id),
            Err(error) => report.errors.push(format!("{}: {error:#}", item.relative_path)),
        }
    }
    let plans_source = format!("{SOURCE_PREFIX}plans");
    if !detection.plans.is_empty() && !imported_sources(store)?.contains(&plans_source) {
        let list = detection
            .plans
            .iter()
            .map(|rel| format!("- `brain/{rel}`"))
            .collect::<Vec<_>>()
            .join("\n");
        let input = NewEntry {
            title: "brain/plans (archive)".into(),
            body: format!(
                "Plans from the legacy brain kit are kept in place. Read them on demand when the user refers to past plans:\n\n{list}"
            ),
            source: Some(plans_source),
            evidence: vec!["brain/plans/".into()],
            tags: vec!["brain".into(), "plan".into()],
            code: None,
        };
        match store.create(Scope::Project, EntryKind::PromptNote, input) {
            Ok(entry) => report.created.push(entry.meta.id),
            Err(error) => report.errors.push(format!("plans: {error:#}")),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HarnessPaths;

    #[test]
    fn imports_brain_once() {
        let root = std::env::temp_dir().join(format!("axecode-brain-{}", uuid::Uuid::new_v4().simple()));
        let ws = root.join("ws");
        let write = |rel: &str, text: &str| {
            let p = ws.join("brain").join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        write("core/identity.md", "I am Axe.");
        write("memory/memory.md", "Remember X.");
        write("projects/active.md", "Project Y.");
        write("knowledge/commands.md", "cmd Z.");
        write("plans/README.md", "plans");
        write("setup/Backup-Brain.ps1", "ignored");
        std::fs::write(ws.join("AGENTS.md"), "Run Setup-Brain.ps1").unwrap();
        let store = HarnessStore::new(HarnessPaths::with_home(&ws, Some(root.join("home"))));

        let det = detect(&store, &ws, None).unwrap();
        assert!(det.found && det.agents_md_obsolete);
        assert_eq!(det.items.len(), 4);
        assert_eq!(det.plans, vec!["plans/README.md".to_string()]);

        let opts = BrainImportOptions { memory_scope: Some(Scope::Project), exclude: vec![] };
        let report = import(&store, &ws, &opts).unwrap();
        assert_eq!(report.created.len(), 5, "{report:?}");
        let again = import(&store, &ws, &opts).unwrap();
        assert!(again.created.is_empty());
        assert_eq!(store.list(Some(EntryKind::Memory), Some(Scope::Project)).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }
}
