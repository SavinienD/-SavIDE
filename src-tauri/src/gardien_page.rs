//! Rattrapage de la page de l'appli (« écran noir après une longue utilisation »).
//!
//! WebView2 signale la mort d'un de ses processus (rendu, GPU, navigateur) ou une page qui ne
//! répond plus par l'événement `ProcessFailed`. Sur macOS, WKWebView appelle
//! `webViewWebContentProcessDidTerminate:` quand son processus de rendu (WebContent) s'arrête
//! (plantage, ou processus tué par le système, par exemple quand la mémoire manque) ; sous Linux,
//! WebKitGTK émet `web-process-terminated`. Sans réaction de l'appli, la fenêtre reste noire,
//! grise ou vide. Ici : on journalise la raison dans `page.log` (dossier des journaux de l'appli) et on
//! recharge la page quand le rendu est mort ou figé ; au rechargement, l'interface rouvre le même
//! écran (dossier, conversation, colonnes) grâce à `page_reprise_demandee`.
//! La page envoie aussi un battement (toutes les 10 s, avec la mémoire JS) : il sert à décider
//! qu'une page « ne répond pas » est vraiment figée, et à noter la mémoire dans le journal.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime, Webview, Window};

/// Nom du journal, dans le dossier des journaux de l'appli.
pub(crate) const NOM_JOURNAL: &str = "page.log";
/// Au-delà, le journal passe en `page.log.1` (un seul ancien gardé).
const TAILLE_MAX_JOURNAL: u64 = 1024 * 1024;
/// Page « ne répond pas » : on ne recharge que si elle l'est encore après ce délai sans battement.
pub(crate) const DELAI_FIGEE: Duration = Duration::from_secs(20);
/// Deux rechargements automatiques plus rapprochés que ça : on s'arrête (boucle de plantage).
pub(crate) const ECART_MIN_RECHARGEMENTS: Duration = Duration::from_secs(15);
/// Boucle plus lente (la page meurt à chaque fois peu après son chargement) : au plus
/// `MAX_RECHARGEMENTS` rechargements automatiques sur `FENETRE_RECHARGEMENTS`.
pub(crate) const MAX_RECHARGEMENTS: usize = 3;
pub(crate) const FENETRE_RECHARGEMENTS: Duration = Duration::from_secs(600);
/// Une ligne « mémoire » au plus toutes les 10 minutes.
const ECART_LIGNES_MEMOIRE: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Panne {
    /// Le processus de rendu de la page est mort (plantage, mémoire, tué).
    RenduMort,
    /// La page ne répond plus aux saisies (script bloqué, rendu saturé).
    RenduFige,
    /// Le processus GPU est mort (WebView2 le relance seul).
    GpuMort,
    /// Le processus navigateur de WebView2 est mort : la vue entière est perdue.
    NavigateurMort,
    /// Un cadre secondaire, un utilitaire… : sans effet sur l'écran.
    Autre,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    Recharger,
    /// Noter et attendre : la page peut se reprendre seule.
    Attendre,
    /// Recharger serait inutile (vue perdue) ou dangereux (boucle de plantages).
    Rien,
}

/// Ce que le gardien sait d'une fenêtre.
#[derive(Debug, Default, Clone)]
pub(crate) struct EtatPage {
    pub(crate) dernier_battement: Option<Instant>,
    pub(crate) figee_depuis: Option<Instant>,
    pub(crate) dernier_rechargement: Option<Instant>,
    /// Rechargements automatiques récents (moins de `FENETRE_RECHARGEMENTS`).
    pub(crate) rechargements: Vec<Instant>,
    pub(crate) derniere_ligne_memoire: Option<Instant>,
    pub(crate) reprise_demandee: bool,
}

/// Décide quoi faire d'une panne, et met l'état à jour en conséquence.
pub(crate) fn decider(etat: &mut EtatPage, panne: Panne, maintenant: Instant) -> Action {
    let action = match panne {
        Panne::RenduMort => Action::Recharger,
        Panne::RenduFige => match etat.figee_depuis {
            // Encore figée longtemps après la première alerte, sans battement entre-temps.
            Some(debut) if maintenant.saturating_duration_since(debut) >= DELAI_FIGEE => Action::Recharger,
            Some(_) => Action::Attendre,
            None => {
                etat.figee_depuis = Some(maintenant);
                Action::Attendre
            }
        },
        // WebView2 relance seul le processus GPU ; un cadre ou un utilitaire n'éteint pas l'écran.
        Panne::GpuMort | Panne::Autre => Action::Attendre,
        Panne::NavigateurMort => Action::Rien,
    };
    if action != Action::Recharger {
        return action;
    }
    if let Some(avant) = etat.dernier_rechargement {
        if maintenant.saturating_duration_since(avant) < ECART_MIN_RECHARGEMENTS {
            return Action::Rien;
        }
    }
    etat.rechargements
        .retain(|t| maintenant.saturating_duration_since(*t) < FENETRE_RECHARGEMENTS);
    if etat.rechargements.len() >= MAX_RECHARGEMENTS {
        return Action::Rien;
    }
    etat.rechargements.push(maintenant);
    etat.dernier_rechargement = Some(maintenant);
    etat.figee_depuis = None;
    etat.reprise_demandee = true;
    Action::Recharger
}

/// Un battement de la page : elle répond, la « figée » en attente est oubliée.
/// Rend `true` quand il faut écrire une ligne « mémoire » dans le journal.
pub(crate) fn battement(etat: &mut EtatPage, maintenant: Instant) -> bool {
    etat.dernier_battement = Some(maintenant);
    etat.figee_depuis = None;
    let ecrire = etat
        .derniere_ligne_memoire
        .map_or(true, |avant| maintenant.saturating_duration_since(avant) >= ECART_LIGNES_MEMOIRE);
    if ecrire {
        etat.derniere_ligne_memoire = Some(maintenant);
    }
    ecrire
}

/// Date UTC lisible (« 2026-11-06 21:03:12 UTC ») sans dépendance de calendrier.
fn horodatage() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (jours, reste) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Algorithme « civil from days » (H. Hinnant).
    let z = jours + 719_468;
    let ere = z.div_euclid(146_097);
    let jde = z.rem_euclid(146_097);
    let ade = (jde - jde / 1460 + jde / 36_524 - jde / 146_096) / 365;
    let jda = jde - (365 * ade + ade / 4 - ade / 100);
    let mp = (5 * jda + 2) / 153;
    let jour = jda - (153 * mp + 2) / 5 + 1;
    let mois = if mp < 10 { mp + 3 } else { mp - 9 };
    let annee = ade + ere * 400 + i64::from(mois <= 2);
    format!(
        "{annee:04}-{mois:02}-{jour:02} {:02}:{:02}:{:02} UTC",
        reste / 3600,
        reste % 3600 / 60,
        reste % 60
    )
}

/// Ajoute une ligne horodatée au journal, en le faisant tourner au-delà de `max` octets.
pub(crate) fn ecrire_journal(chemin: &Path, ligne: &str, max: u64) -> std::io::Result<()> {
    if let Some(dossier) = chemin.parent() {
        fs::create_dir_all(dossier)?;
    }
    if fs::metadata(chemin).map(|m| m.len() >= max).unwrap_or(false) {
        let mut ancien = chemin.as_os_str().to_owned();
        ancien.push(".1");
        let _ = fs::rename(chemin, PathBuf::from(ancien));
    }
    let mut f = OpenOptions::new().create(true).append(true).open(chemin)?;
    writeln!(f, "{} {ligne}", horodatage())
}

/// Libellé d'une décision, pour le journal.
pub(crate) fn texte_action(panne: Panne, action: Action) -> &'static str {
    match (panne, action) {
        (_, Action::Recharger) => "page rechargée",
        (_, Action::Attendre) => "attente",
        (Panne::RenduMort | Panne::RenduFige, Action::Rien) => {
            "PAS de rechargement automatique (trop de rechargements récents) : relancer l'appli"
        }
        (_, Action::Rien) => "rien",
    }
}

fn etats() -> &'static Mutex<HashMap<String, EtatPage>> {
    static ETATS: OnceLock<Mutex<HashMap<String, EtatPage>>> = OnceLock::new();
    ETATS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn avec_etat<T>(fenetre: &str, f: impl FnOnce(&mut EtatPage) -> T) -> T {
    let mut verrou = etats().lock().unwrap_or_else(|e| e.into_inner());
    f(verrou.entry(fenetre.to_string()).or_default())
}

fn chemin_journal<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|d| d.join(NOM_JOURNAL))
}

/// Écrit dans `page.log` (et dans les traces). Jamais bloquant pour l'appli.
pub(crate) fn journaliser<R: Runtime>(app: &AppHandle<R>, ligne: &str) {
    tracing::warn!(target: "page", "{ligne}");
    if let Some(chemin) = chemin_journal(app) {
        let _ = ecrire_journal(&chemin, ligne, TAILLE_MAX_JOURNAL);
    }
}

/// Fenêtre fermée : son état est oublié (une nouvelle fenêtre du même nom repart de zéro).
pub(crate) fn oublier(fenetre: &str) {
    etats().lock().unwrap_or_else(|e| e.into_inner()).remove(fenetre);
}

fn branchees() -> &'static Mutex<std::collections::HashSet<String>> {
    static BRANCHEES: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    BRANCHEES.get_or_init(Default::default)
}

/// Branche le gardien sur une vue (une seule fois par vue ; appelé à chaque chargement de page).
pub(crate) fn surveiller<R: Runtime>(webview: &Webview<R>) {
    let label = webview.label().to_string();
    {
        let mut b = branchees().lock().unwrap_or_else(|e| e.into_inner());
        if !b.insert(label.clone()) {
            return;
        }
    }
    #[cfg(windows)]
    windows_webview2::brancher(webview, label);
    #[cfg(target_os = "macos")]
    macos_wkwebview::brancher(webview, label);
    #[cfg(target_os = "linux")]
    linux_webkitgtk::brancher(webview, label);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let _ = label;
}

/// Fenêtre détruite : la vue pourra être rebranchée si une autre reprend son nom.
pub(crate) fn fenetre_detruite(fenetre: &str) {
    oublier(fenetre);
    branchees().lock().unwrap_or_else(|e| e.into_inner()).remove(fenetre);
    #[cfg(target_os = "macos")]
    macos_wkwebview::oublier_vue(fenetre);
}

/// Le processus de rendu d'une vue WebKit (macOS, Linux) s'est arrêté : décide, note dans le
/// journal et rend `true` s'il faut recharger la page.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rendu_termine<R: Runtime>(app: &AppHandle<R>, label: &str, moteur: &str, raison: &str) -> bool {
    let action = avec_etat(label, |e| decider(e, Panne::RenduMort, Instant::now()));
    journaliser(
        app,
        &format!(
            "[{label}] {moteur} : processus de rendu terminé ({raison}) -> {}",
            texte_action(Panne::RenduMort, action)
        ),
    );
    action == Action::Recharger
}

#[tauri::command]
pub(crate) fn page_battement(app: AppHandle, window: Window, tas_mo: Option<f64>, noeuds: Option<u64>) {
    let ecrire = avec_etat(window.label(), |e| battement(e, Instant::now()));
    if ecrire {
        // WebKit (macOS, Linux) ne donne pas la taille du tas JS : seuls les nœuds sont comptés.
        let tas = tas_mo.map(|t| format!("{t:.0} Mo")).unwrap_or_else(|| "non mesurable".into());
        let n = noeuds.map(|n| n.to_string()).unwrap_or_else(|| "?".into());
        let ligne = format!("[{}] mémoire de la page : tas JS {tas}, nœuds DOM {n}", window.label());
        if let Some(chemin) = chemin_journal(&app) {
            let _ = ecrire_journal(&chemin, &ligne, TAILLE_MAX_JOURNAL);
        }
    }
}

#[tauri::command]
pub(crate) fn page_journal(app: AppHandle, window: Window, texte: String) {
    let texte: String = texte.chars().take(2000).collect();
    journaliser(&app, &format!("[{}] {texte}", window.label()));
}

/// Au démarrage de l'interface : vrai une seule fois après un rechargement fait par le gardien.
#[tauri::command]
pub(crate) fn page_reprise_demandee(app: AppHandle, window: Window) -> bool {
    let reprise = avec_etat(window.label(), |e| std::mem::take(&mut e.reprise_demandee));
    if reprise {
        // Preuve que la page rechargée a bien redémarré (l'interface demande la reprise au démarrage).
        journaliser(&app, &format!("[{}] page relancée : l'interface a redémarré", window.label()));
    }
    reprise
}

#[cfg(target_os = "macos")]
mod macos_wkwebview {
    //! Tauri ne transmet pas `webViewWebContentProcessDidTerminate:` : le délégué de navigation
    //! de wry implémente cette méthode mais n'appelle rien quand aucun rappel n'est donné (et Tauri
    //! n'en donne pas). On remplace donc l'implémentation de cette seule méthode sur la classe du
    //! délégué : l'ancienne est toujours appelée d'abord, puis le gardien décide et recharge.
    use super::*;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel};
    use std::sync::Arc;

    type Rappel = Arc<dyn Fn() -> bool + Send + Sync>;
    type Methode = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

    /// Implémentation d'origine, par classe de délégué (adresse de la classe).
    fn originales() -> &'static Mutex<HashMap<usize, usize>> {
        static M: OnceLock<Mutex<HashMap<usize, usize>>> = OnceLock::new();
        M.get_or_init(Default::default)
    }

    /// Vue WKWebView (adresse) -> (nom de la fenêtre, rappel du gardien).
    fn rappels() -> &'static Mutex<HashMap<usize, (String, Rappel)>> {
        static M: OnceLock<Mutex<HashMap<usize, (String, Rappel)>>> = OnceLock::new();
        M.get_or_init(Default::default)
    }

    pub(super) fn oublier_vue(fenetre: &str) {
        rappels().lock().unwrap_or_else(|e| e.into_inner()).retain(|_, (l, _)| l != fenetre);
    }

    unsafe extern "C-unwind" fn rendu_termine_wk(this: *mut AnyObject, cmd: Sel, vue: *mut AnyObject) {
        if !this.is_null() {
            let classe = unsafe { (*this).class() } as *const AnyClass as usize;
            let origine = originales().lock().unwrap_or_else(|e| e.into_inner()).get(&classe).copied();
            if let Some(imp) = origine {
                let f: Methode = unsafe { std::mem::transmute::<usize, Methode>(imp) };
                unsafe { f(this, cmd, vue) };
            }
        }
        let rappel = rappels().lock().unwrap_or_else(|e| e.into_inner()).get(&(vue as usize)).map(|(_, r)| r.clone());
        let Some(rappel) = rappel else { return };
        let recharger = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rappel())).unwrap_or(false);
        if recharger && !vue.is_null() {
            let _: *mut AnyObject = unsafe { msg_send![vue, reload] };
        }
    }

    /// Remplace (une fois par classe) la méthode de fin du rendu du délégué de navigation.
    unsafe fn accrocher(vue: *mut AnyObject) -> Result<(), &'static str> {
        let delegue: *mut AnyObject = unsafe { msg_send![vue, navigationDelegate] };
        if delegue.is_null() {
            return Err("vue sans délégué de navigation");
        }
        let classe = unsafe { (*delegue).class() };
        let cle = classe as *const AnyClass as usize;
        let mut originales = originales().lock().unwrap_or_else(|e| e.into_inner());
        if originales.contains_key(&cle) {
            return Ok(());
        }
        let Some(methode) = classe.instance_method(sel!(webViewWebContentProcessDidTerminate:)) else {
            return Err("méthode webViewWebContentProcessDidTerminate: absente du délégué");
        };
        let nouvelle: Imp = unsafe { std::mem::transmute::<Methode, Imp>(rendu_termine_wk as Methode) };
        let ancienne = unsafe { methode.set_implementation(nouvelle) };
        originales.insert(cle, ancienne as usize);
        Ok(())
    }

    pub(super) fn brancher<R: Runtime>(webview: &Webview<R>, label: String) {
        let app = webview.app_handle().clone();
        let _ = webview.with_webview(move |plateforme| {
            let vue = plateforme.inner() as *mut AnyObject;
            if vue.is_null() {
                return;
            }
            match unsafe { accrocher(vue) } {
                Ok(()) => {
                    let (app2, label2) = (app.clone(), label.clone());
                    let rappel: Rappel = Arc::new(move || {
                        rendu_termine(&app2, &label2, "WKWebView", "raison non transmise par macOS")
                    });
                    rappels()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(vue as usize, (label.clone(), rappel));
                }
                Err(e) => journaliser(&app, &format!("[{label}] gardien non branché : {e}")),
            }
        });
    }
}

#[cfg(target_os = "linux")]
mod linux_webkitgtk {
    use super::*;
    use webkit2gtk::{WebProcessTerminationReason, WebViewExt};

    fn raison(r: WebProcessTerminationReason) -> String {
        match r {
            WebProcessTerminationReason::Crashed => "plantage".into(),
            WebProcessTerminationReason::ExceededMemoryLimit => "MÉMOIRE ÉPUISÉE".into(),
            WebProcessTerminationReason::TerminatedByApi => "arrêté par l'appli".into(),
            autre => format!("{autre:?}"),
        }
    }

    pub(super) fn brancher<R: Runtime>(webview: &Webview<R>, label: String) {
        let app = webview.app_handle().clone();
        let _ = webview.with_webview(move |plateforme| {
            plateforme.inner().connect_web_process_terminated(move |vue, r| {
                if rendu_termine(&app, &label, "WebKitGTK", &raison(r)) {
                    vue.reload();
                }
            });
        });
    }
}

#[cfg(windows)]
mod windows_webview2 {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    fn panne_de(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> Panne {
        match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => Panne::RenduMort,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => Panne::RenduFige,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => Panne::GpuMort,
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => Panne::NavigateurMort,
            _ => Panne::Autre,
        }
    }

    fn raison(args: &ICoreWebView2ProcessFailedEventArgs, kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> String {
        let mut texte = format!("type {}", kind.0);
        if let Ok(a2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
            let mut r = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
            let mut code = 0i32;
            unsafe {
                let _ = a2.Reason(&mut r);
                let _ = a2.ExitCode(&mut code);
            }
            let nom = match r {
                COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "plantage",
                COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "MÉMOIRE ÉPUISÉE",
                COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "ne répond plus",
                COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "arrêté de l'extérieur",
                COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "lancement impossible",
                COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "profil supprimé",
                _ => "inattendu",
            };
            texte.push_str(&format!(", raison {nom} ({}), code de sortie {code}", r.0));
        }
        texte
    }

    pub(super) fn brancher<R: Runtime>(webview: &Webview<R>, label: String) {
        let app = webview.app_handle().clone();
        let _ = webview.with_webview(move |plateforme| unsafe {
            let Ok(core) = plateforme.controller().CoreWebView2() else { return };
            let app2 = app.clone();
            let label2 = label.clone();
            let gestion = ProcessFailedEventHandler::create(Box::new(move |vue: Option<ICoreWebView2>, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                let panne = panne_de(kind);
                let action = avec_etat(&label2, |e| decider(e, panne, Instant::now()));
                journaliser(&app2, &format!("[{label2}] WebView2 : {panne:?} ({}) -> {}", raison(&args, kind), texte_action(panne, action)));
                if action == Action::Recharger {
                    if let Some(vue) = vue {
                        vue.Reload()?;
                    }
                } else if panne == Panne::NavigateurMort {
                    // La vue entière est perdue : seule une relance de l'appli rend une fenêtre.
                    journaliser(&app2, &format!("[{label2}] relance de l'appli (navigateur WebView2 perdu)"));
                    app2.request_restart();
                }
                Ok(())
            }));
            let mut jeton = 0i64;
            if let Err(err) = core.add_ProcessFailed(&gestion, &mut jeton) {
                journaliser(&app, &format!("[{label}] gardien non branché : {err}"));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn rendu_mort_recharge_et_demande_la_reprise() {
        let mut e = EtatPage::default();
        assert_eq!(decider(&mut e, Panne::RenduMort, t0()), Action::Recharger);
        assert!(e.reprise_demandee);
    }

    #[test]
    fn pas_de_boucle_de_rechargements() {
        let mut e = EtatPage::default();
        let t = t0();
        assert_eq!(decider(&mut e, Panne::RenduMort, t), Action::Recharger);
        assert_eq!(decider(&mut e, Panne::RenduMort, t + Duration::from_secs(3)), Action::Rien);
        assert_eq!(decider(&mut e, Panne::RenduMort, t + Duration::from_secs(40)), Action::Recharger);
    }

    #[test]
    fn boucle_lente_limitee_puis_reprise() {
        let mut e = EtatPage::default();
        let t = t0();
        for i in 0..MAX_RECHARGEMENTS as u64 {
            assert_eq!(decider(&mut e, Panne::RenduMort, t + Duration::from_secs(60 * i)), Action::Recharger);
        }
        // Encore une mort peu après : la limite est atteinte, plus de rechargement automatique.
        assert_eq!(decider(&mut e, Panne::RenduMort, t + Duration::from_secs(240)), Action::Rien);
        // Les anciens rechargements sortent de la fenêtre : on recharge de nouveau.
        assert_eq!(decider(&mut e, Panne::RenduMort, t + Duration::from_secs(661)), Action::Recharger);
    }

    #[test]
    fn libelles_du_journal() {
        assert_eq!(texte_action(Panne::RenduMort, Action::Recharger), "page rechargée");
        assert!(texte_action(Panne::RenduMort, Action::Rien).contains("PAS de rechargement"));
    }

    #[test]
    fn page_figee_rechargee_seulement_si_elle_le_reste() {
        let mut e = EtatPage::default();
        let t = t0();
        assert_eq!(decider(&mut e, Panne::RenduFige, t), Action::Attendre);
        assert_eq!(decider(&mut e, Panne::RenduFige, t + Duration::from_secs(5)), Action::Attendre);
        assert_eq!(decider(&mut e, Panne::RenduFige, t + Duration::from_secs(25)), Action::Recharger);
        assert!(e.figee_depuis.is_none());
    }

    #[test]
    fn un_battement_annule_la_page_figee() {
        let mut e = EtatPage::default();
        let t = t0();
        assert_eq!(decider(&mut e, Panne::RenduFige, t), Action::Attendre);
        battement(&mut e, t + Duration::from_secs(10));
        // La page a répondu entre-temps : nouvelle attente, pas de rechargement.
        assert_eq!(decider(&mut e, Panne::RenduFige, t + Duration::from_secs(25)), Action::Attendre);
    }

    #[test]
    fn gpu_et_autres_seulement_notes() {
        let mut e = EtatPage::default();
        assert_eq!(decider(&mut e, Panne::GpuMort, t0()), Action::Attendre);
        assert_eq!(decider(&mut e, Panne::Autre, t0()), Action::Attendre);
        assert_eq!(decider(&mut e, Panne::NavigateurMort, t0()), Action::Rien);
        assert!(!e.reprise_demandee);
    }

    #[test]
    fn memoire_notee_au_plus_toutes_les_dix_minutes() {
        let mut e = EtatPage::default();
        let t = t0();
        assert!(battement(&mut e, t));
        assert!(!battement(&mut e, t + Duration::from_secs(60)));
        assert!(battement(&mut e, t + Duration::from_secs(601)));
    }

    #[test]
    fn journal_horodate_et_tournant() {
        let dossier = std::env::temp_dir().join(format!("savide-page-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dossier);
        let chemin = dossier.join(NOM_JOURNAL);
        ecrire_journal(&chemin, "première", 200).unwrap();
        let texte = fs::read_to_string(&chemin).unwrap();
        assert!(texte.ends_with("première\n"), "{texte}");
        assert!(texte.starts_with("20"), "horodatage attendu : {texte}");
        for i in 0..10 {
            ecrire_journal(&chemin, &format!("ligne {i} assez longue pour remplir le journal"), 200).unwrap();
        }
        assert!(fs::metadata(&chemin).unwrap().len() <= 200 + 100);
        assert!(dossier.join(format!("{NOM_JOURNAL}.1")).exists());
        let _ = fs::remove_dir_all(&dossier);
    }
}
