//! reprendre ce que l'utilisateur a déjà (Claude Code, Codex,
//! Cursor, VS Code) : consignes du dossier, skills, serveurs MCP. Commandes de
//! l'IDE seulement ; la logique vit dans axecode-harness et axecode-app.

use serde::Deserialize;
use serde_json::{json, Value};

type IpcResult<T> = std::result::Result<T, String>;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DossierInput {
    workspace_path: String,
}

/// Réglages > Harnais : fichiers de consignes du dossier et ce qui en part vers l'agent.
#[tauri::command]
pub(super) async fn interop_consignes(input: DossierInput) -> IpcResult<Value> {
    let root = axecode_app::workspace::normalize_workspace_root(&input.workspace_path).map_err(err)?;
    let consignes = axecode_harness::consignes::lire(&root);
    Ok(json!({"sources": consignes.sources, "plafond": consignes.plafond}))
}

// ---- skills (Claude Code, Codex, ~/.agents, adresses) ----------------------

fn racine_et_store(workspace_path: &str) -> IpcResult<(std::path::PathBuf, axecode_harness::HarnessStore)> {
    let root = axecode_app::workspace::normalize_workspace_root(workspace_path).map_err(err)?;
    let store = axecode_harness::HarnessStore::open(&root);
    Ok((root, store))
}

fn racines_skills(root: &std::path::Path) -> Vec<axecode_harness::skills_externes::RacineExterne> {
    let home = axecode_harness::store::default_home().unwrap_or_else(|| root.to_path_buf());
    axecode_harness::skills_externes::racines(root, &home)
}

/// Rapport d'un import : identifiants faits, erreurs lisibles.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rapport {
    faits: Vec<String>,
    erreurs: Vec<String>,
}

#[tauri::command]
pub(super) async fn interop_skills_lister(input: DossierInput) -> IpcResult<Value> {
    let (root, store) = racine_et_store(&input.workspace_path)?;
    let liste = axecode_harness::skills_externes::lister(&store, &racines_skills(&root));
    serde_json::to_value(liste).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportSkillsInput {
    workspace_path: String,
    chemins: Vec<String>,
}

/// Importe les skills cochés ; ceux déjà importés dont la source a changé sont mis à jour.
#[tauri::command]
pub(super) async fn interop_skills_importer(input: ImportSkillsInput) -> IpcResult<Rapport> {
    use axecode_harness::skills_externes::{self as se, EtatImport};
    let (root, store) = racine_et_store(&input.workspace_path)?;
    let racines = racines_skills(&root);
    let liste = se::lister(&store, &racines);
    let mut rapport = Rapport::default();
    for chemin in &input.chemins {
        let trouve = liste.iter().find(|s| &s.chemin == chemin);
        let resultat = match trouve {
            Some(s) if s.etat == EtatImport::MiseAJour => {
                se::mettre_a_jour(&store, s.id_harnais.as_deref().unwrap_or_default())
            }
            Some(_) => se::importer(&store, &racines, std::path::Path::new(chemin)),
            None => Err(anyhow::anyhow!("introuvable")),
        };
        match resultat {
            Ok(entry) => rapport.faits.push(entry.meta.id),
            Err(e) => rapport.erreurs.push(format!("{} : {e}", trouve.map(|s| s.nom_source.as_str()).unwrap_or(chemin))),
        }
    }
    Ok(rapport)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApercuUrlInput {
    workspace_path: String,
    url: String,
}

#[tauri::command]
pub(super) async fn interop_skills_url_apercu(input: ApercuUrlInput) -> IpcResult<Value> {
    let (_, store) = racine_et_store(&input.workspace_path)?;
    let apercu = axecode_app::skills_url::apercu(&input.url, &axecode_app::skills_url::dossier_cache(), &store)
        .await
        .map_err(err)?;
    serde_json::to_value(apercu).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InstallUrlInput {
    workspace_path: String,
    jeton: String,
    sous_dossiers: Vec<String>,
    portee: String,
}

#[tauri::command]
pub(super) async fn interop_skills_url_installer(input: InstallUrlInput) -> IpcResult<Rapport> {
    let (_, store) = racine_et_store(&input.workspace_path)?;
    let portee: axecode_harness::Scope = input.portee.parse().map_err(err)?;
    let fait = axecode_app::skills_url::installer(
        &input.jeton,
        &input.sous_dossiers,
        portee,
        &axecode_app::skills_url::dossier_cache(),
        &store,
    )
    .map_err(err)?;
    Ok(Rapport { faits: fait.skills.into_iter().map(|e| e.meta.id).collect(), erreurs: fait.erreurs })
}

#[tauri::command]
pub(super) async fn interop_skills_url_installes(input: DossierInput) -> IpcResult<Value> {
    let (_, store) = racine_et_store(&input.workspace_path)?;
    serde_json::to_value(axecode_app::skills_url::installes(&store)).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DesinstallerInput {
    workspace_path: String,
    id: String,
}

/// Désinstalle un skill repris (seulement ceux qui ont une source notée).
#[tauri::command]
pub(super) async fn interop_skills_desinstaller(input: DesinstallerInput) -> IpcResult<()> {
    let (_, store) = racine_et_store(&input.workspace_path)?;
    let entry = store
        .get_kind(axecode_harness::EntryKind::Skill, &input.id)
        .map_err(err)?
        .ok_or_else(|| format!("skill « {} » introuvable", input.id))?;
    if axecode_harness::skills_externes::origine(&entry).is_none() {
        return Err("ce skill n'a pas été importé : supprimez-le depuis la liste des skills".into());
    }
    store.delete(&entry.meta.id).map(|_| ()).map_err(err)
}

// ---- serveurs MCP (Claude Code, Codex, Cursor, VS Code) --------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScanMcpInput {
    #[serde(default)]
    workspace_path: Option<String>,
}

/// Dossier ouvert (local) dont on lit aussi `.mcp.json`, `.cursor/` et `.vscode/`.
fn dossier_local(path: Option<&str>) -> Option<std::path::PathBuf> {
    let path = path.filter(|p| !p.trim().is_empty() && !p.starts_with("axe-cloud://"))?;
    axecode_app::workspace::normalize_workspace_root(path).ok()
}

/// Réglages > MCP « Importer » : serveurs des autres outils, sans aucune valeur secrète.
#[tauri::command]
pub(super) async fn interop_mcp_scanner(
    state: tauri::State<'_, crate::DesktopState>,
    input: ScanMcpInput,
) -> IpcResult<Value> {
    use axecode_app::import_mcp;
    let ws = dossier_local(input.workspace_path.as_deref());
    let actuels = state.store.load_mcp_settings().map_err(err)?;
    let liste = import_mcp::scanner(&import_mcp::sources_du_poste(ws.as_deref()), ws.as_deref(), &actuels);
    serde_json::to_value(liste).map_err(err)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportMcpInput {
    #[serde(default)]
    workspace_path: Option<String>,
    cles: Vec<String>,
}

/// Ajoute les serveurs cochés à la configuration MCP (les fichiers sont relus ici :
/// les valeurs secrètes ne passent jamais par l'interface).
#[tauri::command]
pub(super) async fn interop_mcp_importer(
    state: tauri::State<'_, crate::DesktopState>,
    input: ImportMcpInput,
) -> IpcResult<Value> {
    use axecode_app::import_mcp;
    let ws = dossier_local(input.workspace_path.as_deref());
    let actuels = state.store.load_mcp_settings().map_err(err)?;
    let fait = import_mcp::importer(&import_mcp::sources_du_poste(ws.as_deref()), ws.as_deref(), &actuels, &input.cles)
        .map_err(err)?;
    if !fait.importes.is_empty() {
        state.store.save_mcp_settings(&fait.settings).map_err(err)?;
    }
    Ok(json!({"importes": fait.importes, "erreurs": fait.erreurs}))
}
