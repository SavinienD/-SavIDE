//! Adresse tapée dans la barre du navigateur intégré → URL à charger.
//!
//! Seuls `http`, `https` et `about:blank` s'ouvrent dans la vue : `file:`,
//! `javascript:`, `data:` et les schémas de l'appli (`tauri:`, `asset:`, `ipc:`…)
//! sont refusés, à la saisie comme pendant la navigation (`schema_autorise`).

use url::Url;

/// Moteur utilisé quand la saisie n'est pas une adresse (mots, phrase).
const RECHERCHE: &str = "https://duckduckgo.com/?q=";

/// Vrai si la vue peut charger `url` (navigation, fenêtre surgissante, redirection).
pub(crate) fn schema_autorise(url: &str) -> bool {
    let bas = url.trim().to_ascii_lowercase();
    bas.starts_with("http://") || bas.starts_with("https://") || bas == "about:blank"
}

/// Navigation dans la vue (liens, redirections, cadres) : web, `about:`, `blob:`, `data:`.
/// Refusé : `file:`, les schémas de l'appli et du système (`tauri:`, `asset:`, `ipc:`, `mailto:`…).
pub(crate) fn navigation_autorisee(url: &str) -> bool {
    let bas = url.trim().to_ascii_lowercase();
    schema_autorise(&bas) || bas.starts_with("about:") || bas.starts_with("blob:") || bas.starts_with("data:")
}

/// Hôte local ou du réseau local : on le joint en `http` (serveur de développement).
fn hote_local(hote: &str) -> bool {
    let h = hote.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h == "::1"
        || h == "0.0.0.0"
        || h.starts_with("127.")
        || h.starts_with("10.")
        || h.starts_with("192.168.")
        || (h.starts_with("172.")
            && h.split('.').nth(1).and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (16..=31).contains(&n)))
        || h.ends_with(".local")
}

/// Partie hôte d'une saisie sans schéma : « localhost:5173/a » → « localhost ».
fn hote_de(saisie: &str) -> &str {
    let avant_chemin = saisie.split(['/', '?', '#']).next().unwrap_or(saisie);
    if let Some(reste) = avant_chemin.strip_prefix('[') {
        // IPv6 entre crochets : « [::1]:3000 ».
        return reste.split(']').next().unwrap_or(reste);
    }
    avant_chemin.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map(|(h, _)| h).unwrap_or(avant_chemin)
}

fn encoder_recherche(mots: &str) -> String {
    let mut sortie = String::new();
    for octet in mots.trim().bytes() {
        match octet {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => sortie.push(octet as char),
            b' ' => sortie.push('+'),
            autre => sortie.push_str(&format!("%{autre:02X}")),
        }
    }
    sortie
}

/// Saisie de la barre d'adresse → URL complète.
///
/// « localhost:5173 » → « http://localhost:5173/ », « exemple.fr/docs » →
/// « https://exemple.fr/docs », « recette tarte » → recherche. Un schéma autre
/// que http(s) est refusé avec un message clair.
pub(crate) fn normaliser(saisie: &str) -> Result<String, String> {
    let s = saisie.trim();
    if s.is_empty() {
        return Err("Adresse vide.".into());
    }
    if s.eq_ignore_ascii_case("about:blank") {
        return Ok("about:blank".into());
    }
    let bas = s.to_ascii_lowercase();
    if bas.starts_with("http://") || bas.starts_with("https://") {
        return Url::parse(s).map(|u| u.to_string()).map_err(|_| format!("Adresse invalide : {s}"));
    }
    // « localhost:3000 » ressemble à un schéma (« localhost: ») : c'est un hôte et un port.
    let schema = s.split_once(':').map(|(avant, _)| avant).filter(|avant| {
        !avant.is_empty()
            && avant.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && avant.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    if let Some(schema) = schema {
        let apres = &s[schema.len() + 1..];
        let port_suit = apres.chars().next().is_some_and(|c| c.is_ascii_digit());
        if !port_suit {
            return Err(format!(
                "Adresse refusée ({schema}:) : le navigateur intégré n'ouvre que les adresses http et https."
            ));
        }
    }
    let hote = hote_de(s);
    let ressemble_a_une_adresse = !s.contains(char::is_whitespace)
        && (hote.contains('.') || hote_local(hote) || hote.contains(':'))
        && !hote.is_empty();
    if !ressemble_a_une_adresse {
        return Ok(format!("{RECHERCHE}{}", encoder_recherche(s)));
    }
    let schema = if hote_local(hote) { "http" } else { "https" };
    Url::parse(&format!("{schema}://{s}")).map(|u| u.to_string()).map_err(|_| format!("Adresse invalide : {s}"))
}

/// Adresse locale d'un port ouvert (liste « Ports »).
pub(crate) fn adresse_du_port(port: u16) -> String {
    format!("http://localhost:{port}/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotes_locaux_en_http() {
        assert_eq!(normaliser("localhost:5173").unwrap(), "http://localhost:5173/");
        assert_eq!(normaliser("127.0.0.1:8000/api?x=1").unwrap(), "http://127.0.0.1:8000/api?x=1");
        assert_eq!(normaliser("[::1]:3000").unwrap(), "http://[::1]:3000/");
        assert_eq!(normaliser("app.localhost").unwrap(), "http://app.localhost/");
        assert_eq!(normaliser("192.168.1.20:8080").unwrap(), "http://192.168.1.20:8080/");
    }

    #[test]
    fn domaines_en_https_et_schemas_gardes() {
        assert_eq!(normaliser("exemple.fr/docs").unwrap(), "https://exemple.fr/docs");
        assert_eq!(normaliser("  https://Exemple.fr  ").unwrap(), "https://exemple.fr/");
        assert_eq!(normaliser("http://exemple.fr:8080/a").unwrap(), "http://exemple.fr:8080/a");
        assert_eq!(normaliser("about:blank").unwrap(), "about:blank");
    }

    #[test]
    fn mots_vers_la_recherche() {
        assert_eq!(normaliser("recette tarte").unwrap(), "https://duckduckgo.com/?q=recette+tarte");
        assert_eq!(normaliser("tauri").unwrap(), "https://duckduckgo.com/?q=tauri");
        assert!(normaliser("élément CSS").unwrap().starts_with("https://duckduckgo.com/?q=%C3%A9l"));
    }

    #[test]
    fn schemas_dangereux_refuses() {
        for a in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "tauri://localhost", "asset://x", "ipc://localhost/x", "chrome://settings"] {
            let erreur = normaliser(a).unwrap_err();
            assert!(erreur.contains("http et https"), "{a} : {erreur}");
            assert!(!schema_autorise(a), "{a}");
        }
        assert!(normaliser("   ").is_err());
    }

    #[test]
    fn navigation_dans_la_vue() {
        assert!(schema_autorise("https://a.fr/"));
        assert!(schema_autorise("HTTP://localhost:3000"));
        assert!(schema_autorise("about:blank"));
        assert!(!schema_autorise("about:config"));
        assert!(navigation_autorisee("about:srcdoc") && navigation_autorisee("blob:https://a.fr/1"));
        for refuse in ["file:///C:/Windows", "tauri://localhost/", "ipc://localhost/x", "asset://localhost/a", "mailto:a@b.fr", "ms-settings:privacy"] {
            assert!(!navigation_autorisee(refuse), "{refuse}");
        }
        assert_eq!(adresse_du_port(5173), "http://localhost:5173/");
    }
}
