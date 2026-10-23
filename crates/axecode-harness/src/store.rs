//! On-disk store: one folder per scope, one folder per kind, one Markdown file
//! per entry (skills are a folder with `SKILL.md` + `__init__.py`).
//!
//! Layout:
//! ```text
//! <root>/
//!   index.json
//!   notes/<id>.md
//!   memories/<id>.md
//!   subagents/<id>.md
//!   skills/<slug>/SKILL.md
//!   skills/<slug>/__init__.py
//!   refinements.jsonl
//!   refinements/<refinement id>/...   (snapshots for rollback)
//! ```

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use directories::BaseDirs;
use serde::{Deserialize, Serialize};

use crate::model::{
    excerpt_of, mint_id, now_ms, parse_file, render_file, slugify, Entry, EntryKind, EntryMeta,
    EntryPatch, IndexRow, NewEntry, Scope,
};

pub const GLOBAL_DIR_NAME: &str = ".savide"; // SavIDE : harnais global distinct de SavIDE
pub const PROJECT_DIR_NAME: &str = ".axecode";
/// axe:migration - project folder of before the rename: read as a fallback,
/// never written.
pub const LEGACY_PROJECT_DIR_NAME: &str = ".atelier"; // rebrand:keep
pub const HARNESS_DIR_NAME: &str = "harness";
pub const INDEX_FILE_NAME: &str = "index.json";
pub const SKILL_FILE_NAME: &str = "SKILL.md";
pub const SKILL_INIT_FILE_NAME: &str = "__init__.py";

/// Resolved roots of both scopes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessPaths {
    pub global_root: PathBuf,
    pub project_root: PathBuf,
    /// axe:migration - project harness of before the rename
    /// (`<workspace>/<LEGACY_PROJECT_DIR_NAME>/harness`): read after
    /// `project_root`, never written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_project_root: Option<PathBuf>,
    /// axe:harnais-equipe - harnais global d'ÉQUIPE, commun à tous les espaces
    /// (variable [`TEAM_ENV`]) : lu en plus de `global_root`, et toute entrée
    /// globale écrite y est aussi publiée. Absent = comportement d'avant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_root: Option<PathBuf>,
}

impl HarnessPaths {
    pub fn for_workspace(workspace_root: impl AsRef<Path>) -> Self {
        Self::with_home(workspace_root, default_home())
    }

    pub fn with_home(workspace_root: impl AsRef<Path>, home: Option<PathBuf>) -> Self {
        let workspace_root = workspace_root.as_ref();
        let home = home.unwrap_or_else(|| workspace_root.to_path_buf());
        Self {
            global_root: home.join(GLOBAL_DIR_NAME).join(HARNESS_DIR_NAME),
            project_root: workspace_root.join(PROJECT_DIR_NAME).join(HARNESS_DIR_NAME),
            legacy_project_root: Some(workspace_root.join(LEGACY_PROJECT_DIR_NAME).join(HARNESS_DIR_NAME)),
            team_root: team_root_from_env(),
        }
    }

    /// axe:migration - folder of a kind in the project harness of before the
    /// rename (project scope only).
    pub fn legacy_kind_dir(&self, scope: Scope, kind: EntryKind) -> Option<PathBuf> {
        match scope {
            Scope::Project => self.legacy_project_root.as_ref().map(|root| root.join(kind.dir_name())),
            Scope::Global => None,
        }
    }

    /// axe:migration - whether `path` lies in the project harness of before the
    /// rename (read only).
    pub fn is_legacy_path(&self, path: &Path) -> bool {
        self.legacy_project_root
            .as_ref()
            .is_some_and(|root| path.starts_with(root) || path.starts_with(crate::os_path(root)))
    }

    pub fn root(&self, scope: Scope) -> &Path {
        match scope {
            Scope::Global => &self.global_root,
            Scope::Project => &self.project_root,
        }
    }

    pub fn kind_dir(&self, scope: Scope, kind: EntryKind) -> PathBuf {
        self.root(scope).join(kind.dir_name())
    }

    /// Folders the kernel should add to `sys.path` (global first, then project).
    pub fn skills_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.kind_dir(Scope::Global, EntryKind::Skill)];
        // axe:harnais-equipe - compétences de l'équipe, après celles de l'espace.
        if let Some(team) = &self.team_root {
            paths.push(team.join(EntryKind::Skill.dir_name()));
        }
        paths.push(self.kind_dir(Scope::Project, EntryKind::Skill));
        paths
    }
}

/// axe:harnais-equipe - dossier du harnais d'équipe (ex. /srv/axe/harnais-equipe).
pub const TEAM_ENV: &str = "AXE_HARNESS_EQUIPE";
/// Auteur noté dans les entrées publiées vers l'équipe (sinon `USER`).
pub const TEAM_AUTHOR_ENV: &str = "AXE_HARNESS_AUTEUR";
/// Préfixe de l'étiquette d'auteur dans les entrées d'équipe.
pub const TEAM_AUTHOR_TAG: &str = "auteur:";

pub fn team_root_from_env() -> Option<PathBuf> {
    std::env::var_os(TEAM_ENV).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn team_author() -> String {
    [TEAM_AUTHOR_ENV, "USER", "USERNAME"]
        .iter()
        .find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "inconnu".into())
}

pub fn default_home() -> Option<PathBuf> {
    BaseDirs::new().map(|base| base.home_dir().to_path_buf())
}

/// Index persisted as JSON, rebuilt from the files on every load.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub generated: i64,
    pub entries: Vec<IndexRow>,
}

/// The harness store for one workspace (both scopes).
#[derive(Debug, Clone)]
pub struct HarnessStore {
    paths: HarnessPaths,
}

impl HarnessStore {
    pub fn new(paths: HarnessPaths) -> Self {
        Self { paths }
    }

    pub fn open(workspace_root: impl AsRef<Path>) -> Self {
        Self::new(HarnessPaths::for_workspace(workspace_root))
    }

    pub fn paths(&self) -> &HarnessPaths {
        &self.paths
    }

    // ---- reading ---------------------------------------------------------

    /// Load every entry of one scope straight from disk and rewrite its index.
    pub fn load_scope(&self, scope: Scope) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        for kind in EntryKind::ALL {
            entries.extend(self.load_kind(scope, kind)?);
        }
        entries.sort_by(|a, b| a.meta.created.cmp(&b.meta.created).then(a.meta.id.cmp(&b.meta.id)));
        if let Err(err) = self.write_index(scope, &entries) {
            tracing::debug!(error = %err, scope = %scope, "harness index not written");
        }
        Ok(entries)
    }

    /// Load everything (global first, then project).
    pub fn load_all(&self) -> Result<Vec<Entry>> {
        let mut out = self.load_scope(Scope::Global)?;
        out.extend(self.load_scope(Scope::Project)?);
        Ok(out)
    }

    pub fn list(&self, kind: Option<EntryKind>, scope: Option<Scope>) -> Result<Vec<Entry>> {
        let mut out = Vec::new();
        for s in Scope::ALL {
            if scope.is_some_and(|wanted| wanted != s) {
                continue;
            }
            for k in EntryKind::ALL {
                if kind.is_some_and(|wanted| wanted != k) {
                    continue;
                }
                out.extend(self.load_kind(s, k)?);
            }
        }
        out.sort_by(|a, b| a.meta.created.cmp(&b.meta.created).then(a.meta.id.cmp(&b.meta.id)));
        Ok(out)
    }

    /// Find an entry by id in either scope (project wins on duplicates).
    pub fn get(&self, id: &str) -> Result<Option<Entry>> {
        let id = id.trim();
        for scope in [Scope::Project, Scope::Global] {
            for kind in EntryKind::ALL {
                if let Some(entry) = self.find(scope, kind, id)? {
                    return Ok(Some(entry));
                }
            }
        }
        Ok(None)
    }

    pub fn get_kind(&self, kind: EntryKind, id: &str) -> Result<Option<Entry>> {
        let id = id.trim();
        for scope in [Scope::Project, Scope::Global] {
            if let Some(entry) = self.find(scope, kind, id)? {
                return Ok(Some(entry));
            }
        }
        Ok(None)
    }

    fn find(&self, scope: Scope, kind: EntryKind, id: &str) -> Result<Option<Entry>> {
        let hit = |entry: &Entry| entry.meta.id == id || (kind == EntryKind::Skill && entry.meta.title == id);
        if let Some(entry) = self.load_kind(scope, kind)?.into_iter().find(|e| hit(e)) {
            return Ok(Some(entry));
        }
        // axe:harnais-equipe - entrée masquée par une version plus récente
        // (même titre) : toujours joignable par son id.
        let mut dirs = vec![self.paths.kind_dir(scope, kind)];
        if let (Scope::Global, Some(team)) = (scope, &self.paths.team_root) {
            dirs.push(team.join(kind.dir_name()));
        }
        Ok(dirs
            .iter()
            .flat_map(|dir| self.load_kind_dir(dir, scope, kind))
            .find(|e| hit(e)))
    }

    fn load_kind(&self, scope: Scope, kind: EntryKind) -> Result<Vec<Entry>> {
        let mut entries = self.load_kind_dir(&self.paths.kind_dir(scope, kind), scope, kind);
        // axe:migration - entries of the project harness of before the rename
        // that the new folder does not have (same id: the new one wins). Not in
        // `skills_paths`: the kernel never writes `__pycache__` there.
        if let Some(legacy) = self.paths.legacy_kind_dir(scope, kind) {
            let known: std::collections::HashSet<String> = entries.iter().map(|e| e.meta.id.clone()).collect();
            entries.extend(
                self.load_kind_dir(&legacy, scope, kind)
                    .into_iter()
                    .filter(|entry| !known.contains(&entry.meta.id)),
            );
        }
        // axe:harnais-equipe - même id, ou même type + même titre : la dernière
        // écriture (`updated`) gagne ; à égalité, l'entrée de l'espace.
        if let (Scope::Global, Some(team)) = (scope, &self.paths.team_root) {
            for shared in self.load_kind_dir(&team.join(kind.dir_name()), scope, kind) {
                match entries
                    .iter()
                    .position(|e| e.meta.id == shared.meta.id || e.meta.title == shared.meta.title)
                {
                    Some(i) if shared.meta.updated > entries[i].meta.updated => entries[i] = shared,
                    Some(_) => {}
                    None => entries.push(shared),
                }
            }
        }
        Ok(entries)
    }

    fn load_kind_dir(&self, dir: &Path, scope: Scope, kind: EntryKind) -> Vec<Entry> {
        let Ok(read) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut entries = Vec::new();
        for item in read.flatten() {
            let path = item.path();
            let file = if kind == EntryKind::Skill {
                if !path.is_dir() {
                    continue;
                }
                let skill_md = path.join(SKILL_FILE_NAME);
                if !skill_md.is_file() {
                    continue;
                }
                skill_md
            } else {
                if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                path.clone()
            };
            match read_entry(&file, scope, kind) {
                Ok(entry) => entries.push(entry),
                Err(err) => {
                    tracing::warn!(path = %file.display(), error = %err, "skipping unreadable harness entry");
                }
            }
        }
        entries
    }

    /// axe:migration - entries of the project harness of before the rename are
    /// read only: never deleted or moved from there.
    fn ensure_not_legacy(&self, entry: &Entry) -> Result<()> {
        if self.paths.is_legacy_path(Path::new(&entry.path)) {
            bail!(
                "harness entry `{}` comes from the project folder of before the rename ({}), which stays read only",
                entry.meta.id,
                entry.path
            );
        }
        Ok(())
    }

    fn write_index(&self, scope: Scope, entries: &[Entry]) -> Result<()> {
        let root = self.paths.root(scope);
        if !root.exists() {
            // Do not create folders just to write an empty index.
            return Ok(());
        }
        let index = Index {
            generated: now_ms(),
            entries: entries.iter().map(IndexRow::from).collect(),
        };
        let json = serde_json::to_string_pretty(&index)?;
        fs::write(root.join(INDEX_FILE_NAME), json)
            .with_context(|| format!("unable to write {}", root.join(INDEX_FILE_NAME).display()))
    }

    // ---- writing ---------------------------------------------------------

    pub fn create(&self, scope: Scope, kind: EntryKind, input: NewEntry) -> Result<Entry> {
        let title = input.title.trim().to_string();
        if title.is_empty() {
            bail!("title is required");
        }
        let now = now_ms();
        let id = if kind == EntryKind::Skill {
            let slug = slugify(&title);
            if self.paths.kind_dir(scope, kind).join(&slug).exists() {
                bail!("a skill named `{slug}` already exists in scope {scope}");
            }
            slug
        } else {
            mint_id(kind)
        };
        let meta = EntryMeta {
            id,
            kind,
            scope,
            title: if kind == EntryKind::Skill { slugify(&title) } else { title },
            created: now,
            updated: now,
            source: input.source.unwrap_or_else(|| "user".into()),
            evidence: input.evidence,
            tags: input.tags,
        };
        let (file, package_dir) = self.entry_file(&meta);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("unable to create {}", parent.display()))?;
        }
        if file.exists() {
            bail!("entry file already exists at {}", file.display());
        }
        fs::write(&file, render_file(&meta, &input.body))
            .with_context(|| format!("unable to write {}", file.display()))?;
        if let Some(dir) = &package_dir {
            let init = dir.join(SKILL_INIT_FILE_NAME);
            let code = input
                .code
                .unwrap_or_else(|| default_skill_code(&meta.title, &input.body));
            fs::write(&init, code).with_context(|| format!("unable to write {}", init.display()))?;
        }
        let entry = read_entry(&file, scope, kind)?;
        self.refresh_index(scope);
        self.publish_team(&entry);
        Ok(entry)
    }

    pub fn update(&self, id: &str, patch: EntryPatch) -> Result<Entry> {
        let Some(existing) = self.get(id)? else {
            bail!("harness entry `{id}` not found");
        };
        let mut meta = existing.meta.clone();
        let mut body = existing.body.clone();
        if let Some(title) = patch.title {
            let title = title.trim().to_string();
            if !title.is_empty() {
                meta.title = if meta.kind == EntryKind::Skill { slugify(&title) } else { title };
            }
        }
        if let Some(new_body) = patch.body {
            body = new_body;
        }
        if let Some(evidence) = patch.evidence {
            meta.evidence = evidence;
        }
        if let Some(tags) = patch.tags {
            meta.tags = tags;
        }
        if let Some(source) = patch.source {
            meta.source = source;
        }
        meta.updated = now_ms();
        let mut file = PathBuf::from(&existing.path);
        let mut package_dir = existing.package_dir.clone().map(PathBuf::from);
        // axe:migration - an entry of the project harness of before the rename
        // is written into the new folder; the old file stays as it is and the
        // new one hides it.
        if self.paths.is_legacy_path(&file) {
            let (new_file, new_package) = self.entry_file(&meta);
            if let (Some(src), Some(dst)) = (&package_dir, &new_package) {
                copy_dir_recursive(src, dst)?;
            }
            if let Some(parent) = new_file.parent() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("unable to create {}", parent.display()))?;
            }
            file = new_file;
            package_dir = new_package;
        }
        fs::write(&file, render_file(&meta, &body))
            .with_context(|| format!("unable to write {}", file.display()))?;
        if let (Some(code), Some(dir)) = (patch.code, package_dir.as_deref()) {
            let init = dir.join(SKILL_INIT_FILE_NAME);
            fs::write(&init, code).with_context(|| format!("unable to write {}", init.display()))?;
        }
        let entry = read_entry(&file, meta.scope, meta.kind)?;
        self.refresh_index(meta.scope);
        self.publish_team(&entry);
        Ok(entry)
    }

    pub fn delete(&self, id: &str) -> Result<Entry> {
        let Some(existing) = self.get(id)? else {
            bail!("harness entry `{id}` not found");
        };
        self.ensure_not_legacy(&existing)?;
        if let Some(dir) = &existing.package_dir {
            fs::remove_dir_all(dir).with_context(|| format!("unable to remove {dir}"))?;
        } else {
            fs::remove_file(&existing.path)
                .with_context(|| format!("unable to remove {}", existing.path))?;
        }
        self.refresh_index(existing.meta.scope);
        self.unpublish_team(&existing);
        Ok(existing)
    }

    /// Move an entry to the other scope, keeping id, body and metadata.
    pub fn move_scope(&self, id: &str, target: Scope) -> Result<Entry> {
        let Some(existing) = self.get(id)? else {
            bail!("harness entry `{id}` not found");
        };
        self.ensure_not_legacy(&existing)?;
        if existing.meta.scope == target {
            return Ok(existing);
        }
        let mut meta = existing.meta.clone();
        meta.scope = target;
        meta.updated = now_ms();
        let (file, package_dir) = self.entry_file(&meta);
        if file.exists() {
            bail!("an entry with the same id already exists in scope {target}");
        }
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("unable to create {}", parent.display()))?;
        }
        if let (Some(src_dir), Some(dst_dir)) = (&existing.package_dir, &package_dir) {
            copy_dir_recursive(Path::new(src_dir), dst_dir)?;
            fs::write(&file, render_file(&meta, &existing.body))?;
            fs::remove_dir_all(src_dir).with_context(|| format!("unable to remove {src_dir}"))?;
        } else {
            fs::write(&file, render_file(&meta, &existing.body))
                .with_context(|| format!("unable to write {}", file.display()))?;
            fs::remove_file(&existing.path)
                .with_context(|| format!("unable to remove {}", existing.path))?;
        }
        self.refresh_index(Scope::Global);
        self.refresh_index(Scope::Project);
        let entry = read_entry(&file, target, meta.kind)?;
        if target == Scope::Global {
            self.publish_team(&entry);
        } else {
            self.unpublish_team(&existing);
        }
        Ok(entry)
    }

    pub fn promote(&self, id: &str) -> Result<Entry> {
        self.move_scope(id, Scope::Global)
    }

    pub fn demote(&self, id: &str) -> Result<Entry> {
        self.move_scope(id, Scope::Project)
    }

    /// Path of the Markdown file (and package dir for skills) for a meta.
    fn entry_file(&self, meta: &EntryMeta) -> (PathBuf, Option<PathBuf>) {
        let dir = self.paths.kind_dir(meta.scope, meta.kind);
        if meta.kind == EntryKind::Skill {
            let package = dir.join(&meta.id);
            (package.join(SKILL_FILE_NAME), Some(package))
        } else {
            (dir.join(format!("{}.md", meta.id)), None)
        }
    }

    /// axe:harnais-equipe - copie une entrée globale dans le harnais d'équipe,
    /// avec l'auteur. Une erreur (droits, dossier absent) n'empêche pas
    /// l'écriture locale : elle est seulement journalisée.
    fn publish_team(&self, entry: &Entry) {
        if entry.meta.scope != Scope::Global {
            return;
        }
        let Some(team) = &self.paths.team_root else { return };
        if let Err(err) = self.write_team(team, entry) {
            tracing::warn!(error = %err, id = %entry.meta.id, "harnais d'équipe non publié");
        }
    }

    fn write_team(&self, team: &Path, entry: &Entry) -> Result<()> {
        if !team.is_dir() {
            bail!("dossier du harnais d'équipe absent : {}", team.display());
        }
        let mut meta = entry.meta.clone();
        meta.tags.retain(|t| !t.starts_with(TEAM_AUTHOR_TAG));
        meta.tags.push(format!("{TEAM_AUTHOR_TAG}{}", team_author()));
        let dir = team.join(meta.kind.dir_name());
        // Une autre entrée d'équipe du même titre (autre id) est remplacée.
        for old in self.load_kind_dir(&dir, Scope::Global, meta.kind) {
            if old.meta.id != meta.id && old.meta.title == meta.title {
                let _ = match &old.package_dir {
                    Some(d) => fs::remove_dir_all(d),
                    None => fs::remove_file(&old.path),
                };
            }
        }
        let (file, package) = if meta.kind == EntryKind::Skill {
            let package = dir.join(&meta.id);
            (package.join(SKILL_FILE_NAME), Some(package))
        } else {
            (dir.join(format!("{}.md", meta.id)), None)
        };
        fs::create_dir_all(file.parent().unwrap_or(&dir))?;
        if let (Some(src), Some(dst)) = (&entry.package_dir, &package) {
            if Path::new(src) != dst.as_path() {
                copy_dir_recursive(Path::new(src), dst)?;
            }
        }
        fs::write(&file, render_file(&meta, &entry.body))
            .with_context(|| format!("unable to write {}", file.display()))?;
        share_perms(&dir);
        if let Some(p) = &package {
            share_perms(p);
        }
        share_perms(&file);
        Ok(())
    }

    fn unpublish_team(&self, entry: &Entry) {
        let Some(team) = &self.paths.team_root else { return };
        if entry.meta.scope != Scope::Global {
            return;
        }
        let dir = team.join(entry.meta.kind.dir_name());
        let _ = if entry.meta.kind == EntryKind::Skill {
            fs::remove_dir_all(dir.join(&entry.meta.id))
        } else {
            fs::remove_file(dir.join(format!("{}.md", entry.meta.id)))
        };
    }

    fn refresh_index(&self, scope: Scope) {
        if let Ok(entries) = self.list(None, Some(scope)) {
            let _ = self.write_index(scope, &entries);
        }
    }

    /// Read-only summary used by the Settings pane header.
    pub fn counts(&self) -> Result<BTreeMap<String, usize>> {
        let mut counts = BTreeMap::new();
        for entry in self.load_all()? {
            *counts
                .entry(format!("{}:{}", entry.meta.scope, entry.meta.kind))
                .or_insert(0) += 1;
        }
        Ok(counts)
    }
}

/// Parse one entry file. Missing frontmatter fields are repaired from the
/// path so hand-written files still load.
pub fn read_entry(file: &Path, scope: Scope, kind: EntryKind) -> Result<Entry> {
    let content =
        fs::read_to_string(file).with_context(|| format!("unable to read {}", file.display()))?;
    let parsed = parse_file(&content);
    let fallback_id = if kind == EntryKind::Skill {
        file.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("skill")
            .to_string()
    } else {
        file.file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("entry")
            .to_string()
    };
    let id = parsed
        .scalars
        .get("id")
        .filter(|v| !v.is_empty())
        .cloned()
        .unwrap_or_else(|| fallback_id.clone());
    let title = parsed
        .scalars
        .get("title")
        .or_else(|| parsed.scalars.get("name"))
        .filter(|v| !v.is_empty())
        .cloned()
        .or_else(|| first_heading(&parsed.body))
        .unwrap_or(fallback_id);
    let created = parsed
        .scalars
        .get("created")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or_else(now_ms);
    let updated = parsed
        .scalars
        .get("updated")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(created);
    let meta = EntryMeta {
        id,
        kind,
        scope,
        title,
        created,
        updated,
        source: parsed.scalars.get("source").cloned().unwrap_or_default(),
        evidence: parsed.lists.get("evidence").cloned().unwrap_or_default(),
        tags: parsed.lists.get("tags").cloned().unwrap_or_default(),
    };
    let package_dir = if kind == EntryKind::Skill {
        file.parent().map(|p| crate::os_path(p).display().to_string())
    } else {
        None
    };
    Ok(Entry {
        meta,
        body: parsed.body,
        path: crate::os_path(&file).display().to_string(),
        package_dir,
    })
}

fn first_heading(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix('#').map(|rest| rest.trim_start_matches('#').trim().to_string()))
        .filter(|s| !s.is_empty())
}

/// Droits de groupe (lecture/écriture) sur le harnais d'équipe : les espaces
/// tournent avec UMask=0077.
fn share_perms(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if path.is_dir() { 0o2770 } else { 0o660 };
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
        if path.is_dir() {
            if let Ok(read) = fs::read_dir(path) {
                for item in read.flatten() {
                    share_perms(&item.path());
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

pub fn default_skill_code(name: &str, description: &str) -> String {
    let doc = excerpt_of(description).replace("\"\"\"", "'''");
    format!(
        "\"\"\"{name} — {doc}\n\nThis package is a harness skill. Read SKILL.md next to this file for the\nfull instructions; add helper functions below and import them from the REPL\nwith `import {name}`.\n\"\"\"\n\n__all__: list[str] = []\n"
    )
}

pub fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).with_context(|| format!("unable to create {}", dst.display()))?;
    for entry in fs::read_dir(src).with_context(|| format!("unable to read {}", src.display()))? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)
                .with_context(|| format!("unable to copy {}", entry.path().display()))?;
        }
    }
    Ok(())
}


#[cfg(test)]
mod team_tests {
    use super::*;

    fn store(root: &Path, who: &str, team: &Path) -> HarnessStore {
        let mut paths = HarnessPaths::with_home(root.join(who).join("ws"), Some(root.join(who).join("home")));
        paths.team_root = Some(team.to_path_buf());
        HarnessStore::new(paths)
    }

    fn new(title: &str, body: &str) -> NewEntry {
        serde_json::from_value(serde_json::json!({"title": title, "body": body})).unwrap()
    }

    #[test]
    fn publication_de_a_visible_par_b_derniere_ecriture_gagne() {
        let root = std::env::temp_dir().join(format!("axecode-equipe-{}", uuid::Uuid::new_v4().simple()));
        let team = root.join("harnais-equipe");
        fs::create_dir_all(&team).unwrap();
        let a = store(&root, "a", &team);
        let b = store(&root, "b", &team);
        // Sans dossier d'équipe : rien de partagé (comportement d'avant).
        let mut solo_paths = HarnessPaths::with_home(root.join("c/ws"), Some(root.join("c/home")));
        solo_paths.team_root = None;
        let solo = HarnessStore::new(solo_paths);

        let pub_a = a.create(Scope::Global, EntryKind::Memory, new("Règle", "version A")).unwrap();
        let seen = b.list(Some(EntryKind::Memory), Some(Scope::Global)).unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].body.trim(), "version A");
        assert!(seen[0].meta.tags.iter().any(|t| t.starts_with(TEAM_AUTHOR_TAG)), "auteur noté");
        assert!(solo.list(None, Some(Scope::Global)).unwrap().is_empty());
        // Le projet de B n'est pas touché.
        assert!(b.list(None, Some(Scope::Project)).unwrap().is_empty());

        // B publie la même entrée (même titre) plus tard : dernière écriture gagne chez A.
        std::thread::sleep(std::time::Duration::from_millis(5));
        b.create(Scope::Global, EntryKind::Memory, new("Règle", "version B")).unwrap();
        let seen_a = a.list(Some(EntryKind::Memory), Some(Scope::Global)).unwrap();
        assert_eq!(seen_a.len(), 1);
        assert_eq!(seen_a[0].body.trim(), "version B");
        assert_eq!(fs::read_dir(team.join(EntryKind::Memory.dir_name())).unwrap().count(), 1);

        // A met à jour sa copie : redevient la plus récente pour B.
        std::thread::sleep(std::time::Duration::from_millis(5));
        a.update(&pub_a.meta.id, serde_json::from_value(serde_json::json!({"body": "version A2"})).unwrap()).unwrap();
        let seen_b = b.list(Some(EntryKind::Memory), Some(Scope::Global)).unwrap();
        assert_eq!(seen_b.len(), 1);
        assert_eq!(seen_b[0].body.trim(), "version A2");

        // Compétence publiée par A : visible par B, paquet compris.
        a.create(Scope::Global, EntryKind::Skill, new("outil equipe", "doc")).unwrap();
        let skills = b.list(Some(EntryKind::Skill), Some(Scope::Global)).unwrap();
        assert_eq!(skills.len(), 1);
        assert!(Path::new(skills[0].package_dir.as_ref().unwrap()).join(SKILL_INIT_FILE_NAME).is_file());
        let _ = fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempdir::TempDir, HarnessStore) {
        let dir = tempdir::TempDir::new("harness");
        let paths = HarnessPaths::with_home(dir.path().join("ws"), Some(dir.path().join("home")));
        (dir, HarnessStore::new(paths))
    }

    #[test]
    fn crud_roundtrip() {
        let (_dir, store) = temp_store();
        let created = store
            .create(
                Scope::Project,
                EntryKind::Memory,
                NewEntry {
                    title: "Build command".into(),
                    body: "Use `npm run build`.".into(),
                    source: Some("agent".into()),
                    evidence: vec!["turn 4".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(created.meta.id.starts_with("mem_"));
        let loaded = store.get(&created.meta.id).unwrap().unwrap();
        assert_eq!(loaded.body, "Use `npm run build`.");
        assert_eq!(loaded.meta.evidence, vec!["turn 4".to_string()]);

        let updated = store
            .update(
                &created.meta.id,
                EntryPatch {
                    body: Some("Use `npm run build` (tsc + vite).".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(updated.body.contains("tsc"));

        let promoted = store.promote(&created.meta.id).unwrap();
        assert_eq!(promoted.meta.scope, Scope::Global);
        assert!(store.list(Some(EntryKind::Memory), Some(Scope::Project)).unwrap().is_empty());
        assert_eq!(store.list(Some(EntryKind::Memory), Some(Scope::Global)).unwrap().len(), 1);

        let index: Index = serde_json::from_str(
            &fs::read_to_string(store.paths().global_root.join(INDEX_FILE_NAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(index.entries.len(), 1);

        store.delete(&created.meta.id).unwrap();
        assert!(store.get(&created.meta.id).unwrap().is_none());
    }

    #[test]
    fn skill_is_a_package() {
        let (_dir, store) = temp_store();
        let skill = store
            .create(
                Scope::Global,
                EntryKind::Skill,
                NewEntry {
                    title: "Git Bisect Helper".into(),
                    body: "# Git bisect\nHow to bisect.".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(skill.meta.id, "git_bisect_helper");
        let pkg = PathBuf::from(skill.package_dir.clone().unwrap());
        assert!(pkg.join(SKILL_INIT_FILE_NAME).is_file());
        assert!(pkg.join(SKILL_FILE_NAME).is_file());
        // lookup by name works too
        assert!(store.get_kind(EntryKind::Skill, "git_bisect_helper").unwrap().is_some());
        let demoted = store.demote("git_bisect_helper").unwrap();
        assert_eq!(demoted.meta.scope, Scope::Project);
        assert!(!pkg.exists());
    }

    #[test]
    fn hand_written_file_without_frontmatter_loads() {
        let (_dir, store) = temp_store();
        let dir = store.paths().kind_dir(Scope::Project, EntryKind::PromptNote);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manual.md"), "# Manual note\n\nSome text").unwrap();
        let entries = store.list(Some(EntryKind::PromptNote), None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].meta.id, "manual");
        assert_eq!(entries[0].meta.title, "Manual note");
    }

    // axe:migration
    fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for item in fs::read_dir(&dir).unwrap().flatten() {
                let path = item.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.insert(path.clone(), fs::read(&path).unwrap());
                }
            }
        }
        out
    }

    #[test]
    fn legacy_project_entries_are_read_only() {
        let (dir, store) = temp_store();
        let legacy = store.paths().legacy_project_root.clone().unwrap();
        assert_eq!(legacy, dir.path().join("ws").join(LEGACY_PROJECT_DIR_NAME).join(HARNESS_DIR_NAME));
        fs::create_dir_all(legacy.join("notes")).unwrap();
        fs::write(legacy.join("notes/note_a.md"), "# Old A\n\nold a").unwrap();
        fs::write(legacy.join("notes/note_b.md"), "# Old B\n\nold b").unwrap();
        let old_skill = legacy.join("skills/old_skill");
        fs::create_dir_all(&old_skill).unwrap();
        fs::write(old_skill.join(SKILL_FILE_NAME), "# old skill").unwrap();
        fs::write(old_skill.join(SKILL_INIT_FILE_NAME), "X = 1\n").unwrap();
        let before = tree(&legacy);
        // Read after the new folder.
        assert_eq!(store.list(Some(EntryKind::PromptNote), Some(Scope::Project)).unwrap().len(), 2);
        assert!(store.get("note_a").unwrap().unwrap().body.contains("old a"));
        assert!(store.get_kind(EntryKind::Skill, "old_skill").unwrap().is_some());
        // Update: written into the new folder, which then hides the old file.
        let patch = EntryPatch { body: Some("new a".into()), ..Default::default() };
        let updated = store.update("note_a", patch).unwrap();
        let new_root = crate::os_path(&store.paths().project_root);
        assert!(Path::new(&updated.path).starts_with(&new_root));
        assert_eq!(store.get("note_a").unwrap().unwrap().body.trim(), "new a");
        assert_eq!(store.list(Some(EntryKind::PromptNote), None).unwrap().len(), 2);
        let patch = EntryPatch { code: Some("X = 2\n".into()), ..Default::default() };
        let skill = store.update("old_skill", patch).unwrap();
        let package = PathBuf::from(skill.package_dir.unwrap());
        assert!(package.starts_with(&new_root));
        assert_eq!(fs::read_to_string(package.join(SKILL_INIT_FILE_NAME)).unwrap(), "X = 2\n");
        // Delete and move: refused; the old folder never changes.
        assert!(store.delete("note_b").is_err());
        assert!(store.promote("note_b").is_err());
        assert_eq!(tree(&legacy), before);
        assert!(!store.paths().skills_paths().iter().any(|p| p.starts_with(&legacy)));
    }

    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct TempDir(PathBuf);

        impl TempDir {
            pub fn new(prefix: &str) -> Self {
                let path = std::env::temp_dir().join(format!(
                    "{prefix}-{}-{}",
                    std::process::id(),
                    uuid::Uuid::new_v4().simple()
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
