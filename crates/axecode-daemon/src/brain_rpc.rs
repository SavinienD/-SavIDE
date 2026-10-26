//! axe:v2-l2.4 — `skills.*` and `harness.*` RPC: read and write the workspace
//! brain (installed skills + continual harness) from a remote client.
//!
//! The daemon uses ITS OWN workspace root (`config.workspace_root`): no path
//! ever comes from the client. A client-supplied `name`/`id` is confined to a
//! single path component and refused when it is empty, hidden, or contains a
//! separator or `..`. Global paths (`~/.agents/skills`, `~/.axecode/harness`)
//! are derived by the crates from the service `HOME`, never from a request.
use crate::workspace_rpc;
use crate::Daemon;
use serde_json::{json, Value};
use axecode_app::{
    create_installed_skill_named, delete_installed_skill, list_installed_skills,
    scan_installed_skills, write_installed_skill, SkillSettings, SkillSource,
};
use axecode_core::{SessionError, SessionResult};
use axecode_harness::{refine, EntryKind, EntryPatch, HarnessStore, NewEntry, Scope};
use std::path::{Path, PathBuf};

/// Small JSON file living next to the daemon database.
const SKILL_SETTINGS_FILE: &str = "skill-settings.json";

fn err(error: impl std::fmt::Display) -> SessionError {
    SessionError::Protocol(error.to_string())
}

/// A client `name`: one safe path component, never hidden, never empty.
fn name_of(p: &Value) -> SessionResult<String> {
    let name = p
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| SessionError::Protocol("name is required".into()))?;
    if !valid_component(name) {
        return Err(SessionError::Protocol("invalid skill name".into()));
    }
    Ok(name.to_string())
}

/// A client `id` for the harness: no separator, no traversal, not empty.
fn id_of(p: &Value) -> SessionResult<String> {
    let id = p
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| SessionError::Protocol("id is required".into()))?;
    if id.is_empty()
        || id.len() > 200
        || id.starts_with('.')
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.chars().any(char::is_control)
    {
        return Err(SessionError::Protocol("invalid harness id".into()));
    }
    Ok(id.to_string())
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && !value.starts_with('.')
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.chars().any(char::is_control)
}

fn kind_of(p: &Value) -> SessionResult<Option<EntryKind>> {
    match p.get("kind").and_then(Value::as_str) {
        Some(kind) if !kind.trim().is_empty() => {
            kind.parse::<EntryKind>().map(Some).map_err(err)
        }
        _ => Ok(None),
    }
}

fn scope_of(p: &Value) -> SessionResult<Option<Scope>> {
    match p.get("scope").and_then(Value::as_str) {
        Some(scope) if !scope.trim().is_empty() => {
            scope.parse::<Scope>().map(Some).map_err(err)
        }
        _ => Ok(None),
    }
}

// ----- skills settings file --------------------------------------------------

fn settings_path(d: &Daemon) -> PathBuf {
    d.data_dir().join(SKILL_SETTINGS_FILE)
}

/// Tolerant read: a missing or malformed file simply means "everything on".
fn load_skill_settings(d: &Daemon) -> SkillSettings {
    std::fs::read_to_string(settings_path(d))
        .ok()
        .and_then(|raw| serde_json::from_str::<SkillSettings>(&raw).ok())
        .unwrap_or_default()
        .normalized()
}

/// Atomic save (temporary sibling + rename).
fn save_skill_settings(d: &Daemon, settings: &SkillSettings) -> SessionResult<SkillSettings> {
    let normalized = settings.clone().normalized();
    std::fs::create_dir_all(d.data_dir()).map_err(|e| SessionError::Io(e.to_string()))?;
    let path = settings_path(d);
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(&normalized)?;
    std::fs::write(&tmp, data).map_err(|e| SessionError::Io(e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| SessionError::Io(e.to_string()))?;
    Ok(normalized)
}

/// axe:v2-l7 — compétences de l'espace partagé (`<shared-root>/skills`).
/// Elles sont ajoutées après celles de l'espace de travail et du HOME ; un
/// doublon de nom est masqué (la version locale gagne). `rootLabel` vaut
/// « Partagé » et la source reste `Global` : `InstalledSkill` ne change pas.
fn shared_skills(
    d: &Daemon,
    settings: &SkillSettings,
    seen: &mut std::collections::HashSet<String>,
) -> Vec<axecode_app::InstalledSkill> {
    let Some(shared) = d.config.shared_root.as_ref() else {
        return Vec::new();
    };
    let dir = shared.join("skills");
    if !dir.is_dir() {
        return Vec::new();
    }
    scan_installed_skills(&dir, SkillSource::Global, "Partagé", settings)
        .into_iter()
        .filter(|skill| seen.insert(skill.name.clone()))
        .collect()
}

/// Toutes les compétences visibles du service : espace de travail, HOME puis
/// espace partagé. Sert aussi aux recherches par nom des écritures.
fn all_skills(d: &Daemon, root: &Path) -> Vec<axecode_app::InstalledSkill> {
    let settings = load_skill_settings(d);
    let mut seen = std::collections::HashSet::new();
    let mut skills: Vec<axecode_app::InstalledSkill> = list_installed_skills(root, &settings)
        .into_iter()
        .filter(|skill| seen.insert(skill.name.clone()))
        .collect();
    skills.extend(shared_skills(d, &settings, &mut seen));
    skills
}

/// `{"skills":[{"name","enabled"}]}` for every installed skill.
fn settings_payload(d: &Daemon, root: &Path) -> Value {
    let skills: Vec<Value> = all_skills(d, root)
        .into_iter()
        .map(|skill| json!({"name": skill.name, "enabled": skill.enabled}))
        .collect();
    json!({ "skills": skills })
}

/// Compose a `SKILL.md` when the client sends a body only; keep a full file as
/// it is (the editor round-trips `InstalledSkill.content` verbatim).
fn render_skill_file(name: &str, description: &str, content: &str) -> String {
    if content.trim_start().starts_with("---") {
        return content.to_string();
    }
    let description = description.replace('\n', " ").replace('\r', " ");
    let description = description.trim();
    format!("---\nname: {name}\ndescription: {description}\n---\n\n{content}")
}

pub fn dispatch(d: &Daemon, m: &str, p: &Value) -> SessionResult<Value> {
    let root = workspace_rpc::root(d)?;
    // Harnais « projet » hors du projet (données du service) s'il n'y existe pas déjà.
    let data = axecode_harness::datadir::project_data_dir_in(d.data_dir(), &root);
    let store = HarnessStore::new(axecode_harness::HarnessPaths::with_roots(
        &root,
        axecode_harness::store::default_home(),
        data,
    ));
    match m {
        // ----- skills ----------------------------------------------------
        "skills.list" => Ok(serde_json::to_value(all_skills(d, &root))?),
        "skills.save" => {
            let name = name_of(p)?;
            let description = p
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let content = p.get("content").and_then(Value::as_str).unwrap_or_default();
            // axe:v2-l7 — la recherche inclut l'espace partagé : si la
            // compétence y vit, `write_installed_skill` refuse le chemin hors
            // des racines autorisées (aucune écriture dans le partagé).
            let existing = all_skills(d, &root)
                .into_iter()
                .find(|skill| skill.name == name);
            let rendered = render_skill_file(&name, description, content);
            match existing {
                Some(skill) => {
                    write_installed_skill(&root, Path::new(&skill.absolute_path), &rendered)
                        .map_err(err)?;
                }
                None => {
                    create_installed_skill_named(&root, &name, &rendered).map_err(err)?;
                }
            }
            let saved = all_skills(d, &root)
                .into_iter()
                .find(|skill| skill.name == name)
                .ok_or_else(|| SessionError::Protocol("skill was not saved".into()))?;
            Ok(serde_json::to_value(saved)?)
        }
        "skills.delete" => {
            let name = name_of(p)?;
            // axe:v2-l7 — même confinement : une compétence partagée est
            // trouvée ici puis refusée par `delete_installed_skill`.
            let skill = all_skills(d, &root)
                .into_iter()
                .find(|skill| skill.name == name)
                .ok_or_else(|| SessionError::Protocol("skill not found".into()))?;
            delete_installed_skill(&root, Path::new(&skill.absolute_path)).map_err(err)?;
            Ok(json!({"deleted": true}))
        }
        "skills.settings" => Ok(settings_payload(d, &root)),
        "skills.save_settings" => {
            let raw = p.get("settings").cloned().unwrap_or_else(|| json!({}));
            let parsed: SkillSettings = serde_json::from_value(raw)
                .map_err(|e| SessionError::Protocol(format!("invalid skill settings: {e}")))?;
            // axe:v2-l7 — seuls des noms et des drapeaux entrent ici : le
            // fichier écrit est celui du service (`data_dir`), jamais un
            // `SKILL.md`. Tout nom qui ressemble à un chemin (ou à un dossier
            // caché) est refusé, y compris vers l'espace partagé.
            if let Some(bad) = parsed.skills.iter().find(|skill| {
                let name = skill.name.trim();
                name.starts_with('.')
                    || name.contains('/')
                    || name.contains('\\')
                    || name.contains(':')
            }) {
                return Err(SessionError::Protocol(format!(
                    "invalid skill name in settings: {}",
                    bad.name
                )));
            }
            save_skill_settings(d, &parsed)?;
            Ok(settings_payload(d, &root))
        }

        // ----- harness ---------------------------------------------------
        "harness.paths" => Ok(serde_json::to_value(store.paths())?),
        "harness.list" => {
            let kind = kind_of(p)?;
            let scope = scope_of(p)?;
            let entries = store.list(kind, scope).map_err(err)?;
            Ok(serde_json::to_value(entries)?)
        }
        "harness.get" => {
            let id = id_of(p)?;
            match store.get(&id).map_err(err)? {
                Some(entry) => Ok(serde_json::to_value(entry)?),
                None => Ok(Value::Null),
            }
        }
        "harness.create" => {
            let kind = kind_of(p)?
                .ok_or_else(|| SessionError::Protocol("kind is required".into()))?;
            let scope = scope_of(p)?.unwrap_or(Scope::Project);
            let mut entry: NewEntry =
                serde_json::from_value(p.get("entry").cloned().unwrap_or_else(|| json!({})))
                    .map_err(|e| SessionError::Protocol(format!("invalid entry: {e}")))?;
            entry.source.get_or_insert_with(|| "user".to_string());
            Ok(serde_json::to_value(
                store.create(scope, kind, entry).map_err(err)?,
            )?)
        }
        "harness.update" => {
            let id = id_of(p)?;
            let patch: EntryPatch =
                serde_json::from_value(p.get("patch").cloned().unwrap_or_else(|| json!({})))
                    .map_err(|e| SessionError::Protocol(format!("invalid patch: {e}")))?;
            Ok(serde_json::to_value(store.update(&id, patch).map_err(err)?)?)
        }
        "harness.delete" => {
            let id = id_of(p)?;
            Ok(serde_json::to_value(store.delete(&id).map_err(err)?)?)
        }
        "harness.promote" => {
            let id = id_of(p)?;
            Ok(serde_json::to_value(store.promote(&id).map_err(err)?)?)
        }
        "harness.demote" => {
            let id = id_of(p)?;
            Ok(serde_json::to_value(store.demote(&id).map_err(err)?)?)
        }
        "harness.refinements" => Ok(serde_json::to_value(refine::history(&store).map_err(err)?)?),
        // axe:refine-run — stop a running refinement (the task polls the journal).
        "harness.refine_cancel" => {
            let id = id_of(p)?;
            Ok(serde_json::to_value(refine::cancel(&store, &id).map_err(err)?)?)
        }
        "harness.rollback" => {
            let id = id_of(p)?;
            Ok(serde_json::to_value(
                refine::rollback(&store, &id).map_err(err)?,
            )?)
        }
        _ => Err(SessionError::Protocol(
            "unknown skills/harness method".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        shared: Option<PathBuf>,
        daemon: Option<Arc<Daemon>>,
    }

    impl Fixture {
        fn new() -> Self {
            Self::with_shared(false)
        }

        fn with_shared(shared: bool) -> Self {
            let base = std::env::temp_dir().join(format!("l2.4-brain-{}", uuid::Uuid::new_v4()));
            let root = base.join("work");
            std::fs::create_dir_all(&root).unwrap();
            let mut config = crate::DaemonConfig::new(base.join("data"));
            config.workspace_root = Some(root.clone());
            let shared_root = if shared {
                let dir = base.join("commun");
                std::fs::create_dir_all(&dir).unwrap();
                config.shared_root = Some(dir.clone());
                Some(dir)
            } else {
                None
            };
            let daemon = Daemon::new(config, Arc::new(crate::stub::EchoFactory));
            Self {
                base,
                root,
                shared: shared_root,
                daemon: Some(daemon),
            }
        }

        fn seed(&self, base: &Path, name: &str, body: &str) {
            let folder = base.join("skills").join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(
                folder.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: partagée\n---\n{body}\n"),
            )
            .unwrap();
        }

        fn call(&self, method: &str, params: Value) -> SessionResult<Value> {
            dispatch(self.daemon.as_ref().unwrap(), method, &params)
        }
        fn unique_name(&self) -> String {
            format!("v2l24-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.daemon = None;
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn skills_save_list_settings_and_delete() {
        let f = Fixture::new();
        let name = f.unique_name();
        let saved = f
            .call(
                "skills.save",
                json!({
                    "name": name, "description": "une démo",
                    "content": "# Demo\n\nBonjour le service"
                }),
            )
            .unwrap();
        assert_eq!(saved["name"], name);
        assert_eq!(saved["description"], "une démo");
        assert_eq!(saved["source"], "workspace");
        assert!(saved["content"].as_str().unwrap().contains("Bonjour"));
        let skill_md = f.root.join(".agents/skills").join(&name).join("SKILL.md");
        assert!(skill_md.is_file(), "SKILL.md was not created");

        let listed = f.call("skills.list", json!({})).unwrap();
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == name.as_str()));

        // Disabling it is reflected in both the payload and `InstalledSkill.enabled`.
        let payload = f
            .call(
                "skills.save_settings",
                json!({"settings": {"skills": [{"name": name, "enabled": false}]}}),
            )
            .unwrap();
        let entry = payload["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == name.as_str())
            .unwrap();
        assert_eq!(entry["enabled"], false);
        assert!(f
            .call("skills.list", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == name.as_str())
            .unwrap()["enabled"]
            .as_bool()
            .unwrap()
            == false);

        let deleted = f.call("skills.delete", json!({"name": name})).unwrap();
        assert_eq!(deleted["deleted"], true);
        assert!(!f.root.join(".agents/skills").join(&name).exists());
    }

    #[test]
    fn skills_reject_escaping_names() {
        let f = Fixture::new();
        for bad in ["../escape", "a/b", "a\\b", "a:b", ".hidden", "..", ""] {
            assert!(
                f.call("skills.save", json!({"name": bad, "content": "x"}))
                    .is_err(),
                "skills.save accepted {bad:?}"
            );
            assert!(
                f.call("skills.delete", json!({"name": bad})).is_err(),
                "skills.delete accepted {bad:?}"
            );
        }
        assert!(!f.root.join(".agents").exists(), "nothing was written");
    }

    #[test]
    fn harness_crud_roundtrip() {
        let f = Fixture::new();
        let paths = f.call("harness.paths", json!({})).unwrap();
        assert!(paths["globalRoot"].as_str().unwrap().ends_with(".axecode/harness"));
        assert!(paths["projectRoot"].as_str().unwrap().ends_with("/harness"));
        assert!(!paths["projectRoot"].as_str().unwrap().starts_with(&f.root.display().to_string()));

        let created = f
            .call(
                "harness.create",
                json!({
                    "kind": "memory", "scope": "project",
                    "entry": {"title": "Build command", "body": "npm run build"}
                }),
            )
            .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("mem_"));
        assert_eq!(created["source"], "user");

        let listed = f
            .call("harness.list", json!({"kind": "memory", "scope": "project"}))
            .unwrap();
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == id.as_str()));

        let got = f.call("harness.get", json!({"id": id})).unwrap();
        assert_eq!(got["body"], "npm run build");

        let updated = f
            .call(
                "harness.update",
                json!({"id": id, "patch": {"body": "npm run build (tsc + vite)"}}),
            )
            .unwrap();
        assert!(updated["body"].as_str().unwrap().contains("tsc"));

        let deleted = f.call("harness.delete", json!({"id": id})).unwrap();
        assert_eq!(deleted["id"], id.as_str());
        assert!(f.call("harness.get", json!({"id": id})).unwrap().is_null());
    }

    #[test]
    fn harness_rejects_invalid_ids_and_args() {
        let f = Fixture::new();
        for bad in ["../escape", "a/b", "a\\b", ".hidden", "a..b", ""] {
            assert!(f.call("harness.get", json!({"id": bad})).is_err());
            assert!(f.call("harness.delete", json!({"id": bad})).is_err());
        }
        // Unknown kind/scope and missing kind are protocol errors.
        assert!(f.call("harness.list", json!({"kind": "nope"})).is_err());
        assert!(f.call("harness.list", json!({"scope": "nope"})).is_err());
        assert!(f
            .call(
                "harness.create",
                json!({"scope": "project", "entry": {"title": "x", "body": "y"}})
            )
            .is_err());
    }

    #[test]
    fn brain_methods_need_a_workspace_root() {
        let base = std::env::temp_dir().join(format!("l2.4-brain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let daemon = Daemon::new(
            crate::DaemonConfig::new(base.join("data")),
            Arc::new(crate::stub::EchoFactory),
        );
        assert!(dispatch(&daemon, "skills.list", &json!({})).is_err());
        assert!(dispatch(&daemon, "harness.list", &json!({})).is_err());
        assert!(dispatch(&daemon, "skills.nope", &json!({})).is_err());
        drop(daemon);
        let _ = std::fs::remove_dir_all(&base);
    }

    // axe:v2-l7 — compétences de l'espace partagé.
    #[test]
    fn shared_skills_are_listed_after_local_ones() {
        let f = Fixture::with_shared(true);
        let shared = f.shared.as_ref().unwrap().clone();
        f.seed(&shared, "commune", "corps partagé");
        let local = f.unique_name();
        f.call(
            "skills.save",
            json!({"name": local, "description": "locale", "content": "corps local"}),
        )
        .unwrap();

        let listed = f.call("skills.list", json!({})).unwrap();
        let listed = listed.as_array().unwrap();
        let shared_entry = listed
            .iter()
            .find(|s| s["name"] == "commune")
            .expect("shared skill missing");
        assert_eq!(shared_entry["rootLabel"], "Partagé");
        assert!(shared_entry["content"].as_str().unwrap().contains("corps partagé"));
        assert_eq!(shared_entry["enabled"], true);

        // Ajoutée à la suite : la locale précède la partagée.
        let local_pos = listed.iter().position(|s| s["name"] == local.as_str()).unwrap();
        let shared_pos = listed.iter().position(|s| s["name"] == "commune").unwrap();
        assert!(local_pos < shared_pos, "shared skill was not appended");
    }

    #[test]
    fn local_skill_wins_over_the_shared_duplicate() {
        let f = Fixture::with_shared(true);
        let shared = f.shared.as_ref().unwrap().clone();
        let name = f.unique_name();
        f.call(
            "skills.save",
            json!({"name": name, "description": "locale", "content": "version locale"}),
        )
        .unwrap();
        f.seed(&shared, &name, "version partagée");

        let listed = f.call("skills.list", json!({})).unwrap();
        let matches: Vec<&Value> = listed
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["name"] == name.as_str())
            .collect();
        assert_eq!(matches.len(), 1, "duplicate was not hidden");
        assert_ne!(matches[0]["rootLabel"], "Partagé");
        assert!(matches[0]["content"].as_str().unwrap().contains("version locale"));
    }

    #[test]
    fn shared_skills_are_read_only() {
        let f = Fixture::with_shared(true);
        let shared = f.shared.as_ref().unwrap().clone();
        f.seed(&shared, "verrouillee", "à ne pas modifier");
        let skill_md = shared.join("skills/verrouillee/SKILL.md");
        let before = std::fs::read_to_string(&skill_md).unwrap();

        assert!(f
            .call(
                "skills.save",
                json!({"name": "verrouillee", "description": "x", "content": "piraté"})
            )
            .is_err());
        assert!(f.call("skills.delete", json!({"name": "verrouillee"})).is_err());
        assert!(f
            .call(
                "skills.save_settings",
                json!({"settings": {"skills": [{"name": "../verrouillee", "enabled": false}]}})
            )
            .is_err());

        assert!(skill_md.is_file(), "shared skill was deleted");
        assert_eq!(std::fs::read_to_string(&skill_md).unwrap(), before);
    }

    #[test]
    fn no_shared_root_keeps_the_current_behaviour() {
        let f = Fixture::new();
        let local = f.unique_name();
        f.call(
            "skills.save",
            json!({"name": local, "description": "locale", "content": "corps"}),
        )
        .unwrap();
        let listed = f.call("skills.list", json!({})).unwrap();
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["rootLabel"] != "Partagé"));
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == local.as_str()));
    }
}
