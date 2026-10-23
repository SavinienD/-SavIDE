//! axe:menage — les sous-agents finis ne gardent pas leur noyau pour rien.
//!
//! Runtimes factices (comme `tests/daemon.rs`) : chaque runtime note l'arrêt
//! de sa session, comme un vrai runtime arrêterait son noyau Python.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use axecode_core::{
    ChatMessage, CreateSessionRequest, JournalEntryKind, ModelRef, RuntimeContext, SessionHost,
    SessionResult, SessionRuntime, SessionRuntimeFactory, SessionStatus, TurnOutcome, TurnRequest,
    TurnSink,
};
use axecode_daemon::{daemon, Daemon, DaemonConfig};
use serde_json::json;

/// Répond à chaque tour ; note l'arrêt de sa session.
struct Rt {
    id: String,
    stopped: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl SessionRuntime for Rt {
    async fn run_turn(
        &self,
        request: TurnRequest,
        sink: Arc<dyn TurnSink>,
    ) -> SessionResult<TurnOutcome> {
        sink.record(JournalEntryKind::Message {
            message: ChatMessage::assistant_text("fini"),
            usage: None,
            turn_id: Some(request.turn_id),
        })
        .await?;
        Ok(TurnOutcome::default())
    }

    async fn shutdown(&self) {
        self.stopped.lock().unwrap().push(self.id.clone());
    }
}

struct Factory {
    stopped: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl SessionRuntimeFactory for Factory {
    async fn create(&self, context: RuntimeContext) -> SessionResult<Arc<dyn SessionRuntime>> {
        Ok(Arc::new(Rt {
            id: context.session.id,
            stopped: self.stopped.clone(),
        }))
    }
}

struct Fixture {
    dir: std::path::PathBuf,
    daemon: Arc<Daemon>,
    stopped: Arc<Mutex<Vec<String>>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture(configure: impl FnOnce(&mut DaemonConfig)) -> Fixture {
    let dir = std::env::temp_dir().join(format!("axecode-menage-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = DaemonConfig::new(dir.join("data"));
    config.auto_shutdown = false;
    configure(&mut config);
    let stopped = Arc::new(Mutex::new(Vec::new()));
    let daemon = Daemon::new(
        config,
        Arc::new(Factory {
            stopped: stopped.clone(),
        }),
    );
    Fixture {
        dir,
        daemon,
        stopped,
    }
}

fn create(d: &Daemon, name: &str, parent: Option<&str>) -> String {
    d.create(CreateSessionRequest {
        name: name.into(),
        workspace_id: "ws".into(),
        model: ModelRef::new("x", "y"),
        parent_id: parent.map(str::to_string),
        system_prompt_extra: None,
        initial_message: None,
    })
    .unwrap()
    .id
}

/// Attend la fin du tour : la réponse est journalisée et la session est au repos.
async fn wait_idle(d: &Daemon, id: &str, entries: usize) {
    for _ in 0..250 {
        let meta = d.meta(id).unwrap();
        if meta.status == SessionStatus::Idle && meta.entry_count >= entries {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("la session {id} n'a pas fini son tour");
}

#[test]
fn delais_par_defaut() {
    let config = DaemonConfig::new(std::env::temp_dir().join("axecode-menage-defauts"));
    assert_eq!(config.idle_unload, Duration::from_secs(30 * 60));
    assert_eq!(config.subagent_idle_unload, Duration::from_secs(2 * 60));
    assert_eq!(config.subagent_idle_unload, daemon::DEFAULT_SUBAGENT_IDLE_UNLOAD);
}

/// Un sous-agent fini libère son noyau après son propre délai ; son parent,
/// au repos depuis aussi longtemps, garde le sien (délai de 30 min).
#[tokio::test(flavor = "multi_thread")]
async fn un_sous_agent_fini_libere_son_noyau_vite() {
    let f = fixture(|config| {
        config.idle_unload = Duration::from_secs(3600);
        config.subagent_idle_unload = Duration::from_millis(100);
    });
    let d = &f.daemon;
    let parent = create(d, "parent", None);
    let child = create(d, "enfant", Some(&parent));
    d.send_user(&parent, ChatMessage::user_text("bonjour")).unwrap();
    d.send_user(&child, ChatMessage::user_text("tache")).unwrap();
    wait_idle(d, &parent, 3).await;
    wait_idle(d, &child, 3).await;

    // Avant le délai : rien n'est déchargé.
    d.housekeeping().await;
    assert!(f.stopped.lock().unwrap().is_empty(), "déchargé trop tôt");
    assert_eq!(d.meta(&child).unwrap().status, SessionStatus::Idle);

    tokio::time::sleep(Duration::from_millis(250)).await;
    d.housekeeping().await;
    assert_eq!(*f.stopped.lock().unwrap(), vec![child.clone()]);
    assert_eq!(d.meta(&child).unwrap().status, SessionStatus::Inactive);
    assert_eq!(d.meta(&parent).unwrap().status, SessionStatus::Idle);

    // Le sous-agent déchargé repart normalement au message suivant.
    d.send_user(&child, ChatMessage::user_text("encore")).unwrap();
    wait_idle(d, &child, 5).await;
}

/// Les sessions sans parent gardent leur propre délai (`idle_unload`).
#[tokio::test(flavor = "multi_thread")]
async fn une_session_sans_parent_garde_son_delai() {
    let f = fixture(|config| {
        config.idle_unload = Duration::from_millis(100);
        config.subagent_idle_unload = Duration::from_secs(3600);
    });
    let d = &f.daemon;
    let parent = create(d, "parent", None);
    let child = create(d, "enfant", Some(&parent));
    d.send_user(&parent, ChatMessage::user_text("bonjour")).unwrap();
    d.send_user(&child, ChatMessage::user_text("tache")).unwrap();
    wait_idle(d, &parent, 3).await;
    wait_idle(d, &child, 3).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    d.housekeeping().await;
    assert_eq!(*f.stopped.lock().unwrap(), vec![parent.clone()]);
    assert_eq!(d.meta(&parent).unwrap().status, SessionStatus::Inactive);
    assert_eq!(d.meta(&child).unwrap().status, SessionStatus::Idle);
}

// ----- étape 2 : archivage automatique des sous-agents finis ----------------

fn archive_file(f: &Fixture, id: &str) -> std::path::PathBuf {
    axecode_daemon::journal::archive_path(&f.dir.join("data"), id)
}

/// Un sous-agent fini depuis plus de `subagent_archive_after` part dans
/// l'archive (noyau arrêté d'abord) ; son parent, sans parent lui-même, reste.
#[tokio::test(flavor = "multi_thread")]
async fn un_sous_agent_fini_part_dans_l_archive() {
    let f = fixture(|config| {
        config.subagent_idle_unload = Duration::from_millis(50);
        config.subagent_archive_after = Duration::from_millis(300);
        config.idle_unload = Duration::from_millis(50);
    });
    let d = &f.daemon;
    let parent = create(d, "parent", None);
    let child = create(d, "enfant", Some(&parent));
    d.send_user(&parent, ChatMessage::user_text("bonjour")).unwrap();
    d.send_user(&child, ChatMessage::user_text("tache")).unwrap();
    wait_idle(d, &parent, 3).await;
    wait_idle(d, &child, 3).await;

    // Déchargé (2e étape du ménage) mais pas encore archivé.
    tokio::time::sleep(Duration::from_millis(100)).await;
    d.housekeeping().await;
    assert_eq!(d.meta(&child).unwrap().status, SessionStatus::Inactive);
    assert!(!archive_file(&f, &child).exists(), "archivé trop tôt");

    tokio::time::sleep(Duration::from_millis(350)).await;
    d.housekeeping().await;
    assert!(d.meta(&child).is_err(), "le sous-agent est resté actif");
    assert!(archive_file(&f, &child).exists(), "pas de fichier d'archive");
    assert!(!d.list_metas().iter().any(|m| m.id == child));
    assert!(d.meta(&parent).unwrap().children.is_empty());
    // La session sans parent n'est jamais archivée d'office.
    assert!(d.meta(&parent).is_ok());
    assert!(!archive_file(&f, &parent).exists());
    // Le noyau du sous-agent a été arrêté une fois, avant l'archivage.
    let stopped = f.stopped.lock().unwrap().clone();
    assert_eq!(stopped.iter().filter(|id| **id == child).count(), 1);
}

/// Le parent ne voit pas l'archive : son sous-agent reste dans sa famille,
/// et un message (`rlm.follow_up` → `post_peer_message`) le rétablit d'abord.
#[tokio::test(flavor = "multi_thread")]
async fn le_parent_relance_un_sous_agent_archive_sans_le_voir() {
    let f = fixture(|config| {
        config.subagent_idle_unload = Duration::from_millis(10);
        config.subagent_archive_after = Duration::from_millis(10);
    });
    let d = &f.daemon;
    let parent = create(d, "parent", None);
    let child = create(d, "enfant", Some(&parent));
    d.send_user(&child, ChatMessage::user_text("tache")).unwrap();
    wait_idle(d, &child, 3).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    d.housekeeping().await;
    assert!(archive_file(&f, &child).exists(), "le sous-agent n'est pas archivé");

    // Vue des runtimes (FamilyHost) : le sous-agent est toujours là.
    let host: &dyn SessionHost = d.as_ref();
    let seen = host.list_sessions().await;
    let vu = seen.iter().find(|m| m.id == child).expect("sous-agent invisible pour le parent");
    assert_eq!(vu.parent_id.as_deref(), Some(parent.as_str()));
    assert_eq!(vu.name, "enfant");
    // La liste des clients (IDE), elle, ne le montre plus.
    assert!(!d.list_metas().iter().any(|m| m.id == child));

    // rlm.follow_up du parent : le message part, le sous-agent repart.
    host.post_peer_message(&parent, &child, "suite".into())
        .await
        .expect("message refusé pour un sous-agent archivé");
    assert!(!archive_file(&f, &child).exists(), "toujours dans l'archive");
    assert!(d.meta(&parent).unwrap().children.contains(&child));
    for _ in 0..250 {
        let journal = d.journal(&child).unwrap();
        let text = serde_json::to_string(journal.lock().unwrap().entries()).unwrap();
        if text.contains("suite") && text.matches("fini").count() >= 2 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("le sous-agent rétabli n'a pas traité le message");
}

/// `sessions.get` (et toute requête sur la session) rétablit un sous-agent
/// archivé ; une conversation archivée à la main sans parent reste archivée.
#[tokio::test(flavor = "multi_thread")]
async fn sessions_get_retablit_un_sous_agent_archive() {
    let f = fixture(|config| {
        config.subagent_idle_unload = Duration::from_millis(10);
        config.subagent_archive_after = Duration::from_millis(10);
    });
    let d = &f.daemon;
    let parent = create(d, "parent", None);
    let child = create(d, "enfant", Some(&parent));
    tokio::time::sleep(Duration::from_millis(50)).await;
    d.housekeeping().await;
    assert!(archive_file(&f, &child).exists());

    let meta = d
        .dispatch(0, "sessions.get", json!({"sessionId": child}))
        .await
        .expect("sessions.get refusé pour un sous-agent archivé");
    assert_eq!(meta["id"], child);
    assert_eq!(meta["parentId"], parent);
    assert!(d.meta(&child).is_ok());
    let history = d
        .dispatch(0, "sessions.history", json!({"sessionId": child}))
        .await
        .unwrap();
    assert!(history.is_array());

    // Une conversation sans parent archivée à la main n'est pas rétablie.
    d.archive(&parent).unwrap();
    assert!(d
        .dispatch(0, "sessions.get", json!({"sessionId": parent}))
        .await
        .is_err());
    assert!(archive_file(&f, &parent).exists());
}

/// Un sous-agent qui a encore un sous-agent actif attend que celui-ci parte.
#[tokio::test(flavor = "multi_thread")]
async fn les_enfants_partent_avant_leur_parent() {
    let f = fixture(|config| {
        config.subagent_idle_unload = Duration::from_millis(10);
        config.subagent_archive_after = Duration::from_millis(10);
    });
    let d = &f.daemon;
    let root = create(d, "racine", None);
    let child = create(d, "enfant", Some(&root));
    let grandchild = create(d, "petit-enfant", Some(&child));
    tokio::time::sleep(Duration::from_millis(50)).await;
    d.housekeeping().await;
    assert!(archive_file(&f, &grandchild).exists());
    assert!(!archive_file(&f, &child).exists(), "parti avant son sous-agent");
    d.housekeeping().await;
    assert!(archive_file(&f, &child).exists());
    assert!(d.meta(&root).is_ok());

    // Une requête sur le petit-enfant ramène d'abord son parent archivé :
    // les liens de la famille restent intacts.
    d.dispatch(0, "sessions.get", json!({"sessionId": grandchild}))
        .await
        .expect("petit-enfant archivé injoignable");
    assert_eq!(d.meta(&grandchild).unwrap().parent_id.as_deref(), Some(child.as_str()));
    assert_eq!(d.meta(&child).unwrap().children, vec![grandchild.clone()]);
    assert!(d.meta(&root).unwrap().children.contains(&child));
}

/// Après un redémarrage, les sous-agents archivés restent visibles des
/// runtimes, et un sous-agent fini avant l'arrêt n'attend pas une heure de plus.
#[tokio::test(flavor = "multi_thread")]
async fn apres_un_redemarrage() {
    let f = fixture(|config| {
        config.subagent_idle_unload = Duration::from_millis(10);
        config.subagent_archive_after = Duration::from_millis(300);
    });
    let d = &f.daemon;
    let parent = create(d, "parent", None);
    let old = create(d, "ancien", Some(&parent));
    let archived = create(d, "archive", Some(&parent));
    d.archive(&archived).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;

    let mut config = DaemonConfig::new(f.dir.join("data"));
    config.auto_shutdown = false;
    config.subagent_archive_after = Duration::from_millis(300);
    let d2 = Daemon::new(
        config,
        Arc::new(Factory {
            stopped: f.stopped.clone(),
        }),
    );
    let host: &dyn SessionHost = d2.as_ref();
    let seen = host.list_sessions().await;
    assert!(seen.iter().any(|m| m.id == archived), "archive oubliée au redémarrage");
    assert!(!d2.list_metas().iter().any(|m| m.id == archived));
    // Journal non touché depuis 400 ms > 300 ms : archivé dès la 1re passe.
    d2.housekeeping().await;
    assert!(archive_file(&f, &old).exists(), "fini avant l'arrêt mais pas archivé");
    assert!(d2.meta(&parent).is_ok());
    // Toujours joignable par son parent.
    host.post_peer_message(&parent, &archived, "reprends".into())
        .await
        .expect("sous-agent archivé injoignable après redémarrage");
    assert!(d2.meta(&archived).is_ok());
}

// ----- étape 3 : compression des archives de plus de 7 jours ---------------

use axecode_daemon::journal;

/// Donne à un fichier l'âge voulu (date de modification).
fn vieillir(path: &std::path::Path, jours: u64) {
    let date = std::time::SystemTime::now() - Duration::from_secs(jours * 24 * 3600);
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(date)
        .unwrap();
}

/// Exécute `f` en capturant les journaux (niveau WARN et plus).
fn capture<T>(f: impl FnOnce() -> T) -> (String, T) {
    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Buf {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let buf = Buf::default();
    let writer = buf.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .finish();
    let out = tracing::subscriber::with_default(subscriber, f);
    let logs = String::from_utf8_lossy(&buf.0.lock().unwrap()).to_string();
    (logs, out)
}

fn fichiers_temporaires(data: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(journal::archive_dir(data))
        .map(|read| {
            read.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|name| name.ends_with(".tmp"))
                .collect()
        })
        .unwrap_or_default()
}

/// Compressée puis restaurée : journal et instantané reviennent à l'octet près.
#[tokio::test(flavor = "multi_thread")]
async fn une_archive_compressee_puis_restauree_est_identique() {
    let f = fixture(|_| {});
    let d = &f.daemon;
    let data = f.dir.join("data");
    let id = create(d, "ancienne", None);
    d.send_user(&id, ChatMessage::user_text("bonjour")).unwrap();
    wait_idle(d, &id, 3).await;
    let instantane: Vec<u8> = (0..300_000u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    std::fs::write(journal::snapshot_path(&data, &id), &instantane).unwrap();
    let historique = serde_json::to_value(d.journal(&id).unwrap().lock().unwrap().history()).unwrap();
    d.archive(&id).unwrap();
    let plain = journal::archive_path(&data, &id);
    let snapshot = journal::archive_snapshot_path(&data, &id);
    let journal_avant = std::fs::read(&plain).unwrap();
    vieillir(&plain, 8);
    vieillir(&snapshot, 8);

    let report = d.compress_old_archives();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.compressed.len(), 2);
    assert!(!plain.exists() && !snapshot.exists(), "originaux restés");
    assert!(journal::gz_path(&plain).exists() && journal::gz_path(&snapshot).exists());
    assert!(fichiers_temporaires(&data).is_empty());

    // Les vues des archives lisent la forme compressée.
    assert_eq!(journal::list_archived_ids(&data), vec![id.clone()]);
    let liste = d.list_archived_entries().unwrap();
    assert_eq!(liste.as_array().unwrap().len(), 1);
    assert_eq!(liste[0]["id"], id);

    // Rétablie : identique, plus aucune copie dans l'archive.
    d.restore_archived(&id).unwrap();
    let journal_apres = std::fs::read(journal::journal_path(&data, &id)).unwrap();
    assert!(journal_apres.starts_with(&journal_avant), "journal modifié");
    let ajout = String::from_utf8(journal_apres[journal_avant.len()..].to_vec()).unwrap();
    assert_eq!(ajout.lines().count(), 1, "seule la marque « active » s'ajoute");
    assert_eq!(std::fs::read(journal::snapshot_path(&data, &id)).unwrap(), instantane);
    assert!(std::fs::read_dir(journal::archive_dir(&data)).unwrap().next().is_none());
    assert!(!d.meta(&id).unwrap().archived);
    let rendu = serde_json::to_value(d.journal(&id).unwrap().lock().unwrap().history()).unwrap();
    assert_eq!(rendu, historique);
}

/// Une archive de moins de 7 jours reste telle quelle.
#[test]
fn une_archive_recente_n_est_pas_compressee() {
    let f = fixture(|_| {});
    let d = &f.daemon;
    let data = f.dir.join("data");
    let id = create(d, "recente", None);
    d.archive(&id).unwrap();
    let plain = journal::archive_path(&data, &id);
    let report = d.compress_old_archives();
    assert!(report.compressed.is_empty() && report.errors.is_empty());
    vieillir(&plain, 6);
    assert!(d.compress_old_archives().compressed.is_empty());
    assert!(plain.exists());
    assert!(!journal::gz_path(&plain).exists());
}

/// Un .gz corrompu : erreur journalisée, rien n'est effacé ; un original
/// resté à côté n'est jamais perdu.
#[test]
fn un_gz_corrompu_donne_une_erreur_journalisee_sans_rien_perdre() {
    let f = fixture(|_| {});
    let d = &f.daemon;
    let data = f.dir.join("data");
    let id = create(d, "corrompue", None);
    d.archive(&id).unwrap();
    let plain = journal::archive_path(&data, &id);
    let original = std::fs::read(&plain).unwrap();
    vieillir(&plain, 8);
    assert_eq!(d.compress_old_archives().compressed.len(), 1);
    let gz = journal::gz_path(&plain);

    let mut abime = std::fs::read(&gz).unwrap();
    let milieu = abime.len() / 2;
    for octet in &mut abime[milieu..] {
        *octet ^= 0x5a;
    }
    std::fs::write(&gz, &abime).unwrap();

    let (logs, resultat) = capture(|| d.restore_archived(&id));
    assert!(resultat.is_err(), "restauration d'un .gz corrompu acceptée");
    assert!(logs.contains("WARN") && logs.contains("archive"), "erreur non journalisée : {logs}");
    assert_eq!(std::fs::read(&gz).unwrap(), abime, "le .gz a été touché");
    assert!(!plain.exists() && fichiers_temporaires(&data).is_empty());
    assert!(d.meta(&id).is_err());
    let (logs, liste) = capture(|| d.list_archived_entries());
    assert!(liste.unwrap().as_array().unwrap().is_empty());
    assert!(logs.contains("WARN"), "lecture ratée non journalisée : {logs}");
    assert_eq!(std::fs::read(&gz).unwrap(), abime);

    // L'original encore là (coupure) : la passe refait un .gz vérifié.
    std::fs::write(&plain, &original).unwrap();
    vieillir(&plain, 8);
    let report = d.compress_old_archives();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!plain.exists());
    journal::inflate_archive(&data, &id).unwrap();
    assert_eq!(std::fs::read(&plain).unwrap(), original);
    assert!(!gz.exists());
}

/// Passe au démarrage (1re passe d'entretien), puis une fois par jour.
#[tokio::test(flavor = "multi_thread")]
async fn compression_au_demarrage_puis_une_fois_par_jour() {
    let f = fixture(|_| {});
    let d = &f.daemon;
    let data = f.dir.join("data");
    let a = create(d, "a", None);
    let b = create(d, "b", None);
    d.archive(&a).unwrap();
    vieillir(&journal::archive_path(&data, &a), 8);
    d.housekeeping().await;
    assert!(journal::gz_path(&journal::archive_path(&data, &a)).exists());

    d.archive(&b).unwrap();
    vieillir(&journal::archive_path(&data, &b), 8);
    d.housekeeping().await;
    assert!(journal::archive_path(&data, &b).exists(), "2e passe le même jour");
}

/// Un sous-agent archivé puis compressé reste joignable après un redémarrage.
#[tokio::test(flavor = "multi_thread")]
async fn un_sous_agent_compresse_reste_joignable() {
    let f = fixture(|_| {});
    let d = &f.daemon;
    let data = f.dir.join("data");
    let parent = create(d, "parent", None);
    let child = create(d, "enfant", Some(&parent));
    d.archive(&child).unwrap();
    vieillir(&journal::archive_path(&data, &child), 8);
    assert_eq!(d.compress_old_archives().compressed.len(), 1);

    let mut config = DaemonConfig::new(data.clone());
    config.auto_shutdown = false;
    let d2 = Daemon::new(
        config,
        Arc::new(Factory {
            stopped: f.stopped.clone(),
        }),
    );
    let host: &dyn SessionHost = d2.as_ref();
    assert!(host.list_sessions().await.iter().any(|m| m.id == child));
    host.post_peer_message(&parent, &child, "reprends".into())
        .await
        .expect("sous-agent compressé injoignable");
    assert!(journal::journal_path(&data, &child).exists());
    assert!(!journal::archive_exists(&data, &child));
}

/// Un instantané de noyau illisible n'empêche pas la restauration : le
/// journal revient, l'instantané abîmé reste compressé dans l'archive.
#[test]
fn un_instantane_corrompu_n_empeche_pas_la_restauration() {
    let f = fixture(|_| {});
    let d = &f.daemon;
    let data = f.dir.join("data");
    let id = create(d, "instantane", None);
    std::fs::write(journal::snapshot_path(&data, &id), vec![7u8; 50_000]).unwrap();
    d.archive(&id).unwrap();
    let snapshot = journal::archive_snapshot_path(&data, &id);
    vieillir(&journal::archive_path(&data, &id), 8);
    vieillir(&snapshot, 8);
    assert_eq!(d.compress_old_archives().compressed.len(), 2);
    let gz = journal::gz_path(&snapshot);
    let mut abime = std::fs::read(&gz).unwrap();
    let n = abime.len();
    abime[n - 6] ^= 0xff; // somme de contrôle gzip fausse
    std::fs::write(&gz, &abime).unwrap();

    let (logs, resultat) = capture(|| d.restore_archived(&id));
    resultat.expect("journal non rétabli à cause de l'instantané");
    assert!(logs.contains("WARN"), "instantané illisible non journalisé : {logs}");
    assert!(journal::journal_path(&data, &id).exists());
    assert!(!journal::snapshot_path(&data, &id).exists());
    assert_eq!(std::fs::read(&gz).unwrap(), abime, "l'instantané abîmé a été touché");
    assert!(journal::list_archived_ids(&data).is_empty());
}
