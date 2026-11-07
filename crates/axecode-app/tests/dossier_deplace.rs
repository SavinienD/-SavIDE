//! Un dossier local renommé ou déplacé est retrouvé (identité stable), et ses
//! conversations le suivent avec tout leur historique.
use std::path::Path;

use axecode_app::dossiers::{identite, retrouver, Limites, Registre};
use axecode_app::store::AppStore;
use axecode_app::workspace::normalize_workspace_root;
use axecode_core::{ChatMessage, ModelRef};

fn racine(p: &Path) -> String {
    normalize_workspace_root(p).unwrap().display().to_string()
}

#[test]
fn renomme_dans_le_meme_parent_est_retrouve() {
    let tmp = tempfile::tempdir().unwrap();
    let ancien = tmp.path().join("projet");
    std::fs::create_dir_all(ancien.join("src")).unwrap();
    std::fs::create_dir_all(tmp.path().join("voisin")).unwrap();
    let id = identite(&ancien);
    assert!(id.fs.is_some(), "identifiant du système de fichiers lu");
    let nouveau = tmp.path().join("projet-renomme");
    std::fs::rename(&ancien, &nouveau).unwrap();
    // Aujourd'hui : l'ouverture de l'ancien chemin échoue.
    assert!(normalize_workspace_root(&ancien).is_err());
    let trouve = retrouver(&ancien, &id, &[], &Limites::default()).expect("retrouvé");
    assert_eq!(trouve.canonicalize().unwrap(), nouveau.canonicalize().unwrap());
}

#[test]
fn deplace_deux_niveaux_plus_haut_ou_dans_un_autre_dossier_recent() {
    let tmp = tempfile::tempdir().unwrap();
    let ancien = tmp.path().join("a/b/c/projet");
    std::fs::create_dir_all(&ancien).unwrap();
    let id = identite(&ancien);
    let ailleurs = tmp.path().join("x/y");
    std::fs::create_dir_all(&ailleurs).unwrap();
    let nouveau = ailleurs.join("projet");
    std::fs::rename(&ancien, &nouveau).unwrap();
    let trouve = retrouver(&ancien, &id, &[], &Limites::default()).expect("retrouvé via les ancêtres");
    assert_eq!(trouve.canonicalize().unwrap(), nouveau.canonicalize().unwrap());

    // Hors de portée des ancêtres, mais sous la racine d'un autre dossier récent.
    let loin = tempfile::tempdir().unwrap();
    let cible = loin.path().join("archives/projet");
    std::fs::create_dir_all(loin.path().join("archives")).unwrap();
    let id2 = identite(&nouveau);
    // Déplacement entre deux dossiers temporaires : même système de fichiers (rename).
    if std::fs::rename(&nouveau, &cible).is_ok() {
        let lim = Limites { profondeur_ancetres: 0, ..Limites::default() };
        assert!(retrouver(&nouveau, &id2, &[], &lim).is_none());
        let trouve = retrouver(&nouveau, &id2, &[loin.path().to_path_buf()], &lim).expect("racine d'un récent");
        assert_eq!(trouve.canonicalize().unwrap(), cible.canonicalize().unwrap());
    }
}

#[test]
fn seule_une_correspondance_sure_est_acceptee() {
    let tmp = tempfile::tempdir().unwrap();
    let ancien = tmp.path().join("projet");
    std::fs::create_dir_all(&ancien).unwrap();
    let id = identite(&ancien);
    std::fs::remove_dir_all(&ancien).unwrap();
    // Un dossier du même nom recréé n'est PAS le même dossier.
    std::fs::create_dir_all(tmp.path().join("projet-copie")).unwrap();
    let autre = tmp.path().join("projet");
    std::fs::create_dir_all(&autre).unwrap();
    let id_autre = identite(&autre);
    std::fs::remove_dir_all(&autre).unwrap();
    if id_autre.fs != id.fs {
        assert!(retrouver(&ancien, &id, &[], &Limites::default()).is_none());
    }
    // Sans identifiant : jamais de correspondance devinée.
    let vide = axecode_app::dossiers::Identite { nom: "projet".into(), ..Default::default() };
    assert!(retrouver(&ancien, &vide, &[], &Limites::default()).is_none());
}

#[test]
fn le_registre_garde_l_identite_et_suit_le_nouveau_chemin() {
    let tmp = tempfile::tempdir().unwrap();
    let ancien = tmp.path().join("projet");
    std::fs::create_dir_all(&ancien).unwrap();
    let reg = Registre::dans(&tmp.path().join("donnees"));
    let cle = racine(&ancien);
    reg.enregistrer(Path::new(&cle));
    let nouveau = tmp.path().join("projet-2");
    std::fs::rename(&ancien, &nouveau).unwrap();
    let id = reg.identite_de(&cle).expect("identité enregistrée à l'ouverture");
    let trouve = retrouver(Path::new(&cle), &id, &[], &Limites::default()).unwrap();
    let cle2 = racine(&trouve);
    reg.renommer(&cle, &cle2);
    assert!(reg.identite_de(&cle).is_none());
    assert_eq!(reg.identite_de(&cle2).unwrap().fs, id.fs);
}

#[test]
fn l_historique_des_conversations_suit_le_dossier() {
    let tmp = tempfile::tempdir().unwrap();
    let store = AppStore::open_at(tmp.path().join("state.sqlite3")).unwrap();
    let ancien = tmp.path().join("projet");
    std::fs::create_dir_all(&ancien).unwrap();
    let cle = racine(&ancien);
    let model = ModelRef::new("test", "model");
    let boot = store.bootstrap_workspace(Path::new(&cle), &model, "sys").unwrap();
    let conv = boot.active_conversation.id.clone();
    store.append_conversation_message(&cle, &conv, &ChatMessage::user_text("bonjour")).unwrap();
    let deux = store.create_conversation(&cle, &model, "sys").unwrap();
    store.append_conversation_message(&cle, &deux.id, &ChatMessage::user_text("deuxième")).unwrap();

    let nouveau = tmp.path().join("projet-renomme");
    std::fs::rename(&ancien, &nouveau).unwrap();
    let cle2 = racine(&nouveau);
    // L'utilisateur l'avait déjà rouvert « à la main » : conversation vide créée au nouveau chemin.
    store.bootstrap_workspace(Path::new(&cle2), &model, "sys").unwrap();

    let deplacees = store.deplacer_espace(&cle, &cle2).unwrap();
    assert_eq!(deplacees.len(), 2);
    let boot2 = store.bootstrap_workspace(Path::new(&cle2), &model, "sys").unwrap();
    assert_eq!(boot2.conversations.len(), 2, "pas de conversation vide en trop");
    let c = store.load_conversation(&cle2, &conv).unwrap().expect("conversation retrouvée");
    assert_eq!(c.history.len(), 1);
    assert_eq!(c.workspace_id, cle2);
    assert!(store.list_conversations(&cle).unwrap().is_empty());
}


#[test]
fn les_recents_ouverts_avant_la_mise_a_jour_sont_notes() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    std::fs::create_dir_all(&a).unwrap();
    let reg = Registre::dans(&tmp.path().join("donnees"));
    let cle = racine(&a);
    let absent = tmp.path().join("absent").display().to_string();
    assert_eq!(reg.noter_absents(&[cle.clone(), absent.clone(), "axe-cloud://x/work".into()]), 1);
    assert_eq!(reg.noter_absents(&[cle.clone()]), 0, "déjà noté");
    assert!(reg.identite_de(&cle).unwrap().fs.is_some());
    assert!(reg.identite_de(&absent).is_none());
}

