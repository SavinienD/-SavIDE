//! mode « Demander avant d'agir ».
//!
//! Réglage par conversation, avec un défaut global (défaut : autonome, comme
//! avant). En mode « demander », chaque cellule python attend l'accord de
//! l'utilisateur avant de tourner : la demande part vers l'interface (événement
//! `approbation` du flux de la session), la réponse revient par le service
//! (`approbation.repondre`). Un refus renvoie son motif à l'agent comme résultat
//! de la cellule ; « Toujours » passe la conversation en autonome. Un sous-agent
//! suit le réglage de son parent tant qu'il n'a pas le sien.

use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};

use anyhow::Result;
use axecode_core::{JournalEntryKind, Part, SessionError, SessionHost, SessionMeta, SessionResult, TurnSink};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::oneshot;

/// Réglages, dans le dossier de données du service.
pub const FICHIER: &str = "validation-actions.json";
/// Profondeur maximale remontée pour trouver le réglage d'un parent.
const PROFONDEUR: usize = 8;
#[cfg(not(test))]
const SONDE: Duration = Duration::from_millis(200);
#[cfg(test)]
const SONDE: Duration = Duration::from_millis(5);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Autonome,
    Demander,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reglages {
    #[serde(default)]
    pub defaut: Mode,
    /// Réglage propre à une conversation (absent : celui du parent, sinon le défaut).
    #[serde(default)]
    pub sessions: BTreeMap<String, Mode>,
}

/// Mode d'une session et d'où il vient.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeEffectif {
    pub mode: Mode,
    /// Réglage propre à la session, s'il y en a un.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicite: Option<Mode>,
    /// Session (parent) dont le réglage s'applique, s'il vient d'un parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub herite_de: Option<String>,
    pub defaut: Mode,
}

/// Réponse de l'utilisateur à une demande.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum Decision {
    Autoriser,
    Refuser {
        #[serde(default)]
        motif: String,
    },
    /// Autoriser et ne plus demander dans cette conversation.
    Toujours,
    /// Le tour a été arrêté pendant l'attente.
    Annulee,
}

/// Une action qui attend l'accord de l'utilisateur.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Demande {
    pub id: String,
    pub session_id: String,
    /// Conversation de premier niveau (celle que l'utilisateur regarde).
    pub racine_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub nom_session: String,
    pub dossier: String,
    /// `python` (cellule du REPL).
    pub outil: String,
    pub call_id: String,
    pub code: String,
    pub cree_le: i64,
}

static REGLAGES: Mutex<()> = Mutex::new(());

/// Lit les réglages (fichier absent ou abîmé : tout en autonome).
pub fn lire(data_dir: &Path) -> Reglages {
    std::fs::read_to_string(data_dir.join(FICHIER))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Règle le mode d'une session (`session` absent : le défaut global).
/// `mode` absent pour une session : elle suit de nouveau son parent ou le défaut.
pub fn regler(data_dir: &Path, session: Option<&str>, mode: Option<Mode>) -> Result<Reglages> {
    let _verrou = REGLAGES.lock().unwrap_or_else(|e| e.into_inner());
    let mut r = lire(data_dir);
    match (session.filter(|s| !s.is_empty()), mode) {
        (None, m) => r.defaut = m.unwrap_or_default(),
        (Some(s), Some(m)) => {
            r.sessions.insert(s.to_string(), m);
        }
        (Some(s), None) => {
            r.sessions.remove(s);
        }
    }
    std::fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join(format!("{FICHIER}.tmp"));
    std::fs::write(&tmp, serde_json::to_string_pretty(&r)?)?;
    std::fs::rename(&tmp, data_dir.join(FICHIER))?;
    Ok(r)
}

/// Mode d'une session : son réglage, sinon celui du parent le plus proche, sinon le défaut.
/// `chaine` = [session, parent, grand-parent…].
pub fn mode_de(reglages: &Reglages, chaine: &[String]) -> ModeEffectif {
    let explicite = chaine.first().and_then(|s| reglages.sessions.get(s)).copied();
    for (rang, id) in chaine.iter().enumerate() {
        if let Some(m) = reglages.sessions.get(id) {
            return ModeEffectif { mode: *m, explicite, herite_de: (rang > 0).then(|| id.clone()), defaut: reglages.defaut };
        }
    }
    ModeEffectif { mode: reglages.defaut, explicite, herite_de: None, defaut: reglages.defaut }
}

/// [session, parent, grand-parent…] d'après le service.
pub async fn chaine(host: &dyn SessionHost, session: &SessionMeta) -> Vec<String> {
    let mut out = vec![session.id.clone()];
    let mut parent = session.parent_id.clone();
    while let Some(id) = parent.filter(|_| out.len() < PROFONDEUR) {
        if out.contains(&id) {
            break;
        }
        parent = host.get_session(&id).await.ok().and_then(|m| m.parent_id);
        out.push(id);
    }
    out
}

struct Attente {
    demande: Demande,
    reponse: oneshot::Sender<Decision>,
}

static ATTENTES: LazyLock<Mutex<HashMap<String, Attente>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn attentes() -> std::sync::MutexGuard<'static, HashMap<String, Attente>> {
    ATTENTES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Demandes en attente dans ce service, les plus anciennes d'abord.
pub fn en_attente() -> Vec<Demande> {
    let mut v: Vec<Demande> = attentes().values().map(|a| a.demande.clone()).collect();
    v.sort_by(|a, b| a.cree_le.cmp(&b.cree_le).then(a.id.cmp(&b.id)));
    v
}

/// Transmet la réponse de l'utilisateur. Erreur si la demande n'attend plus.
pub fn repondre(id: &str, decision: Decision) -> Result<Demande> {
    let attente = attentes().remove(id).ok_or_else(|| anyhow::anyhow!("cette demande n'attend plus de réponse"))?;
    let demande = attente.demande.clone();
    let _ = attente.reponse.send(decision);
    Ok(demande)
}

/// Retire la demande si l'attente est abandonnée (tour arrêté, service qui s'arrête).
struct Garde(String);

impl Drop for Garde {
    fn drop(&mut self) {
        attentes().remove(&self.0);
    }
}

/// Enregistre la demande et attend la réponse ; `annule` est sondé pendant l'attente.
pub async fn attendre(demande: Demande, annule: impl Fn() -> bool) -> Decision {
    let (tx, mut rx) = oneshot::channel();
    let id = demande.id.clone();
    attentes().insert(id.clone(), Attente { demande, reponse: tx });
    let _garde = Garde(id);
    loop {
        if annule() {
            return Decision::Annulee;
        }
        match tokio::time::timeout(SONDE, &mut rx).await {
            Ok(Ok(decision)) => return decision,
            Ok(Err(_)) => return Decision::Annulee,
            Err(_) => {}
        }
    }
}

fn maintenant_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Texte rendu à l'agent quand l'utilisateur refuse une cellule.
pub fn texte_refus(motif: &str) -> String {
    let motif = motif.trim();
    let motif = if motif.is_empty() { "aucun motif donné".to_string() } else { motif.to_string() };
    format!(
        "Refusé par l'utilisateur (mode « Demander avant d'agir ») : cette cellule n'a pas été exécutée.\nMotif : {motif}\nTiens compte du motif ; ne relance pas la même cellule sans changement, ou demande à l'utilisateur comment continuer."
    )
}

/// Crochet du REPL, avant chaque cellule : `None` = la cellule peut tourner ;
/// `Some(part)` = refusée (résultat déjà journalisé) ; `Err(Cancelled)` = tour arrêté.
pub async fn avant_cellule(
    data_dir: &Path,
    host: &dyn SessionHost,
    session: &SessionMeta,
    sink: &Arc<dyn TurnSink>,
    turn_id: &str,
    call_id: &str,
    code: &str,
) -> SessionResult<Option<Part>> {
    let reglages = lire(data_dir);
    if reglages.defaut == Mode::Autonome && reglages.sessions.values().all(|m| *m == Mode::Autonome) {
        return Ok(None);
    }
    let chaine = chaine(host, session).await;
    if mode_de(&reglages, &chaine).mode == Mode::Autonome {
        return Ok(None);
    }
    let demande = Demande {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session.id.clone(),
        racine_id: chaine.last().cloned().unwrap_or_else(|| session.id.clone()),
        parent_id: session.parent_id.clone(),
        nom_session: session.name.clone(),
        dossier: session.workspace_id.clone(),
        outil: "python".into(),
        call_id: call_id.to_string(),
        code: code.to_string(),
        cree_le: maintenant_ms(),
    };
    sink.emit(json!({"type": "approbation", "demande": demande})).await;
    let sonde = sink.clone();
    let decision = attendre(demande.clone(), move || sonde.is_cancelled()).await;
    sink.emit(json!({"type": "approbation_fin", "id": demande.id, "decision": decision})).await;
    if decision != Decision::Annulee {
        let _ = sink
            .record(JournalEntryKind::Extension {
                name: "approbation".into(),
                payload: json!({"id": demande.id, "callId": call_id, "decision": decision}),
            })
            .await;
    }
    match decision {
        Decision::Autoriser => Ok(None),
        Decision::Toujours => {
            if let Err(e) = regler(data_dir, Some(&session.id), Some(Mode::Autonome)) {
                tracing::warn!(error = %e, "réglage « toujours » non enregistré");
            }
            Ok(None)
        }
        Decision::Annulee => Err(SessionError::Cancelled),
        Decision::Refuser { motif } => {
            let content = texte_refus(&motif);
            sink.record(JournalEntryKind::ReplResult {
                call_id: call_id.to_string(),
                output: content.clone(),
                is_error: true,
                images: vec![],
                duration_ms: 0,
                turn_id: Some(turn_id.to_string()),
            })
            .await?;
            sink.emit(json!({"type": "repl_start", "callId": call_id, "code": code})).await;
            sink.emit(json!({"type": "repl_done", "callId": call_id, "summary": "refusée", "isError": true, "durationMs": 0,
                "stdout": "", "stderr": content, "value": null, "error": content, "fileChanges": []}))
                .await;
            Ok(Some(Part::ToolResult { tool_call_id: call_id.to_string(), content, images: vec![], is_error: true, meta: None }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axecode_core::{CreateSessionRequest, EntryId, ModelRef, SessionStatus};
    use serde_json::Value;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct Puits {
        evenements: Mutex<Vec<Value>>,
        journal: Mutex<Vec<JournalEntryKind>>,
        arret: AtomicBool,
    }

    #[async_trait]
    impl TurnSink for Puits {
        async fn record(&self, kind: JournalEntryKind) -> SessionResult<EntryId> {
            self.journal.lock().unwrap().push(kind);
            Ok("e".into())
        }
        async fn emit(&self, event: Value) {
            self.evenements.lock().unwrap().push(event);
        }
        fn is_cancelled(&self) -> bool {
            self.arret.load(Ordering::SeqCst)
        }
    }

    fn meta(id: &str, parent: Option<&str>) -> SessionMeta {
        SessionMeta {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            name: format!("session {id}"),
            workspace_id: "/projet".into(),
            model: ModelRef::new("anthropic", "m"),
            system_prompt_extra: None,
            status: SessionStatus::Running,
            created_at_ms: 0,
            updated_at_ms: 0,
            children: vec![],
            leaf: None,
            entry_count: 0,
            archived: false,
            imported_from: None,
            scratch: false,
        }
    }

    /// Service minimal : connaît les parents.
    struct Hote(Vec<SessionMeta>);

    #[async_trait]
    impl SessionHost for Hote {
        async fn create_session(&self, _: CreateSessionRequest) -> SessionResult<SessionMeta> {
            unimplemented!()
        }
        async fn get_session(&self, id: &str) -> SessionResult<SessionMeta> {
            self.0.iter().find(|m| m.id == id).cloned().ok_or_else(|| SessionError::NotFound(id.into()))
        }
        async fn list_sessions(&self) -> Vec<SessionMeta> {
            self.0.clone()
        }
        async fn send_user_message(&self, _: &str, _: String) -> SessionResult<EntryId> {
            unimplemented!()
        }
        async fn post_peer_message(&self, _: &str, _: &str, _: String) -> SessionResult<EntryId> {
            unimplemented!()
        }
        async fn record(&self, _: &str, _: JournalEntryKind) -> SessionResult<EntryId> {
            unimplemented!()
        }
        async fn stop_turn(&self, _: &str) -> SessionResult<()> {
            unimplemented!()
        }
    }

    fn dossier(nom: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("test-approbation-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Lance le crochet et rend la demande émise (ou `None` si la cellule passe sans demander).
    async fn lancer(
        data: &Path,
        hote: Arc<Hote>,
        session: SessionMeta,
        puits: Arc<Puits>,
        code: &'static str,
    ) -> (tokio::task::JoinHandle<SessionResult<Option<Part>>>, Option<Demande>) {
        let data = data.to_path_buf();
        let sink: Arc<dyn TurnSink> = puits.clone();
        let tache = tokio::spawn(async move { avant_cellule(&data, hote.as_ref(), &session, &sink, "t1", "c1", code).await });
        for _ in 0..200 {
            if tache.is_finished() {
                return (tache, None);
            }
            let vue = puits.evenements.lock().unwrap().iter().find(|e| e["type"] == "approbation").cloned();
            if let Some(e) = vue {
                return (tache, Some(serde_json::from_value(e["demande"].clone()).unwrap()));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("ni demande ni fin");
    }

    #[tokio::test]
    async fn autonome_par_defaut_la_cellule_passe_sans_demander() {
        let d = dossier("defaut");
        let puits = Arc::new(Puits::default());
        let (t, demande) = lancer(&d, Arc::new(Hote(vec![])), meta("s1", None), puits.clone(), "print(1)").await;
        assert!(demande.is_none());
        assert!(t.await.unwrap().unwrap().is_none());
        assert!(puits.evenements.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn demander_puis_autoriser() {
        let d = dossier("autoriser");
        regler(&d, Some("s1"), Some(Mode::Demander)).unwrap();
        let puits = Arc::new(Puits::default());
        let (t, demande) = lancer(&d, Arc::new(Hote(vec![])), meta("s1", None), puits.clone(), "shell.run('ls')").await;
        let demande = demande.expect("une demande");
        assert_eq!((demande.code.as_str(), demande.racine_id.as_str(), demande.outil.as_str()), ("shell.run('ls')", "s1", "python"));
        assert!(en_attente().iter().any(|x| x.id == demande.id), "listée tant qu'elle attend");
        repondre(&demande.id, Decision::Autoriser).unwrap();
        assert!(t.await.unwrap().unwrap().is_none(), "la cellule peut tourner");
        assert!(!en_attente().iter().any(|x| x.id == demande.id));
        assert!(repondre(&demande.id, Decision::Autoriser).is_err(), "une seule réponse");
        let ev = puits.evenements.lock().unwrap().clone();
        assert!(ev.iter().any(|e| e["type"] == "approbation_fin" && e["decision"]["decision"] == "autoriser"));
    }

    #[tokio::test]
    async fn refus_renvoie_le_motif_a_l_agent() {
        let d = dossier("refuser");
        regler(&d, None, Some(Mode::Demander)).unwrap(); // défaut global
        let puits = Arc::new(Puits::default());
        let (t, demande) = lancer(&d, Arc::new(Hote(vec![])), meta("s2", None), puits.clone(), "files.delete('a')").await;
        repondre(&demande.unwrap().id, Decision::Refuser { motif: "ne supprime rien".into() }).unwrap();
        let Some(Part::ToolResult { content, is_error, tool_call_id, .. }) = t.await.unwrap().unwrap() else { panic!("résultat attendu") };
        assert!(is_error && tool_call_id == "c1");
        assert!(content.contains("Motif : ne supprime rien") && content.contains("n'a pas été exécutée"), "{content}");
        let journal = puits.journal.lock().unwrap().clone();
        assert!(journal.iter().any(|k| matches!(k, JournalEntryKind::ReplResult { output, is_error: true, .. } if output.contains("ne supprime rien"))));
        let ev = puits.evenements.lock().unwrap().clone();
        assert!(ev.iter().any(|e| e["type"] == "repl_done" && e["isError"] == true), "le chat montre la cellule refusée");
    }

    #[tokio::test]
    async fn toujours_passe_la_conversation_en_autonome() {
        let d = dossier("toujours");
        regler(&d, None, Some(Mode::Demander)).unwrap();
        let puits = Arc::new(Puits::default());
        let hote = Arc::new(Hote(vec![]));
        let (t, demande) = lancer(&d, hote.clone(), meta("s3", None), puits.clone(), "x = 1").await;
        repondre(&demande.unwrap().id, Decision::Toujours).unwrap();
        assert!(t.await.unwrap().unwrap().is_none());
        assert_eq!(lire(&d).sessions.get("s3"), Some(&Mode::Autonome));
        let puits2 = Arc::new(Puits::default());
        let (t2, demande2) = lancer(&d, hote, meta("s3", None), puits2, "x = 2").await;
        assert!(demande2.is_none(), "plus de demande dans cette conversation");
        assert!(t2.await.unwrap().unwrap().is_none());
        assert_eq!(lire(&d).defaut, Mode::Demander, "le défaut global ne change pas");
    }

    #[tokio::test]
    async fn sous_agent_suit_son_parent_et_remonte_a_la_racine() {
        let d = dossier("sousagent");
        regler(&d, Some("racine"), Some(Mode::Demander)).unwrap();
        let hote = Arc::new(Hote(vec![meta("racine", None), meta("enfant", Some("racine")), meta("petit", Some("enfant"))]));
        let puits = Arc::new(Puits::default());
        let (t, demande) = lancer(&d, hote.clone(), meta("petit", Some("enfant")), puits, "web.fetch('x')").await;
        let demande = demande.expect("le sous-agent demande aussi");
        assert_eq!((demande.racine_id.as_str(), demande.parent_id.as_deref()), ("racine", Some("enfant")));
        repondre(&demande.id, Decision::Autoriser).unwrap();
        t.await.unwrap().unwrap();
        let effectif = mode_de(&lire(&d), &chaine(hote.as_ref(), &meta("petit", Some("enfant"))).await);
        assert_eq!((effectif.mode, effectif.explicite, effectif.herite_de.as_deref()), (Mode::Demander, None, Some("racine")));
    }

    #[tokio::test]
    async fn arret_du_tour_pendant_l_attente() {
        let d = dossier("arret");
        regler(&d, Some("s4"), Some(Mode::Demander)).unwrap();
        let puits = Arc::new(Puits::default());
        let (t, demande) = lancer(&d, Arc::new(Hote(vec![])), meta("s4", None), puits.clone(), "long()").await;
        let id = demande.unwrap().id;
        puits.arret.store(true, Ordering::SeqCst);
        assert!(matches!(t.await.unwrap(), Err(SessionError::Cancelled)));
        assert!(!en_attente().iter().any(|x| x.id == id), "plus rien en attente");
    }
}
