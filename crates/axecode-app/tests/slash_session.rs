//! Commandes slash de session (/goal, /heartbeat, /autonomous, /compact) servies
//! par le vrai démon avec le crochet `SessionCommandsHook` : chaque commande proposée
//! dans l'autocomplétion de l'IDE doit agir sur l'état de la session.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use axecode_app::repl::{ProviderResolver, ReplDeps, ReplFactory};
use axecode_app::session_commands::SessionCommandsHook;
use axecode_core::{
    ChatMessage, CreateSessionRequest, ModelRef, PartKind, Provider,
    ProviderRequest, ProviderStream, StopReason, StreamEvent, TokenEstimate, Usage,
};
use axecode_daemon::{Daemon, DaemonConfig};

struct Echo {
    /// Texte du dernier prompt système vu (pour vérifier les rappels).
    systems: Mutex<VecDeque<String>>,
}

#[async_trait]
impl Provider for Echo {
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
        self.systems.lock().unwrap().push_back(
            request.system_prompt.clone().unwrap_or_default()
                + &serde_json::to_string(&request.transcript).unwrap_or_default(),
        );
        let usage = Usage { input_tokens: 10, output_tokens: 5, ..Default::default() };
        let events = vec![
            StreamEvent::MessageStart { model: "fake".into() },
            StreamEvent::PartStart { index: 0, kind: PartKind::Text, tool: None },
            StreamEvent::TextDelta { index: 0, delta: "ok".into() },
            StreamEvent::PartStop { index: 0 },
            StreamEvent::MessageStop { stop_reason: StopReason::EndTurn, usage },
        ];
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}

struct Resolver(Arc<Echo>);
impl ProviderResolver for Resolver {
    fn provider(&self, _id: &str) -> Result<Arc<dyn Provider>, String> {
        Ok(self.0.clone())
    }
}

struct Banc {
    daemon: Arc<Daemon>,
    hook: Arc<SessionCommandsHook>,
    provider: Arc<Echo>,
    id: String,
    base: std::path::PathBuf,
    /// axe:goal165 — garder le dossier (rechargement simulé par un 2e banc).
    keep: bool,
}

impl Drop for Banc {
    fn drop(&mut self) {
        if !self.keep {
            std::fs::remove_dir_all(&self.base).ok();
        }
    }
}

fn banc() -> Option<Banc> {
    let base = std::env::temp_dir().join(format!("axecode-slash-{}", uuid::Uuid::new_v4()));
    banc_sur(base, None)
}

/// Banc sur un dossier donné ; `session` = reprendre une session existante.
fn banc_sur(base: std::path::PathBuf, session: Option<String>) -> Option<Banc> {
    if axecode_repl::python::find_python(&[]).is_none() {
        eprintln!("skipping: no Python with IPython");
        return None;
    }
    let ws = base.join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let provider = Arc::new(Echo { systems: Mutex::new(VecDeque::new()) });
    let resolver: Arc<dyn ProviderResolver> = Arc::new(Resolver(provider.clone()));
    let hook = SessionCommandsHook::new(resolver.clone());
    let deps = Arc::new(ReplDeps { providers: resolver, resource_dirs: vec![], hooks: vec![hook.clone()] });
    let mut config = DaemonConfig::new(base.join("data"));
    config.auto_shutdown = false;
    let daemon = Daemon::new(config, Arc::new(ReplFactory { deps }));
    if let Some(id) = session {
        return Some(Banc { daemon, hook, provider, id, base, keep: false });
    }
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
    Some(Banc { daemon, hook, provider, id, base, keep: false })
}

impl Banc {
    fn idle(&self) -> bool {
        self.daemon.list_metas().iter().all(|m| m.status != axecode_core::SessionStatus::Running)
    }
    async fn send(&self, text: &str) {
        let before = self.provider.systems.lock().unwrap().len();
        self.daemon.send_user(&self.id, ChatMessage::user_text(text)).unwrap();
        for _ in 0..600 {
            if self.provider.systems.lock().unwrap().len() > before && self.idle() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let j = self.daemon.journal(&self.id).unwrap();
        let dump = serde_json::to_string(j.lock().unwrap().entries()).unwrap();
        panic!("le tour `{text}` ne s'est pas terminé : {}", &dump[dump.len().saturating_sub(3000)..]);
    }
    fn last_prompt(&self) -> String {
        self.provider.systems.lock().unwrap().back().cloned().unwrap_or_default()
    }
    fn journal_has(&self, needle: &str) -> bool {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        serde_json::to_string(j.entries()).unwrap().contains(needle)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn heartbeat_et_goal_par_commande_slash() {
    let Some(b) = banc() else { return };

    b.send("/heartbeat 1m coucou").await;
    let hb = b.hook.state(&b.id).heartbeat.expect("/heartbeat 1m coucou doit poser un heartbeat");
    assert_eq!(hb.interval_ms, 60_000);
    assert_eq!(hb.message, "coucou");
    assert!(b.last_prompt().contains("a installé un réveil"), "le modèle doit être prévenu");

    b.send("/heartbeat off").await;
    assert!(b.hook.state(&b.id).heartbeat.is_none(), "/heartbeat off doit l'arrêter");

    // axe:cmdnat — langage naturel (exemples réels refusés par la 0.1.62).
    b.send("/heartbeat dis coucou touets les 5secondes").await;
    let hb = b.hook.state(&b.id).heartbeat.expect("phrase libre comprise");
    assert_eq!((hb.interval_ms, hb.message.as_str()), (5_000, "coucou"));
    b.send("/heartbeat print coucou toutes les 5s").await;
    assert_eq!(b.hook.state(&b.id).heartbeat.unwrap().message, "coucou");
    b.send("/heartbeat arrête").await;
    assert!(b.hook.state(&b.id).heartbeat.is_none(), "« arrête » doit l'arrêter");
    // Pas compris : confié à l'agent, jamais « usage invalide ».
    b.send("/heartbeat dis coucou de temps en temps").await;
    assert!(b.hook.state(&b.id).heartbeat.is_none());
    let p = b.last_prompt();
    assert!(p.contains("pas été comprise") && p.contains("heartbeat.set") && !p.contains("Invalid"), "{}", &p[p.len().saturating_sub(800)..]);
    b.send("/heartbeat dis coucou toutes les 2 secondes").await;
    assert!(b.hook.state(&b.id).heartbeat.is_none() && b.last_prompt().contains("minimum"));

    b.send("/goal finir le lot 3").await;
    let g = b.hook.state(&b.id).goal.expect("goal posé");
    assert_eq!((g.text.as_str(), g.status.as_str()), ("finir le lot 3", "active"));

    b.send("/goal pause").await;
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "paused");
    b.send("/goal resume").await;
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "active");
    b.send("/goal done").await;
    let g = b.hook.state(&b.id).goal.expect("/goal done garde l'objectif");
    assert_eq!((g.text.as_str(), g.status.as_str()), ("finir le lot 3", "complete"));
    b.send("/goal clear").await;
    assert!(b.hook.state(&b.id).goal.is_none(), "/goal clear doit l'effacer");

    // axe:cmdnat — /goal en langage naturel.
    b.send("/goal migrer la base avec un budget de 200k jetons").await;
    let g = b.hook.state(&b.id).goal.expect("goal naturel");
    assert_eq!((g.text.as_str(), g.budget_tokens), ("migrer la base", Some(200_000)));
    // « /goal » seul : objectif rappelé UNE fois, en français (avant : deux fois, en anglais).
    b.send("/heartbeat dis coucou toutes les 5 minutes").await;
    b.send("/goal").await;
    let p = b.last_prompt();
    assert_eq!(p.matches("## Objectif de la session (en cours)").count(), 1, "{p}");
    assert!(p.contains("## Commande `/goal`") && p.contains("Toutes les 5 min") && p.contains("/heartbeat stop"), "{p}");
    for anglais in ["Session goal", "Slash command", "Every 300s", "to stop"] {
        assert!(!p.contains(anglais), "texte anglais « {anglais} » : {p}");
    }
    b.send("/heartbeat stop").await;
    b.send("/goal mets en pause").await;
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "paused");
    b.send("/goal reprends").await;
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "active");
    b.send("/goal c'est fini").await;
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "complete");
    b.send("/goal termine la migration").await;
    assert!(b.last_prompt().contains("pas été comprise"), "ambigu : confié à l'agent");
    b.send("/goal efface").await;
    assert!(b.hook.state(&b.id).goal.is_none());

    b.send("/autonomous --max-turns 1 relis").await;
    b.send("/autonomous stop").await;
    let a = b.hook.state(&b.id).autonomous.expect("autonomous");
    assert_eq!(a.status, "stopped");

    b.send("/compact garder les décisions").await;
    assert!(!b.last_prompt().contains("Call `compact.run"), "/compact ne passe plus par l'IA");
    assert!(b.journal_has("\"compaction\""), "/compact compacte directement");
}

/// Le heartbeat se déclenche (intervalle minimal 5 s) et son message est journalisé
/// comme message utilisateur balisé `<heartbeat>` (affiché par l'IDE en « réveil »).
#[tokio::test(flavor = "multi_thread")]
async fn heartbeat_se_declenche() {
    let Some(b) = banc() else { return };
    b.send("/heartbeat 5s coucou").await;
    for _ in 0..300 {
        if b.journal_has("\\ncoucou\\n</heartbeat>") && b.idle() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(b.journal_has("\\ncoucou\\n</heartbeat>"), "le réveil doit arriver dans le journal");
}

/// L'IDE arrête le heartbeat et met le goal en pause par `sessions.commands_set` :
/// le crochet le voit tout de suite (plus de réveil).
#[tokio::test(flavor = "multi_thread")]
async fn l_ide_arrete_heartbeat_et_goal() {
    let Some(b) = banc() else { return };
    b.send("/goal finir le lot 3").await;
    b.send("/heartbeat 5s coucou").await;
    let vue = b.daemon.dispatch(0, "sessions.commands_state", serde_json::json!({"sessionId": b.id})).await.unwrap();
    assert_eq!(vue["heartbeat"]["message"], "coucou");
    assert_eq!(vue["goal"]["status"], "active");
    b.daemon.dispatch(0, "sessions.commands_set", serde_json::json!({"sessionId": b.id, "op": "heartbeat_off"})).await.unwrap();
    let vue = b.daemon.dispatch(0, "sessions.commands_set", serde_json::json!({"sessionId": b.id, "op": "goal_pause"})).await.unwrap();
    assert!(vue["heartbeat"].is_null());
    assert_eq!(vue["goal"]["status"], "paused");
    assert!(b.hook.state(&b.id).heartbeat.is_none(), "le crochet relit l'état");
    assert_eq!(b.hook.state(&b.id).goal.unwrap().status, "paused");
    tokio::time::sleep(Duration::from_millis(6_500)).await;
    assert!(!b.journal_has("\ncoucou\n</heartbeat>"), "plus aucun réveil après l'arrêt");
}

/// axe:goal165 — une seule source : l'objectif survit au rechargement (nouveau
/// démon, nouveau crochet, même dossier de données) ; un arrêt depuis l'IDE est vu
/// tout de suite par `goal.get`, par le bloc d'état et par l'indicateur.
#[tokio::test(flavor = "multi_thread")]
async fn objectif_source_unique_et_rechargement() {
    let Some(mut b) = banc() else { return };
    b.send("/goal finir le lot 3").await;
    let (base, id) = (b.base.clone(), b.id.clone());
    b.keep = true;
    drop(b);
    let b = banc_sur(base, Some(id)).expect("banc rechargé");
    let vue = b.daemon.dispatch(0, "sessions.commands_state", serde_json::json!({"sessionId": b.id})).await.unwrap();
    assert_eq!((vue["goal"]["text"].as_str(), vue["goal"]["status"].as_str()), (Some("finir le lot 3"), Some("active")));
    b.send("bonjour").await;
    assert!(b.last_prompt().contains("## Objectif de la session (en cours)\nfinir le lot 3"), "bloc d'état après rechargement");
    assert_eq!(b.hook.state(&b.id).goal.unwrap().text, "finir le lot 3");
    b.daemon.dispatch(0, "sessions.commands_set", serde_json::json!({"sessionId": b.id, "op": "goal_clear"})).await.unwrap();
    assert!(b.hook.state(&b.id).goal.is_none());
    b.send("et maintenant ?").await;
    let p = b.last_prompt();
    assert!(!p.contains("## Objectif de la session"), "plus d'objectif dans le bloc d'état : {p}");
    assert!(p.contains("a arrêté l'objectif depuis l'interface"), "l'agent est prévenu");
}

/// axe:goal165 — objectif actif, AUCUN heartbeat : à la fin du tour l'agent est
/// relancé tout seul ; 3 relances de suite sans avancement => pause automatique.
#[tokio::test(flavor = "multi_thread")]
async fn objectif_relance_seul_puis_pause_sans_avancement() {
    let Some(b) = banc() else { return };
    b.hook.set_pursuit_delay(Duration::from_millis(100));
    b.send("/goal finir le lot 3").await;
    assert!(b.hook.state(&b.id).heartbeat.is_none(), "pas de heartbeat");
    let mut paused = false;
    for _ in 0..400 {
        let g = b.hook.state(&b.id).goal.unwrap();
        if g.status == "paused" && b.idle() {
            paused = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let g = b.hook.state(&b.id).goal.unwrap();
    assert!(paused, "pause automatique attendue : {g:?}");
    assert_eq!(g.relaunches, 3, "3 relances avant la pause : {g:?}");
    assert!(g.auto_pause.as_deref().unwrap_or("").contains("sans avancement"));
    assert!(b.journal_has("<goal_continue"), "relance journalisée comme message balisé");
    assert!(b.last_prompt().contains("Poursuite automatique de l'objectif"), "le tour relancé le sait");
    // En pause : plus aucune relance.
    let n = b.provider.systems.lock().unwrap().len();
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    assert_eq!(b.provider.systems.lock().unwrap().len(), n, "aucun tour après la pause");
    // L'utilisateur reprend : la poursuite repart, compteur remis à zéro.
    b.send("/goal reprends").await;
    let g = b.hook.state(&b.id).goal.unwrap();
    assert_eq!(g.status, "active");
    assert!(g.auto_pause.is_none());
    assert!(g.next_relaunch_ms.is_some() || g.relaunches > 3, "relance replanifiée : {g:?}");
}

/// Un message de l'utilisateur pendant la pause annule la relance prévue.
#[tokio::test(flavor = "multi_thread")]
async fn pas_de_relance_si_l_utilisateur_ecrit() {
    let Some(b) = banc() else { return };
    b.hook.set_pursuit_delay(Duration::from_millis(1_500));
    b.send("/goal finir le lot 3").await;
    assert!(b.hook.state(&b.id).goal.unwrap().next_relaunch_ms.is_some(), "relance planifiée");
    b.hook.set_pursuit_delay(Duration::from_secs(3600));
    b.send("autre chose").await; // le tour de l'utilisateur annule la relance prévue
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    assert!(!b.journal_has("<goal_continue"), "aucune relance : l'utilisateur a parlé");
    b.daemon.dispatch(0, "sessions.commands_set", serde_json::json!({"sessionId": b.id, "op": "goal_pause"})).await.unwrap();
    assert!(b.hook.state(&b.id).goal.unwrap().status == "paused");
}

// ------------------------------------------------------------ axe:guet

impl Banc {
    fn meta(&self) -> axecode_core::SessionMeta {
        self.daemon.list_metas().into_iter().find(|m| m.id == self.id).expect("session")
    }
    async fn guet(&self, method: &str, params: serde_json::Value) -> serde_json::Value {
        use axecode_app::repl::TurnHook;
        self.hook.host_call(&self.meta(), method, params).await.expect(method)
    }
    fn reveils(&self) -> usize {
        let j = self.daemon.journal(&self.id).unwrap();
        let j = j.lock().unwrap();
        serde_json::to_string(j.entries()).unwrap().matches("<guet id=").count()
    }
    async fn attendre_reveils(&self, n: usize, secondes: u64) {
        for _ in 0..secondes * 20 {
            if self.reveils() >= n && self.idle() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("{} réveil(s) de guet au lieu de {n}", self.reveils());
    }
}

/// Une commande qui finit => UN seul réveil, avec son code et la fin de sa sortie.
#[tokio::test(flavor = "multi_thread")]
async fn guet_commande_un_seul_reveil() {
    let Some(b) = banc() else { return };
    b.send("bonjour").await;
    let g = b.guet("guet.commande", serde_json::json!({"cmd": "echo construction-finie; exit 3", "message": "la construction"})).await;
    assert_eq!(g["genre"], "commande");
    assert_eq!(b.guet("guet.liste", serde_json::json!({})).await.as_array().unwrap().len(), 1);
    b.attendre_reveils(1, 20).await;
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    assert_eq!(b.reveils(), 1, "un seul réveil");
    assert!(b.journal_has("statut=\\\"termine\\\"") && b.journal_has("code de sortie 3") && b.journal_has("construction-finie"));
    assert!(b.last_prompt().contains("construction-finie"), "le réveil a lancé un tour");
    assert!(b.hook.state(&b.id).guets.is_empty(), "guet retiré après livraison");
}

/// Condition fausse deux fois, vraie au 3e essai => un réveil « condition remplie ».
#[tokio::test(flavor = "multi_thread")]
async fn guet_condition_vraie_au_troisieme_essai() {
    let Some(b) = banc() else { return };
    b.send("bonjour").await;
    let cmd = "n=$(cat compteur 2>/dev/null || echo 0); n=$((n+1)); echo $n > compteur; echo essai $n; [ $n -ge 3 ]";
    b.guet("guet.condition", serde_json::json!({"cmd": cmd, "intervalle_ms": 300})).await;
    b.attendre_reveils(1, 20).await;
    assert!(b.journal_has("statut=\\\"reussi\\\"") && b.journal_has("3 essais") && b.journal_has("essai 3"));
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    assert_eq!(std::fs::read_to_string(b.base.join("ws/compteur")).unwrap().trim(), "3", "plus d'essai après la réussite");
    assert_eq!(b.reveils(), 1);
}

/// Délai dépassé (commande trop longue, condition jamais vraie) => réveil « délai dépassé ».
#[tokio::test(flavor = "multi_thread")]
async fn guet_delai_depasse() {
    let Some(b) = banc() else { return };
    b.send("bonjour").await;
    b.guet("guet.commande", serde_json::json!({"cmd": "sleep 30", "timeout_ms": 1500})).await;
    b.guet("guet.condition", serde_json::json!({"cmd": "false", "intervalle_ms": 300, "timeout_ms": 1500})).await;
    b.attendre_reveils(2, 20).await;
    let j = b.daemon.journal(&b.id).unwrap();
    let texte = serde_json::to_string(j.lock().unwrap().entries()).unwrap();
    assert_eq!(texte.matches("statut=\\\"delai_depasse\\\"").count(), 2, "{}", &texte[texte.len().saturating_sub(2000)..]);
}

/// Annulé (par l'agent puis par l'IDE) => pas de réveil, la commande est tuée.
#[tokio::test(flavor = "multi_thread")]
async fn guet_annulation() {
    let Some(b) = banc() else { return };
    b.send("bonjour").await;
    let g = b.guet("guet.commande", serde_json::json!({"cmd": "sleep 2; touch fait"})).await;
    let r = b.guet("guet.annuler", serde_json::json!({"id": g["id"]})).await;
    assert_eq!(r["annules"][0], g["id"]);
    // Annulation depuis l'IDE (indicateur) : sessions.commands_set guet_annuler:<id>.
    let c = b.guet("guet.condition", serde_json::json!({"cmd": "false", "intervalle_ms": 200})).await;
    let vue = b.daemon.dispatch(0, "sessions.commands_state", serde_json::json!({"sessionId": b.id})).await.unwrap();
    assert_eq!(vue["guets"][0]["id"], c["id"]);
    let op = format!("guet_annuler:{}", c["id"].as_str().unwrap());
    let vue = b.daemon.dispatch(0, "sessions.commands_set", serde_json::json!({"sessionId": b.id, "op": op})).await.unwrap();
    assert_eq!(vue["guets"].as_array().map_or(0, Vec::len), 0);
    tokio::time::sleep(Duration::from_millis(3_500)).await;
    assert_eq!(b.reveils(), 0, "aucun réveil après annulation");
    assert!(!b.base.join("ws/fait").exists(), "la commande annulée a été tuée");
    b.send("et alors ?").await;
    assert!(b.last_prompt().contains("annulé le guet depuis l'interface"), "l'agent est prévenu");
}

/// Le guet vit dans le service, pas dans le noyau : rechargement complet du service
/// (nouveau démon, nouveau crochet, noyau neuf) => la condition est toujours guettée,
/// et une commande perdue au redémarrage réveille « interrompu ».
#[tokio::test(flavor = "multi_thread")]
async fn guet_survit_au_redemarrage() {
    let Some(mut b) = banc() else { return };
    b.send("bonjour").await;
    b.guet("guet.fichier", serde_json::json!({"chemin": "pret.txt", "intervalle_ms": 200})).await;
    b.guet("guet.commande", serde_json::json!({"cmd": "sleep 60"})).await;
    let (base, id) = (b.base.clone(), b.id.clone());
    b.keep = true;
    b.hook.stop_guets(); // le processus du service s'arrête
    drop(b);
    let b = banc_sur(base, Some(id)).expect("banc rechargé");
    let vue = b.daemon.dispatch(0, "sessions.commands_state", serde_json::json!({"sessionId": b.id})).await.unwrap();
    assert_eq!(vue["guets"].as_array().map_or(0, Vec::len), 2, "guets gardés dans l'état");
    b.send("me revoilà").await;
    b.attendre_reveils(1, 20).await;
    assert!(b.journal_has("statut=\\\"interrompu\\\""));
    std::fs::write(b.base.join("ws/pret.txt"), "ok").unwrap();
    b.attendre_reveils(2, 20).await;
    assert!(b.journal_has("statut=\\\"reussi\\\"") && b.journal_has("fichier pret.txt"));
}

/// axe:guet — `/guet` en langage courant : commande explicite posée, phrase libre
/// confiée à l'agent, « annule » arrête tout.
#[tokio::test(flavor = "multi_thread")]
async fn guet_par_commande_slash() {
    let Some(b) = banc() else { return };
    b.send("/guet quand la construction github est finie").await;
    assert!(b.hook.state(&b.id).guets.is_empty());
    let p = b.last_prompt();
    assert!(p.contains("## Commande `/guet`") && p.contains("guet.condition") && p.contains("gh run"), "{}", &p[p.len().saturating_sub(1200)..]);
    b.send("/guet dès que `test -f jamais.txt` réussit").await;
    let g = b.hook.state(&b.id).guets;
    assert_eq!((g.len(), g[0].genre.as_str(), g[0].par_utilisateur), (1, "condition", true));
    assert!(b.last_prompt().contains("## Guets en cours"), "bloc d'état");
    b.send("/guet anulle").await;
    assert!(b.hook.state(&b.id).guets.is_empty(), "« anulle » (faute) annule");
    assert!(b.last_prompt().contains("a annulé 1 guet"));
}
