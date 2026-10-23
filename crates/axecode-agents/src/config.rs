//! Service-side configuration for external agents.
//!
//! Tolerant JSON file `<data_dir>/agents-settings.json`; a missing or
//! malformed file keeps the defaults. Only commands declared here can be
//! launched by `agents.spawn`.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// File name, next to `repl-settings.json` and `skill-settings.json`.
pub const CONFIG_FILE: &str = "agents-settings.json";
pub const DEFAULT_MODELE: &str = "opencode/nemotron-3.5-super-vl-free";
pub const DEFAULT_MAX: usize = 2;
pub const DEFAULT_DELAI_S: u64 = 1800;

fn default_max() -> usize {
    DEFAULT_MAX
}
fn default_delai() -> u64 {
    DEFAULT_DELAI_S
}
fn default_modele() -> String {
    DEFAULT_MODELE.to_string()
}
fn default_commandes() -> BTreeMap<String, Vec<String>> {
    let mut map = BTreeMap::new();
    map.insert(
        "opencode".to_string(),
        vec![
            // Chemin PARTAGÉ (root, 0755) : la maison du compte d'administration est
            // en 0700, donc invisible depuis un compte SavIDE.
            "/opt/axecode/bin/opencode".to_string(),
            "run".to_string(),
            "--auto".to_string(),
            "--dir".to_string(),
            "{dir}".to_string(),
            "--model".to_string(),
            "{modele}".to_string(),
            "Lis {brief} et execute-le integralement. Autonome, aucune question, aucun secret, aucun git push. Ecris ton rapport final dans resultat.md.".to_string(),
        ],
    );
    map
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    /// Maximum number of tasks running at the same time.
    #[serde(default = "default_max")]
    pub agents_max: usize,
    /// Deadline of one task, in seconds.
    #[serde(default = "default_delai")]
    pub agents_delai_s: u64,
    /// Default model when `agents.spawn` does not send one.
    #[serde(default = "default_modele")]
    pub agents_modele: String,
    /// Allowed commands: a key accepted by `agents.spawn` and its argv
    /// template (`{dir}`, `{brief}`, `{modele}` are substituted).
    #[serde(default = "default_commandes")]
    pub agents_commandes: BTreeMap<String, Vec<String>>,
}

impl Default for AgentsConfig {
    fn default() -> Self {
        Self {
            agents_max: default_max(),
            agents_delai_s: default_delai(),
            agents_modele: default_modele(),
            agents_commandes: default_commandes(),
        }
    }
}

impl AgentsConfig {
    /// Reads `<data_dir>/agents-settings.json`, tolerantly.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(CONFIG_FILE);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(config) => config.normalized(),
            Err(error) => {
                tracing::warn!(path = %path.display(), error = %error, "invalid agents settings; using defaults");
                Self::default()
            }
        }
    }

    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(CONFIG_FILE)
    }

    /// Clamps the values that could break the supervisor or the launch.
    pub fn normalized(mut self) -> Self {
        self.agents_max = self.agents_max.max(1);
        self.agents_delai_s = self.agents_delai_s.max(1);
        if self.agents_modele.trim().is_empty() {
            self.agents_modele = default_modele();
        }
        self.agents_commandes
            .retain(|key, argv| !key.trim().is_empty() && !argv.is_empty() && !argv[0].trim().is_empty());
        if self.agents_commandes.is_empty() {
            self.agents_commandes = default_commandes();
        }
        self
    }
}

// rebrand:keep-begin (installation of before the rename, read only)
/// Installation folders of the shared programs: the new one, then the one of
/// before the rename.
pub const INSTALL_DIRS: [&str; 2] = ["/opt/axecode/", "/opt/savide/"];
// rebrand:keep-end

/// axe:migration - `/opt/axecode/<x>` when it exists, else the same program of
/// the installation of before the rename (and the other way round for
/// settings written before the rename).
pub fn installed_program(program: &str) -> String {
    installed_program_with(program, |path| Path::new(path).is_file())
}

fn installed_program_with(program: &str, exists: impl Fn(&str) -> bool) -> String {
    if exists(program) {
        return program.to_string();
    }
    for (from, to) in [(INSTALL_DIRS[0], INSTALL_DIRS[1]), (INSTALL_DIRS[1], INSTALL_DIRS[0])] {
        if let Some(rest) = program.strip_prefix(from) {
            let twin = format!("{to}{rest}");
            if exists(&twin) {
                return twin;
            }
        }
    }
    program.to_string()
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn program_of_the_installation_of_before_the_rename() {
        let new = format!("{}bin/opencode", INSTALL_DIRS[0]);
        let old = format!("{}bin/opencode", INSTALL_DIRS[1]);
        assert_eq!(installed_program_with(&new, |p| p == new || p == old), new);
        assert_eq!(installed_program_with(&new, |p| p == old), old);
        assert_eq!(installed_program_with(&old, |p| p == new), new);
        assert_eq!(installed_program_with(&new, |_| false), new);
        assert_eq!(installed_program_with("codex", |_| false), "codex");
        assert_eq!(default_commandes()["opencode"][0], new);
        // Built from pieces: the rebrand script must not rewrite it.
        assert_eq!(INSTALL_DIRS[1], concat!("/opt/axe-si", "new/"));
    }
}
