//! REPL settings (Settings > Outils, compaction, output caps), stored in
//! `<data_dir>/repl-settings.json` and shared by the IDE and the daemon.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REPL_SETTINGS_FILE: &str = "repl-settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FunctionSetting {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSetting {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub functions: BTreeMap<String, FunctionSetting>,
}

impl Default for ModuleSetting {
    fn default() -> Self {
        Self {
            enabled: true,
            description: None,
            functions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplSettings {
    /// Chat turns run through the REPL agent in the background service.
    #[serde(default = "default_true")]
    pub agent_enabled: bool,
    #[serde(default)]
    pub modules: BTreeMap<String, ModuleSetting>,
    /// Automatic compaction threshold, percent of the context window
    /// (multiple of 5, 50..=100; 100 disables auto compaction).
    #[serde(default = "default_threshold")]
    pub compaction_threshold: u8,
    /// Max output tokens per model key (`provider/model`).
    #[serde(default)]
    pub max_output_tokens: BTreeMap<String, u32>,
    /// Per-execution cap of characters returned to the model.
    #[serde(default = "default_output_cap")]
    pub output_cap_chars: usize,
    /// Safety cap on model rounds within one turn.
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
    /// sub-m — model (`provider/model`) used by `rlm.spawn` when neither
    /// `model` nor a profile model is given. `None` = the parent's model.
    #[serde(default)]
    pub subagent_default_model: Option<String>,
    /// bascule — provider failover (off by default, backups chosen by the user).
    #[serde(default)]
    pub bascule: BasculeSettings,
    /// uh-d2 — asynchronous kernel (one asyncio loop for the kernel's
    /// life, background commands that wake the session); off by default,
    /// see docs/noyau-asynchrone.md. `AXECODE_KERNEL_ASYNC=1` also turns it on.
    #[serde(default)]
    pub kernel_async: bool,
}

/// bascule — provider failover. When the provider of the session stays
/// down after its retries (or hits its plan limit), the turn goes on with the
/// same model on a backup provider the user designated for THAT provider.
/// Off by default; nothing is ever sent to a provider (or key) that is not in
/// the list of the failing provider (a company key never backs a personal
/// account, nor the reverse, unless the user wrote that pair).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BasculeSettings {
    #[serde(default)]
    pub enabled: bool,
    /// Provider id -> backup provider ids, tried in this order.
    #[serde(default)]
    pub secours: BTreeMap<String, Vec<String>>,
}

impl BasculeSettings {
    /// Backups designated for `provider`, in order, without itself or
    /// duplicates; empty when failover is off.
    pub fn secours_pour(&self, provider: &str) -> Vec<String> {
        if !self.enabled {
            return Vec::new();
        }
        let mut out: Vec<String> = Vec::new();
        for id in self.secours.get(provider).into_iter().flatten() {
            let id = id.trim();
            if !id.is_empty() && id != provider && !out.iter().any(|known| known == id) {
                out.push(id.to_string());
            }
        }
        out
    }

    fn normalized(mut self) -> Self {
        let secours = std::mem::take(&mut self.secours);
        for (provider, list) in secours {
            let provider = provider.trim().to_string();
            if provider.is_empty() {
                continue;
            }
            let probe = Self { enabled: true, secours: BTreeMap::from([(provider.clone(), list)]) };
            let list = probe.secours_pour(&provider);
            if !list.is_empty() {
                self.secours.insert(provider, list);
            }
        }
        self
    }
}

fn default_true() -> bool {
    true
}
fn default_threshold() -> u8 {
    95
}
fn default_output_cap() -> usize {
    20_000
}
fn default_max_rounds() -> usize {
    200
}

impl Default for ReplSettings {
    fn default() -> Self {
        Self {
            agent_enabled: true,
            modules: BTreeMap::new(),
            compaction_threshold: default_threshold(),
            max_output_tokens: BTreeMap::new(),
            output_cap_chars: default_output_cap(),
            max_rounds: default_max_rounds(),
            subagent_default_model: None,
            bascule: BasculeSettings::default(),
            kernel_async: false,
        }
    }
}

impl ReplSettings {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(REPL_SETTINGS_FILE)
    }

    pub fn load(data_dir: &Path) -> Self {
        std::fs::read(Self::path(data_dir))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .unwrap_or_default()
            .normalized()
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let path = Self::path(data_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.clone().normalized())?)?;
        std::fs::rename(tmp, path)
    }

    pub fn normalized(mut self) -> Self {
        let t = self.compaction_threshold.clamp(50, 100);
        self.compaction_threshold = t - t % 5;
        self.output_cap_chars = self.output_cap_chars.clamp(1_000, 1_000_000);
        self.max_rounds = self.max_rounds.clamp(1, 10_000);
        self.bascule = self.bascule.normalized();
        self
    }

    pub fn module_enabled(&self, name: &str) -> bool {
        self.modules.get(name).map(|m| m.enabled).unwrap_or(true)
    }

    /// Module configuration in the shape expected by the kernel `init`.
    pub fn kernel_modules(&self) -> Value {
        serde_json::to_value(&self.modules).unwrap_or(Value::Null)
    }

    pub fn max_output_tokens_for(&self, provider: &str, model: &str) -> Option<u32> {
        self.max_output_tokens
            .get(&format!("{provider}/{model}"))
            .copied()
            .filter(|v| *v > 0)
    }
}

#[cfg(test)]
mod bascule_tests {
    use super::*;

    #[test]
    fn failover_is_off_by_default_and_only_uses_designated_backups() {
        let settings: ReplSettings = serde_json::from_str("{}").unwrap();
        assert!(!settings.bascule.enabled);
        assert!(settings.bascule.secours_pour("anthropic").is_empty());

        let mut bascule = BasculeSettings {
            enabled: false,
            secours: BTreeMap::from([
                ("anthropic".to_string(), vec!["anthropic~2".into(), " anthropic~2 ".into(), "anthropic".into(), "".into(), "axe-cloud".into()]),
            ]),
        };
        assert!(bascule.secours_pour("anthropic").is_empty(), "off: no backup at all");
        bascule.enabled = true;
        assert_eq!(bascule.secours_pour("anthropic"), ["anthropic~2", "axe-cloud"]);
        // The designation goes one way only.
        assert!(bascule.secours_pour("anthropic~2").is_empty());
        assert!(bascule.secours_pour("axe-cloud").is_empty());

        let saved = ReplSettings { bascule, ..ReplSettings::default() }.normalized();
        assert_eq!(saved.bascule.secours["anthropic"], ["anthropic~2", "axe-cloud"]);
        let json = serde_json::to_value(&saved).unwrap();
        assert_eq!(json["bascule"]["enabled"], true);
        assert_eq!(json["bascule"]["secours"]["anthropic"][0], "anthropic~2");
    }
}
