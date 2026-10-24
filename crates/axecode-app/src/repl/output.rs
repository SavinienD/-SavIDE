//! Output shaping for REPL results sent back to the model.

use axecode_repl::ExecResult;

/// Keeps the head and the tail of `text` within `cap` chars, with a counter.
pub fn clip(text: &str, cap: usize) -> String {
    let total = text.chars().count();
    if total <= cap {
        return text.to_string();
    }
    let head = cap * 2 / 3;
    let tail = cap - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(total - tail).collect();
    format!(
        "{start}\n[… {} caractères omis sur {total} …]\n{end}",
        total - head - tail
    )
}

/// Renders an execution result for the model (stdout, stderr, value, error).
pub fn render(result: &ExecResult, cap: usize) -> String {
    let mut sections: Vec<String> = Vec::new();
    let budget = cap.max(1_000);
    let has_err = !result.stderr.trim().is_empty();
    let share = if has_err { budget * 2 / 3 } else { budget };
    if !result.stdout.is_empty() {
        let mut out = clip(&result.stdout, share);
        if result.stdout_total > result.stdout.chars().count() {
            out.push_str(&format!(
                "\n[stdout truncated by kernel: {} chars total]",
                result.stdout_total
            ));
        }
        sections.push(out.trim_end().to_string());
    }
    if has_err {
        sections.push(format!(
            "[stderr]\n{}",
            clip(&result.stderr, budget - share).trim_end()
        ));
    }
    if let Some(value) = &result.value {
        sections.push(format!("[value]\n{}", clip(value, budget / 3)));
    }
    if let Some(error) = &result.error {
        if !result.stdout.contains(error.split(':').next().unwrap_or(error)) {
            sections.push(format!("[error]\n{error}"));
        }
    }
    if !result.file_changes.is_empty() {
        let files: Vec<&str> = result.file_changes.iter().map(|c| c.path.as_str()).collect();
        sections.push(format!("[files changed] {}", files.join(", ")));
    }
    if sections.is_empty() {
        sections.push("(no output)".into());
    }
    sections.push(format!("[{} ms]", result.duration_ms));
    sections.join("\n")
}

/// One-line summary for condensed UI cards.
pub fn summary(result: &ExecResult) -> String {
    if let Some(error) = &result.error {
        return clip(error.lines().next().unwrap_or(error), 160);
    }
    let first = result
        .value
        .as_deref()
        .or_else(|| result.stdout.lines().find(|l| !l.trim().is_empty()))
        .unwrap_or("(no output)");
    clip(first.lines().next().unwrap_or(first), 160)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_head_and_tail() {
        let text = "a".repeat(100) + &"b".repeat(100);
        let out = clip(&text, 30);
        assert!(out.starts_with("aaaa"));
        assert!(out.ends_with("bbbb"));
        assert!(out.contains("170 caractères omis sur 200"));
    }
}
