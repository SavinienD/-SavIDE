//! automatisations — une exécution : vérification, conversation, suivi, bilan.
//!
//! Lancement : la ligne d'historique est notée tout de suite (« verification » ou
//! « en_cours »), puis la conversation est créée (ou la même reprise) avec le
//! prompt. Le planificateur suit la conversation : dès que son tour est fini, le
//! bilan est lu dans le journal (erreur, arrêt, ou dernière réponse = résumé) et
//! l'événement `automatisations` `{type: "fin"}` part vers les écrans.

use std::{path::Path, sync::Arc, time::Duration};

use axecode_core::{ChatMessage, CreateSessionRequest, JournalEntryKind, Part, Role, SessionError, SessionResult, SessionStatus};
use serde_json::{json, Value};

use super::{etat, maintenant_local, message, signaler, Automatisation, Declencheur, Execution, Statut};
use crate::daemon::{lock, Daemon};

/// Durée maximale de la vérification avant lancement.
pub(crate) const VERIFICATION_MAX: Duration = Duration::from_secs(120);

/// Longueur du résumé gardé dans l'historique.
const RESUME_MAX: usize = 280;

/// Démarre une exécution. Refusée si une autre exécution de la même
/// automatisation tourne encore. « Lancer maintenant » (manuel) saute la
/// vérification avant lancement.
pub(crate) fn lancer(
    d: &Arc<Daemon>,
    id: &str,
    declencheur: Declencheur,
    prevue_ms: Option<i64>,
    manquees: u32,
    maintenant_ms: i64,
) -> SessionResult<Execution> {
    let (auto, x, verifier) = {
        let etat = etat(d);
        let mut e = lock(&etat);
        let a = e.trouver(id)?;
        if a.en_cours() {
            return Err(SessionError::Protocol(format!("Une exécution de « {} » est déjà en cours.", a.nom)));
        }
        let verifier = declencheur != Declencheur::Manuel && a.verification.is_some();
        let x = Execution {
            id: crate::util::new_id(),
            declencheur,
            prevue_ms,
            debut_ms: maintenant_ms,
            fin_ms: None,
            statut: if verifier { Statut::Verification } else { Statut::EnCours },
            session_id: None,
            depuis: None,
            resume: None,
            manquees,
            arret_demande: false,
        };
        a.noter(x.clone());
        let auto = a.clone();
        e.enregistrer();
        (auto, x, verifier)
    };
    signaler(d);
    if verifier {
        let d = d.clone();
        let exec_id = x.id.clone();
        tokio::spawn(async move { verifier_puis_ouvrir(d, auto, exec_id).await });
        return Ok(x);
    }
    ouvrir(d, &auto, &x.id, maintenant_ms);
    Ok(lire(d, &auto.id, &x.id).unwrap_or(x))
}

fn lire(d: &Daemon, auto_id: &str, exec_id: &str) -> Option<Execution> {
    let etat = etat(d);
    let e = lock(&etat);
    e.liste.iter().find(|a| a.id == auto_id)?.historique.iter().find(|x| x.id == exec_id).cloned()
}

/// Vérification avant lancement : code 0 = on lance, sinon l'exécution est sautée.
async fn verifier_puis_ouvrir(d: Arc<Daemon>, auto: Automatisation, exec_id: String) {
    let commande = auto.verification.clone().unwrap_or_default();
    let (ok, code, sortie) = axecode_app::guet::essai(Path::new(&auto.dossier), &commande, VERIFICATION_MAX).await;
    let maintenant = crate::util::now_ms();
    // Arrêtée, supprimée ou modifiée pendant la vérification : relue ici.
    let actuelle = {
        let etat = etat(&d);
        let e = lock(&etat);
        e.liste
            .iter()
            .find(|a| a.id == auto.id)
            .filter(|a| a.historique.iter().any(|x| x.id == exec_id && x.statut == Statut::Verification && !x.arret_demande))
            .cloned()
    };
    let Some(actuelle) = actuelle else { return };
    if !ok {
        let detail = derniere_ligne(&sortie).map(|l| format!(" — {l}")).unwrap_or_default();
        let resume = match code {
            Some(c) => format!("Vérification en échec (code {c}){detail}"),
            None => format!("Vérification impossible{detail}"),
        };
        terminer(&d, &auto.id, &exec_id, Statut::Sautee, resume, None, maintenant);
        return;
    }
    ouvrir(&d, &actuelle, &exec_id, maintenant);
}

fn derniere_ligne(sortie: &str) -> Option<String> {
    let ligne = sortie.lines().rev().map(str::trim).find(|l| !l.is_empty() && *l != "…")?;
    Some(couper(ligne, 160))
}

enum Ouverture {
    Lancee { session_id: String, depuis: Option<String> },
    Occupee(String),
}

/// Consigne ajoutée au prompt système des conversations d'une automatisation.
fn consigne(a: &Automatisation) -> String {
    format!(
        "Conversation lancée par l'automatisation « {} » ({}), sans personne devant l'écran. \
         Ne pose aucune question à l'utilisateur et n'attends pas de réponse : fais le travail demandé, \
         puis termine par un résumé court (une ou deux phrases) du résultat ; il sera montré dans \
         l'historique des automatisations.",
        a.nom,
        a.horaire.texte().to_lowercase()
    )
}

fn nom_conversation(a: &Automatisation, maintenant_ms: i64) -> String {
    if a.meme_conversation {
        format!("{} (automatisation)", a.nom)
    } else {
        format!("{} ({})", a.nom, maintenant_local(maintenant_ms).format("%d/%m %H:%M"))
    }
}

pub(crate) fn occupee(d: &Daemon, session_id: &str) -> bool {
    lock(&d.sessions)
        .get(session_id)
        .is_some_and(|s| s.cancel.is_some() || s.meta.status == SessionStatus::Running)
}

/// Nouvelle conversation avec le prompt, ou la même reprise (si elle existe encore).
fn conversation(d: &Arc<Daemon>, a: &Automatisation, maintenant_ms: i64) -> SessionResult<Ouverture> {
    if a.meme_conversation {
        if let Some(id) = a.session_id.as_deref() {
            d.wake_archived(id);
            if let Ok(meta) = d.meta(id) {
                if occupee(d, id) {
                    return Ok(Ouverture::Occupee(id.to_string()));
                }
                if meta.model != a.modele {
                    let _ = d.set_model(id, a.modele.clone());
                }
                let entree = d.send_user(id, ChatMessage::user_text(a.prompt.clone()))?;
                return Ok(Ouverture::Lancee { session_id: id.to_string(), depuis: Some(entree).filter(|e| !e.is_empty()) });
            }
        }
    }
    let meta = d.create(CreateSessionRequest {
        name: nom_conversation(a, maintenant_ms),
        workspace_id: a.dossier.clone(),
        model: a.modele.clone(),
        parent_id: None,
        system_prompt_extra: Some(consigne(a)),
        initial_message: Some(a.prompt.clone()),
    })?;
    Ok(Ouverture::Lancee { session_id: meta.id, depuis: None })
}

fn ouvrir(d: &Arc<Daemon>, auto: &Automatisation, exec_id: &str, maintenant_ms: i64) {
    match conversation(d, auto, maintenant_ms) {
        Ok(Ouverture::Lancee { session_id, depuis }) => {
            maj(d, &auto.id, exec_id, |a, x| {
                x.statut = Statut::EnCours;
                x.session_id = Some(session_id.clone());
                x.depuis = depuis;
                if a.meme_conversation {
                    a.session_id = Some(session_id);
                }
            });
        }
        Ok(Ouverture::Occupee(session_id)) => terminer(
            d,
            &auto.id,
            exec_id,
            Statut::Sautee,
            "La conversation de l'automatisation était occupée.".into(),
            Some(session_id),
            maintenant_ms,
        ),
        Err(err) => terminer(
            d,
            &auto.id,
            exec_id,
            Statut::Echouee,
            format!("Lancement impossible : {}", message(&err)),
            None,
            maintenant_ms,
        ),
    }
}


/// Modifie une exécution (et son automatisation) sous le verrou, enregistre, signale.
fn maj(
    d: &Daemon,
    auto_id: &str,
    exec_id: &str,
    f: impl FnOnce(&mut Automatisation, &mut Execution),
) -> Option<(Automatisation, Execution)> {
    let sortie = {
        let etat = etat(d);
        let mut e = lock(&etat);
        let a = e.liste.iter_mut().find(|a| a.id == auto_id)?;
        let i = a.historique.iter().position(|x| x.id == exec_id)?;
        let mut x = a.historique[i].clone();
        f(a, &mut x);
        a.historique[i] = x.clone();
        let copie = a.clone();
        e.enregistrer();
        (copie, x)
    };
    signaler(d);
    Some(sortie)
}

/// Clôt une exécution (statut, résumé) et prévient les écrans (`fin`).
pub(crate) fn terminer(
    d: &Daemon,
    auto_id: &str,
    exec_id: &str,
    statut: Statut,
    resume: String,
    session_id: Option<String>,
    maintenant_ms: i64,
) {
    let fini = maj(d, auto_id, exec_id, |_, x| {
        x.statut = statut;
        x.fin_ms = Some(maintenant_ms);
        x.resume = Some(resume);
        if session_id.is_some() {
            x.session_id = session_id;
        }
    });
    if let Some((a, x)) = fini {
        d.broadcast(
            "automatisations",
            None,
            json!({"type": "fin", "automatisation": {"id": a.id, "nom": a.nom, "dossier": a.dossier}, "execution": x}),
        );
    }
}

/// Résumé sur une ligne, `max` caractères au plus.
pub(crate) fn couper(texte: &str, max: usize) -> String {
    let une_ligne = texte.split_whitespace().collect::<Vec<_>>().join(" ");
    if une_ligne.chars().count() <= max {
        return une_ligne;
    }
    let mut court: String = une_ligne.chars().take(max.saturating_sub(1)).collect();
    court = court.trim_end().to_string();
    court.push('…');
    court
}

fn texte_de(m: &ChatMessage) -> String {
    m.parts
        .iter()
        .filter_map(|p| match p {
            Part::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Bilan d'un tour fini, lu dans le journal à partir du prompt de l'exécution :
/// erreur du tour, arrêt forcé, ou dernière réponse de l'agent (le résumé).
pub(crate) fn bilan(d: &Daemon, session_id: &str, depuis: Option<&str>) -> (Statut, String) {
    let Ok(journal) = d.journal(session_id) else {
        return (Statut::Echouee, "Conversation introuvable (supprimée ou archivée).".into());
    };
    let j = lock(&journal);
    let chemin = j.path_to_leaf();
    let debut = depuis.and_then(|id| chemin.iter().position(|e| e.id == id)).map_or(0, |i| i + 1);
    let mut erreur: Option<String> = None;
    let mut arretee = false;
    let mut derniere: Option<&ChatMessage> = None;
    for e in &chemin[debut.min(chemin.len())..] {
        match &e.kind {
            JournalEntryKind::Extension { name, payload } if name == "turn_error" => {
                let texte = payload.get("error").and_then(Value::as_str).unwrap_or("erreur inconnue");
                erreur = Some(texte.to_string());
            }
            JournalEntryKind::Extension { name, .. } if name == "turn_stopped" => arretee = true,
            JournalEntryKind::Message { message, .. } => derniere = Some(message),
            _ => {}
        }
    }
    if let Some(err) = erreur {
        return (Statut::Echouee, couper(&err, RESUME_MAX));
    }
    if arretee {
        return (Statut::Arretee, "Arrêtée avant la fin.".into());
    }
    match derniere {
        Some(m) if m.role == Role::Assistant && !m.parts.iter().any(|p| matches!(p, Part::ToolCall { .. })) => {
            let texte = texte_de(m);
            if texte.trim().is_empty() {
                (Statut::Reussie, "Terminée, sans message final.".into())
            } else {
                (Statut::Reussie, couper(&texte, RESUME_MAX))
            }
        }
        _ => (Statut::Echouee, "Interrompue avant la fin (service arrêté ou tour coupé).".into()),
    }
}

/// Exécutions dont la conversation a fini son tour : bilan, puis `fin`.
pub(crate) fn suivre(d: &Arc<Daemon>, maintenant_ms: i64) {
    let en_cours: Vec<(String, String, String, Option<String>, bool)> = {
        let etat = etat(d);
        let e = lock(&etat);
        e.liste
            .iter()
            .flat_map(|a| {
                a.historique.iter().filter(|x| x.statut == Statut::EnCours).filter_map(|x| {
                    let session = x.session_id.clone()?;
                    Some((a.id.clone(), x.id.clone(), session, x.depuis.clone(), x.arret_demande))
                })
            })
            .collect()
    };
    for (auto_id, exec_id, session_id, depuis, arret_demande) in en_cours {
        if occupee(d, &session_id) {
            continue;
        }
        let (statut, resume) = if arret_demande {
            (Statut::Arretee, "Arrêtée depuis l'écran des automatisations.".to_string())
        } else {
            bilan(d, &session_id, depuis.as_deref())
        };
        terminer(d, &auto_id, &exec_id, statut, resume, None, maintenant_ms);
    }
}

/// Arrête l'exécution en cours (pendant la vérification ou dans sa conversation).
pub(crate) fn arreter(d: &Daemon, auto_id: &str) -> SessionResult<()> {
    let (exec_id, statut, session_id) = {
        let etat = etat(d);
        let mut e = lock(&etat);
        let a = e.trouver(auto_id)?;
        let Some(x) = a.historique.iter_mut().find(|x| x.statut.en_cours()) else {
            return Err(SessionError::Protocol("Aucune exécution en cours.".into()));
        };
        x.arret_demande = true;
        let cible = (x.id.clone(), x.statut, x.session_id.clone());
        e.enregistrer();
        cible
    };
    match (statut, session_id) {
        (Statut::EnCours, Some(session_id)) => {
            // Le suivi la note « arrêtée » quand le tour s'est arrêté.
            let _ = d.stop(&session_id);
        }
        _ => terminer(d, auto_id, &exec_id, Statut::Arretee, "Arrêtée avant le lancement.".into(), None, crate::util::now_ms()),
    }
    Ok(())
}

/// Au démarrage du service : une vérification ou un lancement coupés par l'arrêt
/// du service sont notés en échec ; les exécutions déjà dans leur conversation
/// sont suivies normalement (bilan au premier passage).
pub(crate) fn reprendre(d: &Arc<Daemon>, maintenant_ms: i64) {
    let orphelines: Vec<(String, String)> = {
        let etat = etat(d);
        let e = lock(&etat);
        e.liste
            .iter()
            .flat_map(|a| {
                a.historique
                    .iter()
                    .filter(|x| x.statut == Statut::Verification || (x.statut == Statut::EnCours && x.session_id.is_none()))
                    .map(|x| (a.id.clone(), x.id.clone()))
            })
            .collect()
    };
    for (auto_id, exec_id) in orphelines {
        terminer(
            d,
            &auto_id,
            &exec_id,
            Statut::Echouee,
            "Interrompue : le service s'est arrêté pendant le lancement.".into(),
            None,
            maintenant_ms,
        );
    }
}

