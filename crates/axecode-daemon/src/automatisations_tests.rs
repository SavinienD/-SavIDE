//! automatisations — tests du planificateur avec une horloge simulée : les
//! passages (`tic`) reçoivent l'heure, rien n'attend l'heure réelle.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use axecode_core::{
    ChatMessage, JournalEntryKind, RuntimeContext, SessionError, SessionResult, SessionRuntime, SessionRuntimeFactory,
    TurnOutcome, TurnRequest, TurnSink,
};
use chrono::{Local, TimeZone};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::*;
use crate::daemon::Daemon;

struct Banc {
    d: Arc<Daemon>,
    dossier: PathBuf,
    racine: PathBuf,
    #[allow(dead_code)]
    rx: mpsc::UnboundedReceiver<String>,
}

impl Drop for Banc {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.racine);
    }
}

fn banc(factory: Arc<dyn SessionRuntimeFactory>) -> Banc {
    let racine = std::env::temp_dir().join(format!("axe-auto-{}", uuid::Uuid::new_v4()));
    let dossier = racine.join("projet");
    std::fs::create_dir_all(&dossier).unwrap();
    std::fs::create_dir_all(racine.join("donnees")).unwrap();
    let mut config = crate::DaemonConfig::new(racine.join("donnees"));
    config.auto_shutdown = false;
    let d = Daemon::new(config, factory);
    let (tx, rx) = mpsc::unbounded_channel();
    let client = d.add_client("test".into(), tx);
    d.attach(client, "*", true);
    Banc { d, dossier, racine, rx }
}

/// Horloge simulée : novembre 2026, heure locale du poste.
fn heure(jour: u32, h: u32, m: u32, s: u32) -> i64 {
    Local.with_ymd_and_hms(2026, 11, jour, h, m, s).single().unwrap().timestamp_millis()
}

fn params(b: &Banc, horaire: Value) -> Value {
    json!({
        "nom": "Rapport du matin",
        "dossier": b.dossier.display().to_string(),
        "prompt": "Fais le point.",
        "modele": "test/echo",
        "horaire": horaire,
    })
}

fn auto(b: &Banc, id: &str) -> Automatisation {
    let e = etat(&b.d);
    let e = lock(&e);
    e.liste.iter().find(|a| a.id == id).cloned().unwrap()
}

fn sessions(b: &Banc) -> usize {
    b.d.list_metas().len()
}

async fn attendre_fin(d: &Arc<Daemon>, session_id: &str) {
    for _ in 0..400 {
        if !execution::occupee(d, session_id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("le tour de {session_id} ne finit pas");
}

/// Agent qui travaille jusqu'à ce qu'on le libère (ou qu'on l'arrête).
struct Lent(Arc<AtomicBool>);

#[async_trait]
impl SessionRuntime for Lent {
    async fn run_turn(&self, request: TurnRequest, sink: Arc<dyn TurnSink>) -> SessionResult<TurnOutcome> {
        while !self.0.load(Ordering::SeqCst) {
            if sink.is_cancelled() {
                return Err(SessionError::Cancelled);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        sink.record(JournalEntryKind::Message {
            message: ChatMessage::assistant_text("Fini."),
            usage: None,
            turn_id: Some(request.turn_id),
        })
        .await?;
        Ok(TurnOutcome { final_text: "Fini.".into(), ..Default::default() })
    }
}

struct LentFactory(Arc<AtomicBool>);

#[async_trait]
impl SessionRuntimeFactory for LentFactory {
    async fn create(&self, _: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(Arc::new(Lent(self.0.clone())))
    }
}

/// Agent dont chaque tour échoue (fournisseur non configuré).
struct Panne;

#[async_trait]
impl SessionRuntime for Panne {
    async fn run_turn(&self, _: TurnRequest, _: Arc<dyn TurnSink>) -> SessionResult<TurnOutcome> {
        Err(SessionError::Runtime("fournisseur absent".into()))
    }
}

struct PanneFactory;

#[async_trait]
impl SessionRuntimeFactory for PanneFactory {
    async fn create(&self, _: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(Arc::new(Panne))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lancee_a_l_heure_avec_le_bilan_dans_l_historique() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let a = creer(&b.d, &params(&b, json!({"type": "quotidien", "heure": "08:00"})), heure(9, 7, 0, 0)).unwrap();
    assert_eq!(a.prochaine_ms, Some(heure(9, 8, 0, 0)));
    tic(&b.d, heure(9, 7, 59, 0));
    assert!(auto(&b, &a.id).historique.is_empty());
    tic(&b.d, heure(9, 8, 0, 5));
    let x = auto(&b, &a.id).historique[0].clone();
    assert_eq!(x.declencheur, Declencheur::Horaire);
    assert_eq!(x.prevue_ms, Some(heure(9, 8, 0, 0)));
    let session = x.session_id.clone().expect("conversation créée");
    let meta = b.d.meta(&session).unwrap();
    assert_eq!(meta.workspace_id, b.dossier.display().to_string());
    assert!(meta.name.starts_with("Rapport du matin ("), "{}", meta.name);
    assert!(meta.system_prompt_extra.unwrap_or_default().contains("sans personne devant l'écran"));
    attendre_fin(&b.d, &session).await;
    tic(&b.d, heure(9, 8, 0, 15));
    let a2 = auto(&b, &a.id);
    let x = &a2.historique[0];
    assert_eq!(x.statut, Statut::Reussie);
    assert_eq!(x.resume.as_deref(), Some("echo: Fais le point."));
    assert_eq!(x.fin_ms, Some(heure(9, 8, 0, 15)));
    assert_eq!(a2.prochaine_ms, Some(heure(10, 8, 0, 0)));
    // Stockage local relu à l'identique.
    let relu = Etat::charger(b.d.config.data_dir.join("automatisations.json"));
    assert_eq!(relu.liste, vec![a2]);
}


#[tokio::test(flavor = "multi_thread")]
async fn jamais_deux_executions_simultanees() {
    let liberer = Arc::new(AtomicBool::new(false));
    let b = banc(Arc::new(LentFactory(liberer.clone())));
    let a = creer(&b.d, &params(&b, json!({"type": "intervalle", "heures": 1})), heure(9, 7, 30, 0)).unwrap();
    tic(&b.d, heure(9, 8, 0, 1));
    let session = auto(&b, &a.id).historique[0].session_id.clone().unwrap();
    // « Lancer maintenant » refusé pendant l'exécution.
    let err = execution::lancer(&b.d, &a.id, Declencheur::Manuel, None, 0, heure(9, 8, 10, 0)).unwrap_err();
    assert!(message(&err).contains("déjà en cours"), "{err}");
    // Les créneaux de 9 h et 10 h tombent pendant l'exécution : sautés, sur une seule ligne.
    tic(&b.d, heure(9, 9, 0, 1));
    tic(&b.d, heure(9, 10, 0, 1));
    let h = auto(&b, &a.id).historique;
    assert_eq!(h.len(), 2);
    assert_eq!(h[0].statut, Statut::Sautee);
    assert_eq!(h[0].manquees, 2);
    assert!(h[0].resume.as_deref().unwrap().contains("2 créneaux"));
    assert_eq!(h[1].statut, Statut::EnCours);
    assert_eq!(sessions(&b), 1);
    liberer.store(true, Ordering::SeqCst);
    attendre_fin(&b.d, &session).await;
    tic(&b.d, heure(9, 10, 0, 20));
    assert_eq!(auto(&b, &a.id).historique[1].statut, Statut::Reussie);
    // De nouveau libre : « Lancer maintenant » part.
    let x = execution::lancer(&b.d, &a.id, Declencheur::Manuel, None, 0, heure(9, 10, 1, 0)).unwrap();
    assert_eq!(x.statut, Statut::EnCours);
    assert_eq!(sessions(&b), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn apres_une_veille_une_seule_execution_rattrapee() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let a = creer(&b.d, &params(&b, json!({"type": "quotidien", "heure": "08:00"})), heure(9, 7, 0, 0)).unwrap();
    // PC en veille du 9 à 7 h au 11 à 10 h 30 : 3 créneaux manqués (9, 10 et 11 à 8 h).
    tic(&b.d, heure(11, 10, 30, 0));
    let a2 = auto(&b, &a.id);
    assert_eq!(a2.historique.len(), 1);
    let x = &a2.historique[0];
    assert_eq!(x.declencheur, Declencheur::Rattrapage);
    assert_eq!(x.manquees, 3);
    assert_eq!(x.prevue_ms, Some(heure(9, 8, 0, 0)));
    assert_eq!(a2.prochaine_ms, Some(heure(12, 8, 0, 0)));
    attendre_fin(&b.d, x.session_id.as_deref().unwrap()).await;
    tic(&b.d, heure(11, 10, 30, 10));
    tic(&b.d, heure(11, 10, 30, 20));
    assert_eq!(auto(&b, &a.id).historique.len(), 1);
    assert_eq!(auto(&b, &a.id).historique[0].statut, Statut::Reussie);
    assert_eq!(sessions(&b), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn sans_rattrapage_la_veille_est_notee_manquee() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let mut p = params(&b, json!({"type": "quotidien", "heure": "08:00"}));
    p["rattrapage"] = json!(false);
    let a = creer(&b.d, &p, heure(9, 7, 0, 0)).unwrap();
    tic(&b.d, heure(11, 10, 30, 0));
    let a2 = auto(&b, &a.id);
    assert_eq!(a2.historique.len(), 1);
    assert_eq!(a2.historique[0].statut, Statut::Manquee);
    assert_eq!(a2.historique[0].manquees, 3);
    assert_eq!(sessions(&b), 0);
    // Moins de 5 min de retard n'est pas une veille : lancée normalement.
    tic(&b.d, heure(12, 8, 3, 0));
    assert_eq!(auto(&b, &a.id).historique[0].declencheur, Declencheur::Horaire);
    assert_eq!(sessions(&b), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn en_pause_rien_ne_part_et_la_reprise_ne_rattrape_pas() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    // 08/11/2026 = dimanche : prochaine exécution le lundi 9 à 8 h.
    let p = params(&b, json!({"type": "hebdomadaire", "jours": [1], "heure": "08:00"}));
    let a = creer(&b.d, &p, heure(8, 12, 0, 0)).unwrap();
    assert_eq!(a.prochaine_ms, Some(heure(9, 8, 0, 0)));
    assert!(retient_le_service(&b.d));
    let pause = modifier(&b.d, &a.id, &json!({"active": false}), heure(8, 12, 1, 0)).unwrap();
    assert_eq!(pause.prochaine_ms, None);
    assert!(!retient_le_service(&b.d));
    tic(&b.d, heure(9, 8, 0, 5));
    assert!(auto(&b, &a.id).historique.is_empty());
    let reprise = modifier(&b.d, &a.id, &json!({"active": true}), heure(10, 9, 0, 0)).unwrap();
    assert_eq!(reprise.prochaine_ms, Some(heure(16, 8, 0, 0)));
    tic(&b.d, heure(10, 9, 0, 5));
    assert!(auto(&b, &a.id).historique.is_empty());
    assert_eq!(sessions(&b), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn la_meme_conversation_est_reprise_avec_son_propre_bilan() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let mut p = params(&b, json!({"type": "quotidien", "heure": "08:00"}));
    p["memeConversation"] = json!(true);
    let a = creer(&b.d, &p, heure(9, 7, 0, 0)).unwrap();
    tic(&b.d, heure(9, 8, 0, 1));
    let s1 = auto(&b, &a.id).historique[0].session_id.clone().unwrap();
    attendre_fin(&b.d, &s1).await;
    tic(&b.d, heure(9, 8, 0, 10));
    modifier(&b.d, &a.id, &json!({"prompt": "Et maintenant ?"}), heure(9, 9, 0, 0)).unwrap();
    tic(&b.d, heure(10, 8, 0, 1));
    let a2 = auto(&b, &a.id);
    let s2 = a2.historique[0].session_id.clone().unwrap();
    assert_eq!(s2, s1);
    assert_eq!(a2.session_id.as_deref(), Some(s1.as_str()));
    attendre_fin(&b.d, &s2).await;
    tic(&b.d, heure(10, 8, 0, 10));
    let a3 = auto(&b, &a.id);
    assert_eq!(a3.historique[0].resume.as_deref(), Some("echo: Et maintenant ?"));
    assert_eq!(a3.historique[1].resume.as_deref(), Some("echo: Fais le point."));
    assert_eq!(sessions(&b), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn une_erreur_du_tour_est_notee_echouee() {
    let b = banc(Arc::new(PanneFactory));
    let a = creer(&b.d, &params(&b, json!({"type": "quotidien", "heure": "08:00"})), heure(9, 7, 0, 0)).unwrap();
    let x = execution::lancer(&b.d, &a.id, Declencheur::Manuel, None, 0, heure(9, 7, 1, 0)).unwrap();
    attendre_fin(&b.d, x.session_id.as_deref().unwrap()).await;
    tic(&b.d, heure(9, 7, 2, 0));
    let h = &auto(&b, &a.id).historique[0];
    assert_eq!(h.statut, Statut::Echouee);
    assert!(h.resume.as_deref().unwrap().contains("fournisseur absent"), "{:?}", h.resume);
}

#[tokio::test(flavor = "multi_thread")]
async fn arreter_une_execution_en_cours() {
    let b = banc(Arc::new(LentFactory(Arc::new(AtomicBool::new(false)))));
    let a = creer(&b.d, &params(&b, json!({"type": "quotidien", "heure": "08:00"})), heure(9, 7, 0, 0)).unwrap();
    let x = execution::lancer(&b.d, &a.id, Declencheur::Manuel, None, 0, heure(9, 7, 1, 0)).unwrap();
    dispatch(&b.d, "automatisations.arreter", &json!({"id": a.id})).unwrap();
    attendre_fin(&b.d, x.session_id.as_deref().unwrap()).await;
    tic(&b.d, heure(9, 7, 2, 0));
    assert_eq!(auto(&b, &a.id).historique[0].statut, Statut::Arretee);
    assert!(dispatch(&b.d, "automatisations.arreter", &json!({"id": a.id})).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn un_lancement_coupe_par_un_arret_du_service_est_note_au_demarrage() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let a = creer(&b.d, &params(&b, json!({"type": "quotidien", "heure": "08:00"})), heure(9, 7, 0, 0)).unwrap();
    {
        let e = etat(&b.d);
        let mut e = lock(&e);
        e.trouver(&a.id).unwrap().noter(Execution {
            id: "x1".into(),
            declencheur: Declencheur::Horaire,
            prevue_ms: Some(heure(9, 8, 0, 0)),
            debut_ms: heure(9, 8, 0, 0),
            fin_ms: None,
            statut: Statut::EnCours,
            session_id: None,
            depuis: None,
            resume: None,
            manquees: 0,
            arret_demande: false,
        });
    }
    execution::reprendre(&b.d, heure(9, 9, 0, 0));
    let h = &auto(&b, &a.id).historique[0];
    assert_eq!(h.statut, Statut::Echouee);
    assert!(h.resume.as_deref().unwrap().starts_with("Interrompue"));
}


#[tokio::test(flavor = "multi_thread")]
async fn creation_refusee_avec_un_message_clair() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let refus = |p: Value| message(&creer(&b.d, &p, heure(9, 7, 0, 0)).unwrap_err());
    let base = || params(&b, json!({"type": "quotidien", "heure": "08:00"}));
    let mut p = base();
    p["nom"] = json!("  ");
    assert_eq!(refus(p), "Donnez un nom à l'automatisation.");
    let mut p = base();
    p["dossier"] = json!(b.racine.join("absent").display().to_string());
    assert!(refus(p).starts_with("Dossier introuvable"));
    let mut p = base();
    p["horaire"] = json!({"type": "cron", "expression": "0 8 * *"});
    assert!(refus(p).contains("5 champs"));
    let mut p = base();
    p["modele"] = json!("sans-barre");
    assert!(refus(p).starts_with("Modèle invalide"));
    let mut p = base();
    p.as_object_mut().unwrap().remove("horaire");
    assert_eq!(refus(p), "Choisissez un horaire.");
    let mut p = base();
    p["prompt"] = json!(" ");
    assert_eq!(refus(p), "Écrivez le prompt à envoyer.");
    // Aperçu de l'horaire (écran de création) : en clair et les 3 prochaines fois.
    let apercu = dispatch(&b.d, "automatisations.apercu", &json!({"horaire": {"type": "quotidien", "heure": "08:00"}})).unwrap();
    assert_eq!(apercu["texte"], json!("Tous les jours à 8 h"));
    assert_eq!(apercu["prochaines"].as_array().unwrap().len(), 3);
    let faux = dispatch(&b.d, "automatisations.apercu", &json!({"horaire": {"type": "cron", "expression": "x"}}));
    assert!(message(&faux.unwrap_err()).contains("5 champs"));
}

#[tokio::test(flavor = "multi_thread")]
async fn lister_historique_supprimer() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let a = creer(&b.d, &params(&b, json!({"type": "quotidien", "heure": "08:00"})), heure(9, 7, 0, 0)).unwrap();
    let x = execution::lancer(&b.d, &a.id, Declencheur::Manuel, None, 0, heure(9, 7, 1, 0)).unwrap();
    attendre_fin(&b.d, x.session_id.as_deref().unwrap()).await;
    tic(&b.d, heure(9, 7, 2, 0));
    let liste = dispatch(&b.d, "automatisations.lister", &json!({})).unwrap();
    let v = &liste["automatisations"][0];
    assert_eq!(v["horaireTexte"], json!("Tous les jours à 8 h"));
    assert_eq!(v["enCours"], json!(false));
    assert_eq!(v["memeConversation"], json!(false));
    assert_eq!(v["prochaineMs"], json!(heure(9, 8, 0, 0)));
    assert_eq!(v["modele"], json!({"provider": "test", "name": "echo"}));
    assert_eq!(v["historique"][0]["statut"], json!("reussie"));
    assert_eq!(v["historique"][0]["declencheur"], json!("manuel"));
    let h = dispatch(&b.d, "automatisations.historique", &json!({"limite": 5})).unwrap();
    assert_eq!(h[0]["nom"], json!("Rapport du matin"));
    assert_eq!(h[0]["automatisationId"], json!(a.id));
    let modif = dispatch(&b.d, "automatisations.modifier", &json!({"id": a.id, "nom": "Point du soir", "horaire": {"type": "quotidien", "heure": "18:30"}})).unwrap();
    assert_eq!(modif["horaireTexte"], json!("Tous les jours à 18 h 30"));
    dispatch(&b.d, "automatisations.supprimer", &json!({"id": a.id})).unwrap();
    assert_eq!(dispatch(&b.d, "automatisations.lister", &json!({})).unwrap()["automatisations"], json!([]));
    assert!(dispatch(&b.d, "automatisations.supprimer", &json!({"id": a.id})).is_err());
}


async fn attendre_statut(b: &Banc, id: &str, fini: impl Fn(Statut) -> bool) -> Execution {
    for _ in 0..400 {
        if let Some(x) = auto(b, id).historique.first() {
            if fini(x.statut) {
                return x.clone();
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("statut attendu jamais atteint : {:?}", auto(b, id).historique.first());
}

#[tokio::test(flavor = "multi_thread")]
async fn la_verification_avant_lancement_saute_ou_lance() {
    let b = banc(Arc::new(crate::stub::EchoFactory));
    let mut p = params(&b, json!({"type": "quotidien", "heure": "08:00"}));
    p["verification"] = json!("echo rien de neuf; exit 3");
    let a = creer(&b.d, &p, heure(9, 7, 0, 0)).unwrap();
    tic(&b.d, heure(9, 8, 0, 1));
    let x = attendre_statut(&b, &a.id, |s| !s.en_cours()).await;
    assert_eq!(x.statut, Statut::Sautee);
    assert_eq!(x.resume.as_deref(), Some("Vérification en échec (code 3) — rien de neuf"));
    assert_eq!(sessions(&b), 0);
    // La commande réussit (lancée dans le dossier) : la conversation part.
    modifier(&b.d, &a.id, &json!({"verification": "test -d ../projet"}), heure(9, 9, 0, 0)).unwrap();
    tic(&b.d, heure(10, 8, 0, 1));
    let x = attendre_statut(&b, &a.id, |s| s != Statut::Verification).await;
    assert_eq!(x.statut, Statut::EnCours);
    attendre_fin(&b.d, x.session_id.as_deref().expect("conversation créée")).await;
    tic(&b.d, heure(10, 8, 0, 20));
    assert_eq!(auto(&b, &a.id).historique[0].statut, Statut::Reussie);
    // « Lancer maintenant » ne vérifie pas.
    modifier(&b.d, &a.id, &json!({"verification": "exit 1"}), heure(10, 9, 0, 0)).unwrap();
    let x = execution::lancer(&b.d, &a.id, Declencheur::Manuel, None, 0, heure(10, 9, 1, 0)).unwrap();
    assert_eq!(x.statut, Statut::EnCours);
    assert!(x.session_id.is_some());
}

