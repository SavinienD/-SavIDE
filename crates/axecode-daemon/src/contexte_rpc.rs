//! Jauge du contexte et minuteur du cache de l'en-tête du chat :
//! `sessions.context {sessionId}` -> `{appel}`.
//!
//! `appel` : le dernier appel au modèle noté par la boucle du tour
//! (`axecode_app::repl::dernier_appel`) ; si le service a été relancé depuis, le dernier message
//! de l'assistant du journal (jetons seulement) ; `null` après une compaction (taille inconnue
//! jusqu'au prochain appel) ou sans appel. Un service plus ancien répond « unknown method » :
//! l'en-tête n'affiche alors rien. Méthode `sessions.*` : la visibilité de la session est
//! contrôlée comme pour les autres (server.rs).

use axecode_app::repl::dernier_appel::{self, DernierAppel};
use axecode_core::{JournalEntry, JournalEntryKind, Role, SessionResult};
use serde_json::{json, Value};

use crate::daemon::{lock, Daemon};

/// Dernier appel d'après le chemin du journal : le message de l'assistant le plus récent qui
/// porte son usage, sauf si une compaction l'a suivi.
pub fn depuis_journal<'a>(chemin: impl DoubleEndedIterator<Item = &'a JournalEntry>) -> Option<DernierAppel> {
    for entry in chemin.rev() {
        match &entry.kind {
            JournalEntryKind::Compaction { .. } => return None,
            JournalEntryKind::Message { message, usage: Some(usage), .. } if message.role == Role::Assistant => {
                return Some(DernierAppel::depuis_journal(usage, entry.ts));
            }
            _ => {}
        }
    }
    None
}

pub fn session(daemon: &Daemon, id: &str) -> SessionResult<Value> {
    if let Some(appel) = dernier_appel::lire(id) {
        return Ok(json!({ "appel": appel }));
    }
    let journal = daemon.journal(id)?;
    let journal = lock(&journal);
    Ok(json!({ "appel": depuis_journal(journal.path_to_leaf().into_iter()) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axecode_core::{ChatMessage, Usage};

    fn entree(ts: i64, kind: JournalEntryKind) -> JournalEntry {
        JournalEntry { id: format!("e{ts}"), parent: None, ts, kind }
    }

    fn message(texte: ChatMessage, usage: Option<Usage>) -> JournalEntryKind {
        JournalEntryKind::Message { message: texte, usage, turn_id: None }
    }

    #[test]
    fn dernier_message_de_l_assistant_avec_son_usage() {
        let usage = Usage { input_tokens: 10, cache_read_tokens: 1_000, output_tokens: 5, ..Default::default() };
        let chemin = vec![
            entree(1, message(ChatMessage::user_text("bonjour"), None)),
            entree(2, message(ChatMessage::assistant_text("salut"), Some(usage))),
            entree(3, message(ChatMessage::user_text("suite"), None)),
        ];
        let appel = depuis_journal(chemin.iter()).unwrap();
        assert_eq!((appel.jetons_contexte, appel.debut_ms, appel.cache_ttl_s), (1_010, 2, None));
        // Compaction après le dernier appel : taille inconnue jusqu'au prochain.
        let mut compacte = chemin.clone();
        compacte.push(entree(4, JournalEntryKind::Compaction {
            summary: "résumé".into(),
            from_entry: "e1".into(),
            to_entry: "e3".into(),
            directive: None,
        }));
        assert_eq!(depuis_journal(compacte.iter()), None);
        assert_eq!(depuis_journal(chemin[..1].iter()), None);
    }
}
