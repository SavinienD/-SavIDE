//! Dernier appel au modèle de chaque session, pour la jauge du contexte et le minuteur du cache
//! de l'en-tête du chat : jetons envoyés, fenêtre du modèle, seuil de la compaction automatique,
//! et cache de prompt (début de l'appel qui l'a lu ou écrit, durée de vie annoncée par le
//! fournisseur). Tenu en mémoire par le service, rempli par la boucle du tour (`turn.rs`), lu par
//! `sessions.context`.

use std::{collections::HashMap, sync::Mutex};

use axecode_core::{ModelCapabilities, ModelRef, ProviderRequest, Usage};
use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DernierAppel {
    /// Jetons de la requête (entrée + cache lu + cache écrit) : ce que le contexte contient.
    pub jetons_contexte: u32,
    /// Jetons de la réponse.
    pub jetons_sortie: u32,
    pub cache_lu: u32,
    pub cache_ecrit: u32,
    /// Fenêtre de contexte du modèle (0 : inconnue).
    pub fenetre: u32,
    /// Jetons à partir desquels la compaction automatique part (`None` : désactivée).
    pub seuil_compaction: Option<u32>,
    /// Début de l'appel (ms Unix) : la durée de vie du cache court à partir de là.
    pub debut_ms: i64,
    pub fin_ms: i64,
    /// Durée de vie du cache de prompt (s), seulement si l'appel a lu ou écrit le cache.
    pub cache_ttl_s: Option<u32>,
    /// Fin de vie du cache (ms Unix), même condition.
    pub cache_expire_ms: Option<i64>,
    pub modele: String,
}

static REGISTRE: Mutex<Option<HashMap<String, DernierAppel>>> = Mutex::new(None);

fn jetons_requete(usage: &Usage) -> u32 {
    usage
        .input_tokens
        .saturating_add(usage.cache_read_tokens)
        .saturating_add(usage.cache_creation_tokens)
}

impl DernierAppel {
    /// Appel relu dans le journal (service relancé depuis) : jetons seulement, sans cache ni
    /// fenêtre, daté de la fin de l'appel.
    pub fn depuis_journal(usage: &Usage, fin_ms: i64) -> Self {
        Self {
            jetons_contexte: jetons_requete(usage),
            jetons_sortie: usage.output_tokens,
            cache_lu: usage.cache_read_tokens,
            cache_ecrit: usage.cache_creation_tokens,
            debut_ms: fin_ms,
            fin_ms,
            ..Self::default()
        }
    }
}

/// Seuil (jetons) de la compaction automatique, calculé comme la boucle du tour : `pct` de la
/// fenêtre, jamais plus près de la fenêtre que la place gardée pour la réponse ; `None` à 100 %.
pub(crate) fn seuil_compaction(
    caps: &ModelCapabilities,
    model: &ModelRef,
    pct: u8,
    max_output_tokens: Option<u32>,
) -> Option<u32> {
    if pct >= 100 || caps.context_window == 0 {
        return None;
    }
    let mut probe = ProviderRequest::new(model.clone(), Vec::new());
    probe.max_output_tokens = max_output_tokens;
    let limite = super::budget::threshold(caps, pct, probe.output_token_budget(caps));
    (limite > 0).then(|| limite.min(u32::MAX as u64) as u32)
}

/// Note l'appel qui vient de finir (boucle du tour) et le rend.
#[allow(clippy::too_many_arguments)]
pub(crate) fn noter_appel(
    session_id: &str,
    model: &ModelRef,
    usage: &Usage,
    caps: Option<&ModelCapabilities>,
    pct: u8,
    max_output_tokens: Option<u32>,
    cache_ttl_s: Option<u32>,
    debut_ms: i64,
    fin_ms: i64,
) -> DernierAppel {
    let cache_actif = usage.cache_read_tokens > 0 || usage.cache_creation_tokens > 0;
    let cache_ttl_s = cache_ttl_s.filter(|_| cache_actif);
    let appel = DernierAppel {
        jetons_contexte: jetons_requete(usage),
        jetons_sortie: usage.output_tokens,
        cache_lu: usage.cache_read_tokens,
        cache_ecrit: usage.cache_creation_tokens,
        fenetre: caps.map(|c| c.context_window).unwrap_or(0),
        seuil_compaction: caps.and_then(|c| seuil_compaction(c, model, pct, max_output_tokens)),
        debut_ms,
        fin_ms,
        cache_expire_ms: cache_ttl_s.map(|s| debut_ms + i64::from(s) * 1000),
        cache_ttl_s,
        modele: model.name.clone(),
    };
    if let Ok(mut registre) = REGISTRE.lock() {
        registre.get_or_insert_with(HashMap::new).insert(session_id.to_string(), appel.clone());
    }
    appel
}

/// Dernier appel noté pour la session depuis le démarrage du service.
pub fn lire(session_id: &str) -> Option<DernierAppel> {
    REGISTRE.lock().ok()?.as_ref()?.get(session_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axecode_core::EffortMode;

    fn caps(window: u32) -> ModelCapabilities {
        ModelCapabilities {
            model: ModelRef::new("anthropic", "claude-test"),
            context_window: window,
            preferred_window: window,
            max_output_tokens: 32_000,
            supports_thinking: true,
            visible_thinking: true,
            supports_tools: true,
            supports_images: true,
            effort_mode: EffortMode::None,
        }
    }

    #[test]
    fn appel_note_puis_relu() {
        let model = ModelRef::new("anthropic", "claude-test");
        let usage = Usage { input_tokens: 1_200, cache_read_tokens: 80_000, cache_creation_tokens: 2_800, output_tokens: 900, ..Default::default() };
        let appel = noter_appel("s-1", &model, &usage, Some(&caps(200_000)), 80, Some(32_000), Some(300), 1_000, 9_000);
        assert_eq!(appel.jetons_contexte, 84_000);
        assert_eq!(appel.fenetre, 200_000);
        // 80 % de 200 000 = 160 000, sous la fenêtre moins la réponse (168 000).
        assert_eq!(appel.seuil_compaction, Some(160_000));
        // Le cache court depuis le début de l'appel.
        assert_eq!(appel.cache_expire_ms, Some(1_000 + 300_000));
        assert_eq!(lire("s-1"), Some(appel));
        assert_eq!(lire("s-2"), None);
    }

    #[test]
    fn sans_cache_ni_compaction() {
        let model = ModelRef::new("ollama", "qwen");
        let usage = Usage { input_tokens: 5_000, output_tokens: 10, ..Default::default() };
        let appel = noter_appel("s-3", &model, &usage, Some(&caps(32_768)), 100, None, Some(300), 0, 1);
        assert_eq!((appel.cache_ttl_s, appel.cache_expire_ms, appel.seuil_compaction), (None, None, None));
        let relu = DernierAppel::depuis_journal(&usage, 42);
        assert_eq!((relu.jetons_contexte, relu.fenetre, relu.debut_ms), (5_000, 0, 42));
    }
}
