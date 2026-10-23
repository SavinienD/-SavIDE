//! Locating the Python interpreter and the `axecode_kernel` package.

use std::path::{Path, PathBuf};

/// Embedded interpreter (Tauri sidecar layout) or system python in dev.
pub fn find_python(resource_dirs: &[PathBuf]) -> Option<PathBuf> {
    if let Ok(explicit) = axecode_core::env::var("AXECODE_PYTHON") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    let exe_name = if cfg!(windows) { "python.exe" } else { "bin/python3" };
    for dir in resource_dirs {
        for candidate in [
            dir.join("python-runtime").join(exe_name),
            dir.join("binaries").join("python-runtime").join(exe_name),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    let names: &[&str] = if cfg!(windows) {
        &["python.exe", "python3.exe"]
    } else {
        &["python3", "python"]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            // Skip the Windows Store alias stub which opens the store.
            if candidate.exists() && !candidate.to_string_lossy().contains("WindowsApps") {
                return Some(candidate);
            }
        }
    }
    None
}

/// Directory that contains the `axecode_kernel` package.
pub fn find_package_dir(resource_dirs: &[PathBuf]) -> Option<PathBuf> {
    if let Ok(explicit) = axecode_core::env::var("AXECODE_KERNEL_DIR") {
        let path = PathBuf::from(explicit);
        if has_package(&path) {
            return Some(path);
        }
    }
    for dir in resource_dirs {
        for candidate in [dir.join("python"), dir.clone()] {
            if has_package(&candidate) {
                return Some(candidate);
            }
        }
    }
    // Dev: walk up from the executable / cwd to the repository `python/` dir.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        roots.extend(exe.ancestors().map(Path::to_path_buf));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.extend(cwd.ancestors().map(Path::to_path_buf));
    }
    roots
        .into_iter()
        .map(|root| root.join("python"))
        .find(|candidate| has_package(candidate))
}

fn has_package(dir: &Path) -> bool {
    dir.join("axecode_kernel").join("__main__.py").exists()
}
