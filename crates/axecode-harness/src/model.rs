//! Core data model of the harness: entry kinds, scopes, metadata and the
//! Markdown + YAML frontmatter on-disk format.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

/// The four kinds of harness entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    PromptNote,
    Memory,
    Skill,
    SubagentSpec,
}

impl EntryKind {
    pub const ALL: [EntryKind; 4] = [
        EntryKind::PromptNote,
        EntryKind::Memory,
        EntryKind::Skill,
        EntryKind::SubagentSpec,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EntryKind::PromptNote => "prompt_note",
            EntryKind::Memory => "memory",
            EntryKind::Skill => "skill",
            EntryKind::SubagentSpec => "subagent_spec",
        }
    }

    /// Folder name under `<scope root>/`.
    pub fn dir_name(self) -> &'static str {
        match self {
            EntryKind::PromptNote => "notes",
            EntryKind::Memory => "memories",
            EntryKind::Skill => "skills",
            EntryKind::SubagentSpec => "subagents",
        }
    }

    /// Short prefix used when minting ids (`note_ab12cd`).
    pub fn id_prefix(self) -> &'static str {
        match self {
            EntryKind::PromptNote => "note",
            EntryKind::Memory => "mem",
            EntryKind::Skill => "skill",
            EntryKind::SubagentSpec => "agent",
        }
    }

    /// Whether this kind is injected in the per-turn system reminder.
    pub fn is_injected(self) -> bool {
        matches!(self, EntryKind::PromptNote | EntryKind::Memory)
    }
}

impl fmt::Display for EntryKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for EntryKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "prompt_note" | "note" | "notes" => Ok(EntryKind::PromptNote),
            "memory" | "memories" | "mem" => Ok(EntryKind::Memory),
            "skill" | "skills" => Ok(EntryKind::Skill),
            "subagent_spec" | "subagent" | "subagents" | "agent" => Ok(EntryKind::SubagentSpec),
            other => Err(format!("unknown harness kind `{other}`")),
        }
    }
}

/// Where an entry lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    Project,
}

impl Scope {
    pub const ALL: [Scope; 2] = [Scope::Global, Scope::Project];

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Global => "global",
            Scope::Project => "project",
        }
    }

    pub fn other(self) -> Scope {
        match self {
            Scope::Global => Scope::Project,
            Scope::Project => Scope::Global,
        }
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Scope {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "global" | "user" | "home" => Ok(Scope::Global),
            "project" | "workspace" | "local" => Ok(Scope::Project),
            other => Err(format!("unknown harness scope `{other}`")),
        }
    }
}

/// Frontmatter metadata stored at the top of every entry file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMeta {
    pub id: String,
    pub kind: EntryKind,
    pub scope: Scope,
    /// Human-readable title (also the Python package name for skills).
    pub title: String,
    /// Unix milliseconds.
    pub created: i64,
    /// Unix milliseconds.
    pub updated: i64,
    /// Who created this entry: `user`, `agent`, `refine:<id>`, `import:brain`, ...
    #[serde(default)]
    pub source: String,
    /// Short pieces of evidence (trajectory excerpts, file paths, ...).
    #[serde(default)]
    pub evidence: Vec<String>,
    /// Free-form tags.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A fully loaded entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub meta: EntryMeta,
    /// Markdown body (without frontmatter).
    pub body: String,
    /// Absolute path of the Markdown file (`SKILL.md` for skills).
    pub path: String,
    /// For skills: absolute path of the package folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_dir: Option<String>,
}

/// Lightweight index row persisted to `index.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRow {
    #[serde(flatten)]
    pub meta: EntryMeta,
    pub path: String,
    /// First ~160 chars of the body, for list views.
    pub excerpt: String,
}

impl From<&Entry> for IndexRow {
    fn from(entry: &Entry) -> Self {
        Self {
            meta: entry.meta.clone(),
            path: entry.path.clone(),
            excerpt: excerpt_of(&entry.body),
        }
    }
}

pub fn excerpt_of(body: &str) -> String {
    let flat: String = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");
    let mut out: String = flat.chars().take(160).collect();
    if flat.chars().count() > 160 {
        out.push('…');
    }
    out
}

/// Input for creating an entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEntry {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Skills only: Python source of `__init__.py` (defaults to a stub).
    #[serde(default)]
    pub code: Option<String>,
}

/// Patch for updating an entry; `None` fields are left untouched.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub evidence: Option<Vec<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub source: Option<String>,
    /// Skills only: replace `__init__.py`.
    #[serde(default)]
    pub code: Option<String>,
}

// ---------------------------------------------------------------------------
// Frontmatter (de)serialisation. We implement a tiny, dependency-free YAML
// subset: scalar `key: value` lines and `key:` followed by `- item` lists.
// Values are quoted with JSON string escaping when they contain special
// characters, which is valid YAML.
// ---------------------------------------------------------------------------

pub fn render_file(meta: &EntryMeta, body: &str) -> String {
    let mut out = String::from("---\n");
    push_scalar(&mut out, "id", &meta.id);
    push_scalar(&mut out, "kind", meta.kind.as_str());
    push_scalar(&mut out, "scope", meta.scope.as_str());
    push_scalar(&mut out, "title", &meta.title);
    out.push_str(&format!("created: {}\n", meta.created));
    out.push_str(&format!("updated: {}\n", meta.updated));
    push_scalar(&mut out, "source", &meta.source);
    push_list(&mut out, "evidence", &meta.evidence);
    push_list(&mut out, "tags", &meta.tags);
    out.push_str("---\n\n");
    out.push_str(body.trim_end());
    out.push('\n');
    out
}

fn push_scalar(out: &mut String, key: &str, value: &str) {
    out.push_str(key);
    out.push_str(": ");
    out.push_str(&yaml_scalar(value));
    out.push('\n');
}

fn push_list(out: &mut String, key: &str, items: &[String]) {
    if items.is_empty() {
        out.push_str(key);
        out.push_str(": []\n");
        return;
    }
    out.push_str(key);
    out.push_str(":\n");
    for item in items {
        out.push_str("  - ");
        out.push_str(&yaml_scalar(item));
        out.push('\n');
    }
}

fn yaml_scalar(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value.contains(['\n', ':', '#', '"', '\'', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', '%', '@', '`'])
        || value.starts_with(['-', '?'])
        || value.trim() != value
        || matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "null" | "yes" | "no" | "~"
        )
        || value.parse::<f64>().is_ok();
    if needs_quotes {
        serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
    } else {
        value.to_string()
    }
}

/// Parsed frontmatter + body.
#[derive(Debug, Clone, Default)]
pub struct ParsedFile {
    pub scalars: std::collections::BTreeMap<String, String>,
    pub lists: std::collections::BTreeMap<String, Vec<String>>,
    pub body: String,
}

pub fn parse_file(content: &str) -> ParsedFile {
    let mut parsed = ParsedFile::default();
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    let Some(first) = lines.next() else {
        return parsed;
    };
    if first.trim() != "---" {
        parsed.body = content.to_string();
        return parsed;
    }

    let mut current_list: Option<String> = None;
    let mut body_lines: Vec<&str> = Vec::new();
    let mut in_body = false;
    for line in lines {
        if in_body {
            body_lines.push(line);
            continue;
        }
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            in_body = true;
            continue;
        }
        if let Some(item) = trimmed.trim_start().strip_prefix("- ") {
            if let Some(key) = &current_list {
                parsed
                    .lists
                    .entry(key.clone())
                    .or_default()
                    .push(unquote(item.trim()));
                continue;
            }
        }
        if trimmed.trim().is_empty() || trimmed.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim();
        if value.is_empty() {
            current_list = Some(key.clone());
            parsed.lists.entry(key).or_default();
        } else if value == "[]" {
            current_list = None;
            parsed.lists.insert(key, Vec::new());
        } else if value.starts_with('[') && value.ends_with(']') {
            current_list = None;
            let inner = &value[1..value.len() - 1];
            let items = inner
                .split(',')
                .map(|item| unquote(item.trim()))
                .filter(|item| !item.is_empty())
                .collect();
            parsed.lists.insert(key, items);
        } else {
            current_list = None;
            parsed.scalars.insert(key, unquote(value));
        }
    }
    if !in_body {
        // Unterminated frontmatter: treat everything as body.
        parsed.body = content.to_string();
        parsed.scalars.clear();
        parsed.lists.clear();
        return parsed;
    }
    // Drop a single leading blank line after the frontmatter.
    let joined = body_lines.join("\n");
    parsed.body = joined.trim_start_matches('\n').trim_end().to_string();
    parsed
}

fn unquote(value: &str) -> String {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        if let Ok(decoded) = serde_json::from_str::<String>(value) {
            return decoded;
        }
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return value[1..value.len() - 1].replace("''", "'");
    }
    value.to_string()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `note_1a2b3c4d`-style id.
pub fn mint_id(kind: EntryKind) -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    format!("{}_{}", kind.id_prefix(), &raw[..8])
}

/// Turn a free title into a safe folder / Python identifier
/// (`My Skill!` → `my_skill`).
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut last_us = false;
    for ch in title.trim().chars() {
        let mapped = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch.is_alphanumeric() {
            // Keep non-ASCII letters out of Python identifiers; transliterate common accents.
            deaccent(ch)
        } else {
            None
        };
        match mapped {
            Some(c) => {
                out.push(c);
                last_us = false;
            }
            None => {
                if !last_us && !out.is_empty() {
                    out.push('_');
                    last_us = true;
                }
            }
        }
    }
    let out = out.trim_end_matches('_').to_string();
    let out = if out.is_empty() { "skill".to_string() } else { out };
    if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("s_{out}")
    } else {
        out
    }
}

fn deaccent(ch: char) -> Option<char> {
    Some(match ch {
        'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'ý' | 'ÿ' => 'y',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_roundtrip() {
        let meta = EntryMeta {
            id: "note_abc".into(),
            kind: EntryKind::PromptNote,
            scope: Scope::Global,
            title: "Préférences: style \"compact\"".into(),
            created: 1,
            updated: 2,
            source: "user".into(),
            evidence: vec!["turn 3: user said no".into(), "".into()],
            tags: vec![],
        };
        let text = render_file(&meta, "# Hello\n\nBody with --- inside\n");
        let parsed = parse_file(&text);
        assert_eq!(parsed.scalars["id"], "note_abc");
        assert_eq!(parsed.scalars["title"], meta.title);
        assert_eq!(parsed.lists["evidence"], meta.evidence);
        assert_eq!(parsed.lists["tags"], Vec::<String>::new());
        assert_eq!(parsed.body, "# Hello\n\nBody with --- inside");
    }

    #[test]
    fn plain_markdown_without_frontmatter() {
        let parsed = parse_file("# Title\ntext");
        assert!(parsed.scalars.is_empty());
        assert_eq!(parsed.body, "# Title\ntext");
    }

    #[test]
    fn slug() {
        assert_eq!(slugify("My Skill!"), "my_skill");
        assert_eq!(slugify("Débogage réseau"), "debogage_reseau");
        assert_eq!(slugify("123abc"), "s_123abc");
        assert_eq!(slugify("   "), "skill");
    }

    #[test]
    fn kind_parsing() {
        assert_eq!("prompt-note".parse::<EntryKind>().unwrap(), EntryKind::PromptNote);
        assert_eq!("subagent".parse::<EntryKind>().unwrap(), EntryKind::SubagentSpec);
        assert!("nope".parse::<EntryKind>().is_err());
    }
}
