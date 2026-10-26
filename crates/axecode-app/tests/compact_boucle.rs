//! axe:compact169 — /compact bouclait (capture du 26/10 : l'IA appelait compact.run()
//! 9 fois, chaque réponse « Compaction runs before the next request », tour sans fin).
//! Vrai démon + vrai noyau + crochet des commandes ; l'IA est simulée « obéissante » :
//! elle appelle compact.run() tant que le prompt le lui demande.

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

#[derive(Default)]
struct Obeissante {
    /// Requêtes du tour (hors requêtes de compaction).
    tour: Mutex<Vec<String>>,
    compactions: Mutex<usize>,
    /// Nombre d'appels compact.run() que l'IA tente d'office dans un tour.
    insiste: usize,
}

#[async_trait]
impl Provider for Obeissante {
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
        let tout = request.system_prompt.clone().unwrap_or_default()
            + &serde_json::to_string(&request.transcript).unwrap_or_default();
        let usage = Usage { input_tokens: 10, output_tokens: 5, ..Default::default() };
        let stop = StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage };
        let texte = |t: &str| {
            vec![
                StreamEvent::MessageStart { model: "fake".into() },
                StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
                StreamEvent::TextDelta { index: 0, delta: t.to_string() },
                StreamEvent::PartStop { index: 0 },
                stop.clone(),
            ]
        };
        let events = if tout.contains("CONTEXT CHECKPOINT COMPACTION") {
            *self.compactions.lock().unwrap() += 1;
            texte("résumé")
        } else {
            let n = {
                let mut t = self.tour.lock().unwrap();
                t.push(tout.clone());
                t.len()
            };
            // L'IA obéit à une consigne « appelle compact.run() » restée dans le prompt
            // (ancien comportement de /compact), ou insiste d'elle-même `insiste` fois.
            let consigne = tout.contains("Call `compact.run(");
            if (consigne || n <= self.insiste) && n < 12 {
                vec![
                    StreamEvent::MessageStart { model: "fake".into() },
                    StreamEvent::PartStart {
                        index: 0,
                        kind: PartKind::ToolCall,
                        tool: Some(ToolCallIntro { id: format!("c{n}"), name: "python".into() }),
                    },
                    StreamEvent::ToolJsonDelta {
                        index: 0,
                        chunk: serde_json::json!({"code": "print(compact.run())"}).to_string(),
                    },
                    StreamEvent::PartStop { index: 0 },
                    StreamEvent::MessageStop { stop_reason: StopReason::ToolUse, usage: Usage::default() },
                ]
            } else {
                texte("fini")
            }
        };
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver(Arc<Obeissante>);
impl ProviderResolver for Resolver {
    fn provider(&self, _id: &str) -> Result<Arc<dyn Provider>, String> {
        Ok(self.0.clone())
    }
}

struct Banc {
    daemon: Arc<Daemon>,
    ia: Arc<Obeissante>,
    id: String,
    base: std::path::PathBuf,
}
impl Drop for Banc {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.base).ok();
    }
}

fn banc(insiste: usize) -> Option<Banc> {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping: no Python with IPython");
        return None;
    }
    let base = std::env::temp_dir().join(format!("axecode-compact-{}", uuid::Uuid::new_v4()));
    let ws = base.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let ia = Arc::new(Obeissante { insiste, ..Default::default() });
    let resolver: Arc<dyn ProviderResolver> = Arc::new(Resolver(ia.clone()));
    let hook = SessionCommandsHook::new(resolver.clone());
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
    Some(Banc { daemon, ia, id, base })
}

impl Banc {
    async fn tour(&self, text: &str) {
        let compte = || self.ia.tour.lock().unwrap().len() + *self.ia.compactions.lock().unwrap();
        let avant = compte();
        self.daemon.send_user(&self.id, ChatMessage::user_text(text)).unwrap();
        for _ in 0..600 {
            if compte() > avant && self.daemon.list_metas().iter().all(|m| m.status != axecode_core::SessionStatus::Running) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("le tour `{text}` ne finit pas : {:?}", self.entrees());
    }
    fn entrees(&self) -> Vec<JournalEntryKind> {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        j.entries().iter().map(|e| e.kind.clone()).collect()
    }
    fn nb_compactions(&self) -> usize {
        self.entrees().iter().filter(|k| matches!(k, JournalEntryKind::Compaction { .. })).count()
    }
    fn sorties(&self) -> Vec<String> {
        self.entrees()
            .into_iter()
            .filter_map(|k| match k {
                JournalEntryKind::ReplResult { output, .. } => Some(output),
                _ => None,
            })
            .collect()
    }
}

/// /compact : compaction faite directement, l'IA n'est pas sollicitée, une seule fois.
#[tokio::test(flavor = "multi_thread")]
async fn slash_compact_sans_l_ia_et_sans_boucle() {
    let Some(b) = banc(0) else { return };
    b.tour("bonjour").await;
    assert_eq!(b.ia.tour.lock().unwrap().len(), 1);
    b.tour("/compact garder les décisions").await;
    assert_eq!(b.nb_compactions(), 1, "une seule compaction");
    assert_eq!(*b.ia.compactions.lock().unwrap(), 1);
    assert_eq!(b.ia.tour.lock().unwrap().len(), 1, "/compact ne doit pas lancer de tour de l'IA");
    assert!(b.sorties().iter().all(|s| !s.contains("compact.run")));
    let dir = b.entrees().into_iter().find_map(|k| match k {
        JournalEntryKind::Compaction { directive, .. } => directive,
        _ => None,
    });
    assert_eq!(dir.as_deref(), Some("garder les décisions"));
    // La conversation continue normalement après.
    b.tour("et maintenant ?").await;
    assert_eq!(b.ia.tour.lock().unwrap().len(), 2);
    assert_eq!(b.nb_compactions(), 1);
}

/// compact.run() appelé en boucle par l'IA : 1er appel programmé, les suivants ignorés,
/// réponses en français qui disent de terminer ; une seule compaction ; le tour finit.
#[tokio::test(flavor = "multi_thread")]
async fn compact_run_repete_ignore() {
    let Some(b) = banc(9) else { return };
    b.tour("compacte").await;
    let sorties = b.sorties();
    assert!(sorties.len() >= 2, "{sorties:?}");
    assert!(sorties[0].contains("Compaction programmée"), "{sorties:?}");
    assert!(sorties[0].contains("termine ton tour"), "{sorties:?}");
    assert!(sorties[1..].iter().all(|s| s.contains("appel ignoré")), "{sorties:?}");
    assert!(sorties.iter().all(|s| !s.contains("Compaction runs")), "{sorties:?}");
    assert_eq!(b.nb_compactions(), 1, "une seule compaction malgré {} appels", sorties.len());
    // Au tour suivant, compact.run() est de nouveau permis.
    let avant = b.sorties().len();
    b.ia.tour.lock().unwrap().clear();
    b.tour("encore").await;
    assert!(b.sorties()[avant].contains("Compaction programmée"));
}
