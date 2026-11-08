//! Agents en ligne de commande dans la file des agents externes : programme et
//! arguments résolus par l'appelant, consigne sur l'entrée standard ou dans les
//! arguments, dossier et environnement de l'agent.
#![cfg(unix)]

use std::{collections::BTreeMap, path::PathBuf, time::Duration};

use axecode_agents::{AgentStore, AgentsConfig, LancementCli, Statut};

fn dossier_temporaire(nom: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("agents-cli-{nom}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn lancement(dossier: &std::path::Path, script: &str, prompt_stdin: bool) -> LancementCli {
    let mut env = BTreeMap::new();
    env.insert("FAUX_REGLAGE".to_string(), "oui".to_string());
    LancementCli {
        cli: "faux".into(),
        programme: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        dossier: dossier.display().to_string(),
        env,
        prompt_stdin,
    }
}

async fn attendre_fin(store: &AgentStore, id: &str) -> axecode_agents::StatusView {
    for _ in 0..200 {
        store.supervise();
        let v = store.status(id).unwrap();
        if v.statut.is_terminal() {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("la tâche {id} ne s'est pas terminée");
}

#[tokio::test]
async fn consigne_sur_l_entree_standard_dans_le_dossier_de_l_agent() {
    let base = dossier_temporaire("stdin");
    let projet = base.join("projet");
    std::fs::create_dir_all(&projet).unwrap();
    let store = AgentStore::open_at(&projet, &base.join("file"), AgentsConfig::default()).unwrap();
    let script = r#"echo "dossier=$(pwd)"; echo "reglage=$FAUX_REGLAGE terme=$TERM"; printf 'consigne='; cat; echo; exit 3"#;
    let s = store
        .spawn_cli("Corrige le test\nsur deux lignes".into(), Some("essai".into()), None, lancement(&projet, script, true))
        .unwrap();
    let v = attendre_fin(&store, &s.id).await;
    assert_eq!(v.statut, Statut::Erreur, "{}", v.journal);
    assert_eq!(v.code_sortie, Some(3));
    let journal = std::fs::read_to_string(store.root().join(&s.id).join("journal.log")).unwrap();
    assert!(journal.contains(&format!("dossier={}", projet.canonicalize().unwrap().display())), "{journal}");
    assert!(journal.contains("reglage=oui terme=dumb"), "{journal}");
    assert!(journal.contains("consigne=Corrige le test\nsur deux lignes"), "{journal}");
    let liste = store.list();
    assert_eq!(liste[0].commande, "cli:faux");
    assert_eq!(liste[0].label, "essai");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn consigne_dans_les_arguments_entree_standard_fermee() {
    let base = dossier_temporaire("argv");
    let store = AgentStore::open_at(&base, &base.join("file"), AgentsConfig::default()).unwrap();
    let s = store
        .spawn_cli("p".into(), None, None, lancement(&base, "cat; echo fin-sans-blocage", false))
        .unwrap();
    let v = attendre_fin(&store, &s.id).await;
    assert_eq!(v.statut, Statut::Termine, "{}", v.journal);
    assert!(v.journal.contains("fin-sans-blocage"));
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn dossier_absent_ou_programme_vide_refuses() {
    let base = dossier_temporaire("refus");
    let store = AgentStore::open_at(&base, &base.join("file"), AgentsConfig::default()).unwrap();
    let absent = base.join("absent");
    assert!(store.spawn_cli("p".into(), None, None, lancement(&absent, "true", false)).is_err());
    let mut vide = lancement(&base, "true", false);
    vide.programme = " ".into();
    assert!(store.spawn_cli("p".into(), None, None, vide).is_err());
    assert!(store.spawn_cli(" ".into(), None, None, lancement(&base, "true", false)).is_err(), "consigne vide");
    assert!(store.list().is_empty(), "rien ne reste de ces essais");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn arret_d_un_agent_et_etat_relu_au_redemarrage() {
    let base = dossier_temporaire("arret");
    let store = AgentStore::open_at(&base, &base.join("file"), AgentsConfig::default()).unwrap();
    let s = store.spawn_cli("p".into(), None, None, lancement(&base, "sleep 30", false)).unwrap();
    assert_eq!(store.stop(&s.id).unwrap().statut, Statut::Arrete);
    let relu = AgentStore::open_at(&base, &base.join("file"), AgentsConfig::default()).unwrap();
    let v = relu.status(&s.id).unwrap();
    assert_eq!(v.statut, Statut::Arrete);
    let etat: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(relu.root().join(&s.id).join("etat.json")).unwrap()).unwrap();
    assert_eq!(etat["lancement"]["cli"], "faux", "le lancement est gardé dans etat.json");
    let _ = std::fs::remove_dir_all(&base);
}
