//! axe:refine169 — affinage bout à bout avec le VRAI flux : l'IA appelle
//! `refine.run()` dans le noyau d'une vraie session du démon (crochet des commandes),
//! le planificateur tourne en arrière-plan, et l'affinage finit TOUJOURS en
//! appliqué / rien à changer / échec avec raison / arrêté (délai et bouton Arrêter).

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplFactory};
use axecode_app::session_commands::SessionCommandsHook;
use axecode_core::{
    ChatMessage, CreateSessionRequest, JournalEntryKind, ModelRef, PartKind, Provider,
    ProviderRequest, ProviderStream, StopReason, StreamEvent, TokenEstimate, ToolCallIntro, Usage,
};
use axecode_daemon::{Daemon, DaemonConfig};
use axecode_harness::{
    refine::{self, RefineOutcome, RefinementRecord},
    HarnessStore,
};

#[derive(Clone, Copy)]
enum Planif {
    Plan,
    RienAChanger,
    Erreur,
    Bloque,
}

struct Ia {
    planif: Planif,
    tours: Mutex<usize>,
    planifs: Mutex<usize>,
}

const PLAN: &str = r#"{"summary":"note utile","evidence":["e"],"operations":[{"op":"create","kind":"memory","scope":"project","title":"Fait appris","body":"corps"}]}"#;
const RIEN: &str = r#"{"summary":"rien à changer","evidence":[],"operations":[]}"#;

#[async_trait]
impl Provider for Ia {
    fn name(&self) -> &str {
        "fake"
    }
    fn capabilities(&self, _m: &ModelRef) -> Option<axecode_core::ModelCapabilities> {
        None
    }
    async fn estimate_tokens(&self, _r: ProviderRequest) -> axecode_core::Result<TokenEstimate> {
        Ok(TokenEstimate { input_tokens: 10, exact: false })
    }
    async fn stream(&self, request: ProviderRequest) -> axecode_core::Result<ProviderStream> {
        let usage = Usage { input_tokens: 10, output_tokens: 5, ..Default::default() };
        let texte = |t: &str| -> Vec<StreamEvent> {
            vec![
                StreamEvent::MessageStart { model: "fake".into() },
                StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
                StreamEvent::TextDelta { index: 0, delta: t.to_string() },
                StreamEvent::PartStop { index: 0 },
                StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage: usage.clone() },
            ]
        };
        let system = request.system_prompt.clone().unwrap_or_default();
        if system.contains("harness refiner") {
            *self.planifs.lock().unwrap() += 1;
            return match self.planif {
                Planif::Plan => Ok(Box::pin(futures::stream::iter(texte(PLAN).into_iter().map(Ok)))),
                Planif::RienAChanger => Ok(Box::pin(futures::stream::iter(texte(RIEN).into_iter().map(Ok)))),
                Planif::Erreur => Err(axecode_core::AppError::Provider("modèle indisponible".into())),
                Planif::Bloque => Ok(Box::pin(futures::stream::pending())),
            };
        }
        let n = {
            let mut t = self.tours.lock().unwrap();
            *t += 1;
            *t
        };
        let events = if n % 2 == 1 {
            vec![
                StreamEvent::MessageStart { model: "fake".into() },
                StreamEvent::PartStart {
                    index: 0,
                    kind: PartKind::ToolCall,
                    tool: Some(ToolCallIntro { id: format!("c{n}"), name: "python".into() }),
                },
                StreamEvent::ToolJsonDelta {
                    index: 0,
                    chunk: serde_json::json!({"code": "print(refine.run('préférences'))"}).to_string(),
                },
                StreamEvent::PartStop { index: 0 },
                StreamEvent::MessageStop { stop_reason: StopReason::ToolUse, usage: Usage::default() },
            ]
        } else {
            texte("ok")
        };
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver(Arc<Ia>);
impl ProviderResolver for Resolver {
    fn provider(&self, _id: &str) -> Result<Arc<dyn Provider>, String> {
        Ok(self.0.clone())
    }
}

struct Banc {
    daemon: Arc<Daemon>,
    ia: Arc<Ia>,
    id: String,
    ws: std::path::PathBuf,
    base: std::path::PathBuf,
}
impl Drop for Banc {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.base).ok();
    }
}

fn banc(planif: Planif, delai: Option<Duration>) -> Option<Banc> {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping: no Python with IPython");
        return None;
    }
    let base = std::env::temp_dir().join(format!("axecode-refine-{}", uuid::Uuid::new_v4()));
    let ws = base.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let ia = Arc::new(Ia { planif, tours: Mutex::new(0), planifs: Mutex::new(0) });
    let resolver: Arc<dyn ProviderResolver> = Arc::new(Resolver(ia.clone()));
    let hook = SessionCommandsHook::new(resolver.clone());
    if let Some(d) = delai {
        hook.set_refine_timeout(d);
    }
    let deps = Arc::new(ReplDeps { providers: resolver, resource_dirs: vec![], hooks: vec![hook] });
    let mut config = DaemonConfig::new(base.join("data"));
    config.auto_shutdown = false;
    let daemon = Daemon::new(config, Arc::new(ReplFactory { deps }));
    let id = daemon
        .create(CreateSessionRequest {
            name: "t".into(),
            workspace_id: ws.display().to_string(),
            model: ModelRef::new("fake", "m"),
            parent_id: None,
            system_prompt_extra: None,
            initial_message: None,
        })
        .unwrap()
        .id;
    Some(Banc { daemon, ia, id, ws, base })
}

impl Banc {
    fn store(&self) -> HarnessStore {
        HarnessStore::open(&self.ws)
    }
    async fn tour(&self, text: &str) {
        let avant = *self.ia.tours.lock().unwrap();
        self.daemon.send_user(&self.id, ChatMessage::user_text(text)).unwrap();
        for _ in 0..600 {
            if *self.ia.tours.lock().unwrap() >= avant + 2
                && self.daemon.list_metas().iter().all(|m| m.status != axecode_core::SessionStatus::Running)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("le tour `{text}` ne finit pas : {:?}", self.sorties());
    }
    fn sorties(&self) -> Vec<String> {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        j.entries()
            .iter()
            .filter_map(|e| match &e.kind {
                JournalEntryKind::ReplResult { output, .. } => Some(output.clone()),
                _ => None,
            })
            .collect()
    }
    fn journal_affinage(&self) -> Vec<String> {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        j.entries()
            .iter()
            .filter_map(|e| match &e.kind {
                JournalEntryKind::Refinement { refinement_id, .. } => Some(refinement_id.clone()),
                _ => None,
            })
            .collect()
    }
    /// Attend la fin de l'affinage (au plus `secondes`) ; renvoie le dernier enregistrement.
    async fn fin(&self, secondes: u64) -> RefinementRecord {
        for _ in 0..secondes * 20 {
            let h = refine::history(&self.store()).unwrap();
            if let Some(r) = h.first().filter(|r| r.outcome != RefineOutcome::Running) {
                return r.clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("affinage bloqué : {:?}", refine::history(&self.store()).unwrap());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn refine_run_applique() {
    let Some(b) = banc(Planif::Plan, None) else { return };
    b.tour("retiens ça").await;
    assert!(b.sorties()[0].contains("'started': True"), "{:?}", b.sorties());
    let r = b.fin(10).await;
    assert_eq!(r.outcome, RefineOutcome::Applied, "{r:?}");
    assert_eq!(r.focus.as_deref(), Some("préférences"));
    assert_eq!(refine::history(&b.store()).unwrap().len(), 1);
    assert!(b.store().load_all().unwrap().iter().any(|e| e.meta.title == "Fait appris"));
    // Le tour suivant le mentionne une fois dans le journal de la session.
    b.tour("suite").await;
    assert_eq!(b.journal_affinage(), vec![r.id.clone()]);
    // Et un nouvel affinage peut repartir.
    let r2 = b.fin(10).await;
    assert_eq!(*b.ia.planifs.lock().unwrap(), 2);
    let _ = r2;
}

#[tokio::test(flavor = "multi_thread")]
async fn refine_run_rien_a_changer() {
    let Some(b) = banc(Planif::RienAChanger, None) else { return };
    b.tour("retiens ça").await;
    let r = b.fin(10).await;
    assert_eq!(r.outcome, RefineOutcome::Noop, "{r:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn refine_run_echec_avec_raison() {
    let Some(b) = banc(Planif::Erreur, None) else { return };
    b.tour("retiens ça").await;
    let r = b.fin(10).await;
    assert_eq!(r.outcome, RefineOutcome::Failed, "{r:?}");
    assert!(r.error.as_deref().unwrap_or("").contains("modèle indisponible"), "{r:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn refine_run_delai_depasse() {
    let Some(b) = banc(Planif::Bloque, Some(Duration::from_millis(500))) else { return };
    b.tour("retiens ça").await;
    let r = b.fin(10).await;
    assert_eq!(r.outcome, RefineOutcome::Failed, "{r:?}");
    assert!(r.error.as_deref().unwrap_or("").contains("délai dépassé"), "{r:?}");
}

/// Bouton Arrêter des Réglages : il tourne dans le processus de l'IDE, pas dans celui
/// du démon qui porte la tâche (un autre `RefineRunner`).
#[tokio::test(flavor = "multi_thread")]
async fn refine_run_arrete_depuis_l_ide() {
    let Some(b) = banc(Planif::Bloque, None) else { return };
    b.tour("retiens ça").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let h = refine::history(&b.store()).unwrap();
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].outcome, RefineOutcome::Running);
    let ide = refine::RefineRunner::new();
    ide.cancel(&b.store(), &h[0].id).unwrap();
    let r = b.fin(5).await;
    assert_eq!(r.outcome, RefineOutcome::Cancelled, "{r:?}");
    // La session peut relancer un affinage tout de suite.
    b.tour("encore").await;
    assert!(b.sorties().last().unwrap().contains("'started': True"), "{:?}", b.sorties());
}
