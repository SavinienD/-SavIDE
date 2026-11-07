//! Rattrapage de la page de l'appli (« écran noir après une longue utilisation »).
//!
//! WebView2 signale la mort d'un de ses processus (rendu, GPU, navigateur) ou une page qui ne
//! répond plus par l'événement `ProcessFailed`. Sans réaction de l'appli, la fenêtre reste noire
//! ou vide. Ici : on journalise la raison dans `page.log` (dossier des journaux de l'appli) et on
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

/// Branche le gardien sur une vue (une seule fois par vue ; appelé à chaque chargement de page).
pub(crate) fn surveiller<R: Runtime>(webview: &Webview<R>) {
    static BRANCHEES: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let label = webview.label().to_string();
    {
        let mut b = BRANCHEES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        if !b.insert(label.clone()) {
            return;
        }
    }
    #[cfg(windows)]
    windows_webview2::brancher(webview, label);
    #[cfg(not(windows))]
    let _ = label;
}

/// Fenêtre détruite : la vue pourra être rebranchée si une autre reprend son nom.
pub(crate) fn fenetre_detruite(fenetre: &str) {
    oublier(fenetre);
}

#[tauri::command]
pub(crate) fn page_battement(app: AppHandle, window: Window, tas_mo: Option<f64>, noeuds: Option<u64>) {
    let ecrire = avec_etat(window.label(), |e| battement(e, Instant::now()));
    if ecrire {
        let tas = tas_mo.map(|t| format!("{t:.0} Mo")).unwrap_or_else(|| "?".into());
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
pub(crate) fn page_reprise_demandee(window: Window) -> bool {
    avec_etat(window.label(), |e| std::mem::take(&mut e.reprise_demandee))
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
                journaliser(&app2, &format!("[{label2}] WebView2 : {panne:?} ({}) -> {action:?}", raison(&args, kind)));
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
