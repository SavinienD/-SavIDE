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
