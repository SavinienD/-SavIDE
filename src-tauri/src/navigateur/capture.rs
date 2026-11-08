//! Capture de la page (PNG) et touches réelles pour l'agent, selon le système.
//! - Windows : WebView2, protocole des outils de développement
//!   (`CallDevToolsProtocolMethod` : `Page.captureScreenshot`, `Input.dispatchKeyEvent`).
//! - Linux : WebKitGTK (`webkit_web_view_get_snapshot`, partie visible).
//! - macOS : pas de capture pour l'instant (message clair) ; les touches passent par
//!   la bibliothèque de la page, comme sous Linux.

use tauri::AppHandle;

/// Message rendu quand la capture n'existe pas sur ce système.
#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) const CAPTURE_INDISPONIBLE: &str =
    "capture de la page indisponible sous ce système pour l'instant : utilisez lire() pour connaître la page";

/// Touche connue du protocole des outils de développement : (key, code, code virtuel, texte).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn touche_cdp(nom: &str) -> Option<(&'static str, &'static str, u32, &'static str)> {
    let nom = nom.trim().to_lowercase();
    Some(match nom.as_str() {
        "entrée" | "entree" | "enter" => ("Enter", "Enter", 13, "\r"),
        "tab" | "tabulation" => ("Tab", "Tab", 9, ""),
        "échap" | "echap" | "escape" | "esc" => ("Escape", "Escape", 27, ""),
        "espace" | "space" => (" ", "Space", 32, " "),
        "retour arrière" | "backspace" => ("Backspace", "Backspace", 8, ""),
        "suppr" | "delete" => ("Delete", "Delete", 46, ""),
        "flèche bas" | "bas" | "arrowdown" => ("ArrowDown", "ArrowDown", 40, ""),
        "flèche haut" | "haut" | "arrowup" => ("ArrowUp", "ArrowUp", 38, ""),
        "flèche gauche" | "gauche" | "arrowleft" => ("ArrowLeft", "ArrowLeft", 37, ""),
        "flèche droite" | "droite" | "arrowright" => ("ArrowRight", "ArrowRight", 39, ""),
        "début" | "debut" | "home" => ("Home", "Home", 36, ""),
        "fin" | "end" => ("End", "End", 35, ""),
        "page suivante" | "pagedown" => ("PageDown", "PageDown", 34, ""),
        "page précédente" | "pageup" => ("PageUp", "PageUp", 33, ""),
        _ => return None,
    })
}

/// Paramètres JSON des deux évènements (appui, relâche) d'une touche.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn evenements_touche(nom: &str) -> Option<[String; 2]> {
    let (key, code, vk, texte) = touche_cdp(nom)?;
    let base = serde_json::json!({"key": key, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk});
    let mut appui = base.clone();
    appui["type"] = serde_json::json!(if texte.is_empty() { "rawKeyDown" } else { "keyDown" });
    if !texte.is_empty() {
        appui["text"] = serde_json::json!(texte);
        appui["unmodifiedText"] = serde_json::json!(texte);
    }
    let mut relache = base;
    relache["type"] = serde_json::json!("keyUp");
    Some([appui.to_string(), relache.to_string()])
}

/// Décode la réponse de `Page.captureScreenshot` (`{"data": "<base64>"}`).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn png_de_cdp(json: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let valeur: serde_json::Value = serde_json::from_str(json).map_err(|_| "capture illisible".to_string())?;
    let data = valeur.get("data").and_then(|d| d.as_str()).ok_or_else(|| "capture vide".to_string())?;
    base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "capture illisible".to_string())
}

#[cfg(windows)]
pub(crate) async fn cdp(app: &AppHandle, fenetre: &str, methode: &str, parametres: String) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;
    use wry::WebViewExtWindows;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let envoi = Arc::new(Mutex::new(Some(tx)));
    let (label, methode) = (fenetre.to_string(), methode.to_string());
    super::sur_le_fil_principal(app, move || -> Result<(), String> {
        super::vue::avec(&label, |vue| {
            let coeur = vue.webview.webview();
            let envoi = envoi.clone();
            let gestion = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |resultat, json| {
                let reponse = resultat.map(|_| json).map_err(|e| e.message().to_string());
                if let Some(tx) = envoi.lock().ok().and_then(|mut g| g.take()) {
                    let _ = tx.send(reponse);
                }
                Ok(())
            }));
            unsafe { coeur.CallDevToolsProtocolMethod(&HSTRING::from(methode.as_str()), &HSTRING::from(parametres.as_str()), &gestion) }
                .map_err(|e| e.message().to_string())
        })
        .unwrap_or_else(|| Err("le navigateur intégré n'est pas ouvert".into()))
    })
    .await??;
    tokio::time::timeout(std::time::Duration::from_secs(20), rx)
        .await
        .map_err(|_| "la page ne répond pas (délai dépassé)".to_string())?
        .map_err(|_| "le navigateur intégré a été fermé".to_string())?
}

/// Image PNG de la partie visible de la page.
#[cfg(windows)]
pub(crate) async fn png(app: &AppHandle, fenetre: &str) -> Result<Vec<u8>, String> {
    let json = cdp(app, fenetre, "Page.captureScreenshot", r#"{"format":"png"}"#.into()).await?;
    png_de_cdp(&json)
}

#[cfg(target_os = "linux")]
pub(crate) async fn png(app: &AppHandle, fenetre: &str) -> Result<Vec<u8>, String> {
    use std::sync::{Arc, Mutex};
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let envoi = Arc::new(Mutex::new(Some(tx)));
    let label = fenetre.to_string();
    super::sur_le_fil_principal(app, move || -> Result<(), String> {
        use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
        use wry::WebViewExtUnix;
        super::vue::avec(&label, |vue| {
            let envoi = envoi.clone();
            vue.webview.webview().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&gtk::gio::Cancellable>,
                move |resultat| {
                    let reponse = resultat.map_err(|e| e.to_string()).and_then(|surface| png_de_surface(&surface));
                    if let Some(tx) = envoi.lock().ok().and_then(|mut g| g.take()) {
                        let _ = tx.send(reponse);
                    }
                },
            );
        })
        .ok_or_else(|| "le navigateur intégré n'est pas ouvert".to_string())
    })
    .await??;
    tokio::time::timeout(std::time::Duration::from_secs(20), rx)
        .await
        .map_err(|_| "la page ne répond pas (délai dépassé)".to_string())?
        .map_err(|_| "le navigateur intégré a été fermé".to_string())?
}

#[cfg(target_os = "linux")]
fn png_de_surface(surface: &gtk::cairo::Surface) -> Result<Vec<u8>, String> {
    let image = gtk::cairo::ImageSurface::try_from(surface.clone()).map_err(|_| "capture illisible".to_string())?;
    let (largeur, hauteur) = (image.width(), image.height());
    if largeur <= 0 || hauteur <= 0 {
        return Err("capture vide (la vue est cachée ?)".into());
    }
    let pixbuf = gtk::gdk::pixbuf_get_from_surface(surface, 0, 0, largeur, hauteur)
        .ok_or_else(|| "capture illisible".to_string())?;
    pixbuf.save_to_bufferv("png", &[]).map_err(|e| e.to_string())
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) async fn png(_app: &AppHandle, _fenetre: &str) -> Result<Vec<u8>, String> {
    Err(CAPTURE_INDISPONIBLE.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touches_du_protocole() {
        let [appui, relache] = evenements_touche("Entrée").unwrap();
        assert!(appui.contains(r#""type":"keyDown""#) && appui.contains(r#""text":"\r""#), "{appui}");
        assert!(relache.contains(r#""type":"keyUp""#));
        let [tab, _] = evenements_touche("tab").unwrap();
        assert!(tab.contains("rawKeyDown") && !tab.contains("\"text\""));
        assert!(evenements_touche("a").is_none(), "caractères : bibliothèque de la page");
    }

    #[test]
    fn capture_cdp_decodee() {
        assert_eq!(png_de_cdp(r#"{"data":"iVBORw=="}"#).unwrap(), vec![0x89, b'P', b'N', b'G']);
        assert!(png_de_cdp("{}").is_err());
        assert!(png_de_cdp("x").is_err());
    }
}
