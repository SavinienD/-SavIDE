//! Per-turn injection of harness notes and memories into the system reminder.
//!
//! The base prompt is immutable; this module only produces the *harness
//! layer* appended after it: notes first, then memories, global scope before
//! project scope, each line prefixed with its id so the agent can reference,
//! update or delete it through the `harness` module.

use crate::model::{Entry, EntryKind, Scope};

/// Maximum characters of one entry body kept in the reminder.
pub const MAX_ENTRY_CHARS: usize = 1_200;
/// Maximum total characters of the harness layer.
pub const MAX_LAYER_CHARS: usize = 24_000;

const HEADER: &str = "# Harness\n\nThe following notes and memories were written by you or the user in earlier sessions. \
Treat them as standing instructions and known facts. Each line starts with its id: use \
`harness.update_*(id, ...)`, `harness.delete(id)`, `harness.promote(id)` or `harness.demote(id)` \
from the REPL when something is wrong, outdated or deserves a wider scope.\n\n";

const SHORTENED: &str = "Some entries are shortened to a summary: read one in full with \
`harness.get(\"memory\", id)` or `harness.get(\"prompt_note\", id)` before relying on its details.\n\n";

/// Render the harness reminder. Returns `None` when there is nothing to inject.
pub fn render_reminder(entries: &[Entry]) -> Option<String> {
    let mut sections: Vec<(&str, EntryKind, Vec<&Entry>)> = Vec::new();
    for kind in [EntryKind::PromptNote, EntryKind::Memory] {
        for scope in [Scope::Global, Scope::Project] {
            let mut items: Vec<&Entry> = entries
                .iter()
                .filter(|e| e.meta.kind == kind && e.meta.scope == scope)
                .filter(|e| !e.meta.tags.iter().any(|t| t == "plan"))
                .collect();
            if items.is_empty() {
                continue;
            }
            items.sort_by(|a, b| a.meta.created.cmp(&b.meta.created));
            let heading = match (kind, scope) {
                (EntryKind::PromptNote, Scope::Global) => "## Global prompt notes",
                (EntryKind::PromptNote, Scope::Project) => "## Project prompt notes",
                (EntryKind::Memory, Scope::Global) => "## Global memories",
                (EntryKind::Memory, Scope::Project) => "## Project memories",
                _ => unreachable!(),
            };
            sections.push((heading, kind, items));
        }
    }
    if sections.is_empty() {
        return None;
    }

    // Full bodies when everything fits; otherwise memories, then notes too,
    // become one-line summaries so that every entry stays listed.
    let mut out = String::new();
    for shortened in [
        &[][..],
        &[EntryKind::Memory],
        &[EntryKind::Memory, EntryKind::PromptNote],
    ] {
        let (text, omitted) = render_sections(&sections, shortened);
        out = text;
        if omitted == 0 {
            break;
        }
    }
    Some(out)
}

/// Renders the sections within `MAX_LAYER_CHARS`; returns the text and the
/// number of entries left out.
fn render_sections(
    sections: &[(&str, EntryKind, Vec<&Entry>)],
    shortened: &[EntryKind],
) -> (String, usize) {
    const OMITTED_NOTE_CHARS: usize = 120;
    let mut out = String::from(HEADER);
    if !shortened.is_empty() {
        out.push_str(SHORTENED);
    }
    let mut omitted = 0;
    for (heading, kind, items) in sections {
        if omitted > 0 {
            omitted += items.len();
            continue;
        }
        let mut block = format!("{heading}\n");
        let mut shown = 0;
        for entry in items {
            let line = if shortened.contains(kind) {
                render_short(entry)
            } else {
                render_entry(entry)
            };
            if omitted > 0
                || out.len() + block.len() + line.len() + OMITTED_NOTE_CHARS > MAX_LAYER_CHARS
            {
                omitted += 1;
                continue;
            }
            block.push_str(&line);
            block.push('\n');
            shown += 1;
        }
        if shown > 0 {
            out.push_str(&block);
            out.push('\n');
        }
    }
    if omitted > 0 {
        out.push_str(&format!(
            "\n_({omitted} more entries not shown — list them with `harness.list()`)_\n"
        ));
    }
    (out.trim_end().to_string(), omitted)
}

fn render_short(entry: &Entry) -> String {
    let excerpt = crate::model::excerpt_of(&entry.body);
    let mut line = format!("- [{}] **{}**", entry.meta.id, entry.meta.title.trim());
    if !excerpt.is_empty() {
        line.push_str(": ");
        line.push_str(&excerpt);
    }
    line
}

fn render_entry(entry: &Entry) -> String {
    let body = compact_body(&entry.body, MAX_ENTRY_CHARS);
    let mut line = format!("- [{}] **{}**", entry.meta.id, entry.meta.title.trim());
    if !body.is_empty() {
        if body.contains('\n') {
            line.push_str(":\n");
            for l in body.lines() {
                line.push_str("  ");
                line.push_str(l);
                line.push('\n');
            }
            line.pop();
        } else {
            line.push_str(": ");
            line.push_str(&body);
        }
    }
    line
}

fn compact_body(body: &str, max_chars: usize) -> String {
    // Drop a leading heading that duplicates the title.
    let mut lines: Vec<&str> = body.lines().map(str::trim_end).collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    if lines.first().is_some_and(|l| l.trim_start().starts_with('#')) {
        lines.remove(0);
    }
    let text = lines.join("\n").trim().to_string();
    if text.chars().count() <= max_chars {
        return text;
    }
    let mut cut: String = text.chars().take(max_chars).collect();
    cut.push('…');
    cut
}

/// Short list of skills available as Python packages, injected after the
/// notes/memories layer so the agent knows what it can `import`.
pub fn render_skills_hint(entries: &[Entry]) -> Option<String> {
    let mut skills: Vec<&Entry> = entries
        .iter()
        .filter(|e| e.meta.kind == EntryKind::Skill)
        // axe:cleanup — toggled off in Settings > Skills.
        .filter(|e| !e.meta.tags.iter().any(|t| t == "disabled"))
        .collect();
    if skills.is_empty() {
        return None;
    }
    skills.sort_by(|a, b| a.meta.title.cmp(&b.meta.title));
    let mut out = String::from(
        "## Harness skills (Python packages)\nImportable from the REPL with `import <name>`; read `<name>.__doc__` or `harness.get(\"skill\", \"<name>\")` for the full SKILL.md.\n",
    );
    for skill in skills {
        let excerpt = crate::model::excerpt_of(&skill.body);
        out.push_str(&format!(
            "- `{}` ({}){}\n",
            skill.meta.title,
            skill.meta.scope,
            if excerpt.is_empty() { String::new() } else { format!(": {excerpt}") }
        ));
    }
    Some(out.trim_end().to_string())
}

/// Sub-agent specs summary (name + one-line purpose) for `rlm()` callers.
pub fn render_subagent_specs_hint(entries: &[Entry]) -> Option<String> {
    let mut specs: Vec<&Entry> = entries
        .iter()
        .filter(|e| e.meta.kind == EntryKind::SubagentSpec)
        .collect();
    if specs.is_empty() {
        return None;
    }
    specs.sort_by(|a, b| a.meta.title.cmp(&b.meta.title));
    let mut out = String::from(
        "## Harness sub-agent specs\nUse the id as the `profile` argument of `rlm()` to spawn a sub-agent with this specification.\n",
    );
    for spec in specs {
        out.push_str(&format!(
            "- [{}] **{}** ({}): {}\n",
            spec.meta.id,
            spec.meta.title,
            spec.meta.scope,
            crate::model::excerpt_of(&spec.body)
        ));
    }
    Some(out.trim_end().to_string())
}

/// Archived plans (prompt notes tagged `plan`): titles only, read on demand.
pub fn render_plans_hint(entries: &[Entry]) -> Option<String> {
    let mut plans: Vec<&Entry> = entries
        .iter()
        .filter(|e| e.meta.kind == EntryKind::PromptNote && e.meta.tags.iter().any(|t| t == "plan"))
        .collect();
    if plans.is_empty() {
        return None;
    }
    plans.sort_by(|a, b| b.meta.updated.cmp(&a.meta.updated));
    let mut out = String::from(
        "## Archived plans\nRead one with `harness.get(\"prompt_note\", id)`; archive or update a plan with `harness.archive_plan(...)`.\n",
    );
    for plan in plans.iter().take(20) {
        let status = plan
            .body
            .lines()
            .find_map(|l| l.strip_prefix("**Statut** : "))
            .unwrap_or("?");
        out.push_str(&format!("- [{}] {} ({status})\n", plan.meta.id, plan.meta.title));
    }
    Some(out.trim_end().to_string())
}

/// Everything to append to the base system prompt for one turn.
pub fn render_layer(entries: &[Entry]) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(reminder) = render_reminder(entries) {
        parts.push(reminder);
    }
    if let Some(skills) = render_skills_hint(entries) {
        parts.push(skills);
    }
    if let Some(specs) = render_subagent_specs_hint(entries) {
        parts.push(specs);
    }
    if let Some(plans) = render_plans_hint(entries) {
        parts.push(plans);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::EntryMeta;

    fn entry(kind: EntryKind, scope: Scope, id: &str, title: &str, body: &str, created: i64) -> Entry {
        Entry {
            meta: EntryMeta {
                id: id.into(),
                kind,
                scope,
                title: title.into(),
                created,
                updated: created,
                source: "user".into(),
                evidence: vec![],
                tags: vec![],
            },
            body: body.into(),
            path: String::new(),
            package_dir: None,
        }
    }

    #[test]
    fn order_is_notes_then_memories_global_then_project() {
        let entries = vec![
            entry(EntryKind::Memory, Scope::Project, "mem_p", "Proj mem", "pm", 4),
            entry(EntryKind::PromptNote, Scope::Project, "note_p", "Proj note", "pn", 3),
            entry(EntryKind::Memory, Scope::Global, "mem_g", "Glob mem", "gm", 2),
            entry(EntryKind::PromptNote, Scope::Global, "note_g", "Glob note", "# Glob note\ngn", 1),
            entry(EntryKind::Skill, Scope::Global, "sk", "sk", "skill body", 0),
        ];
        let text = render_reminder(&entries).unwrap();
        let pos = |needle: &str| text.find(needle).unwrap_or_else(|| panic!("{needle} missing"));
        assert!(pos("[note_g]") < pos("[note_p]"));
        assert!(pos("[note_p]") < pos("[mem_g]"));
        assert!(pos("[mem_g]") < pos("[mem_p]"));
        assert!(text.contains("**Glob note**: gn"));
        assert!(!text.contains("skill body"));
    }

    #[test]
    fn oversized_harness_ends_with_a_counter() {
        let body = "x".repeat(500);
        let entries: Vec<Entry> = (0..400)
            .map(|i| entry(EntryKind::Memory, Scope::Global, &format!("mem_{i}"), "m", &body, i))
            .collect();
        let text = render_reminder(&entries).unwrap();
        assert!(text.len() <= MAX_LAYER_CHARS);
        let shown = text.matches("[mem_").count();
        assert!(shown > 0);
        let omitted = 400 - shown;
        assert!(text.ends_with(&format!(
            "_({omitted} more entries not shown — list them with `harness.list()`)_"
        )));
    }

    #[test]
    fn empty_when_nothing_to_inject() {
        assert!(render_reminder(&[]).is_none());
        let skill_only = vec![entry(EntryKind::Skill, Scope::Global, "x", "x", "b", 0)];
        assert!(render_reminder(&skill_only).is_none());
        assert!(render_layer(&skill_only).unwrap().contains("import <name>"));
    }
}
