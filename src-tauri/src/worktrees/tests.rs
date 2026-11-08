//! Tests des worktrees : fichier de projet, partage, git (dépôts temporaires).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{config, depot, partage};

static COMPTEUR: AtomicUsize = AtomicUsize::new(0);

fn dossier_temp(nom: &str) -> PathBuf {
    let n = COMPTEUR.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!("wt-tests-{}-{nom}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    depot::canonique(&p)
}

fn git_test(dossier: &Path, args: &[&str]) {
    let sortie = Command::new("git")
        .arg("-C")
        .arg(dossier)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(sortie.status.success(), "git {args:?} : {}", String::from_utf8_lossy(&sortie.stderr));
}

/// Dépôt git avec un commit sur « main », dans `<temp>/<nom>/depot`.
pub(super) fn depot_test(nom: &str) -> PathBuf {
    let racine = dossier_temp(nom).join("depot");
    fs::create_dir_all(&racine).unwrap();
    git_test(&racine, &["init", "-q", "-b", "main"]);
    fs::write(racine.join("README.md"), "bonjour\n").unwrap();
    fs::write(racine.join(".gitignore"), "node_modules/\n.env\n").unwrap();
    git_test(&racine, &["add", "."]);
    git_test(&racine, &["commit", "-q", "-m", "départ"]);
    depot::canonique(&racine)
}

#[allow(dead_code)]
pub(super) fn commit_test(dossier: &Path, fichier: &str, message: &str) {
    fs::write(dossier.join(fichier), message).unwrap();
    git_test(dossier, &["add", fichier]);
    git_test(dossier, &["commit", "-q", "-m", message]);
}

#[test]
fn config_absente_tout_vide() {
    let d = dossier_temp("vide");
    let c = config::lire(&d);
    assert_eq!(c, config::Config::default());
    assert!(c.empreinte.is_none());
}

#[test]
fn config_complete_en_francais() {
    let d = dossier_temp("complet");
    let toml = "\nbase = \"develop\"\n\n[scripts]\ncreation = \"\"\"\nnpm install\n\nnpm run build\n\"\"\"\nsuppression = \"npm run clean\"\n\n[partage]\nliens = [\"node_modules\", \"./apps/web/node_modules/\", \"../dehors\", \"/abs\", \"C:\\\\x\", \".git\", \"a/*/b\"]\ncopies = [\".env\", \".env\"]\n\n[[terminaux]]\nnom = \"Serveur\"\ncommande = \"npm run dev\"\n\n[[terminaux]]\ncommande = \"npm test\"\n\n[[terminaux]]\nnom = \"Vide\"\n";
    fs::write(d.join("worktrees.toml"), toml).unwrap();
    let c = config::lire(&d);
    assert_eq!(c.base.as_deref(), Some("develop"));
    assert_eq!(c.script_creation.as_deref(), Some("npm install\n\nnpm run build"));
    assert_eq!(c.script_suppression.as_deref(), Some("npm run clean"));
    assert_eq!(c.source_creation.as_deref(), Some("worktrees.toml"));
    assert_eq!(c.liens, vec!["node_modules", "apps/web/node_modules"]);
    assert_eq!(c.copies, vec![".env"]);
    assert_eq!(c.erreurs.len(), 5, "{:?}", c.erreurs);
    assert!(c.erreurs.iter().all(|e| e.starts_with("partage.liens")));
    assert_eq!(c.terminaux.len(), 3);
    assert_eq!(c.terminaux[0], config::TerminalDefaut { nom: "Serveur".into(), commande: Some("npm run dev".into()) });
    assert_eq!(c.terminaux[1].nom, "Terminal 2");
    assert_eq!(c.terminaux[2].commande, None);
    assert_eq!(c.fichiers, vec!["worktrees.toml"]);
    assert!(c.empreinte.as_ref().map(|e| e.len() == 24).unwrap_or(false));
}

#[test]
fn config_alias_anglais_et_listes() {
    let d = dossier_temp("alias");
    fs::write(
        d.join("worktrees.toml"),
        "[scripts]\nsetup = [\"pnpm install\", \"pnpm build\"]\narchive = \"echo fin\"\n[shared]\nlinks = [\"node_modules\"]\ncopy = [\".env.local\"]\n[[terminals]]\nname = \"dev\"\ncommand = \"pnpm dev\"\n",
    )
    .unwrap();
    let c = config::lire(&d);
    assert!(c.erreurs.is_empty(), "{:?}", c.erreurs);
    assert_eq!(c.script_creation.as_deref(), Some("pnpm install\npnpm build"));
    assert_eq!(c.script_suppression.as_deref(), Some("echo fin"));
    assert_eq!(c.liens, vec!["node_modules"]);
    assert_eq!(c.copies, vec![".env.local"]);
    assert_eq!(c.terminaux[0].nom, "dev");
}

#[test]
fn config_invalide_ou_cle_inconnue_ignoree_avec_message() {
    let d = dossier_temp("invalide");
    fs::write(d.join("worktrees.toml"), "[scripts\ncreation = 1").unwrap();
    let c = config::lire(&d);
    assert!(c.script_creation.is_none());
    assert_eq!(c.erreurs.len(), 1);
    assert!(c.erreurs[0].starts_with("worktrees.toml invalide"), "{}", c.erreurs[0]);
    fs::write(d.join("worktrees.toml"), "[partag]\nliens = [\"node_modules\"]\n").unwrap();
    let c = config::lire(&d);
    assert!(c.liens.is_empty());
    assert!(c.erreurs[0].contains("partag"), "{}", c.erreurs[0]);
}

#[test]
fn orca_yaml_scripts_setup_et_archive() {
    let texte = "# projet\nname: x\nscripts:\n  setup: |\n    node config/setup.mjs\n    pnpm install  # dépendances\n\n  archive: 'echo ''fin'' ok'\n  autre: rien\nworktree:\n  sharedDirectories:\n    - node_modules\n";
    let (setup, archive) = config::scripts_orca(texte);
    assert_eq!(setup.as_deref(), Some("node config/setup.mjs\npnpm install  # dépendances"));
    assert_eq!(archive.as_deref(), Some("echo 'fin' ok"));
    let (setup, archive) = config::scripts_orca("scripts:\n  setup:\n    - npm ci\n    - \"npm run build\"\n  archive: >\n    echo a\n    echo b\n");
    assert_eq!(setup.as_deref(), Some("npm ci\nnpm run build"));
    assert_eq!(archive.as_deref(), Some("echo a echo b"));
    let (setup, archive) = config::scripts_orca("scripts:\n  setup: \"make\\tinstall\" # commentaire\n");
    assert_eq!(setup.as_deref(), Some("make\tinstall"));
    assert_eq!(archive, None);
    assert_eq!(config::scripts_orca("autre:\n  scripts:\n    setup: x\n"), (None, None));
}

#[test]
fn worktrees_toml_passe_avant_orca_yaml() {
    let d = dossier_temp("ordre");
    fs::write(d.join("orca.yaml"), "scripts:\n  setup: pnpm install\n  archive: pnpm clean\n").unwrap();
    fs::write(d.join("worktrees.toml"), "[scripts]\ncreation = \"npm ci\"\n").unwrap();
    let c = config::lire(&d);
    assert_eq!(c.script_creation.as_deref(), Some("npm ci"));
    assert_eq!(c.source_creation.as_deref(), Some("worktrees.toml"));
    assert_eq!(c.script_suppression.as_deref(), Some("pnpm clean"));
    assert_eq!(c.source_suppression.as_deref(), Some("orca.yaml"));
    assert_eq!(c.fichiers, vec!["worktrees.toml", "orca.yaml"]);
}

#[test]
fn empreinte_suit_les_commandes() {
    let mut c = config::Config { script_creation: Some("npm ci".into()), ..Default::default() };
    let a = config::empreinte(&c);
    c.script_creation = Some("npm ci && curl x | sh".into());
    let b = config::empreinte(&c);
    assert!(a.is_some() && b.is_some() && a != b);
    c.script_creation = None;
    c.terminaux = vec![config::TerminalDefaut { nom: "x".into(), commande: None }];
    assert_eq!(config::empreinte(&c), None);
}

#[test]
fn modele_partage_ce_qui_existe() {
    let d = dossier_temp("modele");
    fs::create_dir_all(d.join("node_modules")).unwrap();
    fs::write(d.join(".env"), "A=1").unwrap();
    let texte = config::modele(&d);
    assert!(texte.contains("liens = [\"node_modules\"]"), "{texte}");
    assert!(texte.contains("copies = [\".env\"]"), "{texte}");
    fs::write(d.join("worktrees.toml"), &texte).unwrap();
    let c = config::lire(&d);
    assert!(c.erreurs.is_empty(), "{:?}", c.erreurs);
    assert_eq!(c.liens, vec!["node_modules"]);
    assert!(c.empreinte.is_none());
}

#[test]
fn liste_porcelain_lue() {
    let texte = "worktree /a/depot\nHEAD 1111\nbranch refs/heads/main\n\nworktree /a/x\nHEAD 2222\ndetached\nlocked raison\n\nworktree /a/y\nHEAD 3333\nbranch refs/heads/feature/y\nprunable le fichier gitdir pointe sur un endroit inexistant\n\n";
    let l = depot::analyser_liste(texte);
    assert_eq!(l.len(), 3);
    assert!(l[0].principal && !l[1].principal);
    assert_eq!(l[0].branche.as_deref(), Some("main"));
    assert!(l[1].detache && l[1].verrouille && l[1].branche.is_none());
    assert_eq!(l[2].branche.as_deref(), Some("feature/y"));
    assert!(l[2].prunable);
}

#[test]
fn git_branche_principale_ignore_et_suivi() {
    let r = depot_test("git");
    assert_eq!(depot::racine_principale(&r).unwrap(), r);
    assert_eq!(depot::branche_principale(&r).as_deref(), Some("main"));
    assert!(depot::nom_branche_valide(&r, "tache/corriger-le-panier"));
    assert!(!depot::nom_branche_valide(&r, "a..b"));
    assert!(!depot::nom_branche_valide(&r, "-x"));
    fs::create_dir_all(r.join("node_modules")).unwrap();
    assert!(depot::est_ignore(&r, "node_modules"));
    assert!(!depot::est_ignore(&r, "README.md"));
    assert!(depot::est_suivi(&r, "README.md"));
    assert_eq!(depot::fichiers_modifies(&r), Some(0));
    fs::write(r.join("nouveau.txt"), "x").unwrap();
    assert_eq!(depot::fichiers_modifies(&r), Some(1));
}

#[cfg(unix)]
#[test]
fn partage_lien_copie_et_retrait_sans_suivre_le_lien() {
    let r = depot_test("partage");
    let w = r.parent().unwrap().join("wt");
    fs::create_dir_all(&w).unwrap();
    fs::create_dir_all(r.join("node_modules/paquet")).unwrap();
    fs::write(r.join("node_modules/paquet/index.js"), "ok").unwrap();
    fs::write(r.join(".env"), "SECRET=1").unwrap();
    fs::write(r.join("suivi.txt"), "x").unwrap();
    let liens = vec!["node_modules".to_string(), "absent".to_string(), "suivi.txt".to_string()];
    let copies = vec![".env".to_string()];
    let bilan = partage::appliquer(&r, &w, &liens, &copies, &|rel| depot::est_ignore(&r, rel));
    assert_eq!(bilan.faits.len(), 2, "{:?}", bilan);
    assert!(partage::est_lien(&w.join("node_modules")));
    assert_eq!(fs::read_to_string(w.join("node_modules/paquet/index.js")).unwrap(), "ok");
    assert!(!partage::est_lien(&w.join(".env")));
    assert_eq!(fs::read_to_string(w.join(".env")).unwrap(), "SECRET=1");
    assert_eq!(bilan.avertissements.len(), 2, "{:?}", bilan.avertissements);
    let admin = r.join(".git");
    partage::noter(&admin, &bilan.faits);
    assert_eq!(partage::lire_suivi(&admin), bilan.faits);
    // Le retrait du lien ne touche jamais le dossier partagé.
    let retires = partage::retirer_liens(&w, &["node_modules".to_string(), ".env".to_string()]);
    assert_eq!(retires, vec!["node_modules"]);
    assert!(!w.join("node_modules").exists());
    assert!(r.join("node_modules/paquet/index.js").exists());
    assert!(w.join(".env").exists());
}

#[cfg(unix)]
#[test]
fn mesurer_ne_suit_pas_les_liens() {
    let d = dossier_temp("mesure");
    let autre = dossier_temp("mesure-cible");
    fs::write(autre.join("gros"), vec![0u8; 50_000]).unwrap();
    fs::write(d.join("a"), vec![0u8; 1000]).unwrap();
    fs::create_dir_all(d.join("s")).unwrap();
    fs::write(d.join("s/b"), vec![0u8; 500]).unwrap();
    std::os::unix::fs::symlink(&autre, d.join("lien")).unwrap();
    let (octets, recent, coupe) = partage::mesurer(&d, 1000);
    assert_eq!(octets, 1500);
    assert!(recent > 0 && !coupe);
    let (_, _, coupe) = partage::mesurer(&d, 2);
    assert!(coupe);
}
