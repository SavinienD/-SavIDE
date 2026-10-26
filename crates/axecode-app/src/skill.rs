use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use axecode_core::ToolDescriptor;

use crate::tool_run::ToolRunResult;

const SKILL_TOOL_NAME: &str = "skill";
const SKILL_FILE_NAME: &str = "SKILL.md";

#[derive(Debug, Clone)]
pub struct SkillTool {
    workspace_root: PathBuf,
    settings: SkillSettings,
}

#[derive(Debug, Clone)]
struct SkillEntry {
    name: String,
    path: PathBuf,
}

impl SkillTool {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            settings: SkillSettings::default(),
        }
    }

    pub fn with_settings(workspace_root: impl Into<PathBuf>, settings: SkillSettings) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            settings: settings.normalized(),
        }
    }

    pub fn descriptor(&self) -> Option<ToolDescriptor> {
        let skills = self.discover();
        if skills.is_empty() {
            return None;
        }

        Some(ToolDescriptor {
            name: SKILL_TOOL_NAME.into(),
            description: format!(
                "Load one skill by name before using it. Available skills:\n{}",
                skills
                    .iter()
                    .map(|skill| format!("- {}", skill.name))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Exact skill name from the available skills list."
                    }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
        })
    }

    pub async fn run(&self, input: Value) -> ToolRunResult {
        match self.load(input) {
            Ok(output) => ToolRunResult::ok(output, Vec::new()),
            Err(err) => ToolRunResult::err(err.to_string(), Vec::new()),
        }
    }

    fn load(&self, input: Value) -> Result<String> {
        let parsed: SkillInput = serde_json::from_value(input)
            .map_err(|err| anyhow::anyhow!("invalid skill input: {err}"))?;
        let name = parsed.name.trim();
        if name.is_empty() {
            bail!("skill name is required");
        }

        let skills = self.discover();
        let Some(skill) = skills.iter().find(|skill| skill.name == name) else {
            let available = skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            bail!("unknown skill `{name}`. Available skills: {available}");
        };

        let content = fs::read_to_string(&skill.path)
            .with_context(|| format!("unable to read skill `{name}`"))?;
        Ok(format!(
            "Loaded skill `{name}`:\n\n<skill name=\"{name}\">\n{}\n</skill>",
            content.trim()
        ))
    }

    fn discover(&self) -> Vec<SkillEntry> {
        let mut roots = vec![
            self.workspace_root.join(".agents/skills"),
            self.workspace_root.join(".axecode/skills"),
            axecode_harness::legacy_dirs::project_skills_dir(&self.workspace_root), // axe:dossiers-anciens
            legacy_skills_dir(&self.workspace_root, false), // axe:migration - read only
        ];
        if let Some(base_dirs) = BaseDirs::new() {
            let home = base_dirs.home_dir();
            roots.push(home.join(".agents/skills"));
            roots.push(home.join(".axecode/skills"));
            roots.push(legacy_skills_dir(home, true)); // axe:migration - read only
        }

        let mut seen = HashSet::new();
        let mut skills = Vec::new();
        for root in roots {
            for skill in scan_skill_root(&root) {
                if self.settings.is_enabled(&skill.name) && seen.insert(skill.name.clone()) {
                    skills.push(skill);
                }
            }
        }
        skills.sort_by(|left, right| left.name.cmp(&right.name));
        skills
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSettings {
    #[serde(default)]
    pub skills: Vec<SkillConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConfig {
    pub name: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl SkillSettings {
    pub fn normalized(mut self) -> Self {
        let mut seen = HashSet::new();
        self.skills = self
            .skills
            .into_iter()
            .filter_map(|mut skill| {
                skill.name = skill.name.trim().to_string();
                if skill.name.is_empty() || !seen.insert(skill.name.clone()) {
                    return None;
                }
                Some(skill)
            })
            .collect();
        self
    }

    pub fn is_enabled(&self, name: &str) -> bool {
        self.skills
            .iter()
            .find(|skill| skill.name == name)
            .map(|skill| skill.enabled)
            .unwrap_or(true)
    }
}

fn scan_skill_root(root: &Path) -> Vec<SkillEntry> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let skill_path = path.join(SKILL_FILE_NAME);
        if !skill_path.is_file() {
            continue;
        }

        let fallback_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
            .to_string();
        let name = fs::read_to_string(&skill_path)
            .ok()
            .and_then(|content| parse_skill_name(&content))
            .unwrap_or(fallback_name);

        skills.push(SkillEntry {
            name,
            path: skill_path,
        });
    }

    skills
}

fn parse_skill_name(content: &str) -> Option<String> {
    parse_frontmatter(content)
        .remove("name")
        .filter(|value| !value.is_empty())
}

fn parse_frontmatter(content: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return fields;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        fields.insert(
            key.trim().to_string(),
            clean_yaml_string(value.trim()).to_string(),
        );
    }
    fields
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Workspace,
    Global,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: SkillSource,
    pub root_label: String,
    pub absolute_path: String,
    pub content: String,
    pub enabled: bool,
}

pub fn list_installed_skills(
    workspace_root: impl AsRef<Path>,
    settings: &SkillSettings,
) -> Vec<InstalledSkill> {
    let workspace_root = workspace_root.as_ref();
    let home_dir = BaseDirs::new().map(|base| base.home_dir().to_path_buf());

    let mut roots: Vec<(SkillSource, PathBuf)> = vec![
        (
            SkillSource::Workspace,
            workspace_root.join(".agents/skills"),
        ),
        (SkillSource::Workspace, workspace_root.join(".axecode/skills")),
        (SkillSource::Workspace, axecode_harness::legacy_dirs::project_skills_dir(workspace_root)), // axe:dossiers-anciens
        (SkillSource::Workspace, legacy_skills_dir(workspace_root, false)), // axe:migration - read only
    ];
    if let Some(home) = home_dir.as_ref() {
        roots.push((SkillSource::Global, home.join(".agents/skills")));
        roots.push((SkillSource::Global, home.join(".axecode/skills")));
        roots.push((SkillSource::Global, legacy_skills_dir(home, true))); // axe:migration - read only
    }

    let mut seen = HashSet::new();
    let mut skills = Vec::new();

    for (source, root) in roots {
        let root_label = format_root_label(&root, workspace_root, home_dir.as_deref());
        for skill in scan_installed_skills(&root, source, &root_label, settings) {
            if seen.insert(skill.name.clone()) {
                skills.push(skill);
            }
        }
    }

    skills.sort_by(|left, right| left.name.cmp(&right.name));
    skills
}

/// axe:v2-l7 — lit les compétences d'un dossier donné (sans déduplication ni
/// tri) : sert aussi aux racines hors espace de travail, comme l'espace partagé.
pub fn scan_installed_skills(
    root: &Path,
    source: SkillSource,
    root_label: &str,
    settings: &SkillSettings,
) -> Vec<InstalledSkill> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut skills = Vec::new();

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_path = dir.join(SKILL_FILE_NAME);
        if !skill_path.is_file() {
            continue;
        }

        let Ok(content) = fs::read_to_string(&skill_path) else {
            continue;
        };
        let frontmatter = parse_frontmatter(&content);
        let fallback_name = dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill")
            .to_string();
        let name = frontmatter
            .get("name")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback_name);

        let description = frontmatter
            .get("description")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let enabled = settings.is_enabled(&name);

        skills.push(InstalledSkill {
            name,
            description,
            source,
            root_label: root_label.to_string(),
            absolute_path: skill_path.display().to_string(),
            content,
            enabled,
        });
    }
    skills
}

/// axe:migration - skills of before the rename (`<root>/.atelier/skills`, rebrand:keep):
/// copied ONCE into the app data (never into the project), then only that copy
/// is listed, after the new folders (same name: the new one wins), never
/// written: not in `skill_roots`.
fn legacy_skills_dir(root: &Path, global: bool) -> PathBuf {
    let dest = if global {
        axecode_harness::app_data_dir().join("legacy-skills")
    } else {
        axecode_harness::project_data_dir(root).join("legacy-skills")
    };
    let src = root.join(axecode_harness::store::LEGACY_PROJECT_DIR_NAME).join("skills");
    let marker = dest.with_extension("migrated");
    if src.is_dir() && !marker.exists() && axecode_harness::store::copy_missing(&src, &dest).is_ok() {
        let _ = fs::write(&marker, src.display().to_string());
    }
    dest
}

/// axe:v2-l2.4 — allowed skill roots (workspace first, then global), mirroring
/// what `list_installed_skills` scans.
pub fn skill_roots(workspace_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        workspace_root.join(".agents/skills"),
        workspace_root.join(".axecode/skills"),
        axecode_harness::legacy_dirs::project_skills_dir(workspace_root), // axe:dossiers-anciens
    ];
    if let Some(base) = BaseDirs::new() {
        let home = base.home_dir();
        roots.push(home.join(".agents/skills"));
        roots.push(home.join(".axecode/skills"));
    }
    roots
}

/// Refuses any `SKILL.md` whose folder is not a direct child of an allowed
/// skill root (the same confinement the desktop app applies).
fn ensure_inside_skill_root(workspace_root: &Path, skill_md: &Path) -> Result<()> {
    let folder = skill_md
        .parent()
        .ok_or_else(|| anyhow::anyhow!("skill has no parent folder"))?;
    let allowed = skill_roots(workspace_root)
        .into_iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| folder.parent() == Some(root.as_path()));
    if !allowed {
        bail!("skill is outside the configured skill folders");
    }
    Ok(())
}

/// Atomic write (temporary sibling + rename) of a skill file.
fn write_skill_atomic(path: &Path, content: &str) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(SKILL_FILE_NAME);
    let tmp = path.with_file_name(format!(".{file_name}.tmp"));
    fs::write(&tmp, content).with_context(|| format!("unable to write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("unable to replace {}", path.display()))?;
    Ok(())
}

/// axe:v2-l2.4 — write (atomically) the `SKILL.md` of an existing skill.
pub fn write_installed_skill(
    workspace_root: impl AsRef<Path>,
    skill_md: &Path,
    content: &str,
) -> Result<PathBuf> {
    let workspace_root = workspace_root.as_ref();
    let skill_md = fs::canonicalize(skill_md).context("skill file does not exist")?;
    if skill_md.file_name().and_then(|name| name.to_str()) != Some(SKILL_FILE_NAME) {
        bail!("can only edit a SKILL.md file");
    }
    ensure_inside_skill_root(workspace_root, &skill_md)?;
    write_skill_atomic(&skill_md, content)?;
    Ok(skill_md)
}

/// axe:v2-l2.4 — create `<workspace>/.agents/skills/<name>/SKILL.md`.
/// `name` must be a single safe path component (validated by the caller too).
pub fn create_installed_skill_named(
    workspace_root: impl AsRef<Path>,
    name: &str,
    content: &str,
) -> Result<PathBuf> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        bail!("invalid skill name");
    }
    let folder = workspace_root.as_ref().join(".agents/skills").join(name);
    fs::create_dir_all(&folder).with_context(|| format!("unable to create {}", folder.display()))?;
    let skill_path = folder.join(SKILL_FILE_NAME);
    write_skill_atomic(&skill_path, content)?;
    Ok(skill_path)
}

/// axe:v2-l2.4 — delete a skill folder, only inside the allowed roots.
pub fn delete_installed_skill(
    workspace_root: impl AsRef<Path>,
    skill_md: &Path,
) -> Result<PathBuf> {
    let workspace_root = workspace_root.as_ref();
    let skill_md = fs::canonicalize(skill_md).context("skill file does not exist")?;
    if skill_md.file_name().and_then(|name| name.to_str()) != Some(SKILL_FILE_NAME) {
        bail!("can only delete a SKILL.md file");
    }
    ensure_inside_skill_root(workspace_root, &skill_md)?;
    let folder = skill_md
        .parent()
        .ok_or_else(|| anyhow::anyhow!("skill has no parent folder"))?
        .to_path_buf();
    fs::remove_dir_all(&folder)
        .with_context(|| format!("unable to delete skill folder {}", folder.display()))?;
    Ok(folder)
}

/// Create a new empty skill under `~/.agents/skills/<name>/SKILL.md`.
///
/// Picks a unique folder name (`new-skill`, `new-skill-1`, …) so the user can
/// just click "Add" without having to think about naming. Returns the path of
/// the freshly written `SKILL.md` along with the resolved skill name.
pub fn create_installed_skill() -> Result<(String, PathBuf)> {
    let base = BaseDirs::new()
        .map(|base| base.home_dir().to_path_buf())
        .context("unable to locate home directory")?
        .join(".agents/skills");
    fs::create_dir_all(&base)
        .with_context(|| format!("unable to create skills folder {}", base.display()))?;

    let (name, folder) = pick_unique_skill_folder(&base);
    fs::create_dir_all(&folder)
        .with_context(|| format!("unable to create skill folder {}", folder.display()))?;

    let skill_path = folder.join(SKILL_FILE_NAME);
    if skill_path.exists() {
        bail!("skill file already exists at {}", skill_path.display());
    }
    let template = default_skill_template(&name);
    fs::write(&skill_path, template)
        .with_context(|| format!("unable to write {}", skill_path.display()))?;

    Ok((name, skill_path))
}

fn pick_unique_skill_folder(base: &Path) -> (String, PathBuf) {
    const STEM: &str = "new-skill";
    let candidate = base.join(STEM);
    if !candidate.exists() {
        return (STEM.to_string(), candidate);
    }
    let mut index = 1u32;
    loop {
        let name = format!("{STEM}-{index}");
        let candidate = base.join(&name);
        if !candidate.exists() {
            return (name, candidate);
        }
        index = index.saturating_add(1);
        if index == u32::MAX {
            // Extremely unlikely; fall back to a timestamp suffix.
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default();
            let name = format!("{STEM}-{stamp}");
            return (name.clone(), base.join(name));
        }
    }
}

fn default_skill_template(name: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Décrivez à quoi sert ce skill\n---\n\n# {name}\n\nÉcrivez les consignes que l'agent doit suivre quand ce skill est activé.\n"
    )
}

fn format_root_label(root: &Path, workspace_root: &Path, home_dir: Option<&Path>) -> String {
    if let Ok(rel) = root.strip_prefix(workspace_root) {
        return rel.display().to_string();
    }
    if let Some(home) = home_dir {
        if let Ok(rel) = root.strip_prefix(home) {
            return format!("~/{}", rel.display());
        }
    }
    root.display().to_string()
}

fn clean_yaml_string(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct SkillInput {
    name: String,
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    fn skill(root: &Path, name: &str, body: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE_NAME), format!("---\nname: {name}\ndescription: d\n---\n{body}\n")).unwrap();
    }

    #[test]
    fn legacy_skills_are_listed_after_the_new_ones_and_never_writable() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        skill(&ws.join(".axecode/skills"), "mig-test-both", "new");
        std::env::set_var(axecode_harness::datadir::DATA_ENV, tmp.path().join("donnees"));
        let old = ws.join(axecode_harness::store::LEGACY_PROJECT_DIR_NAME).join("skills");
        skill(&old, "mig-test-both", "old");
        skill(&old, "mig-test-old-only", "old");
        let skills = list_installed_skills(ws, &SkillSettings::default());
        let find = |name: &str| skills.iter().find(|s| s.name == name).unwrap();
        assert!(find("mig-test-both").content.contains("new"));
        assert!(find("mig-test-old-only").absolute_path.starts_with(&tmp.path().join("donnees").display().to_string()));
        assert!(!skill_roots(ws).contains(&legacy_skills_dir(ws, false)));
        std::env::remove_var(axecode_harness::datadir::DATA_ENV);
    }
}
