//! Centre des notifications de l'appli.
//!
//! - Liste des événements récents (cloche de la barre du haut, 100 au plus), état de chaque
//!   session (attend votre réponse, fini, échec ; lu ou non : vue « Tableau » de l'onglet Agents)
//!   et réglages (Réglages > Notifications), gardés dans `<données>/notifications.json`.
//! - Les fenêtres repèrent les fins de tour dans les événements du service
//!   (`src/components/notifications/suivi.ts`) et les signalent ici. Plusieurs fenêtres signalent
//!   la même fin avec la même clé : elle n'est gardée, montrée et sonnée qu'une fois. L'événement
//!   de fenêtre `ide-notification` des autres lots (contrat commun :
//!   `src/components/notifications/contrat.ts`) arrive par le même chemin.
//! - Notification du système seulement si aucune fenêtre qui a le focus n'affiche la
//!   conversation : Windows = toast WinRT (clic = ouvrir la conversation), macOS = `osascript`
//!   + rebond du Dock, Linux = `notify-send` (clic = ouvrir si le serveur le permet).
//! - Badge de l'icône = nombre de non-lus : Windows = pastille sur le bouton de la barre des
//!   tâches, macOS = Dock, Linux = lanceur (Unity) quand il existe.
//!
//! Aucune dépendance ajoutée : le greffon officiel qui sait suivre les clics sur ordinateur
//! (tauri-plugin-notification 2.6+) exige Tauri 2.12 ; nous sommes en 2.10.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// État complet (événements, états des sessions, réglages, non-lus), émis à chaque changement.
pub(crate) const EVENEMENT_ETAT: &str = "axe://notifications";
/// Clic sur une notification du système : la fenêtre choisie ouvre la conversation.
pub(crate) const EVENEMENT_OUVRIR: &str = "axe://notification-ouvrir";
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

    pub(crate) fn non_lus(&self) -> usize {
        verrou(&self.donnees).evenements.iter().filter(|e| !e.lu).count()
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

fn nom_appli(app: &AppHandle) -> String {
    app.config().product_name.clone().unwrap_or_else(|| "SavIDE".into())
}

/// Une fenêtre qui a le focus affiche-t-elle cette session ?
fn affichee(app: &AppHandle, session: Option<&str>) -> bool {
    let Some(session) = session.filter(|s| !s.is_empty()) else { return false };
    app.webview_windows()
        .iter()
        .any(|(label, w)| w.is_focused().unwrap_or(false) && centre().vue_de(label).as_deref() == Some(session))
}

/// Envoie l'état à toutes les fenêtres et met le badge de l'icône à jour.
fn publier(app: &AppHandle) {
    let _ = app.emit(EVENEMENT_ETAT, centre().etat());
    badge(app, centre().non_lus());
}

/// Clic sur une notification : la fenêtre qui a le focus (sinon la principale) revient
/// devant et ouvre la conversation.
pub(crate) fn ouvrir(app: &AppHandle, ev: &Evenement) {
    let fenetres = app.webview_windows();
    let cible = fenetres
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| fenetres.get("main"))
        .or_else(|| fenetres.values().next());
    if let Some(w) = cible {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to(w.label(), EVENEMENT_OUVRIR, ev);
    }
}

// ---- Badge de l'icône ------------------------------------------------------------------

const TAILLE_BADGE: u32 = 32;

/// Chiffres 3 x 5 (lignes de 3 bits, bit de gauche en premier) et « + ».
fn glyphe(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        _ => [0b000, 0b010, 0b111, 0b010, 0b000],
    }
}

/// Pastille de la barre des tâches de Windows (32 x 32, RGBA) : disque rouge et nombre en
/// blanc (« 9+ » au-delà de 9).
pub(crate) fn image_badge(n: usize) -> Vec<u8> {
    let t = TAILLE_BADGE as i32;
    let mut rgba = vec![0u8; (t * t * 4) as usize];
    let centre = (t as f32 - 1.0) / 2.0;
    let rayon = t as f32 / 2.0;
    for y in 0..t {
        for x in 0..t {
            let d = ((x as f32 - centre).powi(2) + (y as f32 - centre).powi(2)).sqrt();
            let couverture = (rayon - d).clamp(0.0, 1.0);
            if couverture > 0.0 {
                let i = ((y * t + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&[0xD9, 0x30, 0x25, (couverture * 255.0) as u8]);
            }
        }
    }
    let texte: Vec<char> = if n > 9 { vec!['9', '+'] } else { n.to_string().chars().collect() };
    let echelle: i32 = if texte.len() > 1 { 3 } else { 4 };
    let largeur = texte.len() as i32 * 3 * echelle + (texte.len() as i32 - 1) * echelle;
    let (x0, y0) = ((t - largeur) / 2, (t - 5 * echelle) / 2);
    for (k, c) in texte.iter().enumerate() {
        let gx = x0 + k as i32 * 4 * echelle;
        for (ligne, bits) in glyphe(*c).iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..echelle {
                    for dx in 0..echelle {
                        let (x, y) = (gx + col * echelle + dx, y0 + ligne as i32 * echelle + dy);
                        if (0..t).contains(&x) && (0..t).contains(&y) {
                            let i = ((y * t + x) * 4) as usize;
                            rgba[i..i + 4].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
                        }
                    }
                }
            }
        }
    }
    rgba
}

fn badge(app: &AppHandle, n: usize) {
    #[cfg(windows)]
    for w in app.webview_windows().values() {
        let icone = (n > 0).then(|| tauri::image::Image::new_owned(image_badge(n), TAILLE_BADGE, TAILLE_BADGE));
        let _ = w.set_overlay_icon(icone);
    }
    #[cfg(not(windows))]
    if let Some(w) = app.webview_windows().values().next() {
        let _ = w.set_badge_count((n > 0).then_some(n as i64));
    }
}

// ---- Notification du système -----------------------------------------------------------

/// Texte sûr pour un document XML (toast de Windows) : caractères spéciaux échappés,
/// caractères de contrôle retirés.
pub(crate) fn echapper_xml(texte: &str) -> String {
    let mut sortie = String::with_capacity(texte.len());
    for c in texte.chars() {
        match c {
            '&' => sortie.push_str("&amp;"),
            '<' => sortie.push_str("&lt;"),
            '>' => sortie.push_str("&gt;"),
            '"' => sortie.push_str("&quot;"),
            '\'' => sortie.push_str("&apos;"),
            '\n' | '\t' => sortie.push(' '),
            c if (c as u32) < 0x20 => {}
            c => sortie.push(c),
        }
    }
    sortie
}

/// Contenu du toast : titre, texte, sans son (le son court est joué par la fenêtre).
#[allow(dead_code)] // Windows seulement (et tests)
pub(crate) fn xml_toast(titre: &str, texte: &str) -> String {
    format!(
        "<toast activationType=\"foreground\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio silent=\"true\"/></toast>",
        echapper_xml(titre),
        echapper_xml(texte)
    )
}

/// Chaîne AppleScript entre guillemets.
#[allow(dead_code)] // macOS seulement (et tests)
pub(crate) fn chaine_applescript(texte: &str) -> String {
    let propre: String = texte.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
    format!("\"{}\"", propre.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Arguments de `notify-send` (Linux) ; `action` : bouton « Ouvrir » et attente du clic.
#[allow(dead_code)] // Linux seulement (et tests)
pub(crate) fn arguments_notify_send(appli: &str, titre: &str, texte: &str, action: bool) -> Vec<String> {
    let mut args = vec![format!("--app-name={appli}"), "--expire-time=10000".to_string()];
    if action {
        args.push("--action=default=Ouvrir".into());
        args.push("--wait".into());
    }
    args.push("--".into());
    args.push(titre.to_string());
    args.push(texte.to_string());
    args
}

fn montrer_systeme(app: &AppHandle, ev: &Evenement) {
    let titre = if ev.titre.trim().is_empty() { nom_appli(app) } else { ev.titre.clone() };
    #[cfg(windows)]
    if let Err(err) = toast::montrer(app, &titre, &ev.texte, ev.clone()) {
        tracing::warn!(error = %err, "notification du système impossible");
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!("display notification {} with title {}", chaine_applescript(&ev.texte), chaine_applescript(&titre));
        let _ = crate::__nw_std("osascript").arg("-e").arg(script).stdin(std::process::Stdio::null()).spawn();
        if let Some(w) = app.webview_windows().values().next() {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let (app, ev, appli) = (app.clone(), ev.clone(), nom_appli(app));
        std::thread::spawn(move || {
            let lancer = |action: bool| {
                crate::__nw_std("notify-send")
                    .args(arguments_notify_send(&appli, &titre, &ev.texte, action))
                    .stdin(std::process::Stdio::null())
                    .output()
            };
            match lancer(true) {
                Ok(sortie) if sortie.status.success() => {
                    if String::from_utf8_lossy(&sortie.stdout).trim() == "default" {
                        ouvrir(&app, &ev);
                    }
                }
                // libnotify trop ancienne pour --action / --wait : notification simple.
                Ok(_) => {
                    let _ = lancer(false);
                }
                Err(_) => tracing::debug!("notify-send absent : pas de notification du système"),
            }
        });
    }
}

#[cfg(windows)]
mod toast {
    use super::{verrou, Evenement};
    use std::sync::{Mutex, OnceLock};
    use tauri::AppHandle;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    /// Identité de Windows PowerShell : celle des versions de développement (l'installeur NSIS
    /// donne au raccourci du menu Démarrer l'identifiant de l'appli, que Windows exige).
    const AUMID_POWERSHELL: &str = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

    fn aumid(app: &AppHandle) -> String {
        let dev = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_lowercase()))
            .is_some_and(|nom| nom == "debug" || nom == "release");
        if dev { AUMID_POWERSHELL.to_string() } else { app.config().identifier.clone() }
    }

    /// Toasts gardés en vie : leur clic (Activated) n'arrive que tant que l'objet existe.
    fn gardes() -> &'static Mutex<Vec<ToastNotification>> {
        static GARDES: OnceLock<Mutex<Vec<ToastNotification>>> = OnceLock::new();
        GARDES.get_or_init(|| Mutex::new(Vec::new()))
    }

    pub(super) fn montrer(app: &AppHandle, titre: &str, texte: &str, ev: Evenement) -> windows::core::Result<()> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(super::xml_toast(titre, texte)))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        let app_clic = app.clone();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            super::ouvrir(&app_clic, &ev);
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid(app)))?.Show(&toast)?;
        let mut gardes = verrou(gardes());
        gardes.push(toast);
        let n = gardes.len();
        if n > 20 {
            gardes.drain(..n - 20);
        }
        Ok(())
    }
}

// ---- Commandes ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn notifications_lister() -> Result<Value, String> {
    Ok(centre().etat())
}

/// Une fin de tour (ou un `ide-notification`) : gardée une fois, notification du système et son
/// selon les réglages ; la fenêtre dont l'appel rend `son: true` joue le son court.
#[tauri::command]
pub(crate) async fn notifications_signaler(app: AppHandle, signalement: Signalement) -> Result<Decision, String> {
    let vue = affichee(&app, signalement.evenement.session_id.as_deref());
    let (decision, ev) = centre().signaler(signalement, maintenant_ms(), vue, false);
    if decision.nouveau {
        publier(&app);
        if decision.systeme {
            montrer_systeme(&app, &ev);
        }
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

/// Réglages > Notifications > « Essayer » : une notification du système et le son.
#[tauri::command]
pub(crate) async fn notifications_essayer(app: AppHandle) -> Result<Decision, String> {
    let maintenant = maintenant_ms();
    let evenement = Evenement {
        cle: format!("essai:{maintenant}"),
        genre: "info".into(),
        titre: nom_appli(&app),
        texte: "Les notifications fonctionnent.".into(),
        ..Default::default()
    };
    let (decision, ev) = centre().signaler(Signalement { evenement, alerter: true }, maintenant, false, true);
    if decision.nouveau {
        publier(&app);
        if decision.systeme {
            montrer_systeme(&app, &ev);
        }
    }
    Ok(decision)
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

    #[test]
    fn contenus_systeme_surs() {
        let xml = xml_toast("A & B <fin>", "« guillemets » \"x\" 'y'\u{7}\nligne");
        assert!(xml.contains("<text>A &amp; B &lt;fin&gt;</text>"), "{xml}");
        assert!(xml.contains("&quot;x&quot; &apos;y&apos; ligne"), "{xml}");
        assert!(xml.contains("<audio silent=\"true\"/>"));
        assert_eq!(chaine_applescript("dit \"oui\" \\ fin\n"), "\"dit \\\"oui\\\" \\\\ fin \"");
        let args = arguments_notify_send("SavIDE", "-titre", "texte", true);
        assert_eq!(args, ["--app-name=SavIDE", "--expire-time=10000", "--action=default=Ouvrir", "--wait", "--", "-titre", "texte"]);
        assert!(!arguments_notify_send("SavIDE", "t", "x", false).iter().any(|a| a == "--wait"));
    }

    #[test]
    fn badge_dessine() {
        for n in [1usize, 7, 12] {
            let img = image_badge(n);
            assert_eq!(img.len(), (TAILLE_BADGE * TAILLE_BADGE * 4) as usize);
            let blancs = img.chunks(4).filter(|p| p == &[0xFF, 0xFF, 0xFF, 0xFF]).count();
            let rouges = img.chunks(4).filter(|p| p[0] == 0xD9 && p[3] == 0xFF).count();
            assert!(blancs > 20, "{n} : chiffre dessiné ({blancs} pixels)");
            assert!(rouges > 400, "{n} : disque dessiné ({rouges} pixels)");
            assert_eq!(&img[0..4], &[0, 0, 0, 0], "coin transparent");
        }
        assert_ne!(image_badge(1), image_badge(7));
    }
}
