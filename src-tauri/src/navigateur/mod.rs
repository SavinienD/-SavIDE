//! Navigateur intégré (lot 186) : onglet « Navigateur » de l'IDE (barre d'adresse,
//! précédent / suivant / recharger, zoom, outils de développement, tailles d'écran,
//! téléchargements), Design Mode (choisir un élément de la page pour la conversation),
//! liste des ports ouverts par le dossier, et pilotage de la page par l'agent
//! (module `navigateur` du REPL, par le pont local de `pont.rs`).
//!
//! Sécurité : la page est une vue wry à part (`vue.rs`), sans IPC Tauri. Seuls
//! `http`, `https` (et `about:`, `blob:`, `data:` pour les cadres) y sont chargés.
//! L'appli lit la page en y évaluant des scripts (`page.rs`) : la page ne peut rien
//! appeler en retour, et ce qu'elle renvoie est borné avant d'être montré.

mod adresse;
mod capture;
mod etat;
mod page;
mod ports;
mod pont;
mod telechargements;
mod vue;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, Window};

pub(crate) use etat::EtatPage;
pub(crate) use pont::{demarrer_pont, HookNavigateur};
pub(crate) use ports::PortOuvert;

/// Rectangle de l'onglet dans la fenêtre, en pixels logiques (CSS × zoom de l'interface).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub(crate) struct Zone {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) largeur: f64,
    pub(crate) hauteur: f64,
}

impl Zone {
    /// Zone utilisable (nombres finis, taille d'au moins 8 px), sinon `None` (vue cachée).
    pub(crate) fn valide(self) -> Option<Zone> {
        let finis = [self.x, self.y, self.largeur, self.hauteur].iter().all(|n| n.is_finite() && n.abs() < 100_000.0);
        (finis && self.largeur >= 8.0 && self.hauteur >= 8.0).then_some(self)
    }
}

fn texte(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Exécute `f` sur le fil principal (seul fil où une vue wry se manipule) et rend son résultat.
pub(crate) async fn sur_le_fil_principal<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(texte)?;
    rx.await.map_err(|_| "fil principal de l'appli indisponible".to_string())
}

/// Attend que la page ait fini un premier chargement (avant, la vue ignore les scripts).
pub(crate) async fn attendre_pret(fenetre: &str, delai: Duration) -> Result<(), String> {
    let debut = Instant::now();
    loop {
        let e = etat::lire(fenetre);
        if !e.ouvert {
            return Err("le navigateur intégré n'est pas ouvert".into());
        }
        if e.pret {
            return Ok(());
        }
        if debut.elapsed() >= delai {
            return Err("la page n'a pas fini de se charger (délai dépassé)".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Attend la fin du chargement en cours (après une navigation), au plus `delai`.
pub(crate) async fn attendre_chargement(fenetre: &str, delai: Duration) {
    let debut = Instant::now();
    tokio::time::sleep(Duration::from_millis(150)).await;
    while debut.elapsed() < delai {
        let e = etat::lire(fenetre);
        if !e.ouvert || (e.pret && !e.chargement) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Évalue `script` dans la page de `fenetre` et rend la valeur brute (JSON).
pub(crate) async fn evaluer(app: &AppHandle, fenetre: &str, script: String, delai: Duration) -> Result<String, String> {
    attendre_pret(fenetre, delai).await?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let envoi = Arc::new(Mutex::new(Some(tx)));
    let label = fenetre.to_string();
    sur_le_fil_principal(app, move || -> Result<(), String> {
        vue::avec(&label, |v| {
            v.webview
                .evaluate_script_with_callback(&script, move |reponse| {
                    if let Some(tx) = envoi.lock().ok().and_then(|mut g| g.take()) {
                        let _ = tx.send(reponse);
                    }
                })
                .map_err(texte)
        })
        .unwrap_or_else(|| Err("le navigateur intégré n'est pas ouvert".into()))
    })
    .await??;
    tokio::time::timeout(delai, rx)
        .await
        .map_err(|_| "la page ne répond pas (délai dépassé)".to_string())?
        .map_err(|_| "la page a changé pendant la lecture : réessayez".to_string())
}

/// Crée la vue si besoin (cachée tant que l'onglet ne l'a pas placée).
pub(crate) async fn assurer_vue(app: &AppHandle, fenetre: &str, url: &str) -> Result<(), String> {
    let window = app.get_webview_window(fenetre).ok_or_else(|| "fenêtre de l'appli introuvable".to_string())?;
    let (app2, url) = (app.clone(), url.to_string());
    sur_le_fil_principal(app, move || vue::creer(&app2, &window, &url, None)).await?
}

/// Charge `url` (déjà normalisée) dans la vue de `fenetre`, en la créant si besoin.
pub(crate) async fn aller(app: &AppHandle, fenetre: &str, url: &str) -> Result<(), String> {
    let window = app.get_webview_window(fenetre).ok_or_else(|| "fenêtre de l'appli introuvable".to_string())?;
    let (app2, label, cible) = (app.clone(), fenetre.to_string(), url.to_string());
    sur_le_fil_principal(app, move || {
        if vue::existe(&label) {
            vue::avec(&label, |v| v.webview.load_url(&cible).map_err(texte)).unwrap_or(Ok(()))
        } else {
            vue::creer(&app2, &window, &cible, None)
        }
    })
    .await??;
    etat::changer(app, fenetre, |e| {
        e.url = url.to_string();
        e.chargement = true;
        e.refus = None;
    });
    Ok(())
}

/// Demande à l'interface d'ouvrir l'onglet Navigateur (l'agent l'a ouvert).
pub(crate) fn demander_onglet(app: &AppHandle, fenetre: &str) {
    let _ = app.emit(etat::EVENEMENT_DEMANDE, serde_json::json!({"fenetre": fenetre}));
}

/// Fenêtre fermée : sa vue et son état disparaissent (fil principal).
pub(crate) fn fenetre_detruite(fenetre: &str) {
    vue::detruire(fenetre);
    etat::oublier_fenetre(fenetre);
}

// ----- commandes de l'interface ------------------------------------------------

/// L'interface du dossier `espace` est montée dans cette fenêtre (l'agent de ce dossier
/// pilotera ce navigateur-là).
#[tauri::command]
pub(crate) fn navigateur_enregistrer(window: Window, espace: String) -> EtatPage {
    etat::noter_espace(window.label(), &espace);
    etat::lire(window.label())
}

/// Pose la vue sur la zone de l'onglet (la crée au premier affichage), ou la cache.
#[tauri::command]
pub(crate) async fn navigateur_placer(app: AppHandle, window: Window, espace: String, zone: Option<Zone>) -> Result<EtatPage, String> {
    let label = window.label().to_string();
    etat::noter_espace(&label, &espace);
    let zone = zone.and_then(Zone::valide);
    let window = app.get_webview_window(&label).ok_or_else(|| "fenêtre de l'appli introuvable".to_string())?;
    let precedente = etat::lire(&label).url;
    let url = if precedente.is_empty() { "about:blank".to_string() } else { precedente };
    let (app2, label2) = (app.clone(), label.clone());
    sur_le_fil_principal(&app, move || {
        if vue::existe(&label2) {
            vue::placer(&label2, zone)
        } else if zone.is_some() {
            vue::creer(&app2, &window, &url, zone)
        } else {
            Ok(())
        }
    })
    .await??;
    Ok(etat::lire(&label))
}

/// Ouvre ce qui est tapé dans la barre d'adresse ; rend l'URL chargée.
#[tauri::command]
pub(crate) async fn navigateur_aller(app: AppHandle, window: Window, adresse: String) -> Result<String, String> {
    let url = adresse::normaliser(&adresse)?;
    aller(&app, window.label(), &url).await?;
    Ok(url)
}

/// Boutons de la barre : précédent, suivant, recharger, arrêter, outils de développement.
#[tauri::command]
pub(crate) async fn navigateur_action(app: AppHandle, window: Window, action: String) -> Result<(), String> {
    let label = window.label().to_string();
    sur_le_fil_principal(&app, move || {
        vue::avec(&label, |v| match action.as_str() {
            "precedent" => v.webview.evaluate_script("history.back()").map_err(texte),
            "suivant" => v.webview.evaluate_script("history.forward()").map_err(texte),
            "arreter" => v.webview.evaluate_script("window.stop()").map_err(texte),
            "recharger" => v.webview.reload().map_err(texte),
            "devtools" => {
                if v.webview.is_devtools_open() {
                    v.webview.close_devtools();
                } else {
                    v.webview.open_devtools();
                }
                Ok(())
            }
            autre => Err(format!("action inconnue : {autre}")),
        })
        .unwrap_or_else(|| Err("le navigateur intégré n'est pas ouvert".into()))
    })
    .await?
}

/// Zoom de la page (1 = 100 %), entre 25 % et 300 %.
#[tauri::command]
pub(crate) async fn navigateur_zoom(app: AppHandle, window: Window, facteur: f64) -> Result<f64, String> {
    let facteur = if facteur.is_finite() { facteur.clamp(0.25, 3.0) } else { 1.0 };
    let label = window.label().to_string();
    sur_le_fil_principal(&app, move || {
        vue::avec(&label, |v| v.webview.zoom(facteur).map_err(texte)).unwrap_or(Ok(()))
    })
    .await??;
    Ok(facteur)
}

/// Onglet fermé : la vue est détruite (l'adresse est gardée pour une réouverture).
#[tauri::command]
pub(crate) async fn navigateur_fermer(app: AppHandle, window: Window) -> Result<EtatPage, String> {
    let label = window.label().to_string();
    let label2 = label.clone();
    sur_le_fil_principal(&app, move || vue::detruire(&label2)).await?;
    Ok(etat::vue_fermee(&app, &label))
}

#[tauri::command]
pub(crate) fn navigateur_etat(window: Window) -> EtatPage {
    etat::lire(window.label())
}

/// Design Mode : `actif` installe le survol dans la page et relève le choix toutes les
/// 250 ms (événement `navigateur://choix`) ; sinon le retire.
#[tauri::command]
pub(crate) async fn navigateur_design(app: AppHandle, window: Window, actif: bool) -> Result<EtatPage, String> {
    let label = window.label().to_string();
    if !actif {
        let _ = evaluer(&app, &label, page::ARRET_DESIGN.into(), Duration::from_secs(3)).await;
        return Ok(etat::changer(&app, &label, |e| e.design = false));
    }
    page::decoder(&evaluer(&app, &label, page::activation_design(), Duration::from_secs(10)).await?)?;
    let etat = etat::changer(&app, &label, |e| e.design = true);
    tauri::async_runtime::spawn(async move {
        let mut echecs = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let courant = etat::lire(&label);
            if !courant.design || !courant.ouvert {
                break;
            }
            let releve = evaluer(&app, &label, page::RELEVE_DESIGN.into(), Duration::from_secs(3))
                .await
                .and_then(|brut| page::lire_releve(&brut));
            match releve {
                Ok(releve) => {
                    echecs = 0;
                    if let Some(choix) = releve.choix {
                        let _ = app.emit(etat::EVENEMENT_CHOIX, serde_json::json!({"fenetre": label, "element": choix}));
                    }
                    if !releve.actif {
                        etat::changer(&app, &label, |e| e.design = false);
                        break;
                    }
                }
                Err(_) => {
                    echecs += 1;
                    if echecs >= 12 {
                        etat::changer(&app, &label, |e| e.design = false);
                        break;
                    }
                }
            }
        }
    });
    Ok(etat)
}

/// Ports ouverts par les serveurs du dossier (lancés dessous ou depuis ses terminaux).
#[tauri::command]
pub(crate) async fn navigateur_ports(espace: String) -> Result<Vec<PortOuvert>, String> {
    tauri::async_runtime::spawn_blocking(move || ports::lister(&espace)).await.map_err(texte)
}
