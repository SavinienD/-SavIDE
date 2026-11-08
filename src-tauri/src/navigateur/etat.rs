//! État partagé des navigateurs (une vue par fenêtre de l'appli) et événements vers
//! l'interface. Lisible depuis n'importe quel fil ; la vue elle-même vit dans `vue.rs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub(crate) const EVENEMENT_ETAT: &str = "navigateur://etat";
pub(crate) const EVENEMENT_CHOIX: &str = "navigateur://choix";
pub(crate) const EVENEMENT_DEMANDE: &str = "navigateur://demande";
pub(crate) const EVENEMENT_TELECHARGEMENT: &str = "navigateur://telechargement";

/// Ce que l'interface affiche d'un navigateur (barre d'adresse, chargement, Design Mode).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EtatPage {
    pub(crate) fenetre: String,
    pub(crate) ouvert: bool,
    pub(crate) url: String,
    pub(crate) titre: String,
    pub(crate) chargement: bool,
    /// Vrai après le premier chargement fini : la page accepte alors les scripts.
    pub(crate) pret: bool,
    pub(crate) design: bool,
    /// Dernière navigation refusée (schéma interdit), pour un message court.
    pub(crate) refus: Option<String>,
}

#[derive(Default)]
struct Registre {
    pages: HashMap<String, EtatPage>,
    /// Fenêtre de l'appli → dossier ouvert dedans (pour l'agent de ce dossier).
    espaces: HashMap<String, String>,
    /// Téléchargements en cours : URL → fichier choisi.
    telechargements: HashMap<String, PathBuf>,
}

fn registre() -> &'static Mutex<Registre> {
    static R: OnceLock<Mutex<Registre>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Registre::default()))
}

fn avec<T>(f: impl FnOnce(&mut Registre) -> T) -> T {
    let mut garde = registre().lock().unwrap_or_else(|e| e.into_inner());
    f(&mut garde)
}

pub(crate) fn lire(fenetre: &str) -> EtatPage {
    avec(|r| r.pages.get(fenetre).cloned()).unwrap_or_else(|| EtatPage { fenetre: fenetre.into(), ..Default::default() })
}

/// Modifie l'état d'une fenêtre puis le diffuse (l'interface filtre sur `fenetre`).
pub(crate) fn changer(app: &AppHandle, fenetre: &str, f: impl FnOnce(&mut EtatPage)) -> EtatPage {
    let etat = avec(|r| {
        let page = r.pages.entry(fenetre.to_string()).or_insert_with(|| EtatPage { fenetre: fenetre.into(), ..Default::default() });
        f(page);
        page.clone()
    });
    let _ = app.emit(EVENEMENT_ETAT, &etat);
    etat
}

/// Vue créée : état neuf (pas encore prête), ouvert.
pub(crate) fn vue_creee(app: &AppHandle, fenetre: &str, url: &str) -> EtatPage {
    changer(app, fenetre, |e| {
        *e = EtatPage { fenetre: fenetre.into(), ouvert: true, url: url.into(), chargement: true, ..Default::default() };
    })
}

/// Vue fermée : on garde l'adresse pour une réouverture.
pub(crate) fn vue_fermee(app: &AppHandle, fenetre: &str) -> EtatPage {
    changer(app, fenetre, |e| {
        e.ouvert = false;
        e.chargement = false;
        e.pret = false;
        e.design = false;
    })
}

pub(crate) fn page_chargee(app: &AppHandle, fenetre: &str, fini: bool, url: String) {
    changer(app, fenetre, |e| {
        e.chargement = !fini;
        if fini {
            e.pret = true;
        } else {
            e.refus = None;
        }
        if !url.is_empty() {
            e.url = url;
        }
    });
}

pub(crate) fn titre(app: &AppHandle, fenetre: &str, titre: String) {
    changer(app, fenetre, |e| e.titre = titre.chars().take(300).collect());
}

pub(crate) fn refus(app: &AppHandle, fenetre: &str, url: &str) {
    let court: String = url.chars().take(120).collect();
    changer(app, fenetre, |e| e.refus = Some(court));
}

pub(crate) fn noter_espace(fenetre: &str, espace: &str) {
    let espace = espace.trim();
    if espace.is_empty() {
        return;
    }
    avec(|r| r.espaces.insert(fenetre.to_string(), espace.to_string()));
}

pub(crate) fn oublier_fenetre(fenetre: &str) {
    avec(|r| {
        r.espaces.remove(fenetre);
        r.pages.remove(fenetre);
    });
}

/// Compare deux chemins de dossier (séparateurs et casse sous Windows ignorés).
pub(crate) fn meme_dossier(a: &str, b: &str) -> bool {
    let propre = |s: &str| {
        let s = s.trim().replace('\\', "/");
        let s = s.trim_start_matches("//?/").trim_end_matches('/').to_string();
        if cfg!(windows) || s.chars().nth(1) == Some(':') { s.to_lowercase() } else { s }
    };
    !a.trim().is_empty() && propre(a) == propre(b)
}

/// Fenêtre de l'appli à utiliser pour l'agent d'un dossier : celle qui a ce dossier,
/// sinon une fenêtre qui a déjà un navigateur ouvert, sinon la première connue.
pub(crate) fn fenetre_pour(espace: &str, connues: &[String]) -> Option<String> {
    avec(|r| {
        let mut parmi: Vec<&String> = connues.iter().collect();
        parmi.sort();
        parmi
            .iter()
            .find(|f| r.espaces.get(f.as_str()).is_some_and(|e| meme_dossier(e, espace)))
            .or_else(|| parmi.iter().find(|f| r.pages.get(f.as_str()).is_some_and(|p| p.ouvert)))
            .or_else(|| parmi.iter().find(|f| f.as_str() == "main"))
            .or_else(|| parmi.first())
            .map(|f| f.to_string())
    })
}

pub(crate) fn telechargement_commence(app: &AppHandle, fenetre: &str, url: &str, chemin: &Path) {
    avec(|r| r.telechargements.insert(url.to_string(), chemin.to_path_buf()));
    let _ = app.emit(
        EVENEMENT_TELECHARGEMENT,
        serde_json::json!({"fenetre": fenetre, "fichier": chemin.display().to_string(), "fini": false, "ok": true}),
    );
}

pub(crate) fn telechargement_fini(app: &AppHandle, fenetre: &str, url: &str, chemin: Option<PathBuf>, ok: bool) {
    let prevu = avec(|r| r.telechargements.remove(url));
    let chemin = chemin.filter(|c| !c.as_os_str().is_empty()).or(prevu);
    let _ = app.emit(
        EVENEMENT_TELECHARGEMENT,
        serde_json::json!({
            "fenetre": fenetre,
            "fichier": chemin.map(|c| c.display().to_string()).unwrap_or_default(),
            "fini": true,
            "ok": ok,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dossiers_compares_sans_casse_ni_separateurs_sous_windows() {
        assert!(meme_dossier("C:\\Users\\Sav\\projet", "c:/users/sav/projet/"));
        assert!(meme_dossier("\\\\?\\C:\\a", "C:/a"));
        assert!(meme_dossier("/home/a/projet/", "/home/a/projet"));
        assert!(!meme_dossier("", ""));
        assert!(!meme_dossier("/home/a/p1", "/home/a/p2"));
    }

    #[test]
    fn choix_de_la_fenetre() {
        noter_espace("axecode-window-test-1", "/srv/projet-a");
        noter_espace("axecode-window-test-2", "/srv/projet-b");
        let connues = vec!["axecode-window-test-1".to_string(), "axecode-window-test-2".to_string()];
        assert_eq!(fenetre_pour("/srv/projet-b/", &connues).as_deref(), Some("axecode-window-test-2"));
        assert_eq!(fenetre_pour("/ailleurs", &connues).as_deref(), Some("axecode-window-test-1"));
        assert_eq!(fenetre_pour("/ailleurs", &[]), None);
        oublier_fenetre("axecode-window-test-1");
        oublier_fenetre("axecode-window-test-2");
    }
}
