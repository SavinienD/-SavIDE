//! Host-call dispatcher for the `harness` and `refine` Python modules.
//! The REPL worker routes every `harness.*` RPC (and the synchronous
//! `refine.history` / `refine.rollback`) here. `refine.run` / `refine.status`
//! need the session's provider and history and stay in the worker
//! (see [`crate::refine::RefineRunner`]).

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::{
    model::{EntryKind, EntryPatch, NewEntry, Scope},
    refine,
    store::HarnessStore,
};

fn opt_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

fn req_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    opt_str(params, key).ok_or_else(|| anyhow!("missing `{key}`"))
}

fn parse_opt<T: std::str::FromStr<Err = String>>(params: &Value, key: &str) -> Result<Option<T>> {
    opt_str(params, key).map(|v| v.parse::<T>().map_err(|e| anyhow!(e))).transpose()
}

/// Whether `method` is handled by [`dispatch`].
pub fn handles(method: &str) -> bool {
    method.starts_with("harness.") || matches!(method, "refine.history" | "refine.rollback")
}

/// Execute one host call and return its JSON result.
pub fn dispatch(store: &HarnessStore, method: &str, params: &Value) -> Result<Value> {
    Ok(match method {
        "harness.list" => {
            let kind: Option<EntryKind> = parse_opt(params, "kind")?;
            let scope: Option<Scope> = parse_opt(params, "scope")?;
            let rows: Vec<Value> = store
                .list(kind, scope)?
                .iter()
                .map(|e| {
                    json!({
                        "id": e.meta.id, "kind": e.meta.kind, "scope": e.meta.scope,
                        "title": e.meta.title, "updated": e.meta.updated,
                        "excerpt": crate::model::excerpt_of(&e.body),
                    })
                })
                .collect();
            Value::Array(rows)
        }
        "harness.get" => serde_json::to_value(store.get(req_str(params, "id")?)?)?,
        "harness.create" => {
            let kind: EntryKind = req_str(params, "kind")?.parse().map_err(|e: String| anyhow!(e))?;
            let scope: Scope = opt_str(params, "scope").unwrap_or("project").parse().map_err(|e: String| anyhow!(e))?;
            let mut entry: NewEntry = serde_json::from_value(params.get("entry").cloned().unwrap_or(Value::Null))?;
            if entry.title.trim().is_empty() {
                bail!("`title` must not be empty");
            }
            entry.source.get_or_insert_with(|| "agent".into());
            serde_json::to_value(store.create(scope, kind, entry)?)?
        }
        "harness.update" => {
            let id = req_str(params, "id")?;
            check_kind(store, id, params)?;
            let patch: EntryPatch = serde_json::from_value(params.get("patch").cloned().unwrap_or(json!({})))?;
            serde_json::to_value(store.update(id, patch)?)?
        }
        "harness.delete" => {
            let id = req_str(params, "id")?;
            check_kind(store, id, params)?;
            serde_json::to_value(store.delete(id)?)?
        }
        "harness.promote" => serde_json::to_value(store.promote(req_str(params, "id")?)?)?,
        "harness.demote" => serde_json::to_value(store.demote(req_str(params, "id")?)?)?,
        "harness.skills_paths" => json!(store
            .paths()
            .skills_paths()
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()),
        "harness.archive_plan" => {
            let plan: PlanArchive = serde_json::from_value(params.clone())?;
            serde_json::to_value(archive_plan(store, &plan)?)?
        }
        "refine.history" => serde_json::to_value(refine::history(store)?)?,
        "refine.rollback" => serde_json::to_value(refine::rollback(store, req_str(params, "id")?)?)?,
        other => bail!("unknown harness host call `{other}`"),
    })
}

/// Guard against `delete_memory("skill_x")`-style mistakes.
fn check_kind(store: &HarnessStore, id: &str, params: &Value) -> Result<()> {
    let Some(kind) = parse_opt::<EntryKind>(params, "kind")? else {
        return Ok(());
    };
    let entry = store.get(id)?.ok_or_else(|| anyhow!("harness entry `{id}` not found"))?;
    if entry.meta.kind != kind {
        bail!("`{id}` is a {}, not a {kind}", entry.meta.kind);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HarnessPaths;

    #[test]
    fn crud_roundtrip() {
        let root = std::env::temp_dir().join(format!("axecode-host-{}", uuid::Uuid::new_v4().simple()));
        let store = HarnessStore::new(HarnessPaths::with_home(root.join("ws"), Some(root.join("home"))));
        let created = dispatch(
            &store,
            "harness.create",
            &json!({"kind": "memory", "scope": "project", "entry": {"title": "T", "body": "B"}}),
        )
        .unwrap();
        let id = created["meta"]["id"].as_str().or(created["id"].as_str()).unwrap().to_string();
        assert!(dispatch(&store, "harness.delete", &json!({"kind": "skill", "id": id})).is_err());
        let list = dispatch(&store, "harness.list", &json!({"kind": "memory"})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        dispatch(&store, "harness.promote", &json!({"id": id})).unwrap();
        dispatch(&store, "harness.delete", &json!({"kind": "memory", "id": id})).unwrap();
        assert!(handles("refine.rollback") && !handles("refine.run"));
        let plan = json!({"title": "P", "body": "steps", "decisions": ["d1"], "status": "draft"});
        dispatch(&store, "harness.archive_plan", &plan).unwrap();
        let plan = json!({"title": "P", "body": "steps", "status": "done"});
        dispatch(&store, "harness.archive_plan", &plan).unwrap();
        let notes = store.list(Some(EntryKind::PromptNote), None).unwrap();
        assert_eq!(notes.len(), 1);
        assert!(notes[0].body.contains("**Statut** : done"));
        let layer = crate::inject::render_layer(&notes).unwrap();
        assert!(layer.contains("Archived plans") && !layer.contains("steps"));
        let _ = std::fs::remove_dir_all(root);
    }
}

// ---------------------------------------------------------------------------
// Plan archive (chantier F): plans produced by the agent are stored as
// project prompt notes tagged `plan`, with a standard header.
// ---------------------------------------------------------------------------

pub const PLAN_TAG: &str = "plan";

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct PlanArchive {
    pub title: String,
    pub body: String,
    /// Perimeter / scope of the plan (files, features).
    pub perimeter: String,
    pub decisions: Vec<String>,
    /// `draft`, `in_progress`, `done`, `abandoned`
    pub status: String,
    /// Deviations from the plan observed during implementation.
    pub deviations: Vec<String>,
    pub source: Option<String>,
}

pub fn render_plan(plan: &PlanArchive) -> String {
    let list = |items: &[String]| {
        if items.is_empty() {
            "- (aucun)".to_string()
        } else {
            items.iter().map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n")
        }
    };
    let date = {
        let secs = crate::model::now_ms() / 1000;
        let days = secs.div_euclid(86_400);
        // Civil date from days since epoch (Howard Hinnant's algorithm).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!("{y:04}-{m:02}-{d:02}")
    };
    format!(
        "**Date** : {date}\n**Périmètre** : {}\n**Statut** : {}\n\n**Décisions**\n{}\n\n**Écarts**\n{}\n\n---\n\n{}",
        if plan.perimeter.trim().is_empty() { "—" } else { plan.perimeter.trim() },
        if plan.status.trim().is_empty() { "draft" } else { plan.status.trim() },
        list(&plan.decisions),
        list(&plan.deviations),
        plan.body.trim()
    )
}

/// Archive (or update, when a plan with the same title exists) a plan.
pub fn archive_plan(store: &HarnessStore, plan: &PlanArchive) -> Result<crate::model::Entry> {
    if plan.title.trim().is_empty() {
        bail!("plan title must not be empty");
    }
    let body = render_plan(plan);
    let existing = store
        .list(Some(EntryKind::PromptNote), Some(Scope::Project))?
        .into_iter()
        .find(|e| e.meta.tags.iter().any(|t| t == PLAN_TAG) && e.meta.title == plan.title);
    if let Some(entry) = existing {
        return store.update(
            &entry.meta.id,
            EntryPatch { body: Some(body), ..Default::default() },
        );
    }
    store.create(
        Scope::Project,
        EntryKind::PromptNote,
        NewEntry {
            title: plan.title.clone(),
            body,
            source: Some(plan.source.clone().unwrap_or_else(|| "agent:plan".into())),
            evidence: Vec::new(),
            tags: vec![PLAN_TAG.into()],
            code: None,
        },
    )
}
