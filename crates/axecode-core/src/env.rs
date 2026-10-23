//! Environment variables of the app, read under their name `AXECODE_<X>`,
//! then under the names of before the rename (read only: services, scripts
//! and shortcuts written for the old name keep working).

use std::{env::VarError, ffi::OsString};

/// Prefix of the variables of the app.
pub const PREFIX: &str = "AXECODE_";
// rebrand:keep-begin (old prefixes, read only)
/// Prefixes of before the rename, in reading order.
pub const LEGACY_PREFIXES: &[&str] = &["ATELIER_", "AXE_ATELIER_"];
// rebrand:keep-end

/// Names read for `name`, in order: `name`, then, for an `AXECODE_<X>` name,
/// `<old prefix><X>`.
pub fn names(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string()];
    if let Some(rest) = name.strip_prefix(PREFIX) {
        names.extend(LEGACY_PREFIXES.iter().map(|prefix| format!("{prefix}{rest}")));
    }
    names
}

/// Like `std::env::var_os`: the first non-empty value among [`names`], else
/// the value of `name` itself (possibly empty).
pub fn var_os(name: &str) -> Option<OsString> {
    names(name)
        .iter()
        .find_map(|n| std::env::var_os(n).filter(|value| !value.is_empty()))
        .or_else(|| std::env::var_os(name))
}

/// Like `std::env::var`, with the fallback of [`var_os`].
pub fn var(name: &str) -> Result<String, VarError> {
    match var_os(name) {
        Some(value) => value.into_string().map_err(VarError::NotUnicode),
        None => Err(VarError::NotPresent),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_name_first_then_the_old_ones() {
        let new = "AXECODE_TEST_ENV_FALLBACK";
        let old: Vec<String> = LEGACY_PREFIXES.iter().map(|p| format!("{p}TEST_ENV_FALLBACK")).collect();
        let all = [new, old[0].as_str(), old[1].as_str()];
        for name in all {
            std::env::remove_var(name);
        }
        assert_eq!(var(new), Err(VarError::NotPresent));
        std::env::set_var(&old[1], "old 2");
        assert_eq!(var(new).as_deref(), Ok("old 2"));
        std::env::set_var(&old[0], "old 1");
        assert_eq!(var(new).as_deref(), Ok("old 1"));
        std::env::set_var(new, "");
        assert_eq!(var(new).as_deref(), Ok("old 1"), "an empty new name does not hide the old one");
        std::env::set_var(new, "new");
        assert_eq!(var(new).as_deref(), Ok("new"));
        assert_eq!(var_os(new), Some(OsString::from("new")));
        for name in all {
            std::env::remove_var(name);
        }
        std::env::set_var(new, "");
        assert_eq!(var(new).as_deref(), Ok(""), "new name alone: same as std");
        std::env::remove_var(new);
        assert_eq!(var_os(new), None);
    }

    #[test]
    fn only_names_of_the_app_have_old_names() {
        assert_eq!(names("PATH"), vec!["PATH".to_string()]);
        assert_eq!(names("AXECODE_PYTHON").len(), 3);
        // Built from pieces: the rebrand script must not rewrite them.
        assert_eq!(LEGACY_PREFIXES, ["ATELIER_", "AXE_ATELIER_"]);
    }
}
