//! Conversations endormies : délai réglable (`<données>/sommeil.json`,
//! RPC sommeil.get / sommeil.set). « Jamais » garde les conversations éveillées ; les
//! sous-agents finis gardent leur propre délai.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use axecode_core::{
    ChatMessage, CreateSessionRequest, JournalEntryKind, ModelRef, RuntimeContext, SessionResult,
    SessionRuntime, SessionRuntimeFactory, SessionStatus, TurnOutcome, TurnRequest, TurnSink,
};
use axecode_daemon::{sommeil, Daemon, DaemonConfig};
use serde_json::json;

struct Rt {
    id: String,
    arretes: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl SessionRuntime for Rt {
    async fn run_turn(&self, request: TurnRequest, sink: Arc<dyn TurnSink>) -> SessionResult<TurnOutcome> {
        sink.record(JournalEntryKind::Message {
            message: ChatMessage::assistant_text("fini"),
            usage: None,
            turn_id: Some(request.turn_id),
        })
        .await?;
        Ok(TurnOutcome::default())
    }

    async fn shutdown(&self) {
        self.arretes.lock().unwrap().push(self.id.clone());
    }
}

struct Fabrique {
    arretes: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl SessionRuntimeFactory for Fabrique {
    async fn create(&self, context: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(Arc::new(Rt { id: context.session.id, arretes: self.arretes.clone() }))
    }
}

struct Banc {
    dossier: std::path::PathBuf,
    daemon: Arc<Daemon>,
    arretes: Arc<Mutex<Vec<String>>>,
}

impl Drop for Banc {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dossier);
    }
}

fn banc(delais: Duration) -> Banc {
    let dossier = std::env::temp_dir().join(format!("axecode-sommeil-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dossier).unwrap();
    let mut config = DaemonConfig::new(dossier.join("data"));
    config.auto_shutdown = false;
    config.idle_unload = delais;
    config.subagent_idle_unload = delais;
    let arretes = Arc::new(Mutex::new(Vec::new()));
    let daemon = Daemon::new(config, Arc::new(Fabrique { arretes: arretes.clone() }));
    Banc { dossier, daemon, arretes }
}

fn creer(d: &Daemon, nom: &str, parent: Option<&str>) -> String {
    d.create(CreateSessionRequest {
        name: nom.into(),
        workspace_id: "ws".into(),
        model: ModelRef::new("x", "y"),
        parent_id: parent.map(str::to_string),
        system_prompt_extra: None,
        initial_message: None,
    })
    .unwrap()
    .id
}

async fn attendre_repos(d: &Daemon, id: &str) {
    for _ in 0..250 {
        let meta = d.meta(id).unwrap();
        if meta.status == SessionStatus::Idle && meta.entry_count >= 3 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("la session {id} n'a pas fini son tour");
}

#[test]
fn delai_lu_dans_sommeil_json() {
    let dossier = std::env::temp_dir().join(format!("axecode-sommeil-delai-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dossier).unwrap();
    let defaut = Duration::from_secs(30 * 60);
    assert_eq!(sommeil::delai(&dossier, defaut), Some(defaut), "sans réglage : délai du service");
    std::fs::write(dossier.join("sommeil.json"), r#"{"conversationsMinutes": 5}"#).unwrap();
    assert_eq!(sommeil::delai(&dossier, defaut), Some(Duration::from_secs(300)));
    std::fs::write(dossier.join("sommeil.json"), r#"{"conversationsMinutes": 0}"#).unwrap();
    assert_eq!(sommeil::delai(&dossier, defaut), None, "0 : jamais");
    std::fs::write(dossier.join("sommeil.json"), "abîmé").unwrap();
    assert_eq!(sommeil::delai(&dossier, defaut), Some(defaut), "fichier illisible : délai du service");
    let _ = std::fs::remove_dir_all(dossier);
}

/// « Jamais » : la conversation garde son noyau ; le sous-agent fini s'endort quand même.
#[tokio::test(flavor = "multi_thread")]
async fn jamais_garde_les_conversations_eveillees() {
    let b = banc(Duration::from_millis(100));
    let d = &b.daemon;
    let r = d.dispatch(0, "sommeil.set", json!({"conversationsMinutes": 0})).await.unwrap();
    assert_eq!(r["conversationsMinutes"], 0);
    let parent = creer(d, "parent", None);
    let enfant = creer(d, "enfant", Some(&parent));
    d.send_user(&parent, ChatMessage::user_text("bonjour")).unwrap();
    d.send_user(&enfant, ChatMessage::user_text("tâche")).unwrap();
    attendre_repos(d, &parent).await;
    attendre_repos(d, &enfant).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    d.housekeeping().await;
    assert_eq!(*b.arretes.lock().unwrap(), vec![enfant.clone()]);
    assert_eq!(d.meta(&parent).unwrap().status, SessionStatus::Idle);
    assert_eq!(d.meta(&enfant).unwrap().status, SessionStatus::Inactive);

    // Retour au délai du service : la conversation s'endort au passage suivant.
    let r = d.dispatch(0, "sommeil.set", json!({"conversationsMinutes": null})).await.unwrap();
    assert!(r["conversationsMinutes"].is_null());
    assert_eq!(r["defautMinutes"], 0, "délai du service de ce banc : 100 ms");
    d.housekeeping().await;
    assert_eq!(d.meta(&parent).unwrap().status, SessionStatus::Inactive);
    // Endormie, elle repart au message suivant (nouveau noyau).
    d.send_user(&parent, ChatMessage::user_text("encore")).unwrap();
    for _ in 0..250 {
        if d.meta(&parent).unwrap().entry_count >= 5 && d.meta(&parent).unwrap().status == SessionStatus::Idle {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(d.meta(&parent).unwrap().status, SessionStatus::Idle);
}

#[tokio::test(flavor = "multi_thread")]
async fn rpc_borne_et_refuse_les_valeurs_invalides() {
    let b = banc(Duration::from_secs(1800));
    let d = &b.daemon;
    let r = d.dispatch(0, "sommeil.get", json!({})).await.unwrap();
    assert!(r["conversationsMinutes"].is_null());
    assert_eq!(r["defautMinutes"], 30);
    let r = d.dispatch(0, "sommeil.set", json!({"conversationsMinutes": 99_999_999})).await.unwrap();
    assert_eq!(r["conversationsMinutes"], 7 * 24 * 60, "une semaine au plus");
    assert!(d.dispatch(0, "sommeil.set", json!({"conversationsMinutes": "dix"})).await.is_err());
    assert!(d.dispatch(0, "sommeil.inconnu", json!({})).await.is_err());
}
