//! `/refine`: two-phase pipeline.
//!
//! 1. **Planning** (background): one model call receives the current
//!    trajectory and the harness state and proposes the *smallest useful*
//!    CRUD as strict JSON.
//! 2. **Application** (fast, next turn): the plan is applied to the files,
//!    with a snapshot of every touched file so it can be rolled back by id.
//!
//! Every refinement is appended to `<scope>/refinements.jsonl`.

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use axecode_core::{ChatMessage, ModelRef, Part, Provider, ProviderRequest, Role, StreamEvent};

use crate::{
    inject,
    model::{now_ms, Entry, EntryKind, EntryPatch, NewEntry, Scope},
    store::{copy_dir_recursive, HarnessStore},
};

pub const REFINEMENTS_FILE_NAME: &str = "refinements.jsonl";
pub const REFINEMENTS_DIR_NAME: &str = "refinements";
/// Characters of trajectory sent to the planner.
pub const MAX_TRAJECTORY_CHARS: usize = 60_000;
const MAX_MESSAGE_CHARS: usize = 4_000;

// ---------------------------------------------------------------------------
// Plan format (what the model must return)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Create,
    Update,
    Delete,
    Promote,
    Demote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineOp {
    pub op: OpKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<EntryKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinePlan {
    /// One sentence explaining the change (or why nothing changes).
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub operations: Vec<RefineOp>,
    /// Trajectory excerpts justifying the change.
    #[serde(default)]
    pub evidence: Vec<String>,
}

impl RefinePlan {
    pub fn is_noop(&self) -> bool {
        self.operations.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Journal record
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefineOutcome {
    Applied,
    Noop,
    Failed,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// `created`, `modified`, `deleted`
    pub change: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinementRecord {
    pub id: String,
    pub ts: i64,
    /// Scope root that owns this record (where the jsonl + snapshot live).
    pub scope: Scope,
    /// `user:/refine`, `agent:refine.run`, `auto:repeated_failure`, ...
    pub trigger: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub operations: Vec<RefineOp>,
    #[serde(default)]
    pub diff: Vec<FileDiff>,
    pub outcome: RefineOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Entry ids touched (created / updated / deleted / moved).
    #[serde(default)]
    pub touched_ids: Vec<String>,
    /// Relative snapshot dir (`refinements/<id>`), present when applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rolled_back_at: Option<i64>,
}

/// Snapshot manifest: for every absolute path touched, whether it existed
/// before and where its backup copy lives.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    files: Vec<SnapshotFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    path: String,
    existed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backup: Option<String>,
}

// ---------------------------------------------------------------------------
// Phase 1 — planning
// ---------------------------------------------------------------------------

pub const PLANNER_SYSTEM_PROMPT: &str = r#"You are the harness refiner of a coding agent. You receive the agent's current trajectory (user + assistant messages, REPL calls and their outputs) and the current harness (prompt notes, memories, skills, sub-agent specs, each with an id and a scope).

Your job: propose the SMALLEST useful change to the harness so that the next session goes better. Prefer:
- a `memory` when a fact, path, command or decision was discovered the hard way and will be needed again;
- a `prompt_note` when the user corrected the agent's behaviour or stated a lasting preference;
- a `skill` only when a reusable, multi-step tactic emerged and can be captured as Python helpers + instructions;
- an `update` of an existing entry instead of a new one when the subject already exists;
- a `delete` when an entry is proven wrong or obsolete;
- `promote` (project → global) only for things that are clearly not project-specific; `demote` for the opposite.

Scope rule: identity, preferences, general rules and cross-project corrections are `global`; everything tied to this codebase is `project`.

If a focus is given, restrict yourself to it. If nothing is worth recording, return zero operations.

Return ONLY a JSON object, no prose, no Markdown fences, with this exact shape:
{
  "summary": "one sentence",
  "evidence": ["short verbatim excerpts from the trajectory that justify the change"],
  "operations": [
    {"op": "create", "kind": "memory|prompt_note|skill|subagent_spec", "scope": "global|project", "title": "...", "body": "markdown", "code": "python source, skills only", "evidence": ["..."], "reason": "..."},
    {"op": "update", "id": "existing id", "title": "optional", "body": "optional full replacement", "evidence": ["..."], "reason": "..."},
    {"op": "delete", "id": "existing id", "reason": "..."},
    {"op": "promote", "id": "existing id", "reason": "..."},
    {"op": "demote", "id": "existing id", "reason": "..."}
  ]
}
Keep bodies short and actionable (bullets, commands, paths). Never repeat the base system prompt. At most 3 operations."#;

pub fn render_trajectory(history: &[ChatMessage]) -> String {
    let mut blocks: Vec<String> = Vec::new();
    for message in history {
        let role = match message.role {
            Role::User => "USER",
            Role::Assistant => "ASSISTANT",
        };
        for part in &message.parts {
            let text = match part {
                Part::Text { text, meta } => {
                    if meta
                        .as_ref()
                        .and_then(|m| m.get("compaction_summary"))
                        .is_some()
                    {
                        format!("[compaction summary]\n{text}")
                    } else {
                        text.clone()
                    }
                }
                Part::Thinking { .. } => continue,
                Part::Image { .. } => "[image]".to_string(),
                Part::ToolCall { name, input, .. } => {
                    let code = input
                        .get("code")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| input.to_string());
                    format!("[call {name}]\n{code}")
                }
                Part::ToolResult {
                    content, is_error, ..
                } => format!("[result{}]\n{content}", if *is_error { " ERROR" } else { "" }),
            };
            let text = truncate_middle(text.trim(), MAX_MESSAGE_CHARS);
            if text.is_empty() {
                continue;
            }
            blocks.push(format!("### {role}\n{text}"));
        }
    }
    let mut out = blocks.join("\n\n");
    if out.chars().count() > MAX_TRAJECTORY_CHARS {
        let keep: String = out
            .chars()
            .rev()
            .take(MAX_TRAJECTORY_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        out = format!("[earlier trajectory omitted]\n\n{keep}");
    }
    out
}

fn truncate_middle(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let half = max_chars / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(count - half).collect();
    format!("{head}\n[… {} chars omitted …]\n{tail}", count - max_chars)
}

pub fn render_harness_state(entries: &[Entry]) -> String {
    if entries.is_empty() {
        return "(empty harness)".to_string();
    }
    let mut out = String::new();
    for entry in entries {
        out.push_str(&format!(
            "- id={} kind={} scope={} title={:?}\n  {}\n",
            entry.meta.id,
            entry.meta.kind,
            entry.meta.scope,
            entry.meta.title,
            truncate_middle(entry.body.trim(), 600).replace('\n', "\n  ")
        ));
    }
    out
}

pub fn build_planner_request(
    model: ModelRef,
    history: &[ChatMessage],
    entries: &[Entry],
    focus: Option<&str>,
) -> ProviderRequest {
    let mut user = String::new();
    if let Some(focus) = focus.map(str::trim).filter(|f| !f.is_empty()) {
        user.push_str(&format!("# Focus\n{focus}\n\n"));
    }
    user.push_str("# Current harness\n");
    user.push_str(&render_harness_state(entries));
    user.push_str("\n\n# Trajectory\n");
    user.push_str(&render_trajectory(history));
    user.push_str("\n\nReturn the JSON object now.");
    ProviderRequest::new(model, vec![ChatMessage::user_text(user)])
        .with_system(PLANNER_SYSTEM_PROMPT.to_string())
}

/// Run the planning call and parse the strict JSON answer.
pub async fn plan(
    provider: &dyn Provider,
    model: ModelRef,
    history: &[ChatMessage],
    entries: &[Entry],
    focus: Option<&str>,
) -> Result<RefinePlan> {
    let request = build_planner_request(model, history, entries, focus);
    let mut stream = provider.stream(request).await?;
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event? {
            StreamEvent::TextDelta { delta, .. } => text.push_str(&delta),
            StreamEvent::MessageStop { .. } => break,
            _ => {}
        }
    }
    parse_plan(&text)
}

pub fn parse_plan(text: &str) -> Result<RefinePlan> {
    let trimmed = text.trim();
    let candidates = [
        trimmed.to_string(),
        strip_fences(trimmed),
        extract_braces(trimmed).unwrap_or_default(),
    ];
    let mut last_err = None;
    for candidate in candidates.iter().filter(|c| !c.is_empty()) {
        match serde_json::from_str::<RefinePlan>(candidate) {
            Ok(mut plan) => {
                plan.operations.truncate(3);
                return Ok(plan);
            }
            Err(err) => last_err = Some(err),
        }
    }
    Err(anyhow!(
        "planner returned invalid JSON: {}",
        last_err.map(|e| e.to_string()).unwrap_or_else(|| "empty answer".into())
    ))
}

fn strip_fences(text: &str) -> String {
    let mut s = text.trim();
    if let Some(rest) = s.strip_prefix("```") {
        s = rest;
        if let Some(idx) = s.find('\n') {
            s = &s[idx + 1..];
        }
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest;
    }
    s.trim().to_string()
}

fn extract_braces(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| text[start..=end].to_string())
}

// ---------------------------------------------------------------------------
// Phase 2 — application + journal + rollback
// ---------------------------------------------------------------------------

pub struct ApplyInput<'a> {
    pub plan: &'a RefinePlan,
    pub trigger: &'a str,
    pub focus: Option<&'a str>,
    pub conversation_id: Option<&'a str>,
}

/// Apply a plan to the store, snapshotting every touched file first.
pub fn apply(store: &HarnessStore, input: ApplyInput<'_>) -> Result<RefinementRecord> {
    let plan = input.plan;
    let id = format!("ref_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let record_scope = dominant_scope(store, plan);
    let mut record = RefinementRecord {
        id: id.clone(),
        ts: now_ms(),
        scope: record_scope,
        trigger: input.trigger.to_string(),
        focus: input.focus.map(str::to_string),
        conversation_id: input.conversation_id.map(str::to_string),
        summary: plan.summary.clone(),
        evidence: plan.evidence.clone(),
        operations: plan.operations.clone(),
        diff: Vec::new(),
        outcome: RefineOutcome::Noop,
        error: None,
        touched_ids: Vec::new(),
        snapshot: None,
        rolled_back_at: None,
    };

    if plan.is_noop() {
        append_record(store, &record)?;
        return Ok(record);
    }

    // Snapshot: collect the files each op may touch.
    let snapshot_dir = store
        .paths()
        .root(record_scope)
        .join(REFINEMENTS_DIR_NAME)
        .join(&id);
    let mut manifest = SnapshotManifest::default();
    let mut before: BTreeMap<String, Option<String>> = BTreeMap::new();
    for op in &plan.operations {
        for path in paths_touched_before(store, op)? {
            snapshot_path(&snapshot_dir, &path, &mut manifest, &mut before)?;
        }
    }

    // Apply.
    let mut after_paths: Vec<PathBuf> = Vec::new();
    let mut error: Option<String> = None;
    for op in &plan.operations {
        match apply_op(store, op, &id) {
            Ok(touched) => {
                for (entry_id, paths) in touched {
                    record.touched_ids.push(entry_id);
                    after_paths.extend(paths);
                }
            }
            Err(err) => {
                error = Some(err.to_string());
                break;
            }
        }
    }

    // Files created by the ops (not in the before-set) must be removable on rollback.
    for path in &after_paths {
        let key = path.display().to_string();
        if !before.contains_key(&key) {
            snapshot_path(&snapshot_dir, path, &mut manifest, &mut before)?;
            // Mark as non-existing before (it was created by this refinement).
            if let Some(file) = manifest.files.iter_mut().find(|f| f.path == key) {
                file.existed = false;
                file.backup = None;
            }
            before.insert(key, None);
        }
    }
    fs::create_dir_all(&snapshot_dir)?;
    fs::write(
        snapshot_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    record.snapshot = Some(format!("{REFINEMENTS_DIR_NAME}/{id}"));

    // Diff.
    for (path, old) in &before {
        let new = fs::read_to_string(path).ok();
        let change = match (old.is_some(), new.is_some()) {
            (false, true) => "created",
            (true, false) => "deleted",
            (true, true) if old == &new => continue,
            (true, true) => "modified",
            (false, false) => continue,
        };
        record.diff.push(FileDiff {
            path: crate::os_path(Path::new(path)).display().to_string(),
            change: change.into(),
            before_excerpt: old.as_deref().map(|s| truncate_middle(s, 800)),
            after_excerpt: new.as_deref().map(|s| truncate_middle(s, 800)),
        });
    }

    record.outcome = if let Some(err) = error {
        record.error = Some(err);
        // Best effort: undo what was applied so a failed plan leaves no trace.
        let _ = restore_snapshot(&snapshot_dir, &manifest);
        RefineOutcome::Failed
    } else {
        RefineOutcome::Applied
    };
    append_record(store, &record)?;
    Ok(record)
}

fn dominant_scope(store: &HarnessStore, plan: &RefinePlan) -> Scope {
    let mut global = 0;
    let mut project = 0;
    for op in &plan.operations {
        let scope = match op.op {
            OpKind::Create => op.scope,
            OpKind::Promote => Some(Scope::Global),
            OpKind::Demote => Some(Scope::Project),
            _ => op
                .id
                .as_deref()
                .and_then(|id| store.get(id).ok().flatten())
                .map(|e| e.meta.scope),
        };
        match scope {
            Some(Scope::Global) => global += 1,
            _ => project += 1,
        }
    }
    if global > project {
        Scope::Global
    } else {
        Scope::Project
    }
}

fn paths_touched_before(store: &HarnessStore, op: &RefineOp) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    if let Some(id) = op.id.as_deref() {
        if let Some(existing) = store.get(id)? {
            // axe:migration - files of the project harness of before the rename
            // are never written, so never snapshotted nor restored.
            out.extend(entry_files(&existing).into_iter().filter(|path| !store.paths().is_legacy_path(path)));
        }
    }
    Ok(out)
}

fn entry_files(entry: &Entry) -> Vec<PathBuf> {
    match &entry.package_dir {
        Some(dir) => list_files(Path::new(dir)),
        None => vec![PathBuf::from(&entry.path)],
    }
}

fn list_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(read) = fs::read_dir(dir) else {
        return out;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(list_files(&path));
        } else {
            out.push(path);
        }
    }
    out
}

fn snapshot_path(
    snapshot_dir: &Path,
    path: &Path,
    manifest: &mut SnapshotManifest,
    before: &mut BTreeMap<String, Option<String>>,
) -> Result<()> {
    let key = path.display().to_string();
    if before.contains_key(&key) {
        return Ok(());
    }
    let content = fs::read_to_string(path).ok();
    let existed = path.exists();
    let backup = if existed {
        let name = format!("{}.bak", manifest.files.len());
        let target = snapshot_dir.join("files").join(&name);
        fs::create_dir_all(target.parent().unwrap())?;
        fs::copy(path, &target)
            .with_context(|| format!("unable to snapshot {}", path.display()))?;
        Some(format!("files/{name}"))
    } else {
        None
    };
    manifest.files.push(SnapshotFile {
        path: key.clone(),
        existed,
        backup,
    });
    before.insert(key, content);
    Ok(())
}

fn restore_snapshot(snapshot_dir: &Path, manifest: &SnapshotManifest) -> Result<()> {
    for file in &manifest.files {
        let path = Path::new(&file.path);
        if file.existed {
            let backup = snapshot_dir.join(file.backup.as_deref().unwrap_or_default());
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&backup, path)
                .with_context(|| format!("unable to restore {}", path.display()))?;
        } else if path.exists() {
            fs::remove_file(path).with_context(|| format!("unable to remove {}", path.display()))?;
            // Remove the package folder if it became empty (skills).
            if let Some(parent) = path.parent() {
                if fs::read_dir(parent).map(|mut d| d.next().is_none()).unwrap_or(false) {
                    let _ = fs::remove_dir(parent);
                }
            }
        }
    }
    Ok(())
}

/// Apply one op; returns (entry id, files now belonging to the entry).
fn apply_op(store: &HarnessStore, op: &RefineOp, refinement_id: &str) -> Result<Vec<(String, Vec<PathBuf>)>> {
    let source = format!("refine:{refinement_id}");
    match op.op {
        OpKind::Create => {
            let kind = op.kind.ok_or_else(|| anyhow!("create: `kind` is required"))?;
            let scope = op.scope.unwrap_or(Scope::Project);
            let entry = store.create(
                scope,
                kind,
                NewEntry {
                    title: op.title.clone().unwrap_or_default(),
                    body: op.body.clone().unwrap_or_default(),
                    source: Some(source),
                    evidence: op.evidence.clone(),
                    tags: Vec::new(),
                    code: op.code.clone(),
                },
            )?;
            Ok(vec![(entry.meta.id.clone(), entry_files(&entry))])
        }
        OpKind::Update => {
            let id = op.id.as_deref().ok_or_else(|| anyhow!("update: `id` is required"))?;
            let entry = store.update(
                id,
                EntryPatch {
                    title: op.title.clone(),
                    body: op.body.clone(),
                    evidence: if op.evidence.is_empty() { None } else { Some(op.evidence.clone()) },
                    tags: None,
                    source: Some(source),
                    code: op.code.clone(),
                },
            )?;
            Ok(vec![(entry.meta.id.clone(), entry_files(&entry))])
        }
        OpKind::Delete => {
            let id = op.id.as_deref().ok_or_else(|| anyhow!("delete: `id` is required"))?;
            let entry = store.delete(id)?;
            Ok(vec![(entry.meta.id, Vec::new())])
        }
        OpKind::Promote | OpKind::Demote => {
            let id = op.id.as_deref().ok_or_else(|| anyhow!("promote/demote: `id` is required"))?;
            let entry = if op.op == OpKind::Promote { store.promote(id)? } else { store.demote(id)? };
            Ok(vec![(entry.meta.id.clone(), entry_files(&entry))])
        }
    }
}

fn append_record(store: &HarnessStore, record: &RefinementRecord) -> Result<()> {
    let root = store.paths().root(record.scope);
    fs::create_dir_all(root)?;
    let path = root.join(REFINEMENTS_FILE_NAME);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("unable to open {}", path.display()))?;
    let line = serde_json::to_string(record)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

/// Read all records (both scopes), newest first. Later lines for the same id
/// (rollback markers) override earlier ones.
pub fn history(store: &HarnessStore) -> Result<Vec<RefinementRecord>> {
    let mut by_id: HashMap<String, RefinementRecord> = HashMap::new();
    for scope in Scope::ALL {
        let path = store.paths().root(scope).join(REFINEMENTS_FILE_NAME);
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<RefinementRecord>(line) {
                Ok(record) => {
                    by_id.insert(record.id.clone(), record);
                }
                Err(err) => tracing::warn!(error = %err, "skipping malformed refinement line"),
            }
        }
    }
    let mut out: Vec<RefinementRecord> = by_id.into_values().collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

/// Restore the files of a refinement from its snapshot and journal it.
pub fn rollback(store: &HarnessStore, id: &str) -> Result<RefinementRecord> {
    let mut record = history(store)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| anyhow!("refinement `{id}` not found"))?;
    if record.outcome == RefineOutcome::RolledBack {
        bail!("refinement `{id}` is already rolled back");
    }
    if record.outcome != RefineOutcome::Applied {
        bail!("refinement `{id}` was not applied (outcome: {:?})", record.outcome);
    }
    let Some(rel) = record.snapshot.as_deref() else {
        bail!("refinement `{id}` has no snapshot");
    };
    let snapshot_dir = store.paths().root(record.scope).join(rel);
    let manifest: SnapshotManifest = serde_json::from_str(
        &fs::read_to_string(snapshot_dir.join("manifest.json"))
            .with_context(|| format!("snapshot of `{id}` is missing"))?,
    )?;
    // Files created after the snapshot inside skill packages (e.g. promote
    // copies) are handled by removing now-empty folders in restore_snapshot.
    restore_snapshot(&snapshot_dir, &manifest)?;
    // Skill moves: the destination package may hold extra files; drop it when
    // every manifest file under it was created by this refinement.
    for file in &manifest.files {
        if file.existed {
            continue;
        }
        if let Some(parent) = Path::new(&file.path).parent() {
            if parent.file_name().is_some_and(|n| n != "notes" && n != "memories" && n != "subagents" && n != "skills")
                && parent.exists()
                && manifest.files.iter().all(|f| !f.existed || !Path::new(&f.path).starts_with(parent))
            {
                let _ = fs::remove_dir_all(parent);
            }
        }
    }
    let _ = store.load_all();
    record.outcome = RefineOutcome::RolledBack;
    record.rolled_back_at = Some(now_ms());
    append_record(store, &record)?;
    Ok(record)
}

// ---------------------------------------------------------------------------
// Runner: background planning + pending plans applied at the next turn
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingState {
    Planning,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRefinement {
    pub conversation_id: String,
    pub trigger: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
    pub started_at: i64,
    pub state: PendingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<RefinePlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Status returned to the kernel / UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingRefinement>,
    pub recent: Vec<RefinementRecord>,
}

/// In-memory coordinator shared by the app. One pending refinement per
/// conversation; planning runs on a tokio task.
#[derive(Clone, Default)]
pub struct RefineRunner {
    pending: Arc<Mutex<HashMap<String, PendingRefinement>>>,
}

impl RefineRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending(&self, conversation_id: &str) -> Option<PendingRefinement> {
        self.pending.lock().ok()?.get(conversation_id).cloned()
    }

    pub fn status(&self, store: &HarnessStore, conversation_id: &str) -> Result<RefineStatus> {
        let mut recent = history(store)?;
        recent.truncate(20);
        Ok(RefineStatus {
            pending: self.pending(conversation_id),
            recent,
        })
    }

    /// Start planning in the background. Returns `false` when a refinement is
    /// already planning for this conversation.
    pub fn start(
        &self,
        provider: Arc<dyn Provider>,
        model: ModelRef,
        store: HarnessStore,
        conversation_id: String,
        history: Vec<ChatMessage>,
        trigger: String,
        focus: Option<String>,
    ) -> bool {
        {
            let mut pending = match self.pending.lock() {
                Ok(p) => p,
                Err(_) => return false,
            };
            if pending
                .get(&conversation_id)
                .is_some_and(|p| p.state == PendingState::Planning)
            {
                return false;
            }
            pending.insert(
                conversation_id.clone(),
                PendingRefinement {
                    conversation_id: conversation_id.clone(),
                    trigger: trigger.clone(),
                    focus: focus.clone(),
                    started_at: now_ms(),
                    state: PendingState::Planning,
                    plan: None,
                    error: None,
                },
            );
        }
        let pending = self.pending.clone();
        tokio::spawn(async move {
            let entries = store.load_all().unwrap_or_default();
            let result = plan(provider.as_ref(), model, &history, &entries, focus.as_deref()).await;
            if let Ok(mut map) = pending.lock() {
                if let Some(slot) = map.get_mut(&conversation_id) {
                    match result {
                        Ok(plan) => {
                            slot.state = PendingState::Ready;
                            slot.plan = Some(plan);
                        }
                        Err(err) => {
                            slot.state = PendingState::Failed;
                            slot.error = Some(err.to_string());
                        }
                    }
                }
            }
        });
        true
    }

    /// Called at the start of a turn: apply a ready plan (fast, filesystem
    /// only) and return the record so the turn can mention it. Failed
    /// plannings are also drained and reported.
    pub fn apply_pending(
        &self,
        store: &HarnessStore,
        conversation_id: &str,
    ) -> Option<Result<RefinementRecord>> {
        let pending = {
            let mut map = self.pending.lock().ok()?;
            let is_done = map
                .get(conversation_id)
                .is_some_and(|p| p.state != PendingState::Planning);
            if !is_done {
                return None;
            }
            map.remove(conversation_id)?
        };
        match pending.state {
            PendingState::Ready => {
                let plan = pending.plan.unwrap_or_default();
                Some(apply(
                    store,
                    ApplyInput {
                        plan: &plan,
                        trigger: &pending.trigger,
                        focus: pending.focus.as_deref(),
                        conversation_id: Some(conversation_id),
                    },
                ))
            }
            PendingState::Failed => Some(Err(anyhow!(
                "refinement planning failed: {}",
                pending.error.unwrap_or_default()
            ))),
            PendingState::Planning => None,
        }
    }

    /// Plan and apply synchronously (used by `refine.run(..., wait=True)` and tests).
    pub async fn run_now(
        &self,
        provider: Arc<dyn Provider>,
        model: ModelRef,
        store: &HarnessStore,
        conversation_id: &str,
        history: &[ChatMessage],
        trigger: &str,
        focus: Option<&str>,
    ) -> Result<RefinementRecord> {
        let entries = store.load_all()?;
        let plan = plan(provider.as_ref(), model, history, &entries, focus).await?;
        apply(
            store,
            ApplyInput {
                plan: &plan,
                trigger,
                focus,
                conversation_id: Some(conversation_id),
            },
        )
    }
}

/// One-line note for the system reminder after a refinement was applied.
pub fn render_applied_notice(record: &RefinementRecord) -> String {
    match record.outcome {
        RefineOutcome::Applied => format!(
            "A harness refinement was just applied (id `{}`): {} Touched: {}. Roll it back with `refine.rollback(\"{}\")` if it is wrong.",
            record.id,
            record.summary,
            if record.touched_ids.is_empty() { "-".to_string() } else { record.touched_ids.join(", ") },
            record.id
        ),
        RefineOutcome::Noop => format!(
            "Refinement `{}` found nothing worth recording: {}",
            record.id, record.summary
        ),
        RefineOutcome::Failed => format!(
            "Refinement `{}` failed and was undone: {}",
            record.id,
            record.error.clone().unwrap_or_default()
        ),
        RefineOutcome::RolledBack => format!("Refinement `{}` was rolled back.", record.id),
    }
}

/// Helper for host dispatchers: the status as JSON.
pub fn status_json(runner: &RefineRunner, store: &HarnessStore, conversation_id: &str) -> Result<Value> {
    Ok(serde_json::to_value(runner.status(store, conversation_id)?)?)
}

/// Expose the injection helpers so hosts only need this module for `/refine`
/// + reminder rendering.
pub fn harness_layer(store: &HarnessStore) -> Result<Option<String>> {
    let mut entries = store.load_all()?;
    // axe:shared-brain — globals of the Axe Cloud space (read-only mirror).
    crate::cloud_mirror::merge_into(&mut entries, &crate::cloud_mirror::read(store.paths()));
    Ok(inject::render_layer(&entries))
}

/// Copy a skill package elsewhere (used by import wizards and tests).
pub fn copy_package(src: &Path, dst: &Path) -> Result<()> {
    copy_dir_recursive(src, dst)
}

pub fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or_else(|_| json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HarnessPaths;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "refine-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store(dir: &TempDir) -> HarnessStore {
        HarnessStore::new(HarnessPaths::with_home(dir.0.join("ws"), Some(dir.0.join("home"))))
    }

    // axe:migration
    #[test]
    fn refine_never_writes_the_old_project_folder() {
        let dir = TempDir::new();
        let store = store(&dir);
        let legacy = store.paths().legacy_project_root.clone().unwrap();
        let old_file = legacy.join("memories").join("mem_old.md");
        fs::create_dir_all(old_file.parent().unwrap()).unwrap();
        fs::write(&old_file, "# Old\n\nold body").unwrap();
        let update = RefineOp {
            op: OpKind::Update,
            kind: None,
            scope: None,
            id: Some("mem_old".into()),
            title: None,
            body: Some("new body".into()),
            code: None,
            evidence: vec![],
            reason: None,
        };
        let plan = RefinePlan { summary: "t".into(), evidence: vec![], operations: vec![update] };
        let input = ApplyInput { plan: &plan, trigger: "test", focus: None, conversation_id: None };
        let record = apply(&store, input).unwrap();
        assert_eq!(record.outcome, RefineOutcome::Applied);
        assert_eq!(store.get("mem_old").unwrap().unwrap().body.trim(), "new body");
        rollback(&store, &record.id).unwrap();
        assert!(store.get("mem_old").unwrap().unwrap().body.contains("old body"));
        assert_eq!(fs::read_to_string(&old_file).unwrap(), "# Old\n\nold body");
        assert_eq!(fs::read_dir(old_file.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn parse_plan_tolerates_fences() {
        let text = "```json\n{\"summary\":\"s\",\"operations\":[{\"op\":\"create\",\"kind\":\"memory\",\"scope\":\"project\",\"title\":\"t\",\"body\":\"b\"}]}\n```";
        let plan = parse_plan(text).unwrap();
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(plan.operations[0].kind, Some(EntryKind::Memory));
        let prose = "Sure! Here is the plan: {\"summary\":\"x\",\"operations\":[]} hope it helps";
        assert!(parse_plan(prose).unwrap().is_noop());
        assert!(parse_plan("nope").is_err());
    }

    #[test]
    fn apply_then_rollback_restores_files() {
        let dir = TempDir::new();
        let store = store(&dir);
        let existing = store
            .create(
                Scope::Project,
                EntryKind::Memory,
                NewEntry {
                    title: "Old".into(),
                    body: "old body".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let plan = RefinePlan {
            summary: "test".into(),
            evidence: vec!["ev".into()],
            operations: vec![
                RefineOp {
                    op: OpKind::Update,
                    kind: None,
                    scope: None,
                    id: Some(existing.meta.id.clone()),
                    title: None,
                    body: Some("new body".into()),
                    code: None,
                    evidence: vec![],
                    reason: None,
                },
                RefineOp {
                    op: OpKind::Create,
                    kind: Some(EntryKind::Skill),
                    scope: Some(Scope::Project),
                    id: None,
                    title: Some("fresh skill".into()),
                    body: Some("# fresh".into()),
                    code: Some("X = 1\n".into()),
                    evidence: vec![],
                    reason: None,
                },
            ],
        };
        let record = apply(
            &store,
            ApplyInput {
                plan: &plan,
                trigger: "test",
                focus: None,
                conversation_id: Some("conv"),
            },
        )
        .unwrap();
        assert_eq!(record.outcome, RefineOutcome::Applied);
        assert_eq!(record.touched_ids.len(), 2);
        assert!(record.diff.iter().any(|d| d.change == "modified"));
        assert!(record.diff.iter().any(|d| d.change == "created"));
        assert_eq!(store.get(&existing.meta.id).unwrap().unwrap().body, "new body");
        assert!(store.get_kind(EntryKind::Skill, "fresh_skill").unwrap().is_some());

        let rolled = rollback(&store, &record.id).unwrap();
        assert_eq!(rolled.outcome, RefineOutcome::RolledBack);
        assert_eq!(store.get(&existing.meta.id).unwrap().unwrap().body, "old body");
        assert!(store.get_kind(EntryKind::Skill, "fresh_skill").unwrap().is_none());

        let hist = history(&store).unwrap();
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].outcome, RefineOutcome::RolledBack);
        assert!(rollback(&store, &record.id).is_err());
    }

    #[test]
    fn failed_plan_is_undone() {
        let dir = TempDir::new();
        let store = store(&dir);
        let plan = RefinePlan {
            summary: "bad".into(),
            evidence: vec![],
            operations: vec![
                RefineOp {
                    op: OpKind::Create,
                    kind: Some(EntryKind::PromptNote),
                    scope: Some(Scope::Global),
                    id: None,
                    title: Some("ok".into()),
                    body: Some("b".into()),
                    code: None,
                    evidence: vec![],
                    reason: None,
                },
                RefineOp {
                    op: OpKind::Delete,
                    kind: None,
                    scope: None,
                    id: Some("missing".into()),
                    title: None,
                    body: None,
                    code: None,
                    evidence: vec![],
                    reason: None,
                },
            ],
        };
        let record = apply(
            &store,
            ApplyInput { plan: &plan, trigger: "t", focus: None, conversation_id: None },
        )
        .unwrap();
        assert_eq!(record.outcome, RefineOutcome::Failed);
        assert!(store.list(Some(EntryKind::PromptNote), None).unwrap().is_empty());
    }
}
