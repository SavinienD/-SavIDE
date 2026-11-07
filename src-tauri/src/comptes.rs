// plusieurs abonnements au même fournisseur (Claude, ChatGPT).
//
// Le compte principal garde son fichier (`anthropic-auth.json`) et son identifiant de fournisseur
// (`anthropic`) : l'ancienne connexion unique sert telle quelle, sans reconnexion. Chaque compte
// ajouté a son fichier (`anthropic-auth-2.json`) et son identifiant (`anthropic~2`) ; ses jetons
// se renouvellent dans son propre fichier (le jeton OAuth garde son chemin d'origine). Déconnecter
// un compte supprime son seul fichier. Le choix du modèle range chaque compte dans son groupe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axecode_core::Provider;
use serde::Serialize;

pub(crate) const SEPARATEUR: char = '~';
/// Fournisseurs à abonnement (OAuth) qui acceptent plusieurs comptes.
pub(crate) const MULTI_COMPTES: [&str; 2] = ["anthropic", "openai"];

pub(crate) fn base(provider_id: &str) -> &str {
    provider_id.split(SEPARATEUR).next().unwrap_or(provider_id)
}

/// Rang du compte (`""` = compte principal).
pub(crate) fn rang(provider_id: &str) -> &str {
    provider_id.split_once(SEPARATEUR).map(|(_, r)| r).unwrap_or("")
}

pub(crate) fn identifiant(base: &str, rang: &str) -> String {
    if rang.is_empty() { base.to_string() } else { format!("{base}{SEPARATEUR}{rang}") }
}

pub(crate) fn dossier() -> Option<PathBuf> {
    directories::ProjectDirs::from("fr", "savide", "savide").map(|d| d.data_local_dir().to_path_buf())
}

pub(crate) fn fichier_dans(dossier: &Path, base: &str, rang: &str) -> PathBuf {
    if rang.is_empty() {
        dossier.join(format!("{base}-auth.json"))
    } else {
        dossier.join(format!("{base}-auth-{rang}.json"))
    }
}

pub(crate) fn fichier(provider_id: &str) -> Option<PathBuf> {
    let b = base(provider_id);
    if !MULTI_COMPTES.contains(&b) {
        return None;
    }
    let r = rang(provider_id);
    if !r.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    dossier().map(|d| fichier_dans(&d, b, r))
}

/// Rangs des comptes ajoutés (`anthropic-auth-2.json` → "2"), dans l'ordre.
pub(crate) fn rangs_dans(dossier: &Path, base: &str) -> Vec<String> {
    let prefixe = format!("{base}-auth-");
    let mut rangs: Vec<String> = std::fs::read_dir(dossier)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|nom| nom.strip_prefix(&prefixe)?.strip_suffix(".json").map(str::to_string))
        .filter(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()))
        .collect();
    rangs.sort_by_key(|r| r.parse::<u64>().unwrap_or(u64::MAX));
    rangs
}

/// Premier rang libre à partir de 2.
pub(crate) fn rang_libre_dans(dossier: &Path, base: &str) -> String {
    let pris = rangs_dans(dossier, base);
    (2u64..).map(|n| n.to_string()).find(|n| !pris.contains(n)).unwrap_or_else(|| "2".into())
}

/// Le fournisseur d'un compte, construit depuis son fichier.
pub(crate) fn construire(provider_id: &str) -> Option<Arc<dyn Provider>> {
    let chemin = fichier(provider_id)?;
    match base(provider_id) {
        "anthropic" => {
            let credential = axecode_anthropic::Credential::from_axecode_auth_file(&chemin).ok()??;
            let mut config = axecode_anthropic::AnthropicConfig::new(credential);
            config.provider_id = provider_id.to_string();
            axecode_anthropic::AnthropicProvider::new(config).ok().map(|p| Arc::new(p) as Arc<dyn Provider>)
        }
        "openai" => {
            let credential = axecode_openai::Credential::from_axecode_auth_file(&chemin).ok()??;
            axecode_openai::OpenAiProvider::new(axecode_openai::OpenAiConfig::new(credential))
                .ok()
                .map(|p| Arc::new(p) as Arc<dyn Provider>)
        }
        _ => None,
    }
}

/// Ajoute au registre les comptes ajoutés (le compte principal est installé comme avant).
pub(crate) fn installer_comptes_ajoutes(registre: &mut HashMap<String, Arc<dyn Provider>>) {
    let Some(d) = dossier() else { return };
    registre.retain(|id, _| !(id.contains(SEPARATEUR) && MULTI_COMPTES.contains(&base(id))));
    for b in MULTI_COMPTES {
        for r in rangs_dans(&d, b) {
            let id = identifiant(b, &r);
            if let Some(p) = construire(&id) {
                registre.insert(id, p);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompteConnecte {
    pub provider_id: String,
    pub base: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub connected: bool,
}

fn etat(provider_id: &str, chemin: &Path) -> Option<CompteConnecte> {
    let (email, plan, connected) = match base(provider_id) {
        "anthropic" => {
            let s = axecode_anthropic::load_auth_status(chemin).ok()?;
            (s.email, s.plan, s.connected)
        }
        "openai" => {
            let s = axecode_openai::load_auth_status(chemin).ok()?;
            (s.email, s.plan_type, s.connected)
        }
        _ => return None,
    };
    connected.then(|| CompteConnecte {
        provider_id: provider_id.to_string(),
        base: base(provider_id).to_string(),
        email,
        plan,
        connected,
    })
}

/// Comptes connectés des fournisseurs à abonnement : principal d'abord, puis les ajoutés.
pub(crate) fn comptes_dans(dossier: &Path) -> Vec<CompteConnecte> {
    let mut comptes = Vec::new();
    for b in MULTI_COMPTES {
        let rangs = std::iter::once(String::new()).chain(rangs_dans(dossier, b));
        for r in rangs {
            if let Some(c) = etat(&identifiant(b, &r), &fichier_dans(dossier, b, &r)) {
                comptes.push(c);
            }
        }
    }
    comptes
}

/// Après la connexion d'un compte ajouté (`rang`) : s'il s'agit d'un compte déjà connecté (même
/// e-mail), son fichier remplace celui du compte existant (même identifiant, pas de doublon).
/// Rend l'identifiant de fournisseur du compte.
pub(crate) fn ranger_nouveau_compte(dossier: &Path, base: &str, rang: &str) -> String {
    let nouveau = fichier_dans(dossier, base, rang);
    let Some(email) = etat(&identifiant(base, rang), &nouveau).and_then(|c| c.email) else {
        return identifiant(base, rang);
    };
    let existant = comptes_dans(dossier)
        .into_iter()
        .find(|c| c.base == base && c.provider_id != identifiant(base, rang) && c.email.as_deref() == Some(email.as_str()));
    match existant {
        Some(c) => {
            let cible = fichier_dans(dossier, base, self::rang(&c.provider_id));
            if std::fs::rename(&nouveau, &cible).is_ok() {
                c.provider_id
            } else {
                identifiant(base, rang)
            }
        }
        None => identifiant(base, rang),
    }
}

#[tauri::command]
pub(crate) fn list_provider_accounts() -> Vec<CompteConnecte> {
    dossier().map(|d| comptes_dans(&d)).unwrap_or_default()
}

/// Déconnecte UN compte (principal ou ajouté) : son fichier seul est supprimé.
#[tauri::command]
pub(crate) async fn disconnect_provider_account(
    state: tauri::State<'_, crate::DesktopState>,
    provider_id: String,
) -> Result<Vec<CompteConnecte>, String> {
    let chemin = fichier(&provider_id).ok_or_else(|| format!("compte inconnu : {provider_id}"))?;
    match std::fs::remove_file(&chemin) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("déconnexion impossible : {e}")),
    }
    crate::providers::cancel_active_turns_for_provider(&state, &provider_id).await;
    if let Ok(mut r) = state.providers.lock() {
        r.remove(&provider_id);
    }
    Ok(list_provider_accounts())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dossier_test(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("axecode-comptes-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn claude(d: &Path, rang: &str, email: &str) {
        let json = serde_json::json!({
            "provider": "anthropic", "authMode": "oauth",
            "tokens": {"accessToken": format!("a-{rang}"), "refreshToken": "r", "expiresAtMs": 4_000_000_000_000i64},
            "account": {"email": email, "plan": "Max"}
        });
        std::fs::write(fichier_dans(d, "anthropic", rang), serde_json::to_vec(&json).unwrap()).unwrap();
    }

    #[test]
    fn identifiants_et_fichiers() {
        assert_eq!(base("anthropic~2"), "anthropic");
        assert_eq!(rang("anthropic~2"), "2");
        assert_eq!(rang("anthropic"), "");
        assert_eq!(identifiant("openai", "3"), "openai~3");
        let d = Path::new("/x");
        assert_eq!(fichier_dans(d, "anthropic", ""), d.join("anthropic-auth.json"));
        assert_eq!(fichier_dans(d, "anthropic", "2"), d.join("anthropic-auth-2.json"));
        assert!(fichier("ollama~2").is_none());
        assert!(fichier("anthropic~../x").is_none());
    }

    #[test]
    fn ancienne_connexion_gardee_et_comptes_ajoutes_listes() {
        let d = dossier_test("liste");
        claude(&d, "", "a@axe.fr");
        assert_eq!(rang_libre_dans(&d, "anthropic"), "2");
        claude(&d, "2", "b@gmail.com");
        claude(&d, "10", "c@gmail.com");
        std::fs::write(d.join("anthropic-auth-2.json.tmp"), b"{}").unwrap();
        assert_eq!(rangs_dans(&d, "anthropic"), vec!["2", "10"]);
        assert_eq!(rang_libre_dans(&d, "anthropic"), "3");
        let comptes = comptes_dans(&d);
        assert_eq!(
            comptes.iter().map(|c| (c.provider_id.as_str(), c.email.as_deref().unwrap_or(""))).collect::<Vec<_>>(),
            vec![("anthropic", "a@axe.fr"), ("anthropic~2", "b@gmail.com"), ("anthropic~10", "c@gmail.com")]
        );
    }

    #[test]
    fn meme_compte_reconnecte_remplace_l_existant() {
        let d = dossier_test("doublon");
        claude(&d, "", "a@axe.fr");
        claude(&d, "2", "b@gmail.com");
        claude(&d, "3", "b@gmail.com");
        assert_eq!(ranger_nouveau_compte(&d, "anthropic", "3"), "anthropic~2");
        assert_eq!(rangs_dans(&d, "anthropic"), vec!["2"]);
        let jeton = std::fs::read_to_string(fichier_dans(&d, "anthropic", "2")).unwrap();
        assert!(jeton.contains("a-3"), "jetons du nouveau login");
        claude(&d, "3", "c@gmail.com");
        assert_eq!(ranger_nouveau_compte(&d, "anthropic", "3"), "anthropic~3");
    }

    #[test]
    fn chaque_compte_lit_son_fichier() {
        let d = dossier_test("credential");
        claude(&d, "", "a@axe.fr");
        claude(&d, "2", "b@gmail.com");
        let a = axecode_anthropic::Credential::from_axecode_auth_file(&fichier_dans(&d, "anthropic", "")).unwrap().unwrap();
        let b = axecode_anthropic::Credential::from_axecode_auth_file(&fichier_dans(&d, "anthropic", "2")).unwrap().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let http = reqwest::Client::new();
        assert_eq!(rt.block_on(a.bearer_or_key(&http)).unwrap(), "a-");
        assert_eq!(rt.block_on(b.bearer_or_key(&http)).unwrap(), "a-2");
    }
}
