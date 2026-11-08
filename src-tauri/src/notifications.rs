//! Centre des notifications de l'appli.
//!
//! - Liste des événements récents (100 au plus), état de chaque session (attend votre réponse,
//!   fini, échec ; lu ou non : vue « Tableau » de l'onglet Agents) et réglages, gardés dans
//!   `<données>/notifications.json`.
//! - Les fenêtres repèrent les fins de tour dans les événements du service
//!   (`src/components/notifications/suivi.ts`) et les signalent ici. Plusieurs fenêtres signalent
//!   la même fin avec la même clé : elle n'est gardée qu'une fois.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// État complet (événements, états des sessions, réglages, non-lus), émis à chaque changement.
pub(crate) const EVENEMENT_ETAT: &str = "axe://notifications";
const MAX_EVENEMENTS: usize = 100;
const MAX_ETATS: usize = 500;
/// Genres qui décrivent l'état d'une session (les autres, « info », ne vont qu'à la cloche).
const GENRES_ETAT: [&str; 3] = ["fini", "attente", "echec"];

fn verrou<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn maintenant_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn vrai() -> bool {
    true
}

/// Texte d'au plus `max` caractères (« … » à la fin s'il est coupé).
fn couper(texte: &str, max: usize) -> String {
    let texte = texte.trim();
    if texte.chars().count() <= max {
        return texte.to_string();
    }
    let mut court: String = texte.chars().take(max.saturating_sub(1)).collect();
    court.push('…');
    court
}

/// Un événement de la cloche (fin de tour, question en attente, échec, information).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Evenement {
    pub cle: String,
    /// « fini », « attente », « echec » ou « info ».
    pub genre: String,
    pub titre: String,
    pub texte: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dossier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Connexion du service (absente : le service de ce poste).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connexion: Option<String>,
    pub sous_agent: bool,
    /// Conversation sans dossier.
    pub libre: bool,
    pub ts: i64,
    pub lu: bool,
}

/// Ce qu'une fenêtre signale : l'événement, et s'il doit alerter (faux pour la fin d'un tour
/// lancé par un réveil /heartbeat ou un guet : listé, sans notification ni son).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Signalement {
    #[serde(flatten)]
    pub evenement: Evenement,
    #[serde(default = "vrai")]
    pub alerter: bool,
}

/// État d'une session pour la vue « Tableau » (attend votre réponse, fini, échec).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct EtatSession {
    pub genre: String,
    pub depuis: i64,
    pub texte: String,
    pub lu: bool,
}

/// Réglages > Notifications.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Reglages {
    /// Notifications du système (sinon : cloche seulement).
    pub systeme: bool,
    pub fini: bool,
    pub attente: bool,
    pub echec: bool,
    /// Fin et échec des sous-agents aussi (leurs questions alertent toujours).
    pub sous_agents: bool,
    /// Son court, joué par la fenêtre.
    pub son: bool,
    pub ne_pas_deranger: bool,
}

impl Default for Reglages {
    fn default() -> Self {
        Self { systeme: true, fini: true, attente: true, echec: true, sous_agents: false, son: true, ne_pas_deranger: false }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Donnees {
    evenements: Vec<Evenement>,
    etats: HashMap<String, EtatSession>,
    reglages: Reglages,
}

/// Suite d'un signalement : nouveau (sinon déjà connu), notification du système, son.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Decision {
    pub nouveau: bool,
    pub systeme: bool,
    pub son: bool,
}

pub(crate) struct Centre {
    chemin: Option<PathBuf>,
    donnees: Mutex<Donnees>,
    /// Fenêtre -> conversation (ou journal de sous-agent) affichée.
    vues: Mutex<HashMap<String, String>>,
}

impl Centre {
    pub(crate) fn ouvrir(chemin: Option<PathBuf>) -> Self {
        let donnees = chemin
            .as_ref()
            .and_then(|c| std::fs::read(c).ok())
            .and_then(|octets| serde_json::from_slice::<Donnees>(&octets).ok())
            .unwrap_or_default();
        Self { chemin, donnees: Mutex::new(donnees), vues: Mutex::new(HashMap::new()) }
    }

    fn enregistrer(&self, donnees: &Donnees) {
        let Some(chemin) = &self.chemin else { return };
        let Ok(texte) = serde_json::to_vec_pretty(donnees) else { return };
        let tmp = chemin.with_extension("json.tmp");
        if std::fs::write(&tmp, texte).is_ok() {
            let _ = std::fs::rename(&tmp, chemin);
        }
    }

    /// Garde un signalement et dit quoi en faire. `affichee` : une fenêtre qui a le focus montre
    /// déjà la conversation (l'événement est lu d'office, sans alerte). `essai` : notification
    /// d'essai des Réglages (montrée même si les notifications du système sont coupées).
    pub(crate) fn signaler(&self, s: Signalement, maintenant: i64, affichee: bool, essai: bool) -> (Decision, Evenement) {
        let mut d = verrou(&self.donnees);
        let mut ev = s.evenement;
        if !matches!(ev.genre.as_str(), "fini" | "attente" | "echec" | "info") {
            ev.genre = "info".into();
        }
        if ev.ts <= 0 {
            ev.ts = maintenant;
        }
        if ev.cle.trim().is_empty() {
            ev.cle = format!("{}:{}:{}", ev.genre, ev.session_id.as_deref().unwrap_or("-"), ev.ts);
        }
        if d.evenements.iter().any(|e| e.cle == ev.cle) {
            return (Decision::default(), ev);
        }
        ev.titre = couper(&ev.titre, 120);
        ev.texte = couper(&ev.texte, 400);
        ev.lu = affichee;
        if let Some(sid) = ev.session_id.clone().filter(|_| GENRES_ETAT.contains(&ev.genre.as_str())) {
            d.etats.insert(sid, EtatSession { genre: ev.genre.clone(), depuis: ev.ts, texte: ev.texte.clone(), lu: affichee });
            if d.etats.len() > MAX_ETATS {
                let mut ordre: Vec<(String, i64)> = d.etats.iter().map(|(k, e)| (k.clone(), e.depuis)).collect();
                ordre.sort_by_key(|(_, depuis)| *depuis);
                for (k, _) in ordre.into_iter().take(d.etats.len() - MAX_ETATS) {
                    d.etats.remove(&k);
                }
            }
        }
        let r = d.reglages.clone();
        let actif = match ev.genre.as_str() {
            "fini" => r.fini && (!ev.sous_agent || r.sous_agents),
            "echec" => r.echec && (!ev.sous_agent || r.sous_agents),
            "attente" => r.attente,
            _ => true,
        };
        let alerter = essai || (s.alerter && !affichee && actif && !r.ne_pas_deranger);
        let decision = Decision { nouveau: true, systeme: alerter && (r.systeme || essai), son: alerter && r.son };
        d.evenements.insert(0, ev.clone());
        d.evenements.truncate(MAX_EVENEMENTS);
        self.enregistrer(&d);
        (decision, ev)
    }

    /// La session repart (nouveau tour) ou l'utilisateur a répondu : plus d'état à montrer.
    pub(crate) fn effacer_etat(&self, session: &str) -> bool {
        let mut d = verrou(&self.donnees);
        let change = d.etats.remove(session).is_some();
        if change {
            self.enregistrer(&d);
        }
        change
    }

    /// Marque lu un événement (`cle`), ceux d'une session et son état (`session`), ou tout.
    /// Une session qui attend une réponse reste dans « Attend votre réponse » (lue).
    pub(crate) fn marquer_lu(&self, cle: Option<&str>, session: Option<&str>) -> bool {
        let mut d = verrou(&self.donnees);
        let mut change = false;
        for e in d.evenements.iter_mut() {
            let vise = match (cle, session) {
                (Some(c), _) => e.cle == c,
                (None, Some(s)) => e.session_id.as_deref() == Some(s),
                (None, None) => true,
            };
            if vise && !e.lu {
                e.lu = true;
                change = true;
            }
        }
        if cle.is_none() {
            for (sid, etat) in d.etats.iter_mut() {
                if session.map_or(true, |s| s == sid) && !etat.lu {
                    etat.lu = true;
                    change = true;
                }
            }
        }
        if change {
            self.enregistrer(&d);
        }
        change
    }

    pub(crate) fn noter_vue(&self, fenetre: &str, session: Option<String>) {
        let mut vues = verrou(&self.vues);
        match session.filter(|s| !s.is_empty()) {
            Some(s) => {
                vues.insert(fenetre.to_string(), s);
            }
            None => {
                vues.remove(fenetre);
            }
        }
    }

    pub(crate) fn vue_de(&self, fenetre: &str) -> Option<String> {
        verrou(&self.vues).get(fenetre).cloned()
    }

    pub(crate) fn etat(&self) -> Value {
        let d = verrou(&self.donnees);
        let non_lus = d.evenements.iter().filter(|e| !e.lu).count();
        json!({"evenements": d.evenements, "etats": d.etats, "reglages": d.reglages, "nonLus": non_lus})
    }

    pub(crate) fn reglages(&self) -> Reglages {
        verrou(&self.donnees).reglages.clone()
    }

    pub(crate) fn changer_reglages(&self, reglages: Reglages) {
        let mut d = verrou(&self.donnees);
        d.reglages = reglages;
        self.enregistrer(&d);
    }
}

/// Le centre de l'appli (une seule instance, quelle que soit la fenêtre).
pub(crate) fn centre() -> &'static Centre {
    static CENTRE: OnceLock<Centre> = OnceLock::new();
    CENTRE.get_or_init(|| {
        let chemin = axecode_daemon::util::default_data_dir().ok().map(|d| d.join("notifications.json"));
        Centre::ouvrir(chemin)
    })
}

/// Une fenêtre qui a le focus affiche-t-elle cette session ?
fn affichee(app: &AppHandle, session: Option<&str>) -> bool {
    let Some(session) = session.filter(|s| !s.is_empty()) else { return false };
    app.webview_windows()
        .iter()
        .any(|(label, w)| w.is_focused().unwrap_or(false) && centre().vue_de(label).as_deref() == Some(session))
}

/// Envoie l'état à toutes les fenêtres.
fn publier(app: &AppHandle) {
    let _ = app.emit(EVENEMENT_ETAT, centre().etat());
}

// ---- Commandes ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn notifications_lister() -> Result<Value, String> {
    Ok(centre().etat())
}

/// Une fin de tour : gardée une fois (même clé signalée par plusieurs fenêtres).
#[tauri::command]
pub(crate) async fn notifications_signaler(app: AppHandle, signalement: Signalement) -> Result<Decision, String> {
    let vue = affichee(&app, signalement.evenement.session_id.as_deref());
    let (decision, _) = centre().signaler(signalement, maintenant_ms(), vue, false);
    if decision.nouveau {
        publier(&app);
    }
    Ok(decision)
}

#[tauri::command]
pub(crate) async fn notifications_effacer_etat(app: AppHandle, session_id: String) -> Result<(), String> {
    if centre().effacer_etat(&session_id) {
        publier(&app);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn notifications_marquer_lu(app: AppHandle, cle: Option<String>, session_id: Option<String>) -> Result<(), String> {
    if centre().marquer_lu(cle.as_deref(), session_id.as_deref()) {
        publier(&app);
    }
    Ok(())
}

/// Conversation affichée par la fenêtre appelante ; si elle a le focus, ses événements sont lus.
#[tauri::command]
pub(crate) async fn notifications_vue(app: AppHandle, window: tauri::Window, session_id: Option<String>) -> Result<(), String> {
    centre().noter_vue(window.label(), session_id.clone());
    if let Some(session) = session_id.filter(|s| !s.is_empty() && window.is_focused().unwrap_or(false)) {
        if centre().marquer_lu(None, Some(&session)) {
            publier(&app);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn notifications_reglages(app: AppHandle, reglages: Option<Reglages>) -> Result<Reglages, String> {
    if let Some(reglages) = reglages {
        centre().changer_reglages(reglages);
        publier(&app);
    }
    Ok(centre().reglages())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn non_lus(c: &Centre) -> u64 {
        c.etat()["nonLus"].as_u64().unwrap_or(0)
    }

    fn sig(cle: &str, genre: &str, session: Option<&str>) -> Signalement {
        Signalement {
            evenement: Evenement {
                cle: cle.into(),
                genre: genre.into(),
                titre: "Facture OVH".into(),
                texte: "Fini.".into(),
                session_id: session.map(str::to_string),
                ..Default::default()
            },
            alerter: true,
        }
    }

    #[test]
    fn meme_cle_gardee_une_seule_fois() {
        let c = Centre::ouvrir(None);
        let (d1, _) = c.signaler(sig("s1:fini:10", "fini", Some("s1")), 100, false, false);
        let (d2, _) = c.signaler(sig("s1:fini:10", "fini", Some("s1")), 101, false, false);
        assert_eq!(d1, Decision { nouveau: true, systeme: true, son: true });
        assert_eq!(d2, Decision::default(), "la deuxième fenêtre ne montre ni ne sonne");
        assert_eq!(non_lus(&c), 1);
        assert_eq!(couper("abcdef", 4), "abc…");
    }

    #[test]
    fn conversation_affichee_lue_sans_alerte() {
        let c = Centre::ouvrir(None);
        let (d, ev) = c.signaler(sig("k", "fini", Some("s1")), 100, true, false);
        assert!(d.nouveau && !d.systeme && !d.son);
        assert!(ev.lu);
        assert_eq!(non_lus(&c), 0);
    }

    #[test]
    fn reglages_ne_pas_deranger_genres_sous_agents() {
        let c = Centre::ouvrir(None);
        c.changer_reglages(Reglages { ne_pas_deranger: true, ..Reglages::default() });
        let (d, _) = c.signaler(sig("a", "attente", Some("s1")), 1, false, false);
        assert!(d.nouveau && !d.systeme && !d.son, "ne pas déranger : cloche seulement");
        c.changer_reglages(Reglages { fini: false, son: false, ..Reglages::default() });
        assert!(!c.signaler(sig("b", "fini", Some("s2")), 2, false, false).0.systeme);
        let (d, _) = c.signaler(sig("c", "echec", Some("s3")), 3, false, false);
        assert!(d.systeme && !d.son);
        let mut sa = sig("d", "fini", Some("s4"));
        sa.evenement.sous_agent = true;
        c.changer_reglages(Reglages::default());
        assert!(!c.signaler(sa.clone(), 4, false, false).0.systeme, "fin d'un sous-agent : sans alerte par défaut");
        sa.evenement.cle = "e".into();
        sa.evenement.genre = "attente".into();
        assert!(c.signaler(sa, 5, false, false).0.systeme, "question d'un sous-agent : alerte");
        let mut reveil = sig("f", "fini", Some("s5"));
        reveil.alerter = false;
        let (d, ev) = c.signaler(reveil, 6, false, false);
        assert!(d.nouveau && !d.systeme && !ev.lu, "réveil /heartbeat : listé non lu, sans alerte");
    }

    #[test]
    fn etats_des_sessions() {
        let c = Centre::ouvrir(None);
        c.signaler(sig("q", "attente", Some("s1")), 10, false, false);
        c.signaler(sig("f", "fini", Some("s2")), 11, false, false);
        c.signaler(sig("i", "info", None), 12, false, false);
        let etat = c.etat();
        assert_eq!(etat["etats"]["s1"]["genre"], "attente");
        assert_eq!(etat["etats"]["s2"]["genre"], "fini");
        assert_eq!(etat["etats"].as_object().unwrap().len(), 2, "« info » ne décrit pas une session");
        assert_eq!(etat["nonLus"], 3);
        // ouvrir la conversation : ses événements et son état sont lus, la question reste.
        assert!(c.marquer_lu(None, Some("s1")));
        let etat = c.etat();
        assert_eq!(etat["etats"]["s1"]["genre"], "attente");
        assert_eq!(etat["etats"]["s1"]["lu"], true);
        assert_eq!(etat["nonLus"], 2);
        // l'utilisateur répond : plus d'état.
        assert!(c.effacer_etat("s1"));
        assert!(c.etat()["etats"].get("s1").is_none());
        // « Tout marquer lu ».
        assert!(c.marquer_lu(None, None));
        assert_eq!(non_lus(&c), 0);
        assert!(!c.marquer_lu(None, None), "rien de plus à marquer");
    }

    #[test]
    fn liste_bornee_et_relue_depuis_le_disque() {
        let dossier = std::env::temp_dir().join(format!("axe-notif-{}", maintenant_ms()));
        std::fs::create_dir_all(&dossier).unwrap();
        let chemin = dossier.join("notifications.json");
        let c = Centre::ouvrir(Some(chemin.clone()));
        for i in 0..(MAX_EVENEMENTS + 5) {
            c.signaler(sig(&format!("k{i}"), "fini", Some(&format!("s{i}"))), i as i64 + 1, false, false);
        }
        c.changer_reglages(Reglages { son: false, ..Reglages::default() });
        let relu = Centre::ouvrir(Some(chemin));
        let etat = relu.etat();
        assert_eq!(etat["evenements"].as_array().unwrap().len(), MAX_EVENEMENTS);
        assert_eq!(etat["evenements"][0]["cle"], format!("k{}", MAX_EVENEMENTS + 4), "le plus récent d'abord");
        assert_eq!(relu.reglages().son, false);
        let _ = std::fs::remove_dir_all(dossier);
    }

    #[test]
    fn vues_par_fenetre() {
        let c = Centre::ouvrir(None);
        c.noter_vue("main", Some("s1".into()));
        c.noter_vue("axecode-window-2", Some("s2".into()));
        assert_eq!(c.vue_de("main").as_deref(), Some("s1"));
        c.noter_vue("main", None);
        assert_eq!(c.vue_de("main"), None);
        assert_eq!(c.vue_de("axecode-window-2").as_deref(), Some("s2"));
    }
}
