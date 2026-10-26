//! Continual harness for SavIDE.

pub mod cloud_mirror;
pub mod datadir;
pub mod host;
pub mod import;
pub mod inject;
pub mod legacy_dirs;
pub mod model;
pub mod refine;
pub mod store;

pub use model::{Entry, EntryKind, EntryMeta, EntryPatch, IndexRow, NewEntry, Scope};
pub use store::{HarnessPaths, HarnessStore};
pub use datadir::{app_data_dir, project_data_dir};

/// Form of a path to hand to the UI or to another program: without the
/// Windows verbatim prefix `\\?\` that `canonicalize` adds and that users
/// read as a strange, un-clickable path. Keep in sync with
/// `axecode_app::workspace::os_path`.
pub(crate) fn os_path(path: &std::path::Path) -> std::path::PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => std::path::PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

