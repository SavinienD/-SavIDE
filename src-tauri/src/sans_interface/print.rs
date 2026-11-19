//! uh-cli — `axecode -p` : un message, la sortie du ou des tours, puis la fin quand plus
//! rien ne doit réveiller la conversation (ou que l'attente maximale est passée).
//! Sortie texte : la réponse finale de chaque tour. Sortie JSON (`--mode json`) : un
//! événement par ligne. Comportement repris du mode print d'Unharnessed (uh-cli
//! print_runtime / headless), écrit pour notre service.

use std::io::Write;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::args::{Mode, Options};
use super::commun;

/// Délai de calme après la fin d'un tour avant de demander au service s'il reste des
/// réveils (une relance d'objectif est planifiée juste après le tour).
const CALME: Duration = Duration::from_millis(1_500);

struct Sortie {
    json: bool,
}

impl Sortie {
    fn ev(&self, v: Value) {
        if self.json {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{v}");
            let _ = out.flush();
        }
    }
    fn texte(&self, t: &str) {
        if !self.json && !t.trim().is_empty() {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{}", t.trim_end());
            let _ = out.flush();
        }
    }
    fn erreur(&self, t: &str) {
        if self.json {
            self.ev(json!({"type": "error", "message": t}));
        }
        eprintln!("axecode : {t}");
    }
}

/// Lit l'entrée standard quand elle est redirigée (pas un terminal).
fn entree_redirigee() -> Option<String> {
    use std::io::{IsTerminal, Read};
    if std::io::stdin().is_terminal() {
        return None;
    }
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).ok()?;
    Some(s).filter(|s| !s.trim().is_empty())
}

pub async fn executer(mut o: Options) -> i32 {
    let sortie = Sortie { json: o.mode == Mode::Json };
    if o.texte.is_none() {
        o.texte = entree_redirigee();
    }
    let message = super::args::message(&o);
    if message.trim().is_empty() {
        sortie.erreur("aucun texte : axecode -p \"<texte>\" (ou l'entrée standard redirigée)");
        return 2;
    }
    let dossier = match commun::dossier(o.dossier.as_deref()) {
        Ok(d) => d,
        Err(e) => {
            sortie.erreur(&e);
            return 2;
        }
    };
    let cle = dossier.display().to_string();
    let (client, mut rx) = match commun::connecter().await {
        Ok(c) => c,
        Err(e) => {
            sortie.erreur(&format!("service injoignable : {e}"));
            return 3;
        }
    };
    // Conversation : reprise, continuation ou nouvelle.
    let existante = if let Some(id) = o.reprendre.as_deref() {
        match commun::trouver(&client, id).await {
            Ok(m) => Some(m),
            Err(e) => {
                sortie.erreur(&e);
                return 2;
            }
        }
    } else if o.continuer {
        let d = commun::derniere(&client, &cle).await.unwrap_or(None);
        if d.is_none() {
            eprintln!("axecode : aucune conversation à continuer dans {cle} ; nouvelle conversation");
        }
        d
    } else {
        None
    };
    let meta = match existante {
        Some(m) => {
            let id = m["id"].as_str().unwrap_or_default().to_string();
            if let Err(e) = client.call("sessions.attach", json!({"sessionId": id})).await {
                sortie.erreur(&e);
                return 1;
            }
            if let Some(modele) = &o.modele {
                if let Err(e) = client.call("sessions.set_model", json!({"sessionId": id, "model": modele})).await {
                    sortie.erreur(&e);
                    return 2;
                }
            }
            client.call("sessions.get", json!({"sessionId": id})).await.unwrap_or(m)
        }
        None => {
            let modele = o.modele.clone().unwrap_or_else(commun::modele_par_defaut);
            let nom = commun::nom(o.texte.as_deref().or(o.objectif.as_deref()).unwrap_or(&message));
            match commun::creer(&client, &dossier, &modele, &nom).await {
                Ok(m) => m,
                Err(e) => {
                    sortie.erreur(&e);
                    return 1;
                }
            }
        }
    };
    let id = meta["id"].as_str().unwrap_or_default().to_string();
    // Le dossier de la conversation reprise peut différer du dossier courant.
    let cle = meta["workspaceId"].as_str().map(str::to_string).unwrap_or(cle);
    commun::synchroniser(&client, &cle, &meta).await;
    sortie.ev(json!({"type": "session", "sessionId": id, "workspace": cle, "model": meta["model"], "name": meta["name"]}));
    if let Err(e) = client.call("sessions.send", json!({"sessionId": id, "text": message})).await {
        sortie.erreur(&e);
        return 1;
    }

    let mut boucle = Boucle { sortie: &sortie, id: &id, tampon: String::new(), en_cours: false, tours: 0, erreurs: Vec::new(), erreurs_du_tour: 0, texte_du_tour: false };
    let attente_max = Duration::from_millis(o.attente_max_ms);
    let debut = Instant::now();
    let mut calme_depuis: Option<Instant> = None;
    let mut attente_depuis: Option<Instant> = None;
    let mut annonce = String::new();
    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);
    let code = loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(ev) => {
                    if boucle.evenement(&ev) {
                        calme_depuis = None;
                        attente_depuis = None;
                        annonce.clear();
                    } else if !boucle.en_cours && boucle.tours > 0 && calme_depuis.is_none() {
                        calme_depuis = Some(Instant::now());
                    }
                }
                None => {
                    sortie.erreur("le service a fermé la connexion");
                    break 3;
                }
            },
            _ = &mut ctrl_c => {
                let _ = client.call("sessions.stop", json!({"sessionId": id})).await;
                sortie.erreur("interrompu (Ctrl+C) : tour arrêté");
                break 130;
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
        if boucle.en_cours || boucle.tours == 0 {
            // Le tour n'a pas commencé : un service qui ne le lance jamais ne bloque pas.
            if boucle.tours == 0 && debut.elapsed() > Duration::from_secs(120) {
                sortie.erreur("le service n'a pas lancé le tour (2 min)");
                break 1;
            }
            continue;
        }
        let calme = calme_depuis.get_or_insert_with(Instant::now);
        if calme.elapsed() < CALME {
            continue;
        }
        let attente = commun::reveils_en_attente(&client, &id).await;
        if attente.is_empty() {
            break boucle.code();
        }
        if o.attente_max_ms == 0 {
            eprintln!("axecode : réveils en attente ({}) : ils continuent dans le service ; --wait-max 0, sortie", attente.join(", "));
            break boucle.code();
        }
        let depuis = attente_depuis.get_or_insert_with(Instant::now);
        let quoi = attente.join(", ");
        if quoi != annonce {
            sortie.ev(json!({"type": "waiting", "for": attente}));
            annonce = quoi.clone();
        }
        if depuis.elapsed() >= attente_max {
            sortie.erreur(&format!(
                "attente maximale ({} ms) passée ; toujours en attente : {quoi} (cela continue dans le service)",
                o.attente_max_ms
            ));
            break boucle.code();
        }
        // On ne redemande l'état qu'une fois par seconde environ.
        calme_depuis = Some(Instant::now() - CALME + Duration::from_millis(1_000));
    };
    let etat = client.call("sessions.commands_state", json!({"sessionId": id})).await.unwrap_or(Value::Null);
    let mut code = code;
    if o.autonome.actif && code == 0 {
        let statut = etat["autonomous"]["status"].as_str().unwrap_or("absent");
        if statut != "done" {
            sortie.erreur(&format!("mode autonome terminé sans réussir (statut : {statut})"));
            code = 1;
        }
    }
    if let Some(m) = client.call("sessions.get", json!({"sessionId": id})).await.ok() {
        commun::synchroniser(&client, &cle, &m).await;
    }
    sortie.ev(json!({"type": "end", "sessionId": id, "exitCode": code, "turns": boucle.tours,
        "goal": etat["goal"], "autonomous": etat["autonomous"], "durationMs": debut.elapsed().as_millis() as u64}));
    code
}

struct Boucle<'a> {
    sortie: &'a Sortie,
    id: &'a str,
    /// Texte du modèle depuis le dernier appel au noyau : la réponse finale du tour.
    tampon: String,
    en_cours: bool,
    tours: u32,
    erreurs: Vec<String>,
    erreurs_du_tour: usize,
    texte_du_tour: bool,
}

impl Boucle<'_> {
    /// Code de sortie : 1 si le dernier tour a échoué sans rien répondre.
    fn code(&self) -> i32 {
        if self.erreurs_du_tour > 0 && !self.texte_du_tour { 1 } else { 0 }
    }

    fn erreur(&mut self, message: String) {
        if self.erreurs.last() == Some(&message) {
            return; // la même erreur arrive par le journal puis par le flux
        }
        self.sortie.erreur(&message);
        self.erreurs.push(message);
        self.erreurs_du_tour += 1;
    }

    /// Traite un événement du service ; vrai si un tour commence.
    fn evenement(&mut self, ev: &axecode_daemon::protocol::Event) -> bool {
        if ev.session_id.as_deref() != Some(self.id) {
            return false;
        }
        let d = &ev.data;
        match ev.event.as_str() {
            "status" => {
                let en_cours = d["status"] == "running";
                if en_cours && !self.en_cours {
                    self.en_cours = true;
                    self.tours += 1;
                    self.tampon.clear();
                    self.erreurs.clear();
                    self.erreurs_du_tour = 0;
                    self.texte_du_tour = false;
                    self.sortie.ev(json!({"type": "turn_start", "turn": self.tours}));
                    return true;
                }
                if !en_cours && self.en_cours {
                    self.en_cours = false;
                    let texte = std::mem::take(&mut self.tampon);
                    self.texte_du_tour = !texte.trim().is_empty();
                    self.sortie.texte(&texte);
                    self.sortie.ev(json!({"type": "turn_end", "turn": self.tours, "text": texte.trim(), "status": d["status"]}));
                }
            }
            "stream" => {
                let e = &d["event"];
                match e["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let delta = e["delta"].as_str().unwrap_or("");
                        self.tampon.push_str(delta);
                        self.sortie.ev(json!({"type": "text_delta", "delta": delta}));
                    }
                    "thinking_delta" => self.sortie.ev(json!({"type": "thinking_delta", "delta": e["delta"]})),
                    "repl_start" => {
                        self.tampon.clear();
                        self.sortie.ev(json!({"type": "kernel_call", "callId": e["callId"], "code": e["code"]}));
                    }
                    "repl_stream" => self.sortie.ev(json!({"type": "kernel_output", "callId": e["callId"], "text": e["text"]})),
                    "repl_done" => self.sortie.ev(json!({"type": "kernel_result", "callId": e["callId"], "stdout": e["stdout"],
                        "stderr": e["stderr"], "isError": e["isError"], "durationMs": e["durationMs"]})),
                    "stream_retry" => {
                        self.tampon.clear();
                        self.sortie.ev(json!({"type": "stream_retry"}));
                    }
                    "turn_error" => self.erreur(e["error"].as_str().unwrap_or("erreur du tour").to_string()),
                    "turn_done" => {}
                    // compaction_start, compaction_done, question… : tels quels.
                    _ => self.sortie.ev(e.clone()),
                }
            }
            "entry" => {
                if let Some(m) = crate::daemon_client::journal_turn_error(d) {
                    self.erreur(m);
                } else if d["kind"] == "compaction" {
                    self.sortie.ev(json!({"type": "compaction", "summary": d["summary"]}));
                } else if d["kind"] == "extension" {
                    let nom = d["name"].as_str().unwrap_or("");
                    if matches!(nom, "goal" | "autonomous" | "heartbeat" | "guet" | "sans_fin") {
                        self.sortie.ev(json!({"type": format!("{nom}_update"), "payload": d["payload"]}));
                    }
                } else if let Some((role, texte)) = commun::message_d_entree(d) {
                    if role == "user" {
                        // Message de l'utilisateur ou réveil (guet, heartbeat, relance d'objectif).
                        // Une relance dans le même tour (mode autonome) : la réponse d'avant
                        // est écrite tout de suite, sur sa ligne.
                        if self.en_cours {
                            let avant = std::mem::take(&mut self.tampon);
                            self.sortie.texte(&avant);
                        }
                        self.sortie.ev(json!({"type": "user_message", "text": texte}));
                    }
                }
            }
            _ => {}
        }
        false
    }
}
