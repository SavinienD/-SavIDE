//! Tâches de fond des worktrees. Création : `git worktree add`, partage (liens,
//! copies), script de préparation. Suppression ou archivage : script de
//! suppression, retrait des liens, `git worktree remove` (et la branche si on
//! le demande). Chaque tâche a son fil ; l'interface suit ses changements et
//! peut l'annuler, la reprendre (Réessayer, Relancer) ou l'oublier.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{ChildKiller, MasterPty};
use serde::{Deserialize, Serialize};

use super::{config, depot, partage, script};

const SORTIE_MAX: usize = 256 * 1024;
const TACHES_FINIES_MAX: usize = 40;
const PAS: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Genre {
    Creation,
    Suppression,
    Archivage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Etape {
    Git,
    Partage,
    Script,
    Fin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Etat {
    EnCours,
    Reussi,
    Echec,
    Annule,
}

/// Terminal du script, tel que l'interface l'affiche.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptVue {
    pub(crate) session_id: String,
    pub(crate) token: String,
    pub(crate) en_cours: bool,
    pub(crate) code: Option<u32>,
    pub(crate) commandes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tache {
    pub(crate) id: String,
    pub(crate) genre: Genre,
    /// Dossier principal du dépôt (forme canonique, comme les clés de l'appli).
    pub(crate) depot: String,
    /// Dossier du worktree.
    pub(crate) dossier: String,
    pub(crate) branche: Option<String>,
    pub(crate) base: Option<String>,
    pub(crate) titre: String,
    pub(crate) etapes: Vec<Etape>,
    pub(crate) etape: Etape,
    pub(crate) etat: Etat,
    /// Création : le worktree est utilisable (git et partage faits).
    pub(crate) pret: bool,
    pub(crate) message: String,
    pub(crate) detail: Option<String>,
    /// Cause d'un échec : "git", "modifie", "script", "empreinte".
    pub(crate) raison: Option<String>,
    pub(crate) avertissements: Vec<String>,
    pub(crate) partages: Vec<partage::Partage>,
    pub(crate) script: Option<ScriptVue>,
    pub(crate) debut_ms: u64,
    pub(crate) maj_ms: u64,
    #[serde(skip)]
    pub(crate) options: Options,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Options {
    pub(crate) lancer_script: bool,
    pub(crate) empreinte: Option<String>,
    pub(crate) supprimer_branche: bool,
    pub(crate) forcer_branche: bool,
    pub(crate) forcer: bool,
    pub(crate) branche_existait: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DemandeCreation {
    /// Un dossier du dépôt (principal ou worktree).
    pub(crate) depot: String,
    #[serde(default)]
    pub(crate) titre: String,
    pub(crate) branche: String,
    #[serde(default)]
    pub(crate) base: Option<String>,
    #[serde(default)]
    pub(crate) lancer_script: bool,
    #[serde(default)]
    pub(crate) empreinte: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DemandeSuppression {
    pub(crate) depot: String,
    pub(crate) dossier: String,
    #[serde(default)]
    pub(crate) archiver: bool,
    #[serde(default)]
    pub(crate) supprimer_branche: bool,
    #[serde(default)]
    pub(crate) forcer_branche: bool,
    #[serde(default)]
    pub(crate) forcer: bool,
    #[serde(default)]
    pub(crate) lancer_script: bool,
    #[serde(default)]
    pub(crate) empreinte: Option<String>,
    #[serde(default)]
    pub(crate) titre: Option<String>,
}

/// Reprendre une tâche arrêtée (échec ou annulation).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reprise {
    /// Passer le script (création : le worktree reste ; suppression : retirer sans lui).
    #[serde(default)]
    pub(crate) sans_script: bool,
    /// Nouvel accord sur les commandes du projet (fichier modifié).
    #[serde(default)]
    pub(crate) empreinte: Option<String>,
    /// Supprimer malgré les fichiers modifiés.
    #[serde(default)]
    pub(crate) forcer: bool,
}

/// Terminal du script rendu joignable (saisie, taille) par l'hôte.
pub(crate) struct Joignable {
    pub(crate) token: String,
    pub(crate) maitre: Box<dyn MasterPty + Send>,
    pub(crate) ecriture: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub(crate) arret: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

/// Ce que les tâches demandent à l'appli (événements, terminaux).
pub(crate) trait Hote: Send + Sync {
    fn publier(&self, tache: &Tache);
    /// Sortie du script ; `debut` = nombre d'octets déjà émis avant ce morceau.
    fn sortie(&self, id: &str, debut: u64, texte: &str);
    fn terminal_ouvert(&self, session: &str, terminal: Joignable);
    fn terminal_ferme(&self, session: &str, token: &str);
}

#[derive(Default)]
struct Controle {
    annule: AtomicBool,
    sortie: Mutex<(Vec<u8>, u64)>,
    arret: Mutex<Option<Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>>>,
}

impl Controle {
    fn ajouter(&self, texte: &str) -> u64 {
        let mut s = self.sortie.lock().unwrap_or_else(|e| e.into_inner());
        let debut = s.1;
        s.0.extend_from_slice(texte.as_bytes());
        s.1 += texte.len() as u64;
        if s.0.len() > SORTIE_MAX {
            let trop = s.0.len() - SORTIE_MAX;
            s.0.drain(..trop);
        }
        debut
    }
}

struct Entree {
    tache: Tache,
    controle: Arc<Controle>,
}

enum Echec {
    Annule,
    Erreur { raison: &'static str, message: String, detail: Option<String> },
}

fn echec(raison: &'static str, message: impl Into<String>, detail: Option<String>) -> Echec {
    Echec::Erreur { raison, message: message.into(), detail }
}

#[derive(Default)]
struct Maj {
    avertissements: Vec<String>,
    partages: Vec<partage::Partage>,
}

/// Un seul `git worktree add / remove` à la fois par dépôt (suppressions groupées).
fn verrou_depot(depot: &str) -> Arc<Mutex<()>> {
    static VERROUS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut verrous = VERROUS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner());
    Arc::clone(verrous.entry(depot.to_lowercase()).or_default())
}

fn registre() -> &'static Mutex<HashMap<String, Entree>> {
    static REGISTRE: OnceLock<Mutex<HashMap<String, Entree>>> = OnceLock::new();
    REGISTRE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn verrou() -> std::sync::MutexGuard<'static, HashMap<String, Entree>> {
    registre().lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn maintenant_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub(crate) fn nouvel_id() -> String {
    use ring::rand::SecureRandom;
    let mut octets = [0u8; 8];
    if ring::rand::SystemRandom::new().fill(&mut octets).is_err() {
        octets = maintenant_ms().to_le_bytes();
    }
    octets.iter().map(|o| format!("{o:02x}")).collect()
}

fn texte_chemin(chemin: &Path) -> String {
    chemin.display().to_string()
}

fn os(chemin: &Path) -> String {
    depot::chemin_os(chemin).display().to_string()
}

/// Nom de dossier ou de branche tiré d'un titre : minuscules, sans accents,
/// tirets ; 48 caractères au plus.
pub(crate) fn slug(texte: &str) -> String {
    let mut sortie = String::new();
    let mut tiret = false;
    for c in texte.chars() {
        let morceau: Option<String> = if c.is_ascii_alphanumeric() {
            Some(c.to_ascii_lowercase().to_string())
        } else {
            sans_accent(c).map(str::to_string)
        };
        match morceau {
            Some(m) => {
                sortie.push_str(&m);
                tiret = false;
            }
            None => {
                if !sortie.is_empty() && !tiret {
                    sortie.push('-');
                    tiret = true;
                }
            }
        }
        if sortie.len() >= 48 {
            break;
        }
    }
    let propre = sortie.trim_matches('-').to_string();
    if propre.is_empty() {
        "tache".to_string()
    } else {
        propre
    }
}

fn sans_accent(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => "a",
        'ç' | 'Ç' => "c",
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => "i",
        'ñ' | 'Ñ' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' => "o",
        'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => "u",
        'ý' | 'ÿ' | 'Ý' => "y",
        'œ' | 'Œ' => "oe",
        'æ' | 'Æ' => "ae",
        'ß' => "ss",
        _ => return None,
    })
}

/// Dossier du nouveau worktree : `<parent>/<dépôt>-worktrees/<branche>` (-2, -3… si pris).
pub(crate) fn chemin_libre(racine: &Path, branche: &str, liste: &[depot::WorktreeBrut]) -> Result<PathBuf, String> {
    let parent = racine.parent().ok_or_else(|| "le dépôt n'a pas de dossier parent".to_string())?;
    let nom = racine.file_name().and_then(|n| n.to_str()).unwrap_or("depot");
    let conteneur = parent.join(format!("{nom}-worktrees"));
    let base = slug(branche);
    for i in 1..1000 {
        let candidat = if i == 1 { conteneur.join(&base) } else { conteneur.join(format!("{base}-{i}")) };
        let pris = fs::symlink_metadata(&candidat).is_ok()
            || liste.iter().any(|w| depot::meme_chemin(&w.chemin, &candidat));
        if !pris {
            return Ok(candidat);
        }
    }
    Err("aucun nom de dossier libre pour le worktree".to_string())
}

/// Vérifie la demande (branche, base, dossier libre) ; rien n'est encore créé.
pub(crate) fn preparer_creation(d: &DemandeCreation) -> Result<Tache, String> {
    let depart = PathBuf::from(d.depot.trim());
    let racine = depot::racine_principale(&depart)?;
    let branche = d.branche.trim().to_string();
    if !depot::nom_branche_valide(&racine, &branche) {
        return Err(format!("Nom de branche invalide : « {branche} »"));
    }
    let liste = depot::lister(&racine)?;
    let existait = depot::branche_locale_existe(&racine, &branche);
    if existait {
        if let Some(w) = liste.iter().find(|w| w.branche.as_deref() == Some(branche.as_str())) {
            return Err(format!(
                "La branche « {branche} » est déjà ouverte dans {}",
                depot::chemin_os(&w.chemin).display()
            ));
        }
    }
    let cfg = config::lire(&racine);
    let base = if existait {
        None
    } else {
        let base = d
            .base
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string)
            .or_else(|| cfg.base.clone())
            .or_else(|| depot::branche_principale(&racine))
            .unwrap_or_else(|| "HEAD".to_string());
        if !depot::revision_existe(&racine, &base) {
            return Err(format!("Branche de départ « {base} » introuvable"));
        }
        Some(base)
    };
    let dossier = chemin_libre(&racine, &branche, &liste)?;
    let lancer = d.lancer_script && cfg.script_creation.is_some();
    let mut etapes = vec![Etape::Git, Etape::Partage];
    if lancer {
        etapes.push(Etape::Script);
    }
    etapes.push(Etape::Fin);
    let titre = if d.titre.trim().is_empty() { branche.clone() } else { d.titre.trim().to_string() };
    let maintenant = maintenant_ms();
    let mut tache = Tache {
        id: nouvel_id(),
        genre: Genre::Creation,
        depot: texte_chemin(&racine),
        dossier: texte_chemin(&dossier),
        branche: Some(branche),
        base,
        titre,
        etapes,
        etape: Etape::Git,
        etat: Etat::EnCours,
        pret: false,
        message: String::new(),
        detail: None,
        raison: None,
        avertissements: Vec::new(),
        partages: Vec::new(),
        script: None,
        debut_ms: maintenant,
        maj_ms: maintenant,
        options: Options {
            lancer_script: lancer,
            empreinte: d.empreinte.clone(),
            branche_existait: existait,
            ..Options::default()
        },
    };
    tache.message = message_etape(&tache);
    Ok(tache)
}

/// Vérifie la demande de suppression ou d'archivage.
pub(crate) fn preparer_suppression(d: &DemandeSuppression) -> Result<Tache, String> {
    let dossier = depot::canonique(Path::new(d.dossier.trim()));
    let racine = depot::racine_principale(Path::new(d.depot.trim()))
        .or_else(|_| depot::racine_principale(&dossier))?;
    let liste = depot::lister(&racine)?;
    let w = liste
        .iter()
        .find(|w| depot::meme_chemin(&w.chemin, &dossier))
        .ok_or_else(|| "Ce dossier n'est pas un worktree de ce dépôt".to_string())?;
    if w.principal {
        return Err("Le dossier principal du dépôt ne se supprime pas ici".to_string());
    }
    if w.verrouille {
        return Err("Worktree verrouillé : « git worktree unlock » pour le libérer".to_string());
    }
    let cfg = config::lire(&racine);
    let lancer = d.lancer_script && cfg.script_suppression.is_some() && w.chemin.is_dir();
    let mut etapes = Vec::new();
    if lancer {
        etapes.push(Etape::Script);
    }
    etapes.push(Etape::Git);
    etapes.push(Etape::Fin);
    let titre = d
        .titre
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| w.branche.clone())
        .unwrap_or_else(|| w.chemin.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    let maintenant = maintenant_ms();
    let mut tache = Tache {
        id: nouvel_id(),
        genre: if d.archiver { Genre::Archivage } else { Genre::Suppression },
        depot: texte_chemin(&racine),
        dossier: texte_chemin(&w.chemin),
        branche: w.branche.clone(),
        base: None,
        titre,
        etape: etapes[0],
        etapes,
        etat: Etat::EnCours,
        pret: false,
        message: String::new(),
        detail: None,
        raison: None,
        avertissements: Vec::new(),
        partages: Vec::new(),
        script: None,
        debut_ms: maintenant,
        maj_ms: maintenant,
        options: Options {
            lancer_script: lancer,
            empreinte: d.empreinte.clone(),
            supprimer_branche: d.supprimer_branche && !d.archiver,
            forcer_branche: d.forcer_branche,
            forcer: d.forcer,
            ..Options::default()
        },
    };
    tache.message = message_etape(&tache);
    Ok(tache)
}

fn message_etape(t: &Tache) -> String {
    let branche = t.branche.clone().unwrap_or_default();
    match (t.genre, t.etape) {
        (Genre::Creation, Etape::Git) => format!("Création de la branche {branche} et du dossier…"),
        (Genre::Creation, Etape::Partage) => "Partage des fichiers du dépôt…".to_string(),
        (Genre::Creation, Etape::Script) => "Préparation du worktree…".to_string(),
        (Genre::Creation, Etape::Fin) => "Worktree prêt".to_string(),
        (_, Etape::Script) => "Script de suppression…".to_string(),
        (Genre::Suppression, Etape::Git) => "Suppression du dossier…".to_string(),
        (Genre::Archivage, Etape::Git) => "Archivage : retrait du dossier…".to_string(),
        (Genre::Suppression, Etape::Fin) => "Worktree supprimé".to_string(),
        (Genre::Archivage, Etape::Fin) => format!("Worktree archivé (branche {branche} gardée)"),
        (_, Etape::Partage) => String::new(),
    }
}

/// Enregistre la tâche et la lance dans son propre fil.
pub(crate) fn lancer(hote: Arc<dyn Hote>, tache: Tache) -> Tache {
    {
        let mut reg = verrou();
        purger(&mut reg);
        reg.insert(tache.id.clone(), Entree { tache: tache.clone(), controle: Arc::new(Controle::default()) });
    }
    hote.publier(&tache);
    demarrer_fil(hote, tache.id.clone());
    tache
}

fn demarrer_fil(hote: Arc<dyn Hote>, id: String) {
    let nom = format!("worktree-{id}");
    let _ = std::thread::Builder::new().name(nom).spawn(move || executer(hote, &id));
}

fn purger(reg: &mut HashMap<String, Entree>) {
    let mut finies: Vec<(u64, String)> = reg
        .values()
        .filter(|e| e.tache.etat != Etat::EnCours)
        .map(|e| (e.tache.maj_ms, e.tache.id.clone()))
        .collect();
    if finies.len() <= TACHES_FINIES_MAX {
        return;
    }
    finies.sort();
    let trop = finies.len() - TACHES_FINIES_MAX;
    for (_, id) in finies.into_iter().take(trop) {
        reg.remove(&id);
    }
}

pub(crate) fn lister() -> Vec<Tache> {
    let mut liste: Vec<Tache> = verrou().values().map(|e| e.tache.clone()).collect();
    liste.sort_by_key(|t| t.debut_ms);
    liste
}

/// Sortie gardée du script (256 Ko au plus) et nombre total d'octets émis.
pub(crate) fn sortie(id: &str) -> Option<(String, u64)> {
    let controle = verrou().get(id).map(|e| Arc::clone(&e.controle))?;
    let s = controle.sortie.lock().unwrap_or_else(|e| e.into_inner());
    Some((String::from_utf8_lossy(&s.0).to_string(), s.1))
}

pub(crate) fn annuler(id: &str) -> Result<(), String> {
    let controle = {
        let reg = verrou();
        let e = reg.get(id).ok_or_else(|| "tâche introuvable".to_string())?;
        if e.tache.etat != Etat::EnCours {
            return Ok(());
        }
        Arc::clone(&e.controle)
    };
    controle.annule.store(true, Ordering::SeqCst);
    if let Some(arret) = controle.arret.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if let Ok(mut k) = arret.lock() {
            let _ = k.kill();
        }
    }
    Ok(())
}

pub(crate) fn oublier(id: &str) -> Result<(), String> {
    let mut reg = verrou();
    if let Some(e) = reg.get(id) {
        if e.tache.etat == Etat::EnCours {
            return Err("tâche en cours : annulez-la d'abord".to_string());
        }
        reg.remove(id);
    }
    Ok(())
}

/// Reprend une tâche en échec ou annulée, depuis l'étape où elle s'est arrêtée.
pub(crate) fn reprendre(hote: Arc<dyn Hote>, id: &str, r: Reprise) -> Result<Tache, String> {
    let tache = {
        let mut reg = verrou();
        let e = reg.get_mut(id).ok_or_else(|| "tâche introuvable".to_string())?;
        match e.tache.etat {
            Etat::EnCours => return Err("la tâche est déjà en cours".to_string()),
            Etat::Reussi => return Err("la tâche est déjà finie".to_string()),
            _ => {}
        }
        let t = &mut e.tache;
        if r.sans_script {
            if t.etape == Etape::Script {
                let i = t.etapes.iter().position(|x| *x == Etape::Script).unwrap_or(0);
                t.etape = t.etapes.get(i + 1).copied().unwrap_or(Etape::Fin);
            }
            t.etapes.retain(|x| *x != Etape::Script);
            t.options.lancer_script = false;
        }
        if let Some(empreinte) = r.empreinte {
            t.options.empreinte = Some(empreinte);
        }
        if r.forcer {
            t.options.forcer = true;
        }
        t.etat = Etat::EnCours;
        t.detail = None;
        t.raison = None;
        t.message = message_etape(t);
        t.maj_ms = maintenant_ms();
        e.controle = Arc::new(Controle::default());
        t.clone()
    };
    hote.publier(&tache);
    demarrer_fil(hote, id.to_string());
    Ok(tache)
}

fn lire(id: &str) -> Option<(Tache, Arc<Controle>)> {
    verrou().get(id).map(|e| (e.tache.clone(), Arc::clone(&e.controle)))
}

fn modifier(hote: &dyn Hote, id: &str, f: impl FnOnce(&mut Tache)) {
    let copie = {
        let mut reg = verrou();
        let Some(e) = reg.get_mut(id) else { return };
        f(&mut e.tache);
        e.tache.maj_ms = maintenant_ms();
        e.tache.clone()
    };
    hote.publier(&copie);
}

fn executer(hote: Arc<dyn Hote>, id: &str) {
    loop {
        let Some((tache, controle)) = lire(id) else { return };
        if tache.etat != Etat::EnCours {
            return;
        }
        // Une suppression déjà lancée dans git va au bout (pas d'arrêt à mi-chemin).
        let interruptible = !(tache.genre != Genre::Creation && tache.etape == Etape::Git);
        if interruptible && controle.annule.load(Ordering::SeqCst) {
            arreter(hote.as_ref(), &tache, None);
            return;
        }
        let resultat = match (tache.genre, tache.etape) {
            (_, Etape::Fin) => {
                modifier(hote.as_ref(), id, |t| {
                    t.etat = Etat::Reussi;
                    t.pret = t.genre == Genre::Creation;
                    t.message = message_etape(t);
                });
                return;
            }
            (Genre::Creation, Etape::Git) => {
                let verrou = verrou_depot(&tache.depot);
                let _garde = verrou.lock().unwrap_or_else(|e| e.into_inner());
                creer_worktree(&tache, &controle)
            }
            (Genre::Creation, Etape::Partage) => partager(&tache),
            (_, Etape::Script) => lancer_script(&hote, &tache, &controle),
            (_, Etape::Git) => {
                let verrou = verrou_depot(&tache.depot);
                let _garde = verrou.lock().unwrap_or_else(|e| e.into_inner());
                retirer_worktree(&tache)
            }
            (_, Etape::Partage) => Ok(Maj::default()),
        };
        match resultat {
            Ok(maj) => modifier(hote.as_ref(), id, |t| {
                t.avertissements.extend(maj.avertissements);
                t.partages.extend(maj.partages);
                if t.genre == Genre::Creation && t.etape == Etape::Partage {
                    t.pret = true;
                }
                let i = t.etapes.iter().position(|x| *x == t.etape).unwrap_or(0);
                t.etape = t.etapes.get(i + 1).copied().unwrap_or(Etape::Fin);
                t.message = message_etape(t);
            }),
            Err(Echec::Annule) => {
                arreter(hote.as_ref(), &tache, None);
                return;
            }
            Err(Echec::Erreur { raison, message, detail }) => {
                arreter(hote.as_ref(), &tache, Some((raison, message, detail)));
                return;
            }
        }
    }
}

/// Fin sur annulation (`erreur` = None) ou sur échec. Une création arrêtée
/// avant d'être prête est défaite (dossier, branche créée), pour repartir propre.
fn arreter(hote: &dyn Hote, tache: &Tache, erreur: Option<(&'static str, String, Option<String>)>) {
    let defaire = tache.genre == Genre::Creation
        && matches!(tache.etape, Etape::Git | Etape::Partage)
        && !matches!(erreur, Some(("dossier", _, _)));
    if defaire {
        defaire_creation(tache);
    }
    modifier(hote, &tache.id, |t| {
        if defaire {
            t.etape = Etape::Git;
            t.pret = false;
            t.partages.clear();
        }
        match erreur {
            Some((raison, message, detail)) => {
                t.etat = Etat::Echec;
                t.raison = Some(raison.to_string());
                t.message = message;
                t.detail = detail;
            }
            None => {
                t.etat = Etat::Annule;
                t.message = match (t.genre, t.etape) {
                    (Genre::Creation, Etape::Script) => "Préparation arrêtée (le worktree reste utilisable)".to_string(),
                    (Genre::Creation, _) => "Création annulée".to_string(),
                    _ => "Suppression annulée : rien n'a été retiré".to_string(),
                };
            }
        }
    });
}

fn defaire_creation(t: &Tache) {
    let racine = PathBuf::from(&t.depot);
    let dossier = PathBuf::from(&t.dossier);
    let liens: Vec<String> = config::lire(&racine).liens;
    if dossier.exists() {
        let mut chemins: Vec<String> = depot::dossier_admin(&dossier)
            .map(|a| partage::lire_suivi(&a).into_iter().map(|p| p.chemin).collect())
            .unwrap_or_default();
        chemins.extend(liens.iter().cloned());
        partage::retirer_liens(&dossier, &chemins);
    }
    let enregistre = depot::lister(&racine)
        .map(|l| l.iter().any(|w| depot::meme_chemin(&w.chemin, &dossier)))
        .unwrap_or(false);
    if enregistre {
        let _ = depot::git(&racine, &["worktree", "remove", "--force", &os(&dossier)]);
    }
    if dossier.exists() {
        partage::retirer_liens(&dossier, &liens);
        let _ = fs::remove_dir_all(&dossier);
    }
    let encore = depot::lister(&racine)
        .map(|l| l.iter().any(|w| depot::meme_chemin(&w.chemin, &dossier)))
        .unwrap_or(false);
    if encore {
        let _ = depot::git(&racine, &["worktree", "prune"]);
    }
    if !t.options.branche_existait {
        if let Some(b) = &t.branche {
            if depot::branche_locale_existe(&racine, b) {
                let _ = depot::git(&racine, &["branch", "-D", "--", b]);
            }
        }
    }
    // Conteneur « <dépôt>-worktrees » laissé vide : on le retire aussi.
    if let Some(parent) = dossier.parent() {
        let _ = fs::remove_dir(parent);
    }
}

/// git, arrêté si la tâche est annulée.
fn git_annulable(racine: &Path, args: &[String], c: &Controle) -> Result<depot::Sortie, Echec> {
    let mut cmd = depot::commande(racine);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut enfant = cmd
        .spawn()
        .map_err(|err| echec("git", format!("git impossible à lancer ({err}) : installez Git"), None))?;
    let lire_tout = |flux: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut octets = Vec::new();
            if let Some(mut f) = flux {
                let _ = f.read_to_end(&mut octets);
            }
            String::from_utf8_lossy(&octets).to_string()
        })
    };
    let fil_sortie = lire_tout(enfant.stdout.take().map(|f| Box::new(f) as Box<dyn Read + Send>));
    let fil_erreur = lire_tout(enfant.stderr.take().map(|f| Box::new(f) as Box<dyn Read + Send>));
    let statut = loop {
        if c.annule.load(Ordering::SeqCst) {
            let _ = enfant.kill();
            let _ = enfant.wait();
            return Err(Echec::Annule);
        }
        match enfant.try_wait() {
            Ok(Some(statut)) => break statut,
            Ok(None) => std::thread::sleep(PAS),
            Err(err) => return Err(echec("git", format!("git : {err}"), None)),
        }
    };
    Ok(depot::Sortie {
        stdout: fil_sortie.join().unwrap_or_default(),
        stderr: fil_erreur.join().unwrap_or_default(),
        ok: statut.success(),
    })
}

fn creer_worktree(t: &Tache, c: &Controle) -> Result<Maj, Echec> {
    let racine = PathBuf::from(&t.depot);
    let dossier = PathBuf::from(&t.dossier);
    let branche = t.branche.clone().unwrap_or_default();
    if fs::symlink_metadata(&dossier).is_ok() {
        let vide = fs::read_dir(&dossier).map(|mut d| d.next().is_none()).unwrap_or(false);
        if !vide {
            // Jamais défait : ce dossier n'est pas à nous.
            return Err(echec("dossier", format!("Le dossier {} existe déjà", os(&dossier)), None));
        }
        let _ = fs::remove_dir(&dossier);
    }
    if let Some(parent) = dossier.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| echec("git", format!("Dossier {} impossible à créer : {err}", os(parent)), None))?;
    }
    let existe = depot::branche_locale_existe(&racine, &branche);
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if existe {
        args.push(os(&dossier));
        args.push(branche.clone());
    } else {
        args.push("-b".into());
        args.push(branche.clone());
        args.push(os(&dossier));
        args.push(t.base.clone().unwrap_or_else(|| "HEAD".into()));
    }
    let sortie = git_annulable(&racine, &args, c)?;
    if !sortie.ok {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        return Err(echec("git", "Création du worktree impossible", Some(depot::message_echec(&refs, &sortie))));
    }
    Ok(Maj::default())
}

fn partager(t: &Tache) -> Result<Maj, Echec> {
    let racine = PathBuf::from(&t.depot);
    let dossier = PathBuf::from(&t.dossier);
    let cfg = config::lire(&racine);
    let mut maj = Maj::default();
    maj.avertissements.extend(cfg.erreurs.iter().cloned());
    if cfg.liens.is_empty() && cfg.copies.is_empty() {
        return Ok(maj);
    }
    let bilan = partage::appliquer(&racine, &dossier, &cfg.liens, &cfg.copies, &|rel| depot::est_ignore(&racine, rel));
    if let Some(admin) = depot::dossier_admin(&dossier) {
        partage::noter(&admin, &bilan.faits);
    }
    // Un lien n'est pas caché par « node_modules/ » : sinon git status le montrerait.
    let visibles: Vec<String> = bilan
        .faits
        .iter()
        .filter(|p| p.mode != "copie" && !depot::est_ignore(&dossier, &p.chemin))
        .map(|p| p.chemin.clone())
        .collect();
    if let Some(commun) = depot::dossier_admin(&racine) {
        partage::exclure(&commun, &visibles);
    }
    maj.avertissements.extend(bilan.avertissements);
    maj.partages = bilan.faits;
    Ok(maj)
}

fn variables(racine: &Path, dossier: &Path, branche: Option<&str>, source: Option<&str>) -> Vec<(String, String)> {
    let r = os(racine);
    let d = os(dossier);
    let mut v = vec![
        ("WORKTREE_PATH".to_string(), d.clone()),
        ("WORKTREE_ROOT_PATH".to_string(), r.clone()),
        ("WORKTREE_BRANCH".to_string(), branche.unwrap_or("").to_string()),
    ];
    if source == Some(config::FICHIER_ORCA) {
        v.push(("ORCA_ROOT_PATH".to_string(), r));
        v.push(("ORCA_WORKTREE_PATH".to_string(), d));
    }
    v
}

fn lancer_script(hote: &Arc<dyn Hote>, t: &Tache, c: &Arc<Controle>) -> Result<Maj, Echec> {
    let racine = PathBuf::from(&t.depot);
    let dossier = PathBuf::from(&t.dossier);
    let cfg = config::lire(&racine);
    let (script, source) = if t.genre == Genre::Creation {
        (cfg.script_creation.clone(), cfg.source_creation.clone())
    } else {
        (cfg.script_suppression.clone(), cfg.source_suppression.clone())
    };
    let Some(script) = script else { return Ok(Maj::default()) };
    if !dossier.is_dir() {
        return Ok(Maj::default());
    }
    if t.options.empreinte.is_none() || t.options.empreinte != cfg.empreinte {
        return Err(echec(
            "empreinte",
            "Les commandes du projet ont changé : vérifiez-les avant de relancer",
            Some(script),
        ));
    }
    let env = variables(&racine, &dossier, t.branche.as_deref(), source.as_deref());
    let lance = script::lancer(&dossier, &script, &env).map_err(|m| echec("script", m, None))?;
    let session = format!("worktree-{}", t.id);
    let token = nouvel_id();
    let arret = Arc::clone(&lance.arret);
    *c.arret.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&arret));
    modifier(hote.as_ref(), &t.id, |x| {
        x.script = Some(ScriptVue {
            session_id: session.clone(),
            token: token.clone(),
            en_cours: true,
            code: None,
            commandes: script.clone(),
        });
    });
    let fil = {
        let hote = Arc::clone(hote);
        let controle = Arc::clone(c);
        let id = t.id.clone();
        let lecteur = lance.lecteur;
        std::thread::spawn(move || lire_sortie(hote, &id, lecteur, controle))
    };
    hote.terminal_ouvert(
        &session,
        Joignable { token: token.clone(), maitre: lance.maitre, ecriture: lance.ecriture, arret: Arc::clone(&arret) },
    );
    let mut enfant = lance.enfant;
    let code = loop {
        if c.annule.load(Ordering::SeqCst) {
            if let Ok(mut k) = arret.lock() {
                let _ = k.kill();
            }
        }
        match enfant.try_wait() {
            Ok(Some(statut)) => break Some(statut.exit_code()),
            Ok(None) => std::thread::sleep(PAS),
            Err(_) => break None,
        }
    };
    hote.terminal_ferme(&session, &token);
    let attente = Instant::now();
    while !fil.is_finished() && attente.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(20));
    }
    *c.arret.lock().unwrap_or_else(|e| e.into_inner()) = None;
    modifier(hote.as_ref(), &t.id, |x| {
        if let Some(s) = x.script.as_mut() {
            s.en_cours = false;
            s.code = code;
        }
    });
    if c.annule.load(Ordering::SeqCst) {
        return Err(Echec::Annule);
    }
    let quoi = if t.genre == Genre::Creation { "de préparation" } else { "de suppression" };
    match code {
        Some(0) => Ok(Maj::default()),
        Some(n) => Err(echec("script", format!("Le script {quoi} a échoué (code {n})"), None)),
        None => Err(echec("script", format!("Le script {quoi} s'est arrêté sans code de sortie"), None)),
    }
}

fn lire_sortie(hote: Arc<dyn Hote>, id: &str, mut lecteur: Box<dyn Read + Send>, c: Arc<Controle>) {
    let mut tampon = [0u8; 8192];
    let mut attente: Vec<u8> = Vec::new();
    loop {
        match lecteur.read(&mut tampon) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                attente.extend_from_slice(&tampon[..n]);
                let texte = script::decouper_utf8(&mut attente);
                if !texte.is_empty() {
                    let debut = c.ajouter(&texte);
                    hote.sortie(id, debut, &texte);
                }
            }
        }
    }
    if !attente.is_empty() {
        let texte = String::from_utf8_lossy(&attente).to_string();
        let debut = c.ajouter(&texte);
        hote.sortie(id, debut, &texte);
    }
}

fn retirer_worktree(t: &Tache) -> Result<Maj, Echec> {
    let racine = PathBuf::from(&t.depot);
    let dossier = PathBuf::from(&t.dossier);
    let mut maj = Maj::default();
    let cfg = config::lire(&racine);
    if dossier.exists() {
        let mut chemins: Vec<String> = depot::dossier_admin(&dossier)
            .map(|a| partage::lire_suivi(&a).into_iter().map(|p| p.chemin).collect())
            .unwrap_or_default();
        for l in &cfg.liens {
            if !chemins.contains(l) {
                chemins.push(l.clone());
            }
        }
        // Liens retirés d'abord (jamais suivis) : ils ne comptent pas comme des modifications.
        let retires = partage::retirer_liens(&dossier, &chemins);
        if !t.options.forcer {
            if let Some(n) = depot::fichiers_modifies(&dossier).filter(|n| *n > 0) {
                if !retires.is_empty() {
                    let _ = partage::appliquer(&racine, &dossier, &retires, &[], &|_| true);
                }
                return Err(echec(
                    "modifie",
                    format!("Le worktree a {n} fichier(s) modifié(s) ou non suivi(s)"),
                    None,
                ));
            }
        }
        let chemin = os(&dossier);
        let mut args = vec!["worktree", "remove"];
        if t.options.forcer {
            args.push("--force");
        }
        args.push(&chemin);
        let sortie = depot::git(&racine, &args).map_err(|m| echec("git", m, None))?;
        if !sortie.ok {
            // Le worktree reste : on remet ses liens pour qu'il reste utilisable.
            if !retires.is_empty() {
                let _ = partage::appliquer(&racine, &dossier, &retires, &[], &|_| true);
            }
            return Err(echec("git", "Suppression refusée par git", Some(depot::message_echec(&args, &sortie))));
        }
    } else {
        // Dossier déjà disparu : git n'a plus qu'à oublier l'entrée.
        let _ = depot::git(&racine, &["worktree", "prune"]);
    }
    if t.genre == Genre::Suppression && t.options.supprimer_branche {
        if let Some(b) = &t.branche {
            let principale = depot::branche_principale(&racine);
            if principale.as_deref() == Some(b.as_str()) {
                maj.avertissements.push(format!("Branche {b} gardée : c'est la branche principale"));
            } else {
                let mode = if t.options.forcer_branche { "-D" } else { "-d" };
                match depot::git(&racine, &["branch", mode, "--", b]) {
                    Ok(s) if s.ok => {}
                    _ => maj
                        .avertissements
                        .push(format!("Branche {b} gardée : elle a des commits qui ne sont pas dans la branche principale")),
                }
            }
        }
    }
    Ok(maj)
}
