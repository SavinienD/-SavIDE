//! Dossiers locaux renommés ou déplacés : commandes de recherche et de mise à jour
//! du chemin (conversations, sessions du service, données internes du projet, registre des
//! identités). La page s'occupe de son stockage local (récents, onglets, colonnes, terminaux).
use std::path::{Path, PathBuf};

use axecode_app::dossiers::{retrouver, Limites, Registre};
use axecode_app::workspace::{workspace_info, WorkspaceInfo};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::*;

pub(crate) fn registre(state: &DesktopState) -> Option<Registre> {
    state.store.path().parent().map(Registre::dans)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetrouverInput {
    chemin: String,
    #[serde(default)]
    racines: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recherche {
    statut: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    chemin: Option<String>,
}

/// Où se trouve maintenant le dossier `chemin` ? « existe » (le chemin est toujours là),
/// « retrouve » (+ nouveau chemin canonique) ou « introuvable ». La recherche, bornée en
/// profondeur, en nombre de dossiers et en durée, tourne hors du fil de l'interface.
#[tauri::command]
pub(crate) async fn dossier_retrouver(
    state: State<'_, DesktopState>,
    input: RetrouverInput,
) -> std::result::Result<Recherche, String> {
    let ancien = PathBuf::from(&input.chemin);
    if input.chemin.starts_with("axe-cloud://") || ancien.is_dir() {
        return Ok(Recherche { statut: "existe", chemin: None });
    }
    let Some(identite) = registre(&state).and_then(|r| r.identite_de(&input.chemin)) else {
        return Ok(Recherche { statut: "introuvable", chemin: None });
    };
    let racines: Vec<PathBuf> = input.racines.iter().map(PathBuf::from).filter(|p| p.is_dir()).collect();
    let trouve = tauri::async_runtime::spawn_blocking(move || retrouver(&ancien, &identite, &racines, &Limites::default()))
        .await
        .map_err(error_to_string)?;
    Ok(match trouve.and_then(|p| normalize_workspace_root(&p).ok()) {
        Some(p) => Recherche { statut: "retrouve", chemin: Some(p.display().to_string()) },
        None => Recherche { statut: "introuvable", chemin: None },
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoterInput {
    chemins: Vec<String>,
}

/// Au démarrage : identité des dossiers récents encore présents qui n'en ont pas encore.
#[tauri::command]
pub(crate) async fn dossiers_noter(state: State<'_, DesktopState>, input: NoterInput) -> std::result::Result<usize, String> {
    let Some(registre) = registre(&state) else { return Ok(0) };
    let chemins: Vec<String> = input.chemins.into_iter().take(100).collect();
    tauri::async_runtime::spawn_blocking(move || registre.noter_absents(&chemins))
        .await
        .map_err(error_to_string)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeplacerInput {
    ancien: String,
    nouveau: String,
}

/// Le dossier `ancien` se trouve désormais à `nouveau` (retrouvé, ou choisi par
/// l'utilisateur) : tout ce qui est rattaché à l'ancien chemin le suit.
#[tauri::command]
pub(crate) async fn dossier_deplacer(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: DeplacerInput,
) -> std::result::Result<WorkspaceInfo, String> {
    let racine = normalize_workspace_root(&input.nouveau).map_err(error_to_string)?;
    let nouveau = racine.display().to_string();
    let ancien = input.ancien;
    if ancien == nouveau || ancien.starts_with("axe-cloud://") {
        return Ok(workspace_info(&racine));
    }
    // 1. Conversations (et leur historique, rattaché à l'identifiant de conversation).
    let ids = state.store.deplacer_espace(&ancien, &nouveau).map_err(error_to_string)?;
    // 2. Données internes du projet (images, plans, harnais « projet »…), hors du projet.
    deplacer_donnees_projet(Path::new(&ancien), &racine);
    // 3. Registre des identités : une seule entrée, au nouveau chemin.
    if let Some(r) = registre(&state) {
        r.renommer(&ancien, &nouveau);
    }
    // 4. Sessions du service rattachées à l'ancien chemin : le prochain tour repart dans le
    //    nouveau dossier (noyau relancé, variables reprises de l'instantané).
    let extra = system_prompt_for_workspace(&racine, "").unwrap_or_default();
    for id in ids {
        relocaliser_session(&app, &id, &ancien, &nouveau, extra.trim()).await;
    }
    Ok(workspace_info(&racine))
}

/// Données internes du projet (`projects/<nom>-<empreinte du chemin>`) : renommées vers la
/// clé du nouveau chemin, sauf si celle-ci existe déjà (dossier rouvert entre-temps).
pub(crate) fn deplacer_donnees_projet(ancien: &Path, nouveau: &Path) {
    let source = axecode_harness::datadir::project_data_dir(ancien);
    let cible = axecode_harness::datadir::project_data_dir(nouveau);
    if source != cible && source.is_dir() && !cible.exists() {
        let _ = std::fs::rename(&source, &cible);
    }
}

async fn relocaliser_session(app: &AppHandle, id: &str, ancien: &str, nouveau: &str, extra: &str) {
    let Ok(meta) = crate::daemon_client::daemon_call_value(app, "sessions.get", json!({"sessionId": id})).await else {
        return;
    };
    let actuel = meta
        .get("workspaceId")
        .or_else(|| meta.get("meta").and_then(|m| m.get("workspaceId")))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if actuel != ancien {
        return;
    }
    let params = json!({"sessionId": id, "workspaceId": nouveau, "systemPromptExtra": extra});
    for _ in 0..10 {
        match crate::daemon_client::daemon_call_value(app, "sessions.relocate", params.clone()).await {
            Err(err) if crate::freechat::relocate_occupe(&err) => {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            _ => return,
        }
    }
}
