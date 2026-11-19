//! Kernel-state notices for the model (lot D1, reprise Unharnessed).
//!
//! A compaction rebuilds the conversation but the Python kernel keeps its
//! namespace; a restart (crash, Stop, app restart) brings variables back from
//! the last snapshot, except the ones that were left out. In both cases the
//! model gets an explicit list of the names that are defined and of the ones
//! that are lost, instead of guessing (and rebuilding everything, or using a
//! name that no longer exists).

use serde::Deserialize;

/// Most names quoted in a notice; the rest is counted.
pub const NOTICE_NAMES_CAP: usize = 60;

/// A name left out of a snapshot, and why (as written by the kernel).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct Skipped {
    pub name: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Reply of the kernel `names` command.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Namespace {
    /// User-defined variables, functions and classes still defined.
    #[serde(default)]
    pub names: Vec<String>,
    /// Aliases of modules the user imported.
    #[serde(default)]
    pub modules: Vec<String>,
    /// Number of user names (`names` may be capped).
    #[serde(default)]
    pub total: usize,
    /// Names the last snapshot left out: lost if the kernel restarts.
    #[serde(default)]
    pub at_risk: Vec<Skipped>,
}

fn quote(names: &[String]) -> String {
    quote_more(names, 0)
}

/// `extra` = names that exist but were not sent (capped by the kernel).
fn quote_more(names: &[String], extra: usize) -> String {
    let shown: Vec<&str> = names.iter().take(NOTICE_NAMES_CAP).map(String::as_str).collect();
    let mut text = shown.join(", ");
    let more = names.len() - shown.len() + extra;
    if more > 0 {
        text.push_str(&format!(" (+{more} more)"));
    }
    text
}

fn quote_lost(items: &[Skipped]) -> String {
    let shown: Vec<String> = items
        .iter()
        .take(NOTICE_NAMES_CAP)
        .map(|item| match item.reason.as_deref().filter(|r| !r.is_empty()) {
            Some(reason) => format!("{} ({reason})", item.name),
            None => item.name.clone(),
        })
        .collect();
    let mut text = shown.join(", ");
    if items.len() > shown.len() {
        text.push_str(&format!(" (+{} more)", items.len() - shown.len()));
    }
    text
}

/// Notice appended after a compaction. `None` = the listing failed.
pub fn notice_after_compaction(namespace: Option<&Namespace>) -> String {
    let mut text = String::from(
        "[python-state] Your Python kernel persisted through compaction: its variables, \
         imports and helpers are still available, do not rebuild them.",
    );
    let Some(ns) = namespace else {
        text.push_str(" (The list of names could not be read.)");
        return text;
    };
    if ns.names.is_empty() && ns.modules.is_empty() {
        text.push_str(" You have not defined any names yet.");
    } else {
        if !ns.names.is_empty() {
            let extra = ns.total.saturating_sub(ns.names.len());
            text.push_str(&format!(" These names are still defined: {}.", quote_more(&ns.names, extra)));
        }
        if !ns.modules.is_empty() {
            text.push_str(&format!(" Imported modules: {}.", quote(&ns.modules)));
        }
    }
    if !ns.at_risk.is_empty() {
        text.push_str(&format!(
            " Left out of the last snapshot, so lost if the kernel restarts: {}.",
            quote_lost(&ns.at_risk)
        ));
    }
    text
}

/// Notice for a kernel that was (re)started and given the last snapshot.
/// `restarted` = it replaced a dead kernel of the same conversation;
/// otherwise the conversation resumes (app restart, new turn after Stop).
pub fn notice_after_restore(restarted: bool, restored: &[String], lost: &[Skipped]) -> String {
    let head = if restarted { "kernel restarted" } else { "kernel resumed" };
    let mut text = if restored.is_empty() {
        format!("{head}: no variable restored from the last snapshot")
    } else {
        format!(
            "{head}: {} variable(s) restored from the last snapshot (end of the previous turn): {}; \
             changes made since then are lost",
            restored.len(),
            quote(restored)
        )
    };
    if !lost.is_empty() {
        text.push_str(&format!("; lost, define them again if you need them: {}", quote_lost(lost)));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compaction_notice_lists_names_modules_and_risks() {
        let ns = Namespace {
            names: vec!["a".into(), "f".into()],
            modules: vec!["np".into()],
            total: 2,
            at_risk: vec![Skipped { name: "f".into(), reason: Some("trop gros".into()) }],
        };
        let text = notice_after_compaction(Some(&ns));
        assert!(text.contains("These names are still defined: a, f."), "{text}");
        assert!(text.contains("Imported modules: np."), "{text}");
        assert!(text.ends_with("lost if the kernel restarts: f (trop gros)."), "{text}");
        let empty = notice_after_compaction(Some(&Namespace::default()));
        assert!(empty.ends_with("You have not defined any names yet."), "{empty}");
        assert!(notice_after_compaction(None).contains("could not be read"));
    }

    #[test]
    fn capped_lists_keep_the_count() {
        let names: Vec<String> = (0..70).map(|i| format!("v{i}")).collect();
        let ns = Namespace { names, total: 75, ..Default::default() };
        let text = notice_after_compaction(Some(&ns));
        assert!(text.contains("v59 (+15 more)."), "{text}");
    }

    #[test]
    fn restore_notice() {
        let text = notice_after_restore(true, &["x".into()], &[Skipped { name: "big".into(), reason: None }]);
        assert_eq!(
            text,
            "kernel restarted: 1 variable(s) restored from the last snapshot (end of the previous turn): x; \
             changes made since then are lost; lost, define them again if you need them: big"
        );
        assert_eq!(notice_after_restore(false, &[], &[]), "kernel resumed: no variable restored from the last snapshot");
    }
}
