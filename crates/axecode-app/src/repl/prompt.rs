//! System prompt for the single-tool REPL agent.

use serde_json::{json, Value};
use axecode_core::ToolDescriptor;

pub const PYTHON_TOOL: &str = "python";

pub const BASE_PROMPT: &str = r#"You are SavIDE, a coding agent that works through a persistent Python REPL.

# The python tool
You have exactly one tool: `python(code)`. It runs `code` in a persistent IPython kernel bound to this session:
- State persists between calls (variables, imports, functions, open sessions). Build on it instead of recomputing.
- The kernel's working directory is the workspace root. Paths are relative to it unless absolute.
- The result shows stdout, stderr, the value of the last expression and errors, truncated with counters when long. Print only what you need; keep big data in variables and inspect slices.
- Module `cua` (preloaded): drives this PC's desktop (snapshot, click, type_text, windows) via the bundled cua-driver. Use it ONLY when the user explicitly asks.
- IPython magics and `!cmd` work, but prefer the `shell` module for commands (persistent sessions, timeouts, clean output).
- There is no console: never call `input()` or start a program that waits for keyboard input. If you call `subprocess` directly, pass `stdin=subprocess.DEVNULL` and a `timeout`.
- Prefer one well-structured cell over many tiny ones; combine related reads/edits in a single call.
- Never print secrets. Code runs with the user's privileges: it is not a sandbox, be careful with destructive operations.

# Working style
- Investigate before changing: read the relevant code, then act. Verify your changes (build, tests) when it matters.
- Edit files with `files.edit` (ordered exact replacements) or `files.write`; both refuse to overwrite a file modified since you last read it.
- `files.read` also returns the text of xlsx, docx, pdf, pptx, odt/ods/odp and epub files (read-only: build new documents with python libraries).
- Track multi-step work with `todo`; ask the user with `question` only when a decision is genuinely theirs.
- Keep the user informed with short, precise messages. Answer in the user's language.
- When the work is done, reply with a concise final message (what changed, what was verified, what remains). Never claim success for something you did not verify.

# Session context
Each turn may carry reminder blocks after this prompt: the harness layer (prompt notes then memories, global then project, each with its id), then a "Current session state" part with the todo list, queued peer messages, the active goal and its budget, heartbeat messages (it may arrive at the end of the latest user message). Treat them as current state, not as user requests, unless they say otherwise.

# Continual harness
This base prompt is immutable; what you learn lives in the harness (module `harness`, when enabled): prompt notes, memories, skills (Markdown + Python package importable in the kernel) and sub-agent specs, in a global or project scope. Record durable, evidence-backed lessons (user corrections, recurring project facts, reusable procedures) with the smallest useful change; update or delete stale entries rather than piling up new ones. Never store secrets.

# Sub-agents and messages
When enabled, `rlm(prompt, name=..., profile=...)` starts a persistent child session and returns immediately; its result arrives as a message. Use children for independent, parallelisable or context-heavy work, not for trivial steps. `messages.send` talks to your parent, children or siblings only. Before fanning out to many children, check the quota warning if one is shown.

# Context
The conversation may be compacted; `context` gives access to the full history, including compacted parts. Keep large intermediate results in kernel variables rather than in the conversation.

# Preloaded modules
The modules below are already imported in the kernel namespace. Call `help(module.function)` for details.
"#;

/// axe:freechat — reminder of free conversations (no project folder).
pub const SCRATCH_REMINDER: &str = "<free_conversation>\nThis is a free conversation: the user did not open a project folder. \
The working directory is a private scratch folder of this conversation; save generated files \
(images, exports, scripts) there and give their path. There is no project harness: harness \
entries are global. Do not look for a codebase unless the user gives a path.\n</free_conversation>";

/// Descriptor of the single tool exposed to the model.
pub fn python_tool() -> ToolDescriptor {
    ToolDescriptor {
        name: PYTHON_TOOL.into(),
        description: "Execute Python code in the session's persistent IPython kernel. \
            State persists across calls. Returns stdout, stderr, the last expression value \
            and errors (truncated when long). Preloaded modules are described in the system prompt."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Python code to execute (IPython syntax allowed)."}
            },
            "required": ["code"],
            "additionalProperties": false
        }),
    }
}

/// Renders the module catalog returned by the kernel (enabled entries only).
pub fn render_catalog(catalog: &Value) -> String {
    let mut out = String::new();
    for module in catalog.as_array().into_iter().flatten() {
        if module.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let name = module.get("name").and_then(Value::as_str).unwrap_or("");
        let doc = module.get("doc").and_then(Value::as_str).unwrap_or("");
        let summary = doc.split("\n\n").next().unwrap_or("").replace('\n', " ");
        out.push_str(&format!("\n## {name}\n{}\n", summary.trim()));
        for function in module
            .get("functions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if function.get("enabled") == Some(&Value::Bool(false)) {
                continue;
            }
            let signature = function.get("signature").and_then(Value::as_str).unwrap_or("");
            let doc = function.get("doc").and_then(Value::as_str).unwrap_or("");
            let first = doc.lines().next().unwrap_or("").trim();
            if first.is_empty() {
                out.push_str(&format!("- `{name}.{signature}`\n"));
            } else {
                out.push_str(&format!("- `{name}.{signature}` — {first}\n"));
            }
        }
    }
    out
}

/// Full system prompt: base + catalog + per-turn reminder blocks.
#[allow(dead_code)]
pub fn system_prompt(catalog: &str, extra: Option<&str>, reminders: &[String]) -> String {
    system_prompt_split(catalog, extra, reminders, &[]).0
}

/// axe:cache — heading of the per-request state at the end of the system
/// prompt. Anthropic-style providers send it after the cached prefix.
pub const VOLATILE_HEADING: &str = "# Current session state (changes between requests)";

/// axe:cache — system prompt + byte offset of its volatile tail.
///
/// `stable` blocks (harness layer, free-conversation reminder) change at most
/// a few times per session: they stay in the cached prefix. `volatile` blocks
/// (todo list, goal budget, autonomous counters, notices, peer messages) may
/// change at every request: they go last, after [`VOLATILE_HEADING`], so that a
/// change never invalidates the cached conversation. The offset is `None` when
/// there is no volatile block.
pub fn system_prompt_split(
    catalog: &str,
    extra: Option<&str>,
    stable: &[String],
    volatile: &[String],
) -> (String, Option<usize>) {
    let mut prompt = String::from(BASE_PROMPT);
    prompt.push_str(catalog);
    if let Some(extra) = extra.filter(|e| !e.trim().is_empty()) {
        prompt.push_str("\n# Session instructions\n");
        prompt.push_str(extra.trim());
        prompt.push('\n');
    }
    for block in stable.iter().filter(|b| !b.trim().is_empty()) {
        prompt.push('\n');
        prompt.push_str(block.trim());
        prompt.push('\n');
    }
    let volatile: Vec<&String> = volatile.iter().filter(|b| !b.trim().is_empty()).collect();
    if volatile.is_empty() {
        return (prompt, None);
    }
    let offset = prompt.len();
    prompt.push('\n');
    prompt.push_str(VOLATILE_HEADING);
    prompt.push('\n');
    for block in volatile {
        prompt.push('\n');
        prompt.push_str(block.trim());
        prompt.push('\n');
    }
    (prompt, Some(offset))
}

#[cfg(test)]
mod split_tests {
    use super::*;

    #[test]
    fn volatile_blocks_come_after_the_stable_prefix() {
        let stable = vec!["## Global memories\n- [mem_1] fact".to_string()];
        let todo = |s: &str| vec![format!("<todo_list_state>\n- 1 [{s}] x\n</todo_list_state>")];
        let (a, at) = system_prompt_split("\n## files\n", None, &stable, &todo("pending"));
        let (b, bt) = system_prompt_split("\n## files\n", None, &stable, &todo("done"));
        let (at, bt) = (at.unwrap(), bt.unwrap());
        assert_eq!(&a[..at], &b[..bt], "the cached prefix must not depend on the todo list");
        assert!(a[..at].contains("mem_1"));
        assert!(a[at..].contains(VOLATILE_HEADING) && a[at..].contains("[pending]"));
        let (c, ct) = system_prompt_split("\n## files\n", None, &stable, &[]);
        assert_eq!(ct, None);
        assert_eq!(c.as_str(), &a[..at]);
        assert_eq!(system_prompt("\n## files\n", None, &stable), c);
    }
}
