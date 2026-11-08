// rlm186 — commande `ia_appel_unique` : un appel unique au modèle depuis
// l'interface (sans session, sans outils, sans harnais), avec les comptes et
// les clés configurés dans l'appli (même résolution des fournisseurs que les
// conversations : registre de l'appli + fournisseurs déclarés).

use crate::*;

use axecode_app::appel_unique::{self, Demande, Reponse};
use axecode_app::repl::{DeclaredProviderResolver, ProviderResolver};

struct RegistreAppli(DesktopState);

impl ProviderResolver for RegistreAppli {
    fn provider(&self, provider_id: &str) -> std::result::Result<Arc<dyn Provider>, String> {
        provider_from_registry(&self.0, provider_id)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IaAppelUniqueInput {
    #[serde(flatten)]
    demande: Demande,
    /// Modèle de la conversation ouverte (`fournisseur/modèle`) : repli quand
    /// ni `modele` ni le modèle des sous-agents des Réglages ne sont donnés.
    #[serde(default)]
    modele_conversation: Option<String>,
}

/// `{ texte, systeme?, modele?, plafond?, modeleConversation? }` →
/// `{ texte, modele, usage, tronque }`.
#[tauri::command]
pub(crate) async fn ia_appel_unique(
    state: State<'_, DesktopState>,
    input: IaAppelUniqueInput,
) -> std::result::Result<Reponse, String> {
    let data_dir = axecode_daemon::util::default_data_dir().map_err(|e| e.to_string())?;
    let conversation = input
        .modele_conversation
        .as_deref()
        .and_then(axecode_app::rlm::parse_model)
        .unwrap_or_else(|| state.default_model.clone());
    let fournisseurs =
        DeclaredProviderResolver::load(Arc::new(RegistreAppli(state.inner().clone())), &data_dir);
    appel_unique::appel_unique(&fournisseurs, &data_dir, Some(&conversation), input.demande).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entree_de_l_interface() {
        let input: IaAppelUniqueInput = serde_json::from_value(json!({
            "texte": "Résume", "systeme": "Court.", "plafond": 300,
            "modeleConversation": "openai/gpt-test"
        }))
        .unwrap();
        assert_eq!(input.demande.texte, "Résume");
        assert_eq!(input.demande.systeme.as_deref(), Some("Court."));
        assert_eq!(input.demande.plafond, Some(300));
        assert_eq!(input.demande.modele, None);
        assert_eq!(input.modele_conversation.as_deref(), Some("openai/gpt-test"));
    }
}
