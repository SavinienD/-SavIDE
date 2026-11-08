//! Pont local entre l'agent et le navigateur intégré.
//!
//! Le noyau Python de l'agent tourne dans le service d'arrière-plan (`--daemon`), le
//! navigateur dans l'appli (fenêtre de l'IDE). Le module `navigateur` du noyau appelle
//! l'hôte (`bridge.call("navigateur.lire", …)`) ; le service passe l'appel à l'appli
//! par ce pont :
//! - l'appli écoute sur 127.0.0.1 (port libre) et écrit `navigateur-pont.json` (port,
//!   jeton aléatoire de 256 bits) dans son dossier de données, lisible par l'utilisateur
//!   seul ;
//! - le service lit ce fichier et envoie UNE ligne JSON par appel :
//!   `{"jeton", "methode", "espace", "params"}` → `{"ok": true, "resultat"}` ou
//!   `{"ok": false, "erreur"}`. Ce n'est pas du HTTP : une page web ne peut pas y parler.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use axecode_core::SessionMeta;

use super::{adresse, capture, etat, page};

const FICHIER: &str = "navigateur-pont.json";
/// Taille maximale d'une requête ou d'une réponse (une page lue tient largement dedans).
const MAX_LIGNE: u64 = 4 * 1024 * 1024;

pub(crate) const INDISPONIBLE: &str = "le navigateur intégré ne répond pas\u{a0}: il faut l'appli ouverte sur ce poste \
(une session dans un espace distant n'y a pas accès)";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct FichierPont {
    pub(crate) port: u16,
    pub(crate) jeton: String,
    pub(crate) pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Requete {
    pub(crate) jeton: String,
    pub(crate) methode: String,
    #[serde(default)]
    pub(crate) espace: String,
    #[serde(default)]
    pub(crate) params: Value,
}

fn texte(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub(crate) fn chemin_fichier() -> Option<PathBuf> {
    axecode_daemon::util::default_data_dir().ok().map(|d| d.join(FICHIER))
}

fn jeton_aleatoire() -> Result<String, String> {
    use ring::rand::SecureRandom;
    let mut octets = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut octets).map_err(|_| "aléa indisponible".to_string())?;
    Ok(octets.iter().map(|o| format!("{o:02x}")).collect())
}

/// Comparaison en temps constant (le jeton ne fuit pas par la durée de la réponse).
fn meme_jeton(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub(crate) fn ecrire_fichier(chemin: &Path, fichier: &FichierPont) -> Result<(), String> {
    if let Some(parent) = chemin.parent() {
        std::fs::create_dir_all(parent).map_err(texte)?;
    }
    let provisoire = chemin.with_extension("json.tmp");
    std::fs::write(&provisoire, serde_json::to_vec(fichier).map_err(texte)?).map_err(texte)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&provisoire, std::fs::Permissions::from_mode(0o600)).map_err(texte)?;
    }
    std::fs::rename(&provisoire, chemin).map_err(texte)
}

pub(crate) fn lire_fichier(chemin: &Path) -> Option<FichierPont> {
    serde_json::from_slice(&std::fs::read(chemin).ok()?).ok()
}

/// Lit une ligne (bornée) avec un délai.
async fn lire_ligne<R: tokio::io::AsyncRead + Unpin>(lecteur: R, delai: Duration) -> Result<String, String> {
    let mut lecteur = BufReader::new(lecteur.take(MAX_LIGNE));
    let mut ligne = String::new();
    tokio::time::timeout(delai, lecteur.read_line(&mut ligne))
        .await
        .map_err(|_| "délai dépassé".to_string())?
        .map_err(texte)?;
    if ligne.trim().is_empty() {
        return Err("réponse vide".into());
    }
    Ok(ligne)
}

/// Sert le pont sur `ecoute` : chaque connexion = une requête, une réponse.
pub(crate) async fn servir<F, Fut>(ecoute: TcpListener, jeton: Arc<String>, gestion: F)
where
    F: Fn(Requete) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    loop {
        let Ok((flux, _)) = ecoute.accept().await else {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        };
        let (jeton, gestion) = (jeton.clone(), gestion.clone());
        tokio::spawn(async move {
            let (lecture, mut ecriture) = flux.into_split();
            let reponse = match lire_ligne(lecture, Duration::from_secs(10)).await {
                Err(e) => json!({"ok": false, "erreur": e}),
                Ok(ligne) => match serde_json::from_str::<Requete>(&ligne) {
                    Err(_) => json!({"ok": false, "erreur": "requête illisible"}),
                    Ok(r) if !meme_jeton(&r.jeton, &jeton) => json!({"ok": false, "erreur": "jeton refusé"}),
                    Ok(r) => match gestion(r).await {
                        Ok(resultat) => json!({"ok": true, "resultat": resultat}),
                        Err(erreur) => json!({"ok": false, "erreur": erreur}),
                    },
                },
            };
            let _ = ecriture.write_all(format!("{reponse}\n").as_bytes()).await;
            let _ = ecriture.shutdown().await;
        });
    }
}

/// Délai d'attente du service pour une méthode (ouvrir attend le chargement de la page).
fn delai_pour(methode: &str) -> Duration {
    match methode {
        "ouvrir" => Duration::from_secs(45),
        "capture" => Duration::from_secs(35),
        _ => Duration::from_secs(25),
    }
}

/// Côté service : appelle le navigateur de l'appli décrit par le fichier `chemin`.
pub(crate) async fn appeler_avec(chemin: &Path, methode: &str, espace: &str, params: Value) -> Result<Value, String> {
    let fichier = lire_fichier(chemin).ok_or_else(|| INDISPONIBLE.to_string())?;
    let flux = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(("127.0.0.1", fichier.port)))
        .await
        .map_err(|_| INDISPONIBLE.to_string())?
        .map_err(|_| INDISPONIBLE.to_string())?;
    let (lecture, mut ecriture) = flux.into_split();
    let requete = Requete { jeton: fichier.jeton, methode: methode.into(), espace: espace.into(), params };
    let ligne = format!("{}\n", serde_json::to_string(&requete).map_err(texte)?);
    ecriture.write_all(ligne.as_bytes()).await.map_err(|_| INDISPONIBLE.to_string())?;
    let reponse = lire_ligne(lecture, delai_pour(methode))
        .await
        .map_err(|e| format!("le navigateur intégré n'a pas répondu ({e})"))?;
    let valeur: Value = serde_json::from_str(&reponse).map_err(|_| "réponse illisible du navigateur intégré".to_string())?;
    if valeur.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(valeur.get("resultat").cloned().unwrap_or(Value::Null))
    } else {
        Err(valeur.get("erreur").and_then(Value::as_str).unwrap_or("erreur du navigateur intégré").to_string())
    }
}

/// Côté service : crochet du REPL qui sert les appels `navigateur.*` du noyau.
pub(crate) struct HookNavigateur;

#[async_trait]
impl axecode_app::repl::TurnHook for HookNavigateur {
    fn handles(&self, method: &str) -> bool {
        method.starts_with("navigateur.")
    }

    async fn host_call(&self, session: &SessionMeta, method: &str, params: Value) -> Result<Value, String> {
        let methode = method.trim_start_matches("navigateur.");
        let chemin = chemin_fichier().ok_or_else(|| INDISPONIBLE.to_string())?;
        appeler_avec(&chemin, methode, &session.workspace_id, params).await
    }
}

/// Côté appli : ouvre le pont (au démarrage) et écrit le fichier qui le décrit.
pub(crate) fn demarrer_pont(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(chemin) = chemin_fichier() else { return };
        let ecoute = match TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(e) => e,
            Err(err) => {
                tracing::warn!(error = %err, "pont du navigateur intégré indisponible");
                return;
            }
        };
        let (Ok(adresse), Ok(jeton)) = (ecoute.local_addr(), jeton_aleatoire()) else { return };
        let fichier = FichierPont { port: adresse.port(), jeton: jeton.clone(), pid: std::process::id() };
        if let Err(err) = ecrire_fichier(&chemin, &fichier) {
            tracing::warn!(error = %err, "fichier du pont du navigateur non écrit");
            return;
        }
        servir(ecoute, Arc::new(jeton), move |requete: Requete| {
            let app = app.clone();
            async move { traiter(&app, &requete.methode, &requete.espace, requete.params).await }
        })
        .await;
    });
}

fn chaine<'a>(params: &'a Value, cle: &str) -> Result<&'a str, String> {
    params.get(cle).and_then(Value::as_str).filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("paramètre « {cle} » manquant"))
}

/// Appelle une fonction de la bibliothèque de la page et rend sa valeur décodée.
async fn dans_la_page(app: &AppHandle, fenetre: &str, fonction: &str, arguments: Vec<Value>) -> Result<Value, String> {
    if !etat::lire(fenetre).ouvert {
        return Err("le navigateur intégré n'est pas ouvert : appelez d'abord navigateur.ouvrir(url)".into());
    }
    let script = page::appel(fonction, &arguments)?;
    page::decoder(&super::evaluer(app, fenetre, script, Duration::from_secs(15)).await?)
}

/// Ajoute l'adresse et le titre courants à une réponse d'action (la page a pu changer).
fn avec_page(mut valeur: Value, fenetre: &str) -> Value {
    let e = etat::lire(fenetre);
    if let Some(objet) = valeur.as_object_mut() {
        objet.insert("url".into(), json!(e.url));
        objet.insert("titre".into(), json!(e.titre));
        objet.insert("chargement".into(), json!(e.chargement));
    }
    valeur
}

/// Côté appli : une requête de l'agent du dossier `espace`.
async fn traiter(app: &AppHandle, methode: &str, espace: &str, params: Value) -> Result<Value, String> {
    let connues: Vec<String> = app.webview_windows().keys().cloned().collect();
    let fenetre = etat::fenetre_pour(espace, &connues).ok_or_else(|| "aucune fenêtre de l'appli n'est ouverte".to_string())?;
    match methode {
        "ouvrir" => {
            let url = adresse::normaliser(chaine(&params, "url")?)?;
            if !etat::lire(&fenetre).ouvert {
                super::assurer_vue(app, &fenetre, "about:blank").await?;
            }
            super::demander_onglet(app, &fenetre);
            super::aller(app, &fenetre, &url).await?;
            super::attendre_chargement(&fenetre, Duration::from_secs(25)).await;
            Ok(avec_page(json!({"ok": true}), &fenetre))
        }
        "etat" => serde_json::to_value(etat::lire(&fenetre)).map_err(texte),
        "lire" => {
            let options = params.get("options").cloned().unwrap_or_else(|| json!({}));
            dans_la_page(app, &fenetre, "lire", vec![options]).await
        }
        "cliquer" => {
            let reponse = dans_la_page(app, &fenetre, "cliquer", vec![json!(chaine(&params, "ref")?)]).await?;
            super::attendre_chargement(&fenetre, Duration::from_secs(5)).await;
            Ok(avec_page(reponse, &fenetre))
        }
        "remplir" => {
            let texte_saisi = params.get("texte").and_then(Value::as_str).unwrap_or("");
            dans_la_page(app, &fenetre, "remplir", vec![json!(chaine(&params, "ref")?), json!(texte_saisi)]).await
        }
        "touche" => {
            let nom = chaine(&params, "nom")?;
            #[cfg(windows)]
            if let Some([appui, relache]) = capture::evenements_touche(nom) {
                // Vraie touche (évènements « de confiance ») par le protocole de WebView2.
                if capture::cdp(app, &fenetre, "Input.dispatchKeyEvent", appui).await.is_ok()
                    && capture::cdp(app, &fenetre, "Input.dispatchKeyEvent", relache).await.is_ok()
                {
                    super::attendre_chargement(&fenetre, Duration::from_secs(5)).await;
                    return Ok(avec_page(json!({"ok": true}), &fenetre));
                }
            }
            let reponse = dans_la_page(app, &fenetre, "touche", vec![json!(nom)]).await?;
            super::attendre_chargement(&fenetre, Duration::from_secs(5)).await;
            Ok(avec_page(reponse, &fenetre))
        }
        "trouver" => dans_la_page(app, &fenetre, "trouver", vec![json!(chaine(&params, "cible")?)]).await,
        "capture" => {
            let chemin = PathBuf::from(chaine(&params, "chemin")?);
            if !chemin.is_absolute() {
                return Err("chemin de capture absolu attendu".into());
            }
            if !etat::lire(&fenetre).ouvert {
                return Err("le navigateur intégré n'est pas ouvert : appelez d'abord navigateur.ouvrir(url)".into());
            }
            let png = capture::png(app, &fenetre).await?;
            if let Some(parent) = chemin.parent() {
                std::fs::create_dir_all(parent).map_err(texte)?;
            }
            std::fs::write(&chemin, &png).map_err(|e| format!("{} : {e}", chemin.display()))?;
            Ok(json!({"chemin": chemin.display().to_string(), "octets": png.len()}))
        }
        autre => Err(format!("méthode inconnue du navigateur intégré : {autre}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dossier_test(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("axecode-pont-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn jetons() {
        let (a, b) = (jeton_aleatoire().unwrap(), jeton_aleatoire().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(meme_jeton(&a, &a.clone()));
        assert!(!meme_jeton(&a, &b));
        assert!(!meme_jeton("", ""));
        assert!(!meme_jeton(&a, &a[..63]));
    }

    #[cfg(unix)]
    #[test]
    fn fichier_lisible_par_l_utilisateur_seul() {
        use std::os::unix::fs::PermissionsExt;
        let d = dossier_test("droits");
        let chemin = d.join(FICHIER);
        let f = FichierPont { port: 4321, jeton: "x".repeat(64), pid: 7 };
        ecrire_fichier(&chemin, &f).unwrap();
        assert_eq!(lire_fichier(&chemin), Some(f));
        assert_eq!(std::fs::metadata(&chemin).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn aller_retour_et_refus() {
        let d = dossier_test("aller-retour");
        let chemin = d.join(FICHIER);
        // Pas de fichier : message clair.
        assert_eq!(appeler_avec(&chemin, "lire", "/p", json!({})).await.unwrap_err(), INDISPONIBLE);

        let ecoute = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = ecoute.local_addr().unwrap().port();
        let jeton = jeton_aleatoire().unwrap();
        tokio::spawn(servir(ecoute, Arc::new(jeton.clone()), |r: Requete| async move {
            if r.methode == "echec" {
                return Err("élément e9 introuvable".to_string());
            }
            Ok(json!({"methode": r.methode, "espace": r.espace, "params": r.params}))
        }));
        ecrire_fichier(&chemin, &FichierPont { port, jeton: jeton.clone(), pid: 1 }).unwrap();
        let v = appeler_avec(&chemin, "cliquer", "/p", json!({"ref": "e3"})).await.unwrap();
        assert_eq!(v, json!({"methode": "cliquer", "espace": "/p", "params": {"ref": "e3"}}));
        assert_eq!(appeler_avec(&chemin, "echec", "/p", json!({})).await.unwrap_err(), "élément e9 introuvable");

        // Mauvais jeton : refusé.
        ecrire_fichier(&chemin, &FichierPont { port, jeton: "0".repeat(64), pid: 1 }).unwrap();
        assert_eq!(appeler_avec(&chemin, "lire", "/p", json!({})).await.unwrap_err(), "jeton refusé");

        // Une requête HTTP (page web) n'obtient rien d'utile.
        let mut flux = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        flux.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await.unwrap();
        let mut reponse = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), flux.read_to_string(&mut reponse)).await;
        assert!(reponse.contains("requête illisible"), "{reponse}");
        assert!(!reponse.contains("HTTP/1.1 200"));

        // Pont fermé (port sans écoute) : message clair.
        let libre = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port_libre = libre.local_addr().unwrap().port();
        drop(libre);
        ecrire_fichier(&chemin, &FichierPont { port: port_libre, jeton, pid: 1 }).unwrap();
        assert_eq!(appeler_avec(&chemin, "lire", "/p", json!({})).await.unwrap_err(), INDISPONIBLE);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn crochet_du_service() {
        use axecode_app::repl::TurnHook;
        assert!(HookNavigateur.handles("navigateur.lire"));
        assert!(!HookNavigateur.handles("cua.run"));
    }
}
