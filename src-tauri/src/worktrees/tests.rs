//! Tests des worktrees : fichier de projet, partage, git (dépôts temporaires).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{config, depot, partage, script};

static COMPTEUR: AtomicUsize = AtomicUsize::new(0);

fn dossier_temp(nom: &str) -> PathBuf {
    let n = COMPTEUR.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!("wt-tests-{}-{nom}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    depot::canonique(&p)
}

fn git_test(dossier: &Path, args: &[&str]) {
    let sortie = crate::__nw_std("git")
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

// ---------------------------------------------------------------------------
// Tâches de fond (création, script, reprise, annulation).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::taches;

#[derive(Default)]
struct HoteTest {
    publications: Mutex<Vec<taches::Tache>>,
    sortie: Mutex<String>,
    terminaux: Mutex<HashMap<String, taches::Joignable>>,
}

impl taches::Hote for HoteTest {
    fn publier(&self, tache: &taches::Tache) {
        self.publications.lock().unwrap().push(tache.clone());
    }
    fn sortie(&self, _id: &str, _debut: u64, texte: &str) {
        self.sortie.lock().unwrap().push_str(texte);
    }
    fn terminal_ouvert(&self, session: &str, terminal: taches::Joignable) {
        self.terminaux.lock().unwrap().insert(session.to_string(), terminal);
    }
    fn terminal_ferme(&self, session: &str, token: &str) {
        let mut t = self.terminaux.lock().unwrap();
        if t.get(session).map(|j| j.token == token).unwrap_or(false) {
            t.remove(session);
        }
    }
}

fn tache(id: &str) -> taches::Tache {
    taches::lister().into_iter().find(|t| t.id == id).expect("tâche inconnue")
}

fn attendre(id: &str, condition: impl Fn(&taches::Tache) -> bool) -> taches::Tache {
    let debut = Instant::now();
    loop {
        let t = tache(id);
        if condition(&t) {
            return t;
        }
        assert!(debut.elapsed() < Duration::from_secs(60), "délai dépassé : {:?} {:?} {}", t.etat, t.etape, t.message);
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn finie(id: &str) -> taches::Tache {
    attendre(id, |t| t.etat != taches::Etat::EnCours)
}

fn demande(depot: &Path, branche: &str, lancer: bool, empreinte: Option<String>) -> taches::DemandeCreation {
    taches::DemandeCreation {
        depot: depot.display().to_string(),
        titre: format!("Tâche {branche}"),
        branche: branche.to_string(),
        base: None,
        lancer_script: lancer,
        empreinte,
    }
}

#[test]
fn slug_et_dossier_libre() {
    assert_eq!(taches::slug("Corriger le bug du panier !"), "corriger-le-bug-du-panier");
    assert_eq!(taches::slug("Été 2026 : Œuvre à l'œil"), "ete-2026-oeuvre-a-l-oeil");
    assert_eq!(taches::slug("feature/Login"), "feature-login");
    assert_eq!(taches::slug("***"), "tache");
    assert!(taches::slug(&"mot ".repeat(40)).len() <= 48);
    let r = depot_test("libre");
    let liste = depot::lister(&r).unwrap();
    let premier = taches::chemin_libre(&r, "ma/tache", &liste).unwrap();
    assert_eq!(premier, r.parent().unwrap().join("depot-worktrees").join("ma-tache"));
    fs::create_dir_all(&premier).unwrap();
    let second = taches::chemin_libre(&r, "ma/tache", &liste).unwrap();
    assert_eq!(second.file_name().unwrap(), "ma-tache-2");
}

#[cfg(unix)]
#[test]
fn creation_complete_partage_et_script_visible() {
    let r = depot_test("creation");
    fs::create_dir_all(r.join("node_modules/paquet")).unwrap();
    fs::write(r.join(".env"), "CLE=1").unwrap();
    fs::write(
        r.join("worktrees.toml"),
        "[scripts]\ncreation = \"\"\"\necho prepare > fait.txt\necho \"branche=$WORKTREE_BRANCH\"\n\"\"\"\n[partage]\nliens = [\"node_modules\"]\ncopies = [\".env\"]\n",
    )
    .unwrap();
    let cfg = config::lire(&r);
    let hote = Arc::new(HoteTest::default());
    let t = taches::preparer_creation(&demande(&r, "corriger-le-panier", true, cfg.empreinte.clone())).unwrap();
    assert_eq!(t.etapes, vec![taches::Etape::Git, taches::Etape::Partage, taches::Etape::Script, taches::Etape::Fin]);
    assert_eq!(t.base.as_deref(), Some("main"));
    let id = taches::lancer(hote.clone(), t).id;
    let t = finie(&id);
    assert_eq!(t.etat, taches::Etat::Reussi, "{} {:?}", t.message, t.detail);
    assert!(t.pret);
    let dossier = PathBuf::from(&t.dossier);
    assert!(depot::lister(&r).unwrap().iter().any(|w| depot::meme_chemin(&w.chemin, &dossier)));
    assert_eq!(depot::branche_courante(&dossier).as_deref(), Some("corriger-le-panier"));
    assert!(partage::est_lien(&dossier.join("node_modules")));
    assert_eq!(fs::read_to_string(dossier.join(".env")).unwrap(), "CLE=1");
    assert_eq!(fs::read_to_string(dossier.join("fait.txt")).unwrap().trim(), "prepare");
    assert_eq!(t.script.as_ref().and_then(|s| s.code), Some(0));
    assert!(hote.sortie.lock().unwrap().contains("branche=corriger-le-panier"));
    assert!(taches::sortie(&id).unwrap().0.contains("branche=corriger-le-panier"));
    assert!(hote.terminaux.lock().unwrap().is_empty(), "terminal du script rendu");
    // Le worktree est utilisable dès la fin du partage (avant la fin du script).
    let pubs = hote.publications.lock().unwrap();
    let premier_pret = pubs.iter().position(|p| p.pret).unwrap();
    assert!(pubs[premier_pret].etape == taches::Etape::Script);
    assert_eq!(depot::fichiers_modifies(&dossier), Some(1), "seul fait.txt est nouveau (lien et .env ignorés)");
    // « node_modules/ » ne cache pas un lien : le chemin est exclu une fois dans info/exclude.
    let exclude = fs::read_to_string(r.join(".git/info/exclude")).unwrap();
    assert_eq!(exclude.matches("\n/node_modules\n").count(), 1, "{exclude}");
    assert!(partage::exclure(&r.join(".git"), &["node_modules".to_string()]).is_empty());
}

#[cfg(unix)]
#[test]
fn script_sans_accord_puis_accepte_et_relance() {
    let r = depot_test("accord");
    fs::write(r.join("worktrees.toml"), "[scripts]\ncreation = \"exit 3\"\n").unwrap();
    let hote = Arc::new(HoteTest::default());
    let id = taches::lancer(hote.clone(), taches::preparer_creation(&demande(&r, "accord", true, None)).unwrap()).id;
    let t = finie(&id);
    assert_eq!(t.etat, taches::Etat::Echec);
    assert_eq!(t.raison.as_deref(), Some("empreinte"));
    assert!(t.pret && PathBuf::from(&t.dossier).is_dir(), "le worktree reste");
    // Accord donné : le script tourne et échoue (code 3) ; corrigé, il passe.
    let empreinte = config::lire(&r).empreinte;
    taches::reprendre(hote.clone(), &id, taches::Reprise { empreinte: empreinte.clone(), ..Default::default() }).unwrap();
    let t = finie(&id);
    assert_eq!(t.raison.as_deref(), Some("script"), "{}", t.message);
    assert_eq!(t.script.as_ref().and_then(|s| s.code), Some(3));
    fs::write(r.join("worktrees.toml"), "[scripts]\ncreation = \"true\"\n").unwrap();
    assert!(taches::reprendre(hote.clone(), &id, taches::Reprise::default()).is_ok());
    assert_eq!(finie(&id).raison.as_deref(), Some("empreinte"), "fichier modifié : nouvel accord demandé");
    let empreinte = config::lire(&r).empreinte;
    taches::reprendre(hote.clone(), &id, taches::Reprise { empreinte, ..Default::default() }).unwrap();
    assert_eq!(finie(&id).etat, taches::Etat::Reussi);
    assert!(taches::reprendre(hote, &id, taches::Reprise::default()).is_err(), "déjà finie");
}

#[cfg(unix)]
#[test]
fn arreter_le_script_garde_le_worktree() {
    let r = depot_test("arret");
    fs::write(r.join("worktrees.toml"), "[scripts]\ncreation = \"sleep 30\"\n").unwrap();
    let hote = Arc::new(HoteTest::default());
    let empreinte = config::lire(&r).empreinte;
    let id = taches::lancer(hote.clone(), taches::preparer_creation(&demande(&r, "arret", true, empreinte)).unwrap()).id;
    attendre(&id, |t| t.script.as_ref().map(|s| s.en_cours).unwrap_or(false));
    let debut = Instant::now();
    taches::annuler(&id).unwrap();
    let t = finie(&id);
    assert!(debut.elapsed() < Duration::from_secs(10));
    assert_eq!(t.etat, taches::Etat::Annule);
    assert!(t.message.contains("Préparation arrêtée"), "{}", t.message);
    assert!(PathBuf::from(&t.dossier).is_dir());
    assert!(taches::oublier(&id).is_ok());
    assert!(taches::lister().iter().all(|x| x.id != id));
}

#[test]
fn dossier_deja_la_jamais_efface() {
    let r = depot_test("protege");
    let hote = Arc::new(HoteTest::default());
    let t = taches::preparer_creation(&demande(&r, "protege", false, None)).unwrap();
    let dossier = PathBuf::from(&t.dossier);
    fs::create_dir_all(&dossier).unwrap();
    fs::write(dossier.join("a-moi.txt"), "précieux").unwrap();
    let id = taches::lancer(hote, t).id;
    let t = finie(&id);
    assert_eq!(t.etat, taches::Etat::Echec);
    assert_eq!(t.raison.as_deref(), Some("dossier"));
    assert_eq!(fs::read_to_string(dossier.join("a-moi.txt")).unwrap(), "précieux");
    assert!(!depot::branche_locale_existe(&r, "protege"));
}

#[test]
fn branche_existante_reprise_et_branche_deja_ouverte_refusee() {
    let r = depot_test("existante");
    git_test(&r, &["branch", "deja"]);
    let hote = Arc::new(HoteTest::default());
    let t = taches::preparer_creation(&demande(&r, "deja", false, None)).unwrap();
    assert_eq!(t.base, None);
    let id = taches::lancer(hote, t).id;
    let t = finie(&id);
    assert_eq!(t.etat, taches::Etat::Reussi, "{:?}", t.detail);
    assert_eq!(depot::branche_courante(Path::new(&t.dossier)).as_deref(), Some("deja"));
    let refus = taches::preparer_creation(&demande(&r, "deja", false, None)).unwrap_err();
    assert!(refus.contains("déjà ouverte"), "{refus}");
    let refus = taches::preparer_creation(&demande(&r, "a..b", false, None)).unwrap_err();
    assert!(refus.contains("invalide"), "{refus}");
    let mut d = demande(&r, "nouvelle", false, None);
    d.base = Some("introuvable".into());
    assert!(taches::preparer_creation(&d).unwrap_err().contains("introuvable"));
}

#[test]
fn texte_des_scripts() {
    let q = "'";
    let posix = script::texte_posix("npm ci\n\n# commentaire\necho 'a'\n");
    assert!(posix.starts_with("set -e\n"));
    assert!(posix.contains("\nnpm ci\n"));
    let echappe = format!("{q}\\{q}{q}");
    let attendu = format!("{q}echo {e}a{e}{q}", e = echappe);
    assert!(posix.contains(&attendu), "{posix}");
    assert!(!posix.contains("commentaire"));
    let ps = script::texte_powershell("npm ci\necho 'a'");
    assert!(ps.contains("$ErrorActionPreference = 'Stop'"));
    let ligne = format!("Write-Host {q}> echo {q}{q}a{q}{q}{q} -ForegroundColor DarkGray");
    assert!(ps.contains(&ligne), "{ps}");
    assert!(ps.contains("npm ci\r\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"));
    assert!(ps.ends_with("exit 0\r\n"));
    // -EncodedCommand : UTF-16LE puis base64 (« a » = 61 00).
    assert_eq!(script::encoder_powershell("a"), "YQA=");
    let mut attente = vec![0xC3];
    assert_eq!(script::decouper_utf8(&mut attente), "");
    attente.push(0xA9);
    assert_eq!(script::decouper_utf8(&mut attente), "é");
    assert!(attente.is_empty());
}

// ---------------------------------------------------------------------------
// Liste par dépôt, suppression, archivage.

fn worktree_test(r: &Path, branche: &str) -> PathBuf {
    let dossier = r.parent().unwrap().join(format!("wt-{branche}"));
    git_test(r, &["worktree", "add", "-q", "-b", branche, dossier.to_str().unwrap(), "main"]);
    depot::canonique(&dossier)
}

fn suppression(r: &Path, dossier: &Path) -> taches::DemandeSuppression {
    taches::DemandeSuppression {
        depot: r.display().to_string(),
        dossier: dossier.display().to_string(),
        archiver: false,
        supprimer_branche: false,
        forcer_branche: false,
        forcer: false,
        lancer_script: false,
        empreinte: None,
        titre: None,
    }
}

#[test]
fn liste_par_depot_etat_et_comparaison() {
    let r = depot_test("liste");
    let a = worktree_test(&r, "tache-a");
    let b = worktree_test(&r, "tache-b");
    commit_test(&a, "a.txt", "travail sur a");
    commit_test(&r, "main.txt", "suite de main");
    fs::write(b.join("brouillon.txt"), "x").unwrap();
    let chemins = vec![r.display().to_string(), a.display().to_string(), "/dossier/absent".to_string()];
    let depots = super::lister_depots(&chemins, &HashMap::new());
    assert_eq!(depots.len(), 1, "un seul groupe pour le dépôt et son worktree");
    let d = &depots[0];
    assert_eq!(d.branche_principale.as_deref(), Some("main"));
    assert_eq!(d.worktrees.len(), 3);
    assert!(d.worktrees[0].principal);
    let wa = d.worktrees.iter().find(|w| w.branche.as_deref() == Some("tache-a")).unwrap();
    assert_eq!((wa.avance, wa.retard, wa.reference.as_deref()), (Some(1), Some(1), Some("main")));
    assert_eq!(wa.modifies, Some(0));
    assert!(wa.dernier_commit_ms.is_some());
    let wb = d.worktrees.iter().find(|w| w.branche.as_deref() == Some("tache-b")).unwrap();
    assert_eq!(wb.modifies, Some(1));
    assert_eq!((wb.avance, wb.retard), (Some(0), Some(1)));
    // Base choisie pour ce dépôt : comparaison avec elle.
    let mut bases = HashMap::new();
    bases.insert(r.display().to_string(), "tache-a".to_string());
    let d = &super::lister_depots(&chemins, &bases)[0];
    let wb = d.worktrees.iter().find(|w| w.branche.as_deref() == Some("tache-b")).unwrap();
    assert_eq!(wb.reference.as_deref(), Some("tache-a"));
    fs::remove_dir_all(&b).unwrap();
    let d = &super::lister_depots(&chemins, &HashMap::new())[0];
    assert!(d.worktrees.iter().find(|w| w.branche.as_deref() == Some("tache-b")).unwrap().introuvable);
}

#[cfg(unix)]
#[test]
fn suppression_retire_les_liens_sans_toucher_au_depot() {
    let r = depot_test("suppression");
    fs::create_dir_all(r.join("node_modules/paquet")).unwrap();
    fs::write(r.join("node_modules/paquet/index.js"), "précieux").unwrap();
    fs::write(r.join("worktrees.toml"), "[partage]\nliens = [\"node_modules\"]\n").unwrap();
    let hote = Arc::new(HoteTest::default());
    let id = taches::lancer(hote.clone(), taches::preparer_creation(&demande(&r, "a-supprimer", false, None)).unwrap()).id;
    let creee = finie(&id);
    assert_eq!(creee.etat, taches::Etat::Reussi, "{:?}", creee.detail);
    let dossier = PathBuf::from(&creee.dossier);
    assert!(partage::est_lien(&dossier.join("node_modules")));
    // Le lien n'est plus dans worktrees.toml : il est quand même retiré (noté à la création).
    fs::write(r.join("worktrees.toml"), "").unwrap();
    let mut d = suppression(&r, &dossier);
    d.supprimer_branche = true;
    let t = taches::preparer_suppression(&d).unwrap();
    assert_eq!(t.etapes, vec![taches::Etape::Git, taches::Etape::Fin]);
    let id = taches::lancer(hote, t).id;
    let t = finie(&id);
    assert_eq!(t.etat, taches::Etat::Reussi, "{} {:?}", t.message, t.detail);
    assert!(!dossier.exists());
    assert_eq!(fs::read_to_string(r.join("node_modules/paquet/index.js")).unwrap(), "précieux");
    assert!(!depot::branche_locale_existe(&r, "a-supprimer"), "branche fusionnée supprimée");
    assert!(t.avertissements.is_empty(), "{:?}", t.avertissements);
}

#[test]
fn suppression_refusee_si_modifie_puis_forcee_et_branche_non_fusionnee_gardee() {
    let r = depot_test("modifie");
    let w = worktree_test(&r, "en-cours");
    commit_test(&w, "w.txt", "commit propre");
    fs::write(w.join("non-suivi.txt"), "x").unwrap();
    let hote = Arc::new(HoteTest::default());
    let mut d = suppression(&r, &w);
    d.supprimer_branche = true;
    let id = taches::lancer(hote.clone(), taches::preparer_suppression(&d).unwrap()).id;
    let t = finie(&id);
    assert_eq!(t.raison.as_deref(), Some("modifie"), "{}", t.message);
    assert!(w.exists());
    taches::reprendre(hote, &id, taches::Reprise { forcer: true, ..Default::default() }).unwrap();
    let t = finie(&id);
    assert_eq!(t.etat, taches::Etat::Reussi, "{:?}", t.detail);
    assert!(!w.exists());
    assert!(depot::branche_locale_existe(&r, "en-cours"), "branche non fusionnée gardée");
    assert_eq!(t.avertissements.len(), 1, "{:?}", t.avertissements);
}

#[cfg(unix)]
#[test]
fn archivage_avec_script_de_suppression_garde_la_branche() {
    let r = depot_test("archive");
    let w = worktree_test(&r, "archivee");
    fs::write(r.join("worktrees.toml"), "[scripts]\nsuppression = \"echo \\\"$WORKTREE_BRANCH\\\" > \\\"$WORKTREE_ROOT_PATH/trace.txt\\\"\"\n").unwrap();
    let cfg = config::lire(&r);
    assert!(cfg.erreurs.is_empty(), "{:?}", cfg.erreurs);
    let mut d = suppression(&r, &w);
    d.archiver = true;
    d.supprimer_branche = true; // ignoré pour un archivage
    d.lancer_script = true;
    d.empreinte = cfg.empreinte.clone();
    let t = taches::preparer_suppression(&d).unwrap();
    assert_eq!(t.genre, taches::Genre::Archivage);
    assert_eq!(t.etapes, vec![taches::Etape::Script, taches::Etape::Git, taches::Etape::Fin]);
    let id = taches::lancer(Arc::new(HoteTest::default()), t).id;
    let t = finie(&id);
    assert_eq!(t.etat, taches::Etat::Reussi, "{} {:?}", t.message, t.detail);
    assert_eq!(fs::read_to_string(r.join("trace.txt")).unwrap().trim(), "archivee");
    assert!(!w.exists());
    assert!(depot::branche_locale_existe(&r, "archivee"));
    assert!(t.message.contains("archivé"), "{}", t.message);
}

#[test]
fn principal_et_verrouille_refuses() {
    let r = depot_test("refus");
    assert!(taches::preparer_suppression(&suppression(&r, &r)).unwrap_err().contains("principal"));
    let w = worktree_test(&r, "verrou");
    git_test(&r, &["worktree", "lock", w.to_str().unwrap()]);
    assert!(taches::preparer_suppression(&suppression(&r, &w)).unwrap_err().contains("verrouillé"));
    assert!(taches::preparer_suppression(&suppression(&r, Path::new("/pas/un/worktree"))).is_err());
}

// ---------------------------------------------------------------------------
// Nettoyage (fusionnés, introuvables, anciens, taille).

use super::nettoyage;

#[test]
fn nettoyage_fusionnes_introuvables_et_taille() {
    let r = depot_test("nettoyage");
    let a = worktree_test(&r, "fusionnee");
    commit_test(&a, "a.txt", "fini");
    git_test(&r, &["merge", "-q", "--ff-only", "fusionnee"]);
    commit_test(&r, "apres.txt", "main continue");
    let b = worktree_test(&r, "disparue");
    fs::remove_dir_all(&b).unwrap();
    let c = worktree_test(&r, "grosse");
    fs::write(c.join("gros.bin"), vec![0u8; 20_000]).unwrap();
    let infos = nettoyage::examiner(&[r.display().to_string()], &HashMap::new());
    assert_eq!(infos.len(), 3, "le dossier principal n'est pas proposé");
    let par = |b: &str| infos.iter().find(|i| i.branche.as_deref() == Some(b)).unwrap();
    assert!(par("fusionnee").fusionne && !par("fusionnee").introuvable);
    assert!(par("disparue").introuvable && par("disparue").octets.is_none());
    assert!(!par("grosse").fusionne, "même commit que la base : pas « fusionnée »");
    assert!(par("grosse").octets.unwrap() >= 20_000);
    assert_eq!(par("grosse").modifies, Some(1));
    assert!(par("grosse").activite_ms.is_some());
    assert_eq!(nettoyage::oublier_introuvables(&r.display().to_string()).unwrap(), 1);
    assert!(depot::lister(&r).unwrap().iter().all(|w| w.branche.as_deref() != Some("disparue")));
    assert_eq!(nettoyage::oublier_introuvables(&r.display().to_string()).unwrap(), 0);
}
