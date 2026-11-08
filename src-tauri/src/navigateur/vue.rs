//! Vue web native du navigateur intégré : une par fenêtre de l'appli, créée avec wry
//! directement (pas une vue Tauri). La page n'a donc ni `__TAURI__`, ni protocole
//! `ipc://`, ni aucune commande de l'appli : rien à appeler, quoi qu'elle charge.
//!
//! - Windows et macOS : vue enfant de la fenêtre (`build_as_child`), posée au-dessus
//!   de la page de l'appli, à l'endroit de l'onglet (coordonnées logiques).
//! - Linux : la boîte GTK de la fenêtre passe dans un `gtk::Overlay` ; la vue est
//!   mise dans un `gtk::Fixed` posé au-dessus (X11 et Wayland).
//!
//! Une vue wry ne se touche que sur le fil principal (`mod.rs::sur_le_fil_principal`).
//! Les rappels de la vue (chargement, titre, téléchargements) ne touchent jamais au
//! registre des vues : ils ne mettent à jour que l'état partagé (`etat.rs`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, WebviewWindow};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};

use super::{adresse, etat, telechargements, Zone};

pub(crate) struct Vue {
    pub(crate) webview: WebView,
    #[cfg(target_os = "linux")]
    fixe: gtk::Fixed,
}

thread_local! {
    static VUES: RefCell<HashMap<String, Vue>> = RefCell::new(HashMap::new());
    /// Données des pages (cookies, stockage) : à part de celles de l'appli, et UN contexte
    /// pour tout le processus (WebKitGTK n'accepte qu'un gestionnaire par dossier).
    static CONTEXTE: RefCell<Option<WebContext>> = const { RefCell::new(None) };
}

/// Fil principal seulement.
pub(crate) fn avec<T>(fenetre: &str, f: impl FnOnce(&Vue) -> T) -> Option<T> {
    VUES.with(|v| v.borrow().get(fenetre).map(f))
}

pub(crate) fn existe(fenetre: &str) -> bool {
    VUES.with(|v| v.borrow().contains_key(fenetre))
}

/// Retire la vue du registre ; elle est détruite hors de l'emprunt (fil principal).
pub(crate) fn detruire(fenetre: &str) -> bool {
    let vue = VUES.with(|v| v.borrow_mut().remove(fenetre));
    let existait = vue.is_some();
    if let Some(vue) = vue {
        let _ = vue.webview.set_visible(false);
        drop(vue);
    }
    existait
}

fn texte(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn rect(zone: Zone) -> Rect {
    Rect {
        position: LogicalPosition::new(zone.x, zone.y).into(),
        size: LogicalSize::new(zone.largeur.max(1.0), zone.hauteur.max(1.0)).into(),
    }
}

/// Dossier des données de la vue (cookies, cache) : `<données de l'appli>/navigateur`.
fn dossier_donnees() -> Option<PathBuf> {
    axecode_daemon::util::default_data_dir().ok().map(|d| d.join("navigateur"))
}

/// Linux : met la boîte de la fenêtre dans un `gtk::Overlay` (une seule fois) et rend le
/// `gtk::Fixed` posé au-dessus, transparent aux clics hors de la vue.
#[cfg(target_os = "linux")]
fn conteneur_linux(fenetre: &WebviewWindow) -> Result<gtk::Fixed, String> {
    use gtk::prelude::*;
    const NOM: &str = "axecode-navigateur";
    let principale = fenetre.gtk_window().map_err(texte)?;
    if let Some(overlay) = principale.child().and_then(|c| c.downcast::<gtk::Overlay>().ok()) {
        if let Some(fixe) = overlay
            .children()
            .into_iter()
            .find(|c| c.widget_name() == NOM)
            .and_then(|c| c.downcast::<gtk::Fixed>().ok())
        {
            return Ok(fixe);
        }
    }
    let boite = fenetre.default_vbox().map_err(texte)?;
    let overlay = gtk::Overlay::new();
    principale.remove(&boite);
    overlay.add(&boite);
    let fixe = gtk::Fixed::new();
    fixe.set_widget_name(NOM);
    overlay.add_overlay(&fixe);
    overlay.set_overlay_pass_through(&fixe, true);
    principale.add(&overlay);
    overlay.show_all();
    Ok(fixe)
}

/// Linux : décalage de la page de l'appli dans la fenêtre (barre de menus GTK au-dessus).
#[cfg(target_os = "linux")]
fn decalage_linux(fixe: &gtk::Fixed) -> (i32, i32) {
    use gtk::prelude::*;
    let Some(overlay) = fixe.parent() else { return (0, 0) };
    let Some(boite) = overlay
        .downcast_ref::<gtk::Overlay>()
        .and_then(|o| o.children().into_iter().find(|c| c.is::<gtk::Box>()))
        .and_then(|c| c.downcast::<gtk::Box>().ok())
    else {
        return (0, 0);
    };
    let page = boite.children().into_iter().find(|c| c.type_().name().contains("WebView"));
    page.and_then(|p| p.translate_coordinates(fixe, 0, 0)).unwrap_or((0, 0))
}

/// Pose la vue sur `zone` (coordonnées logiques de la fenêtre) ou la cache (`None`).
pub(crate) fn placer(fenetre: &str, zone: Option<Zone>) -> Result<(), String> {
    avec(fenetre, |vue| {
        let Some(zone) = zone else {
            return vue.webview.set_visible(false).map_err(texte);
        };
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::*;
            use wry::WebViewExtUnix;
            let page = vue.webview.webview();
            let (dx, dy) = decalage_linux(&vue.fixe);
            vue.fixe.move_(&page, zone.x.round() as i32 + dx, zone.y.round() as i32 + dy);
            page.set_size_request(zone.largeur.round().max(1.0) as i32, zone.hauteur.round().max(1.0) as i32);
        }
        #[cfg(not(target_os = "linux"))]
        vue.webview.set_bounds(rect(zone)).map_err(texte)?;
        vue.webview.set_visible(true).map_err(texte)
    })
    .unwrap_or_else(|| Err("le navigateur intégré n'est pas ouvert dans cette fenêtre".into()))
}

/// Crée la vue de `fenetre` (fil principal), cachée si `zone` est absente.
pub(crate) fn creer(app: &AppHandle, fenetre: &WebviewWindow, url: &str, zone: Option<Zone>) -> Result<(), String> {
    let label = fenetre.label().to_string();
    if existe(&label) {
        return Ok(());
    }
    CONTEXTE.with_borrow_mut(|c| {
        if c.is_none() {
            *c = Some(WebContext::new(dossier_donnees()));
        }
    });
    CONTEXTE.with_borrow_mut(|contexte| {
        let contexte = contexte.as_mut().ok_or_else(|| "contexte de la vue indisponible".to_string())?;
        construire(app, fenetre, &label, contexte, url, zone)
    })?;
    if zone.is_some() {
        placer(&label, zone)?;
    }
    Ok(())
}

fn construire(app: &AppHandle, fenetre: &WebviewWindow, label: &str, contexte: &mut WebContext, url: &str, zone: Option<Zone>) -> Result<(), String> {
    let label = label.to_string();
    let builder = {
        let (a1, l1) = (app.clone(), label.clone());
        let (a2, l2) = (app.clone(), label.clone());
        let (a3, l3) = (app.clone(), label.clone());
        let (a4, l4) = (app.clone(), label.clone());
        let (a5, l5) = (app.clone(), label.clone());
        let (a6, l6) = (app.clone(), label.clone());
        WebViewBuilder::new_with_web_context(contexte)
            .with_url(url)
            .with_visible(zone.is_some())
            .with_bounds(rect(zone.unwrap_or(Zone { x: 0.0, y: 0.0, largeur: 1.0, hauteur: 1.0 })))
            .with_devtools(true)
            .with_clipboard(true)
            .with_hotkeys_zoom(false)
            .with_focused(false)
            .with_background_color((255, 255, 255, 255))
            .with_navigation_handler(move |cible: String| {
                let permis = adresse::navigation_autorisee(&cible);
                if !permis {
                    etat::refus(&a1, &l1, &cible);
                }
                permis
            })
            .with_new_window_req_handler(move |cible: String, _| {
                // Fenêtre surgissante ou lien « nouvel onglet » : dans la même vue.
                if adresse::navigation_autorisee(&cible) {
                    let fenetre = l2.clone();
                    let _ = a2.run_on_main_thread(move || {
                        avec(&fenetre, |vue| vue.webview.load_url(&cible));
                    });
                } else {
                    etat::refus(&a2, &l2, &cible);
                }
                NewWindowResponse::Deny
            })
            .with_on_page_load_handler(move |evenement, cible| {
                etat::page_chargee(&a3, &l3, matches!(evenement, PageLoadEvent::Finished), cible);
            })
            .with_document_title_changed_handler(move |titre| etat::titre(&a4, &l4, titre))
            .with_download_started_handler(move |source: String, chemin: &mut PathBuf| {
                let dossier = telechargements::dossier_telechargements();
                if std::fs::create_dir_all(&dossier).is_err() {
                    return false;
                }
                let nom = telechargements::nom_de_fichier(chemin, &source);
                *chemin = telechargements::chemin_libre(&dossier, &nom);
                etat::telechargement_commence(&a5, &l5, &source, chemin);
                true
            })
            .with_download_completed_handler(move |source, chemin, ok| {
                etat::telechargement_fini(&a6, &l6, &source, chemin, ok);
            })
    };
    #[cfg(target_os = "linux")]
    let (webview, fixe) = {
        use wry::WebViewBuilderExtUnix;
        let fixe = conteneur_linux(fenetre)?;
        (builder.build_gtk(&fixe).map_err(texte)?, fixe)
    };
    #[cfg(not(target_os = "linux"))]
    let webview = builder.build_as_child(fenetre).map_err(texte)?;
    etat::vue_creee(app, &label, url);
    VUES.with(|v| {
        v.borrow_mut().insert(
            label.clone(),
            Vue {
                webview,
                #[cfg(target_os = "linux")]
                fixe,
            },
        )
    });
    Ok(())
}
