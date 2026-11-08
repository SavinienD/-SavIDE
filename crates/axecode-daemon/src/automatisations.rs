//! automatisations — prompts planifiés, lancés par le service, même appli fermée.
//!
//! Une automatisation = nom, dossier, prompt, modèle, horaire (tous les jours à
//! HH:MM, jours de la semaine, toutes les N heures ou expression cron), une
//! nouvelle conversation à chaque exécution (défaut) ou toujours la même, active
//! ou en pause. Options : vérification avant lancement (commande shell qui doit
//! réussir, sinon l'exécution est « sautée ») et rattrapage : après une veille
//! ou un arrêt du service, UNE exécution manquée est relancée (désactivable).
//! Jamais deux exécutions simultanées de la même automatisation.
//!
//! Stockage local : `<données>/automatisations.json` (définitions, prochaine
//! exécution, 50 dernières exécutions de chacune). Tant qu'une automatisation
//! est active, le service ne s'arrête pas seul (`retient_le_service`).
//!
//! RPC : `automatisations.lister | creer | modifier | supprimer | lancer |
//! arreter | historique | apercu`. Événement `automatisations` :
//! `{type: "maj"}` à chaque changement, `{type: "fin", automatisation,
//! execution}` à la fin d'une exécution (l'IDE en fait une notification).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

use async_trait::async_trait;
use axecode_core::{ModelRef, SessionError, SessionMeta, SessionResult};
use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::daemon::{lock, Daemon};

#[path = "automatisations_horaire.rs"]
pub mod horaire;
#[path = "automatisations_execution.rs"]
mod execution;
#[cfg(test)]
#[path = "automatisations_tests.rs"]
mod tests;

pub use horaire::Horaire;

/// Exécutions gardées par automatisation (les plus récentes d'abord).
pub const HISTORIQUE_MAX: usize = 50;
/// Un lancement plus en retard que ça est « manqué » (veille, service arrêté).
pub const TOLERANCE_MS: i64 = 5 * 60_000;
/// Cadence du planificateur.
const TIC: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Statut {
    /// Vérification avant lancement en cours.
    Verification,
    EnCours,
    Reussie,
    Echouee,
    /// Vérification en échec, conversation occupée, ou exécution précédente encore là.
    Sautee,
    /// Créneau passé pendant une veille, rattrapage désactivé.
    Manquee,
    Arretee,
}

impl Statut {
    pub fn en_cours(self) -> bool {
        matches!(self, Statut::Verification | Statut::EnCours)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Declencheur {
    Horaire,
    Rattrapage,
    Manuel,
}

/// Une exécution (ligne de l'historique).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    pub declencheur: Declencheur,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prevue_ms: Option<i64>,
    pub debut_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fin_ms: Option<i64>,
    pub statut: Statut,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Entrée du journal du prompt envoyé (même conversation) : le bilan commence là.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depuis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Créneaux manqués (rattrapage) ou sautés (exécution précédente encore là).
    #[serde(default, skip_serializing_if = "est_zero")]
    pub manquees: u32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub arret_demande: bool,
}

fn est_zero(n: &u32) -> bool {
    *n == 0
}

fn vrai() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automatisation {
    pub id: String,
    pub nom: String,
    pub dossier: String,
    pub prompt: String,
    pub modele: ModelRef,
    pub horaire: Horaire,
    /// Faux (défaut) : une nouvelle conversation à chaque exécution.
    #[serde(default)]
    pub meme_conversation: bool,
    #[serde(default = "vrai")]
    pub active: bool,
    #[serde(default = "vrai")]
    pub rattrapage: bool,
    /// Commande shell lancée dans le dossier avant chaque exécution prévue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
    pub cree_ms: i64,
    pub modifie_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prochaine_ms: Option<i64>,
    /// Conversation réutilisée (même conversation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub historique: Vec<Execution>,
}

impl Automatisation {
    pub fn en_cours(&self) -> bool {
        self.historique.iter().any(|e| e.statut.en_cours())
    }

    /// Ajoute une exécution en tête et oublie les plus anciennes.
    pub(crate) fn noter(&mut self, execution: Execution) {
        self.historique.insert(0, execution);
        self.historique.truncate(HISTORIQUE_MAX);
    }
}

// ----- stockage --------------------------------------------------------------

#[derive(Default, Serialize, Deserialize)]
struct Fichier {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    automatisations: Vec<Automatisation>,
}

pub(crate) struct Etat {
    chemin: PathBuf,
    pub(crate) liste: Vec<Automatisation>,
}

impl Etat {
    fn charger(chemin: PathBuf) -> Self {
        let liste = match std::fs::read(&chemin) {
            Ok(octets) => match serde_json::from_slice::<Fichier>(&octets) {
                Ok(f) => f.automatisations,
                Err(err) => {
                    // Jamais écrasé : mis de côté pour être relu à la main.
                    tracing::warn!(error = %err, "automatisations.json illisible : mis de côté");
                    let _ = std::fs::rename(&chemin, chemin.with_extension("illisible.json"));
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };
        Self { chemin, liste }
    }

    pub(crate) fn enregistrer(&self) {
        let fichier = Fichier { version: 1, automatisations: self.liste.clone() };
        let Ok(octets) = serde_json::to_vec_pretty(&fichier) else { return };
        if let Some(dossier) = self.chemin.parent() {
            let _ = std::fs::create_dir_all(dossier);
        }
        let tmp = self.chemin.with_extension("json.tmp");
        if std::fs::write(&tmp, octets).is_ok() {
            let _ = std::fs::rename(&tmp, &self.chemin);
        }
    }

    pub(crate) fn trouver(&mut self, id: &str) -> SessionResult<&mut Automatisation> {
        self.liste
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| SessionError::Protocol(format!("Automatisation introuvable : {id}")))
    }
}

/// État des automatisations d'un dossier de données (un par service).
pub(crate) fn etat(d: &Daemon) -> Arc<Mutex<Etat>> {
    static ETATS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Etat>>>>> = OnceLock::new();
    let cle = d.config.data_dir.clone();
    lock(ETATS.get_or_init(Default::default))
        .entry(cle.clone())
        .or_insert_with(|| Arc::new(Mutex::new(Etat::charger(cle.join("automatisations.json")))))
        .clone()
}

/// Services vivants de ce processus (le module REPL `automatisations` passe par eux).
fn demons() -> &'static Mutex<Vec<Weak<Daemon>>> {
    static DEMONS: OnceLock<Mutex<Vec<Weak<Daemon>>>> = OnceLock::new();
    DEMONS.get_or_init(Default::default)
}

fn demon_de(session_id: &str) -> Option<Arc<Daemon>> {
    let mut liste = lock(demons());
    liste.retain(|w| w.strong_count() > 0);
    let vivants: Vec<Arc<Daemon>> = liste.iter().filter_map(Weak::upgrade).collect();
    drop(liste);
    vivants
        .iter()
        .find(|d| d.meta(session_id).is_ok())
        .or_else(|| vivants.first())
        .cloned()
}

/// Diffuse « maj » : les écrans relisent la liste.
pub(crate) fn signaler(d: &Daemon) {
    d.broadcast("automatisations", None, json!({"type": "maj"}));
}


fn erreur(texte: impl Into<String>) -> SessionError {
    SessionError::Protocol(texte.into())
}

/// Message d'erreur sans le préfixe technique (« protocol error: »).
pub fn message(err: &SessionError) -> String {
    match err {
        SessionError::Protocol(texte) => texte.clone(),
        autre => autre.to_string(),
    }
}

fn texte(p: &Value, cle: &str) -> Option<String> {
    p.get(cle).and_then(Value::as_str).map(|s| s.trim().to_string())
}

/// `{"provider", "name"}` ou « fournisseur/modèle » (ou « fournisseur:modèle »).
fn lire_modele(v: &Value) -> Option<ModelRef> {
    match v {
        Value::String(s) => {
            let (f, m) = s.trim().split_once('/').or_else(|| s.trim().split_once(':'))?;
            (!f.trim().is_empty() && !m.trim().is_empty()).then(|| ModelRef::new(f.trim(), m.trim()))
        }
        Value::Object(_) => serde_json::from_value::<ModelRef>(v.clone())
            .ok()
            .filter(|m| !m.provider.trim().is_empty() && !m.name.trim().is_empty()),
        _ => None,
    }
}

pub(crate) fn maintenant_local(ms: i64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ms).single().unwrap_or_else(Local::now)
}

fn verifier_dossier(d: &Daemon, dossier: &str) -> SessionResult<()> {
    if dossier.trim().is_empty() {
        return Err(erreur("Choisissez un dossier."));
    }
    // Espace du service (racine imposée) : le dossier est contrôlé à la création
    // de la conversation, comme pour `sessions.create`.
    if d.config.workspace_root.is_none() && !Path::new(dossier).is_dir() {
        return Err(erreur(format!("Dossier introuvable : {dossier}")));
    }
    Ok(())
}

/// Applique les champs présents de `p`.
fn appliquer(d: &Daemon, a: &mut Automatisation, p: &Value) -> SessionResult<()> {
    if let Some(nom) = texte(p, "nom") {
        if nom.is_empty() {
            return Err(erreur("Donnez un nom à l'automatisation."));
        }
        a.nom = nom.chars().take(120).collect();
    }
    if let Some(dossier) = texte(p, "dossier") {
        verifier_dossier(d, &dossier)?;
        if dossier != a.dossier {
            a.session_id = None; // la conversation gardée appartenait à l'ancien dossier
        }
        a.dossier = dossier;
    }
    if let Some(prompt) = p.get("prompt").and_then(Value::as_str) {
        if prompt.trim().is_empty() {
            return Err(erreur("Écrivez le prompt à envoyer."));
        }
        a.prompt = prompt.to_string();
    }
    if let Some(m) = p.get("modele").filter(|m| !m.is_null()) {
        a.modele = lire_modele(m).ok_or_else(|| erreur("Modèle invalide : attendu « fournisseur/modèle »."))?;
    }
    if let Some(h) = p.get("horaire").filter(|h| !h.is_null()) {
        a.horaire = serde_json::from_value(h.clone()).map_err(|e| erreur(format!("Horaire invalide : {e}")))?;
    }
    if let Some(b) = p.get("memeConversation").and_then(Value::as_bool) {
        a.meme_conversation = b;
    }
    if let Some(b) = p.get("active").and_then(Value::as_bool) {
        a.active = b;
    }
    if let Some(b) = p.get("rattrapage").and_then(Value::as_bool) {
        a.rattrapage = b;
    }
    if let Some(v) = p.get("verification") {
        a.verification = v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    }
    Ok(())
}

/// Prochaine exécution d'une automatisation active, après `maintenant`.
fn planifier(a: &mut Automatisation, maintenant_ms: i64) {
    a.prochaine_ms = if a.active {
        a.horaire
            .regle()
            .ok()
            .and_then(|r| horaire::prochaine_apres(&r, &maintenant_local(maintenant_ms)))
            .map(|t| t.timestamp_millis())
    } else {
        None
    };
}

fn creer(d: &Daemon, p: &Value, maintenant_ms: i64) -> SessionResult<Automatisation> {
    if p.get("horaire").is_none_or(Value::is_null) {
        return Err(erreur("Choisissez un horaire."));
    }
    let mut a = Automatisation {
        id: crate::util::new_id(),
        nom: String::new(),
        dossier: String::new(),
        prompt: String::new(),
        modele: ModelRef::new("", ""),
        horaire: Horaire::Quotidien { heure: "08:00".into() },
        meme_conversation: false,
        active: true,
        rattrapage: true,
        verification: None,
        cree_ms: maintenant_ms,
        modifie_ms: maintenant_ms,
        prochaine_ms: None,
        session_id: None,
        historique: Vec::new(),
    };
    appliquer(d, &mut a, p)?;
    if a.nom.is_empty() {
        return Err(erreur("Donnez un nom à l'automatisation."));
    }
    if a.prompt.trim().is_empty() {
        return Err(erreur("Écrivez le prompt à envoyer."));
    }
    verifier_dossier(d, &a.dossier)?;
    if a.modele.provider.is_empty() {
        return Err(erreur("Choisissez un modèle."));
    }
    horaire::valider(&a.horaire, &maintenant_local(maintenant_ms)).map_err(erreur)?;
    planifier(&mut a, maintenant_ms);
    let etat = etat(d);
    let mut e = lock(&etat);
    e.liste.push(a.clone());
    e.enregistrer();
    Ok(a)
}

fn modifier(d: &Daemon, id: &str, p: &Value, maintenant_ms: i64) -> SessionResult<Automatisation> {
    let etat = etat(d);
    let mut e = lock(&etat);
    let a = e.trouver(id)?;
    let mut nouvelle = a.clone();
    appliquer(d, &mut nouvelle, p)?;
    horaire::valider(&nouvelle.horaire, &maintenant_local(maintenant_ms)).map_err(erreur)?;
    if nouvelle.horaire != a.horaire || nouvelle.active != a.active || nouvelle.prochaine_ms.is_none() {
        planifier(&mut nouvelle, maintenant_ms);
    }
    nouvelle.modifie_ms = maintenant_ms;
    *a = nouvelle.clone();
    e.enregistrer();
    Ok(nouvelle)
}

fn supprimer(d: &Daemon, id: &str) -> SessionResult<()> {
    let etat = etat(d);
    let mut e = lock(&etat);
    let avant = e.liste.len();
    e.liste.retain(|a| a.id != id);
    if e.liste.len() == avant {
        return Err(erreur(format!("Automatisation introuvable : {id}")));
    }
    e.enregistrer();
    Ok(())
}

/// Vue envoyée aux écrans : la définition, l'horaire en clair, une exécution en cours.
fn vue(a: &Automatisation) -> Value {
    let mut v = serde_json::to_value(a).unwrap_or_default();
    if let Some(o) = v.as_object_mut() {
        o.insert("horaireTexte".into(), json!(a.horaire.texte()));
        o.insert("enCours".into(), json!(a.en_cours()));
    }
    v
}

fn historique(d: &Daemon, id: Option<&str>, limite: usize) -> SessionResult<Value> {
    let etat = etat(d);
    let mut e = lock(&etat);
    let mut lignes: Vec<Value> = Vec::new();
    let choisies: Vec<&Automatisation> = match id {
        Some(id) => vec![&*e.trouver(id)?],
        None => e.liste.iter().collect(),
    };
    for a in choisies {
        for x in &a.historique {
            let mut v = serde_json::to_value(x)?;
            if let Some(o) = v.as_object_mut() {
                o.insert("automatisationId".into(), json!(a.id));
                o.insert("nom".into(), json!(a.nom));
            }
            lignes.push(v);
        }
    }
    lignes.sort_by_key(|v| std::cmp::Reverse(v.get("debutMs").and_then(Value::as_i64).unwrap_or(0)));
    lignes.truncate(limite.max(1));
    Ok(Value::Array(lignes))
}

/// Horaire en clair et 3 prochaines exécutions (écran de création, REPL).
fn apercu(p: &Value, maintenant_ms: i64) -> SessionResult<Value> {
    let h: Horaire = serde_json::from_value(p.get("horaire").cloned().unwrap_or_default())
        .map_err(|e| erreur(format!("Horaire invalide : {e}")))?;
    let mut t = maintenant_local(maintenant_ms);
    let regle = horaire::valider(&h, &t).map_err(erreur)?;
    let mut prochaines = Vec::new();
    while prochaines.len() < 3 {
        let Some(s) = horaire::prochaine_apres(&regle, &t) else { break };
        prochaines.push(s.timestamp_millis());
        t = s;
    }
    Ok(json!({"texte": h.texte(), "prochaines": prochaines}))
}


/// RPC `automatisations.*`.
pub fn dispatch(d: &Daemon, m: &str, p: &Value) -> SessionResult<Value> {
    let maintenant = crate::util::now_ms();
    let id = || texte(p, "id").filter(|s| !s.is_empty()).ok_or_else(|| erreur("id manquant"));
    match m {
        "automatisations.lister" => {
            let etat = etat(d);
            let liste: Vec<Value> = lock(&etat).liste.iter().map(vue).collect();
            Ok(json!({"automatisations": liste, "maintenantMs": maintenant}))
        }
        "automatisations.creer" => {
            let a = creer(d, p, maintenant)?;
            signaler(d);
            Ok(vue(&a))
        }
        "automatisations.modifier" => {
            let a = modifier(d, &id()?, p, maintenant)?;
            signaler(d);
            Ok(vue(&a))
        }
        "automatisations.supprimer" => {
            supprimer(d, &id()?)?;
            signaler(d);
            Ok(json!({"ok": true}))
        }
        // « Lancer maintenant » : sans la vérification avant lancement.
        "automatisations.lancer" => {
            let x = execution::lancer(&d.arc(), &id()?, Declencheur::Manuel, None, 0, maintenant)?;
            Ok(serde_json::to_value(x)?)
        }
        "automatisations.arreter" => {
            execution::arreter(d, &id()?)?;
            Ok(json!({"ok": true}))
        }
        "automatisations.historique" => {
            let limite = p.get("limite").and_then(Value::as_u64).unwrap_or(20) as usize;
            historique(d, texte(p, "id").filter(|s| !s.is_empty()).as_deref(), limite)
        }
        "automatisations.apercu" => apercu(p, maintenant),
        _ => Err(erreur(format!("unknown method: {m}"))),
    }
}

/// Ce que le planificateur doit faire d'une automatisation arrivée à échéance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Echeance {
    Lancer { prevue_ms: i64, declencheur: Declencheur, manquees: u32 },
    /// Créneau(x) passé(s) pendant une veille, rattrapage désactivé.
    Manquee { prevue_ms: i64, manquees: u32 },
    /// L'exécution précédente tourne encore : ce créneau est sauté.
    Occupee { prevue_ms: i64 },
}

/// Échéance d'une automatisation à l'instant `maintenant` (horloge simulée dans
/// les tests). Avance `prochaine_ms` au créneau suivant quand elle est échue.
pub(crate) fn echeance<Tz: TimeZone>(a: &mut Automatisation, maintenant: &DateTime<Tz>) -> Option<Echeance> {
    let regle = match a.horaire.regle() {
        Ok(r) if a.active => r,
        _ => {
            a.prochaine_ms = None;
            return None;
        }
    };
    let maintenant_ms = maintenant.timestamp_millis();
    let suivante = |apres: &DateTime<Tz>| horaire::prochaine_apres(&regle, apres).map(|t| t.timestamp_millis());
    let Some(prevue) = a.prochaine_ms else {
        a.prochaine_ms = suivante(maintenant);
        return None;
    };
    if maintenant_ms < prevue {
        return None;
    }
    a.prochaine_ms = suivante(maintenant);
    let depuis = maintenant.timezone().timestamp_millis_opt(prevue).single()?;
    let manquees = 1 + horaire::compter_entre(&regle, &depuis, maintenant, 999);
    if a.en_cours() {
        return Some(Echeance::Occupee { prevue_ms: prevue });
    }
    if maintenant_ms - prevue <= TOLERANCE_MS && manquees == 1 {
        return Some(Echeance::Lancer { prevue_ms: prevue, declencheur: Declencheur::Horaire, manquees: 0 });
    }
    if a.rattrapage {
        Some(Echeance::Lancer { prevue_ms: prevue, declencheur: Declencheur::Rattrapage, manquees })
    } else {
        Some(Echeance::Manquee { prevue_ms: prevue, manquees })
    }
}

const OCCUPEE: &str = "L'exécution précédente tournait encore";

/// Note un créneau manqué ou sauté dans l'historique (sautés à la suite : une ligne).
fn noter_echeance(a: &mut Automatisation, ech: &Echeance, maintenant_ms: i64) {
    let ligne = |statut, prevue_ms, manquees, resume: String| Execution {
        id: crate::util::new_id(),
        declencheur: Declencheur::Horaire,
        prevue_ms: Some(prevue_ms),
        debut_ms: maintenant_ms,
        fin_ms: Some(maintenant_ms),
        statut,
        session_id: None,
        depuis: None,
        resume: Some(resume),
        manquees,
        arret_demande: false,
    };
    match *ech {
        Echeance::Manquee { prevue_ms, manquees } => {
            let texte = if manquees > 1 {
                format!("{manquees} exécutions prévues pendant une veille ou un arrêt du service ; rattrapage désactivé.")
            } else {
                "Prévue pendant une veille ou un arrêt du service ; rattrapage désactivé.".to_string()
            };
            a.noter(ligne(Statut::Manquee, prevue_ms, manquees, texte));
        }
        Echeance::Occupee { prevue_ms } => match a.historique.first_mut() {
            Some(x) if x.statut == Statut::Sautee && x.resume.as_deref().is_some_and(|r| r.starts_with(OCCUPEE)) => {
                x.manquees += 1;
                x.fin_ms = Some(maintenant_ms);
                x.resume = Some(format!("{OCCUPEE} ({} créneaux sautés).", x.manquees));
            }
            _ => a.noter(ligne(Statut::Sautee, prevue_ms, 1, format!("{OCCUPEE}."))),
        },
        Echeance::Lancer { .. } => {}
    }
}

/// Un passage du planificateur : fins d'exécution, puis échéances.
pub(crate) fn tic(d: &Arc<Daemon>, maintenant_ms: i64) {
    execution::suivre(d, maintenant_ms);
    let maintenant = maintenant_local(maintenant_ms);
    let (lancements, change) = {
        let etat = etat(d);
        let mut e = lock(&etat);
        let mut change = false;
        let mut lancements = Vec::new();
        for a in e.liste.iter_mut() {
            let avant = a.prochaine_ms;
            match echeance(a, &maintenant) {
                Some(Echeance::Lancer { prevue_ms, declencheur, manquees }) => {
                    lancements.push((a.id.clone(), prevue_ms, declencheur, manquees));
                }
                Some(autre) => {
                    noter_echeance(a, &autre, maintenant_ms);
                    change = true;
                }
                None => {}
            }
            change |= a.prochaine_ms != avant;
        }
        if change {
            e.enregistrer();
        }
        (lancements, change)
    };
    for (id, prevue_ms, declencheur, manquees) in lancements {
        if let Err(err) = execution::lancer(d, &id, declencheur, Some(prevue_ms), manquees, maintenant_ms) {
            tracing::warn!(automatisation = %id, error = %err, "automatisation non lancée");
        }
    }
    if change {
        signaler(d);
    }
}

/// Vrai tant qu'une automatisation est active ou qu'une exécution tourne : le
/// service reste là à l'heure dite, même quand l'appli est fermée.
pub fn retient_le_service(d: &Daemon) -> bool {
    let etat = etat(d);
    let e = lock(&etat);
    e.liste.iter().any(|a| a.active || a.en_cours())
}

/// Au démarrage du service : reprend les exécutions laissées en route, puis
/// lance le planificateur (un passage toutes les 10 s).
pub fn demarrer(d: &Arc<Daemon>) {
    lock(demons()).push(Arc::downgrade(d));
    execution::reprendre(d, crate::util::now_ms());
    let faible = Arc::downgrade(d);
    tokio::spawn(async move {
        let mut cadence = tokio::time::interval(TIC);
        cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            cadence.tick().await;
            let Some(d) = faible.upgrade() else { break };
            if d.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            tic(&d, crate::util::now_ms());
        }
    });
}

// ----- module REPL `automatisations` ----------------------------------------

/// Crochet du noyau REPL : le module Python `automatisations` (creer, lister…).
/// Sans dossier ni modèle donnés, ceux de la conversation qui appelle.
pub fn crochet_repl() -> Arc<dyn axecode_app::repl::TurnHook> {
    Arc::new(CrochetRepl)
}

struct CrochetRepl;

fn completer(method: &str, params: Value, session: &SessionMeta) -> Value {
    let mut params = if params.is_object() { params } else { json!({}) };
    if method == "automatisations.creer" {
        if let Some(o) = params.as_object_mut() {
            if o.get("dossier").and_then(Value::as_str).is_none_or(|s| s.trim().is_empty()) {
                o.insert("dossier".into(), json!(session.workspace_id));
            }
            if o.get("modele").is_none_or(Value::is_null) {
                o.insert("modele".into(), serde_json::to_value(&session.model).unwrap_or_default());
            }
        }
    }
    params
}

#[async_trait]
impl axecode_app::repl::TurnHook for CrochetRepl {
    fn handles(&self, method: &str) -> bool {
        method.starts_with("automatisations.")
    }

    async fn host_call(&self, session: &SessionMeta, method: &str, params: Value) -> Result<Value, String> {
        let d = demon_de(&session.id).ok_or_else(|| "automatisations : service indisponible.".to_string())?;
        dispatch(&d, method, &completer(method, params, session)).map_err(|e| message(&e))
    }
}
