//! uh-cli (lot B) — `axecode --mode acp` : Agent Client Protocol en JSON-RPC 2.0, une
//! ligne JSON par message sur stdin/stdout (les journaux vont sur stderr). Méthodes :
//! `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`,
//! `session/cancel` (notification), `session/set_config_option`. Le travail se fait dans
//! le service de l'appli : une session ACP = une conversation du service (même
//! identifiant), visible ensuite dans l'appli. Les tours lancés par le service (guet,
//! heartbeat, relance d'objectif) sont aussi diffusés en `session/update`.

use std::collections::{HashMap, VecDeque};
use std::io::Write;

use serde_json::{json, Value};
use tokio::io::AsyncBufReadExt;

use axecode_core::{ChatMessage, ModelRef};
use axecode_daemon::{client::DaemonClient, protocol::Event};

use super::acp_maj as maj;
use super::commun;

const ERR_ANALYSE: i64 = -32700;
const ERR_METHODE: i64 = -32601;
const ERR_PARAMS: i64 = -32602;
const ERR_INTERNE: i64 = -32603;

fn ecrire(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn repondre(id: &Value, resultat: Value) {
    ecrire(&json!({"jsonrpc": "2.0", "id": id, "result": resultat}));
}

fn echec(id: &Value, code: i64, message: &str) {
    ecrire(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
}

#[derive(Default)]
struct Session {
    dossier: String,
    modele: Option<ModelRef>,
    /// Requêtes `session/prompt` en attente de la fin de leur tour, dans l'ordre.
    attente: VecDeque<Value>,
    annule: bool,
    en_cours: bool,
    /// Tour lancé par le service (pas par un `session/prompt`).
    reveil: bool,
    sorties: HashMap<String, String>,
    erreurs: Vec<String>,
    texte: bool,
}

struct Acp {
    client: DaemonClient,
    sessions: HashMap<String, Session>,
}

/// Modèles proposés : le courant, ceux des modes de l'appli, le catalogue relu par
/// l'appli (`catalogue-modeles.json`) et le fournisseur faux des essais s'il est posé.
fn modeles_connus() -> Vec<ModelRef> {
    let mut l = Vec::new();
    if std::env::var(axecode_app::fournisseur_faux::FAUX_ENV).is_ok_and(|v| !v.trim().is_empty()) {
        l.push(ModelRef::new(axecode_app::fournisseur_faux::FAUX_PROVIDER_ID, "faux-1"));
    }
    if let Ok(store) = axecode_app::store::AppStore::open_default() {
        let repli = commun::modele_par_defaut();
        if let Ok(r) = store.load_mode_model_settings(&repli) {
            l.push(ModelRef { effort: None, ..r.act });
        }
    }
    if let Ok(dossier) = axecode_daemon::util::default_data_dir() {
        let brut = std::fs::read_to_string(dossier.join("catalogue-modeles.json")).unwrap_or_default();
        let v: Value = serde_json::from_str(&brut).unwrap_or(Value::Null);
        for (fournisseur, liste) in v["fournisseurs"].as_object().into_iter().flatten() {
            for m in liste.as_array().into_iter().flatten() {
                if let Some(id) = m["id"].as_str() {
                    l.push(ModelRef::new(fournisseur, id));
                }
            }
        }
    }
    l
}

pub async fn executer() -> i32 {
    let (client, mut rx) = match commun::connecter().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("axecode : service injoignable : {e}");
            return 3;
        }
    };
    let mut acp = Acp { client, sessions: HashMap::new() };
    let mut lignes = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            ligne = lignes.next_line() => match ligne {
                Ok(Some(l)) if l.trim().is_empty() => {}
                Ok(Some(l)) => acp.message(&l).await,
                _ => break, // stdin fermé : le client est parti
            },
            ev = rx.recv() => match ev {
                Some(ev) => {
                    if let Some(id) = acp.evenement(&ev) {
                        let dossier = acp.sessions.get(&id).map(|s| s.dossier.clone()).unwrap_or_default();
                        if let Ok(m) = acp.client.call("sessions.get", json!({"sessionId": id})).await {
                            commun::synchroniser(&acp.client, &dossier, &m).await;
                        }
                    }
                }
                None => {
                    eprintln!("axecode : le service a fermé la connexion");
                    return 3;
                }
            },
        }
    }
    // Un tour encore en cours continue dans le service (il reste visible dans l'appli).
    for (id, s) in &acp.sessions {
        if let Some(m) = acp.client.call("sessions.get", json!({"sessionId": id})).await.ok() {
            commun::synchroniser(&acp.client, &s.dossier, &m).await;
        }
    }
    0
}

impl Acp {
    async fn message(&mut self, ligne: &str) {
        let v: Value = match serde_json::from_str(ligne) {
            Ok(v) => v,
            Err(e) => return echec(&Value::Null, ERR_ANALYSE, &format!("JSON illisible : {e}")),
        };
        let id = v.get("id").cloned();
        let methode = v["method"].as_str().unwrap_or("").to_string();
        let p = v.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id else {
            // Notifications : seule `session/cancel` est attendue.
            if methode == "session/cancel" {
                self.annuler(p["sessionId"].as_str().unwrap_or("")).await;
            }
            return;
        };
        if methode.is_empty() {
            return; // réponse du client à une requête de l'agent (aucune envoyée)
        }
        let resultat = match methode.as_str() {
            "initialize" => Ok(json!({
                "protocolVersion": maj::VERSION_PROTOCOLE,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": {"image": false, "audio": false, "embeddedContext": true},
                    "mcpCapabilities": {"http": false, "sse": false}
                },
                "authMethods": [],
                "agentInfo": {"name": "axecode", "title": "Axecode", "version": env!("CARGO_PKG_VERSION")}
            })),
            "authenticate" => Ok(json!({})),
            "session/new" => self.nouvelle(&p).await,
            "session/load" => self.charger(&p).await,
            "session/prompt" => match self.prompt(&id, &p).await {
                Ok(()) => return, // la réponse part à la fin du tour
                Err(e) => Err((ERR_PARAMS, e)),
            },
            "session/set_config_option" => self.option(&p).await,
            "session/cancel" => {
                self.annuler(p["sessionId"].as_str().unwrap_or("")).await;
                Ok(Value::Null)
            }
            autre => Err((ERR_METHODE, format!("méthode inconnue : {autre}"))),
        };
        match resultat {
            Ok(r) => repondre(&id, r),
            Err((code, m)) => echec(&id, code, &m),
        }
    }

    fn modele_de(meta: &Value) -> ModelRef {
        serde_json::from_value(meta["model"].clone()).unwrap_or_else(|_| commun::modele_par_defaut())
    }

    async fn nouvelle(&mut self, p: &Value) -> Result<Value, (i64, String)> {
        let cwd = p["cwd"].as_str().map(std::path::PathBuf::from);
        let dossier = commun::dossier(cwd.as_deref()).map_err(|e| (ERR_PARAMS, e))?;
        let modele = commun::modele_par_defaut();
        let meta = commun::creer(&self.client, &dossier, &modele, "Nouvelle conversation")
            .await
            .map_err(|e| (ERR_INTERNE, e))?;
        let id = meta["id"].as_str().unwrap_or_default().to_string();
        let cle = dossier.display().to_string();
        commun::synchroniser(&self.client, &cle, &meta).await;
        let modele = Self::modele_de(&meta);
        let options = maj::options(&modele, &modeles_connus());
        self.sessions.insert(id.clone(), Session { dossier: cle, modele: Some(modele), ..Default::default() });
        Ok(json!({"sessionId": id, "configOptions": options}))
    }

    async fn charger(&mut self, p: &Value) -> Result<Value, (i64, String)> {
        let demande = p["sessionId"].as_str().unwrap_or("");
        let meta = commun::trouver(&self.client, demande).await.map_err(|e| (ERR_PARAMS, e))?;
        let id = meta["id"].as_str().unwrap_or_default().to_string();
        self.client
            .call("sessions.attach", json!({"sessionId": id}))
            .await
            .map_err(|e| (ERR_INTERNE, e))?;
        let historique: Vec<ChatMessage> = self
            .client
            .call("sessions.history", json!({"sessionId": id}))
            .await
            .ok()
            .and_then(|h| serde_json::from_value(h).ok())
            .unwrap_or_default();
        for maj in maj::relecture(&historique) {
            ecrire(&maj::notification(&id, maj));
        }
        let modele = Self::modele_de(&meta);
        let options = maj::options(&modele, &modeles_connus());
        let dossier = meta["workspaceId"].as_str().unwrap_or("").to_string();
        let en_cours = meta["status"] == "running";
        self.sessions.insert(id, Session { dossier, modele: Some(modele), en_cours, reveil: en_cours, ..Default::default() });
        Ok(json!({"configOptions": options}))
    }

    async fn prompt(&mut self, id_requete: &Value, p: &Value) -> Result<(), String> {
        let id = p["sessionId"].as_str().unwrap_or("").to_string();
        let texte = maj::texte_du_prompt(&p["prompt"]);
        if texte.trim().is_empty() {
            return Err("prompt vide".into());
        }
        self.sessions
            .get_mut(&id)
            .ok_or_else(|| format!("session inconnue : {id} (session/new ou session/load d'abord)"))?
            .attente
            .push_back(id_requete.clone());
        if let Err(e) = self.client.call("sessions.send", json!({"sessionId": id, "text": texte})).await {
            if let Some(s) = self.sessions.get_mut(&id) {
                s.attente.pop_back();
            }
            return Err(e);
        }
        // Nom de la conversation d'après son premier message (comme dans l'appli).
        if let Ok(meta) = self.client.call("sessions.get", json!({"sessionId": id})).await {
            if meta["name"] == "Nouvelle conversation" {
                let _ = self
                    .client
                    .call("sessions.update", json!({"sessionId": id, "name": commun::nom(&texte)}))
                    .await;
            }
        }
        Ok(())
    }

    async fn annuler(&mut self, id: &str) {
        let Some(s) = self.sessions.get_mut(id) else { return };
        s.annule = true;
        let en_cours = s.en_cours;
        let _ = self.client.call("sessions.stop", json!({"sessionId": id})).await;
        // Rien ne tournait (message encore en file) : les requêtes finissent tout de suite.
        if !en_cours {
            if let Some(s) = self.sessions.get_mut(id) {
                for r in s.attente.drain(..) {
                    repondre(&r, json!({"stopReason": "cancelled"}));
                }
                s.annule = false;
            }
        }
    }

    async fn option(&mut self, p: &Value) -> Result<Value, (i64, String)> {
        let id = p["sessionId"].as_str().unwrap_or("").to_string();
        let option = p["configId"].as_str().unwrap_or("");
        let valeur = p["value"].as_str().unwrap_or("");
        let courant = {
            let s = self.sessions.get(&id).ok_or((ERR_PARAMS, format!("session inconnue : {id}")))?;
            s.modele.clone().unwrap_or_else(commun::modele_par_defaut)
        };
        let m = maj::appliquer(&courant, option, valeur).map_err(|e| (ERR_PARAMS, e))?;
        self.client
            .call("sessions.set_model", json!({"sessionId": id, "model": m}))
            .await
            .map_err(|e| (ERR_INTERNE, e))?;
        let options = maj::options(&m, &modeles_connus());
        if let Some(s) = self.sessions.get_mut(&id) {
            s.modele = Some(m);
        }
        Ok(json!({"configOptions": options}))
    }

    /// Traduit un événement du service ; rend l'identifiant d'une session dont un tour
    /// vient de finir (pour recopier son historique dans l'appli).
    fn evenement(&mut self, ev: &Event) -> Option<String> {
        let id = ev.session_id.clone()?;
        let s = self.sessions.get_mut(&id)?;
        let d = &ev.data;
        let envoyer = |maj: Value| ecrire(&maj::notification(&id, maj));
        match ev.event.as_str() {
            "status" => {
                let en_cours = d["status"] == "running";
                if en_cours && !s.en_cours {
                    s.en_cours = true;
                    s.reveil = s.attente.is_empty();
                    s.erreurs.clear();
                    s.texte = false;
                    if s.reveil {
                        envoyer(maj::tour_de_reveil(true));
                    }
                } else if !en_cours && s.en_cours {
                    s.en_cours = false;
                    s.sorties.clear();
                    if s.reveil {
                        envoyer(maj::tour_de_reveil(false));
                    } else if let Some(r) = s.attente.pop_front() {
                        if s.annule {
                            repondre(&r, json!({"stopReason": "cancelled"}));
                        } else if !s.erreurs.is_empty() && !s.texte {
                            echec(&r, ERR_INTERNE, &s.erreurs.join("\n"));
                        } else {
                            repondre(&r, json!({"stopReason": "end_turn"}));
                        }
                    }
                    if s.annule {
                        // Les messages encore en file sont annulés avec le tour.
                        for r in s.attente.drain(..) {
                            repondre(&r, json!({"stopReason": "cancelled"}));
                        }
                    }
                    s.annule = false;
                    s.reveil = false;
                    return Some(id);
                }
            }
            "stream" => {
                let e = &d["event"];
                let t = |k: &str| e[k].as_str().unwrap_or("").to_string();
                match e["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        s.texte = true;
                        envoyer(maj::texte("agent_message_chunk", &t("delta")));
                    }
                    "thinking_delta" => envoyer(maj::texte("agent_thought_chunk", &t("delta"))),
                    "repl_start" => envoyer(maj::appel(&t("callId"), &t("code"))),
                    "repl_stream" => {
                        let sortie = s.sorties.entry(t("callId")).or_default();
                        sortie.push_str(&t("text"));
                        envoyer(maj::appel_suite(&t("callId"), sortie));
                    }
                    "repl_done" => {
                        s.sorties.remove(&t("callId"));
                        envoyer(maj::appel_fin(&t("callId"), &t("stdout"), &t("stderr"), e["isError"] == true));
                    }
                    "turn_error" => {
                        let m = t("error");
                        if s.erreurs.last() != Some(&m) {
                            s.erreurs.push(m);
                        }
                    }
                    _ => {}
                }
            }
            "entry" => {
                if let Some(m) = crate::daemon_client::journal_turn_error(d) {
                    if s.erreurs.last() != Some(&m) {
                        s.erreurs.push(m);
                    }
                } else if let Some((role, texte)) = commun::message_d_entree(d) {
                    // Message d'un réveil (guet, heartbeat, relance) : le client ne l'a pas écrit.
                    if role == "user" && s.attente.is_empty() && !texte.trim().is_empty() {
                        envoyer(maj::texte("user_message_chunk", &texte));
                    }
                }
            }
            _ => {}
        }
        None
    }
}
