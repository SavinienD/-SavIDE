// catalogue des fournisseurs intégrés (Anthropic, OpenAI) complété par leur API.
//
// Avant : la liste des modèles du choix du chat était en dur (src/lib/models.ts, MODELS) ; un
// nouveau modèle n'apparaissait qu'avec une nouvelle version de l'appli. Maintenant :
// `GET /v1/models` avec le compte connecté (ou la clé), relu au démarrage puis une fois par jour,
// gardé dans `catalogue-modeles.json` ; l'interface ajoute les modèles inconnus à MODELS, sans
// doublon (src/lib/catalogueModeles.ts). Une erreur garde la liste précédente du fournisseur.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const FICHIER: &str = "catalogue-modeles.json";
const JOUR_MS: i64 = 86_400_000;
/// Après une erreur (hors ligne, jeton expiré), nouvel essai au plus tôt une heure après.
const HEURE_MS: i64 = 3_600_000;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModeleListe {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalogue {
    #[serde(default)]
    pub fetched_at_ms: Option<i64>,
    #[serde(default)]
    pub fournisseurs: BTreeMap<String, Vec<ModeleListe>>,
    #[serde(default)]
    pub erreurs: BTreeMap<String, String>,
}

/// Faut-il relire l'API ? Jamais lu, plus d'un jour, horloge revenue en arrière, un fournisseur
/// connecté absent du catalogue, ou une erreur de plus d'une heure.
pub(crate) fn a_relire(catalogue: &Catalogue, connectes: &[&str], maintenant: i64, forcer: bool) -> bool {
    let Some(lu) = catalogue.fetched_at_ms else { return true };
    let age = maintenant - lu;
    forcer
        || age >= JOUR_MS
        || age < 0
        || connectes.iter().any(|f| !catalogue.fournisseurs.contains_key(*f) && !catalogue.erreurs.contains_key(*f))
        || (!catalogue.erreurs.is_empty() && age >= HEURE_MS)
}

/// Nouvelle lecture : la liste rendue remplace l'ancienne ; une erreur garde l'ancienne ;
/// un fournisseur déconnecté sort du catalogue.
pub(crate) fn fusionner(
    ancien: &Catalogue,
    resultats: Vec<(&str, Result<Vec<ModeleListe>, String>)>,
    maintenant: i64,
) -> Catalogue {
    let mut nouveau = Catalogue { fetched_at_ms: Some(maintenant), ..Catalogue::default() };
    for (fournisseur, resultat) in resultats {
        match resultat {
            Ok(liste) => {
                nouveau.fournisseurs.insert(fournisseur.to_string(), liste);
            }
            Err(erreur) => {
                if let Some(liste) = ancien.fournisseurs.get(fournisseur) {
                    nouveau.fournisseurs.insert(fournisseur.to_string(), liste.clone());
                }
                nouveau.erreurs.insert(fournisseur.to_string(), erreur);
            }
        }
    }
    nouveau
}

fn chemin() -> Result<PathBuf, String> {
    directories::ProjectDirs::from("fr", "savide", "savide")
        .map(|dirs| dirs.data_local_dir().join(FICHIER))
        .ok_or_else(|| "dossier de données local introuvable".to_string())
}

fn lire() -> Catalogue {
    chemin()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn ecrire(catalogue: &Catalogue) {
    let Ok(p) = chemin() else { return };
    if let Some(dossier) = p.parent() {
        let _ = std::fs::create_dir_all(dossier);
    }
    if let Ok(octets) = serde_json::to_vec_pretty(catalogue) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, octets).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

fn maintenant_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Compte Claude utilisé pour lire le catalogue (le premier connecté).
fn credential_anthropic() -> Option<axecode_anthropic::Credential> {
    premier_compte("anthropic", |p| axecode_anthropic::Credential::from_axecode_auth_file(p).ok().flatten())
}

fn credential_openai() -> Option<axecode_openai::Credential> {
    premier_compte("openai", |p| axecode_openai::Credential::from_axecode_auth_file(p).ok().flatten())
}

/// Compte principal, sinon le premier compte ajouté (plusieurs abonnements).
fn premier_compte<T>(base: &str, lire: impl Fn(&std::path::Path) -> Option<T>) -> Option<T> {
    let dossier = crate::comptes::dossier()?;
    std::iter::once(String::new())
        .chain(crate::comptes::rangs_dans(&dossier, base))
        .find_map(|rang| lire(&crate::comptes::fichier_dans(&dossier, base, &rang)))
}

static EN_COURS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Catalogue des fournisseurs intégrés connectés ; relu sur l'API au plus une fois par jour
/// (ou `forcer`). Jamais d'erreur : au pire, le catalogue gardé (éventuellement vide).
#[tauri::command]
pub(crate) async fn catalogue_modeles(forcer: Option<bool>) -> Result<Catalogue, String> {
    let _verrou = EN_COURS.lock().await;
    let ancien = lire();
    let anthropic = credential_anthropic();
    let openai = credential_openai();
    let mut connectes = Vec::new();
    if anthropic.is_some() {
        connectes.push("anthropic");
    }
    if openai.is_some() {
        connectes.push("openai");
    }
    let maintenant = maintenant_ms();
    if !a_relire(&ancien, &connectes, maintenant, forcer.unwrap_or(false)) {
        return Ok(ancien);
    }
    let mut resultats = Vec::new();
    if let Some(credential) = anthropic {
        let r = axecode_anthropic::list_models(&credential)
            .await
            .map(|l| l.into_iter().map(|m| ModeleListe { id: m.id, label: m.label }).collect())
            .map_err(|e| e.to_string());
        resultats.push(("anthropic", r));
    }
    if let Some(credential) = openai {
        let r = axecode_openai::models_list::list_models(&credential)
            .await
            .map(|l| l.into_iter().map(|m| ModeleListe { id: m.id, label: m.label }).collect())
            .map_err(|e| e.to_string());
        resultats.push(("openai", r));
    }
    for (f, r) in &resultats {
        if let Err(e) = r {
            tracing::warn!(fournisseur = %f, erreur = %e, "catalogue des modèles illisible");
        }
    }
    let nouveau = fusionner(&ancien, resultats, maintenant);
    ecrire(&nouveau);
    Ok(nouveau)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str) -> ModeleListe {
        ModeleListe { id: id.into(), label: None }
    }

    #[test]
    fn relu_au_demarrage_puis_une_fois_par_jour() {
        let vide = Catalogue::default();
        assert!(a_relire(&vide, &[], 1_000, false), "jamais lu");
        let mut lu = Catalogue { fetched_at_ms: Some(1_000), ..Catalogue::default() };
        lu.fournisseurs.insert("anthropic".into(), vec![m("claude-opus-6")]);
        assert!(!a_relire(&lu, &["anthropic"], 1_000 + JOUR_MS - 1, false), "moins d'un jour");
        assert!(a_relire(&lu, &["anthropic"], 1_000 + JOUR_MS, false), "un jour");
        assert!(a_relire(&lu, &["anthropic"], 1_000, true), "forcé");
        assert!(a_relire(&lu, &["anthropic", "openai"], 2_000, false), "OpenAI connecté depuis");
        assert!(a_relire(&lu, &["anthropic"], 500, false), "horloge en arrière");
    }

    #[test]
    fn erreur_garde_l_ancienne_liste_et_reessaie_apres_une_heure() {
        let mut ancien = Catalogue { fetched_at_ms: Some(0), ..Catalogue::default() };
        ancien.fournisseurs.insert("anthropic".into(), vec![m("claude-opus-6")]);
        ancien.fournisseurs.insert("openai".into(), vec![m("gpt-6-sol")]);
        let nouveau = fusionner(
            &ancien,
            vec![("anthropic", Err("hors ligne".into())), ("openai", Ok(vec![m("gpt-6-nova")]))],
            10,
        );
        assert_eq!(nouveau.fournisseurs["anthropic"], vec![m("claude-opus-6")]);
        assert_eq!(nouveau.fournisseurs["openai"], vec![m("gpt-6-nova")]);
        assert_eq!(nouveau.erreurs["anthropic"], "hors ligne");
        assert!(!a_relire(&nouveau, &["anthropic", "openai"], 10 + HEURE_MS - 1, false));
        assert!(a_relire(&nouveau, &["anthropic", "openai"], 10 + HEURE_MS, false));
        // Fournisseur déconnecté : il sort du catalogue.
        let sans = fusionner(&nouveau, vec![("openai", Ok(vec![m("gpt-6-nova")]))], 20);
        assert!(!sans.fournisseurs.contains_key("anthropic"));
    }
}
