//! axe:freechat — free conversations (no project folder).
//!
//! A free conversation is a regular session whose workspace is a private,
//! persistent folder `<data>/scratch/<session-id>/`, so the Python REPL,
//! generated files and the global harness work as in a project.

use std::path::{Path, PathBuf};

pub const SCRATCH_DIR: &str = "scratch";

/// Root of every scratch folder.
pub fn scratch_root(data_dir: &Path) -> PathBuf {
    data_dir.join(SCRATCH_DIR)
}

/// Private folder of one free conversation.
pub fn scratch_dir(data_dir: &Path, session_id: &str) -> PathBuf {
    scratch_root(data_dir).join(session_id)
}

/// Comparable form of a path: no Windows verbatim prefix, `/` separators,
/// no trailing separator, case-insensitive on Windows.
fn comparable(path: &str) -> String {
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_string());
    let path = path.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

/// Whether `workspace` is a scratch folder (strictly below the scratch root).
pub fn is_scratch(data_dir: &Path, workspace: &str) -> bool {
    if workspace.trim().is_empty() {
        return false;
    }
    let root = comparable(&scratch_root(data_dir).display().to_string());
    let workspace = comparable(workspace);
    workspace.len() > root.len() + 1 && workspace.starts_with(&format!("{root}/"))
}

/// Data directory of a journal file (`<data>/sessions/<id>.jsonl`).
pub fn data_dir_of_journal(journal: &Path) -> Option<&Path> {
    journal.parent()?.parent()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_scratch_folders() {
        let data = Path::new("/data/axecode");
        assert!(is_scratch(data, "/data/axecode/scratch/abc"));
        assert!(is_scratch(data, "/data/axecode/scratch/abc/"));
        assert!(!is_scratch(data, "/data/axecode/scratch"));
        assert!(!is_scratch(data, "/data/axecode/scratchpad/abc"));
        assert!(!is_scratch(data, "/home/me/project"));
        assert!(!is_scratch(data, ""));
        if cfg!(windows) {
            let data = Path::new(r"C:\Users\me\AppData\Local\axecode");
            assert!(is_scratch(data, r"\\?\C:\Users\me\AppData\Local\axecode\scratch\abc"));
            assert!(is_scratch(data, r"c:/users/me/appdata/local/axecode/scratch/abc"));
        }
    }
}
