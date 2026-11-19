//! uh-cli — morceaux communs au mode `-p` et au mode ACP : connexion au service (le
//! même que celui de l'appli, lancé au besoin par `SavIDE --daemon serve`), choix de
//! la conversation, copie dans le stockage de l'appli pour qu'elle s'y ouvre ensuite,
//! et état des réveils en attente.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use axecode_app::store::AppStore;
use axecode_core::{ChatMessage, ModelRef};
use axecode_daemon::{client::DaemonClient, protocol::Event};

pub type Evenements = mpsc::UnboundedReceiver<Event>;

/// Connexion au service des données par défaut (celles de l'appli).
pub async fn connecter() -> Result<(DaemonClient, Evenements), String> {
    let donnees = axecode_daemon::util::default_data_dir().map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::unbounded_channel();
    let client = axecode_daemon::ensure_daemon(&donnees, &exe, &[crate::daemon_client::DAEMON_FLAG], Some(tx)).await?;
    let _ = client.call("hello", json!({"client": "savide-cli"})).await;
    Ok((client, rx))
}

/// Dossier de travail sous la forme que l'appli utilise comme clé.
pub fn dossier(choisi: Option<&Path>) -> Result<PathBuf, String> {
    let brut = match choisi {
        Some(p) => p.to_path_buf(),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    axecode_app::workspace::normalize_workspace_root(&brut).map_err(|e| format!("{e:#}"))
}

/// Modèle par défaut : le fournisseur scripté s'il est posé (essais), sinon le modèle
/// « Agir » choisi dans l'appli, sinon celui de l'appli au premier lancement.
pub fn modele_par_defaut() -> ModelRef {
    if std::env::var(axecode_app::fournisseur_faux::FAUX_ENV).is_ok_and(|v| !v.trim().is_empty()) {
        return ModelRef::new(axecode_app::fournisseur_faux::FAUX_PROVIDER_ID, "faux-1");
    }
    let repli = ModelRef::new("anthropic", axecode_anthropic::MODEL_ID).with_effort(axecode_core::Effort::Max);
    AppStore::open_default()
        .and_then(|s| s.load_mode_model_settings(&repli))
        .map(|r| r.act)
        .unwrap_or(repli)
}

fn liste(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

/// Conversation à reprendre : identifiant exact ou début unique.
pub async fn trouver(client: &DaemonClient, id: &str) -> Result<Value, String> {
    let toutes = liste(&client.call("sessions.list", json!({})).await?);
    if let Some(s) = toutes.iter().find(|s| s["id"] == id) {
        return Ok(s.clone());
    }
    let candidates: Vec<&Value> = toutes
        .iter()
        .filter(|s| s["id"].as_str().is_some_and(|x| x.starts_with(id)))
        .collect();
    match candidates.as_slice() {
        [une] => Ok((*une).clone()),
        [] => Err(format!("conversation « {id} » introuvable")),
        _ => Err(format!("« {id} » désigne plusieurs conversations : donner plus de caractères")),
    }
}

/// Dernière conversation principale (ni sous-agent ni archivée) du dossier.
pub async fn derniere(client: &DaemonClient, dossier: &str) -> Result<Option<Value>, String> {
    let toutes = liste(&client.call("sessions.list", json!({})).await?);
    Ok(toutes
        .into_iter()
        .filter(|s| s["workspaceId"] == dossier && s["parentId"].is_null() && s["archived"] != true)
        .max_by_key(|s| s["updatedAtMs"].as_i64().unwrap_or(0)))
}

/// Nom d'une nouvelle conversation (mêmes règles que l'appli).
pub fn nom(texte: &str) -> String {
    crate::freechat::session_name("", texte)
}

/// Crée une conversation dans le service (et y attache ce client).
pub async fn creer(client: &DaemonClient, dossier: &Path, modele: &ModelRef, nom: &str) -> Result<Value, String> {
    let extra = crate::system_prompt_for_workspace(dossier, "").unwrap_or_default();
    client
        .call(
            "sessions.create",
            json!({"name": nom, "workspaceId": dossier.display().to_string(), "model": modele, "systemPromptExtra": extra.trim()}),
        )
        .await
}

/// Ligne de la conversation dans le stockage de l'appli (même identifiant que le
/// service), puis son historique : l'appli la liste dans ce dossier et l'ouvre comme
/// les siennes (les messages suivants repartent dans la même session du service).
pub fn copier_dans_l_appli(dossier: &str, id: &str, titre: &str, modele: &ModelRef, historique: Option<Vec<ChatMessage>>) -> Result<(), String> {
    let store = AppStore::open_default().map_err(|e| format!("{e:#}"))?;
    let existante = store.load_conversation(dossier, id).map_err(|e| format!("{e:#}"))?;
    let mut conversation = match existante {
        Some(c) => c,
        None => {
            let conn = rusqlite::Connection::open(store.path()).map_err(|e| e.to_string())?;
            let ailleurs: i64 = conn
                .query_row("select count(*) from conversations where id = ?1", rusqlite::params![id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if ailleurs > 0 {
                return Ok(()); // déjà rangée dans un autre dossier de l'appli : on n'y touche pas
            }
            let creee = store
                .create_conversation(dossier, modele, crate::DEFAULT_SYSTEM_PROMPT)
                .map_err(|e| format!("{e:#}"))?;
            conn.execute("update conversations set id = ?2 where id = ?1", rusqlite::params![creee.id, id])
                .map_err(|e| e.to_string())?;
            let mut c = store
                .load_conversation(dossier, id)
                .map_err(|e| format!("{e:#}"))?
                .ok_or("conversation copiée introuvable")?;
            c.title = titre.to_string();
            c
        }
    };
    conversation.model = modele.clone();
    if let Some(h) = historique {
        conversation.history = h;
    }
    store.save_conversation(&conversation).map_err(|e| format!("{e:#}"))
}

/// Recopie l'historique du service dans l'appli (fin de tour, fin du programme).
pub async fn synchroniser(client: &DaemonClient, dossier: &str, meta: &Value) {
    let Some(id) = meta["id"].as_str() else { return };
    let historique = client
        .call("sessions.history", json!({"sessionId": id}))
        .await
        .ok()
        .and_then(|h| serde_json::from_value::<Vec<ChatMessage>>(h).ok());
    let modele = serde_json::from_value::<ModelRef>(meta["model"].clone()).unwrap_or_else(|_| modele_par_defaut());
    let titre = meta["name"].as_str().unwrap_or("Nouvelle conversation");
    if let Err(e) = copier_dans_l_appli(dossier, id, titre, &modele, historique) {
        tracing::warn!(error = %e, "copie de la conversation dans l'appli impossible");
    }
}

/// Ce qui réveillera encore la conversation (vide = rien à attendre) : guets, objectif
/// actif dont la relance est planifiée, mode autonome ou sans fin, sous-agents en cours.
/// Les heartbeats, récurrents, ne comptent pas.
pub async fn reveils_en_attente(client: &DaemonClient, id: &str) -> Vec<String> {
    let mut attente = Vec::new();
    if let Ok(etat) = client.call("sessions.commands_state", json!({"sessionId": id})).await {
        let n = etat["guets"].as_array().map_or(0, Vec::len);
        if n > 0 {
            attente.push(format!("{n} guet(s)"));
        }
        // Objectif actif : seulement si une relance est planifiée (après une limite du mode
        // autonome, l'objectif reste actif sans que rien ne le relance).
        if etat["goal"]["status"] == "active" && !etat["goal"]["next_relaunch_ms"].is_null() {
            attente.push("relance de l'objectif".into());
        }
        if etat["autonomous"]["status"] == "running" {
            attente.push("mode autonome".into());
        }
        if etat["sans_fin"]["status"] == "running" {
            attente.push("mode sans fin".into());
        }
    }
    if let Ok(toutes) = client.call("sessions.list", json!({})).await {
        let n = liste(&toutes)
            .iter()
            .filter(|s| s["parentId"] == id && s["status"] == "running")
            .count();
        if n > 0 {
            attente.push(format!("{n} sous-agent(s)"));
        }
    }
    attente
}

/// Texte d'un message d'une entrée de journal `message` (rôle, texte).
pub fn message_d_entree(data: &Value) -> Option<(String, String)> {
    if data["kind"] != "message" {
        return None;
    }
    let m: ChatMessage = serde_json::from_value(data["message"].clone()).ok()?;
    let role = serde_json::to_value(&m.role).ok()?.as_str()?.to_string();
    Some((role, m.text()))
}
