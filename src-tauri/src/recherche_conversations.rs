// Lot palette — Ctrl+K : conversations de tous les dossiers et recherche dans leur contenu.
// Le moteur (pur, mesuré sur un historique réel) est dans recherche_conversations/moteur.rs ;
// ici, seulement les deux commandes Tauri et la mémoire partagée entre les recherches.

use crate::*;
use std::sync::OnceLock;

mod moteur;

static CACHE: OnceLock<StdMutex<moteur::Cache>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListeConversations {
    /// Dossier des conversations sans dossier (pour les ouvrir comme telles).
    racine_libre: String,
    conversations: Vec<moteur::ConversationListee>,
}

/// Conversations de tous les dossiers (archivées exclues), la plus récente d'abord.
#[tauri::command]
pub(crate) async fn palette_conversations(
    state: State<'_, DesktopState>,
) -> std::result::Result<ListeConversations, String> {
    let base = state.store.path().to_path_buf();
    let racine_libre = crate::freechat::scratch_root()
        .map(|r| r.display().to_string())
        .unwrap_or_default();
    let conversations = tauri::async_runtime::spawn_blocking(move || moteur::lister(&base))
        .await
        .map_err(error_to_string)??;
    Ok(ListeConversations { racine_libre, conversations })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RechercheInput {
    requete: String,
    #[serde(default)]
    limite: Option<usize>,
}

/// Recherche dans le texte des messages ; une requête vide prépare seulement la mémoire.
#[tauri::command]
pub(crate) async fn palette_recherche_conversations(
    state: State<'_, DesktopState>,
    input: RechercheInput,
) -> std::result::Result<moteur::Recherche, String> {
    let base = state.store.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = CACHE
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "recherche indisponible (verrou)".to_string())?;
        cache.chercher(&base, &input.requete, input.limite.unwrap_or(30).clamp(1, 100))
    })
    .await
    .map_err(error_to_string)?
}
