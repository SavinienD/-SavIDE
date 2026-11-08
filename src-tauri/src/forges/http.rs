//! Appels HTTP aux API des forges (GitHub REST, Forgejo / Gitea /api/v1) : en-têtes,
//! délais, et erreurs expliquées en français (jeton refusé, quota, dépôt introuvable).

use crate::*;
use std::time::Duration;

pub(crate) struct ClientForge {
    http: reqwest::Client,
    base: String,
    jeton: Option<String>,
    github: bool,
    gitlab: bool,
}

impl ClientForge {
    pub(crate) fn nouveau(base: &str, jeton: Option<String>, github: bool) -> std::result::Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(8))
            .user_agent(concat!("axecode/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { http, base: base.trim_end_matches('/').to_string(), jeton, github, gitlab: false })
    }

    /// API GitLab : jeton dans l'en-tête PRIVATE-TOKEN.
    pub(crate) fn gitlab(mut self) -> Self {
        self.gitlab = true;
        self
    }

    pub(crate) fn a_un_jeton(&self) -> bool {
        self.jeton.is_some()
    }

    fn requete(&self, methode: reqwest::Method, chemin_ou_url: &str) -> reqwest::RequestBuilder {
        let url = if chemin_ou_url.starts_with("http://") || chemin_ou_url.starts_with("https://") {
            chemin_ou_url.to_string()
        } else {
            format!("{}{}", self.base, chemin_ou_url)
        };
        let mut r = self.http.request(methode, url);
        if self.github {
            r = r
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28");
        } else {
            r = r.header("Accept", "application/json");
        }
        if let Some(jeton) = &self.jeton {
            r = if self.gitlab {
                r.header("PRIVATE-TOKEN", jeton.as_str())
            } else {
                r.header(
                    "Authorization",
                    if self.github { format!("Bearer {jeton}") } else { format!("token {jeton}") },
                )
            };
        }
        r
    }

    pub(crate) async fn get_json(&self, chemin: &str) -> std::result::Result<Value, String> {
        let reponse = self
            .requete(reqwest::Method::GET, chemin)
            .send()
            .await
            .map_err(erreur_reseau)?;
        lire_json(reponse).await
    }

    pub(crate) async fn post_json(&self, chemin: &str, corps: &Value) -> std::result::Result<Value, String> {
        let reponse = self
            .requete(reqwest::Method::POST, chemin)
            .json(corps)
            .send()
            .await
            .map_err(erreur_reseau)?;
        lire_json(reponse).await
    }

    /// Texte brut (journal d'un job) ; `None` si la forge ne le donne pas (404, HTML…).
    pub(crate) async fn get_texte(&self, chemin_ou_url: &str) -> std::result::Result<Option<String>, String> {
        let reponse = self
            .requete(reqwest::Method::GET, chemin_ou_url)
            .header("Accept", "text/plain, application/octet-stream, */*")
            .send()
            .await
            .map_err(erreur_reseau)?;
        let statut = reponse.status();
        if statut.as_u16() == 404 || statut.as_u16() == 410 {
            return Ok(None);
        }
        if !statut.is_success() {
            return Err(expliquer(statut.as_u16(), reponse.headers(), ""));
        }
        let type_ = reponse
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if type_.contains("html") {
            // Page de connexion de la forge à la place du journal.
            return Ok(None);
        }
        reponse.text().await.map(Some).map_err(|e| e.to_string())
    }
}

fn erreur_reseau(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "La forge ne répond pas (délai dépassé).".into()
    } else if e.is_connect() {
        format!("Forge injoignable : {e}")
    } else {
        format!("Échec de la requête : {e}")
    }
}

async fn lire_json(reponse: reqwest::Response) -> std::result::Result<Value, String> {
    let statut = reponse.status();
    let entetes = reponse.headers().clone();
    let texte = reponse.text().await.map_err(|e| e.to_string())?;
    if !statut.is_success() {
        return Err(expliquer(statut.as_u16(), &entetes, &texte));
    }
    if texte.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&texte).map_err(|e| format!("Réponse illisible de la forge : {e}"))
}

/// Message de l'API (« message » + détails des erreurs de validation).
fn message_api(corps: &str) -> Option<String> {
    let v: Value = serde_json::from_str(corps).ok()?;
    let mut m = v.get("message").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if let Some(erreurs) = v.get("errors").and_then(Value::as_array) {
        let details: Vec<String> = erreurs
            .iter()
            .filter_map(|e| e.get("message").and_then(Value::as_str).or_else(|| e.as_str()))
            .map(str::to_string)
            .collect();
        if !details.is_empty() {
            m = if m.is_empty() { details.join(" ; ") } else { format!("{m} : {}", details.join(" ; ")) };
        }
    }
    (!m.is_empty()).then_some(m)
}

pub(crate) fn expliquer(statut: u16, entetes: &reqwest::header::HeaderMap, corps: &str) -> String {
    let entete = |nom: &str| entetes.get(nom).and_then(|v| v.to_str().ok()).map(str::to_string);
    let detail = message_api(corps).map(|m| format!(" ({m})")).unwrap_or_default();
    match statut {
        401 => format!("Jeton refusé (401) : vérifiez-le ou remplacez-le.{detail}"),
        403 | 429 if entete("x-ratelimit-remaining").as_deref() == Some("0") || statut == 429 => {
            let quand = entete("x-ratelimit-reset")
                .and_then(|v| v.parse::<u64>().ok())
                .map(|fin| {
                    let maintenant = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                    let minutes = fin.saturating_sub(maintenant).div_ceil(60);
                    format!(" : réessayez dans {minutes} min")
                })
                .unwrap_or_default();
            format!("Quota de l'API atteint{quand}. Un jeton (ou gh connecté) donne un quota plus large.")
        }
        403 => format!("Accès refusé (403) : le jeton n'a pas les droits nécessaires sur ce dépôt.{detail}"),
        404 => "Introuvable (404) : dépôt privé sans jeton, ou adresse inconnue.".to_string(),
        409 | 422 => format!("Demande refusée par la forge ({statut}){detail}."),
        500..=599 => format!("La forge répond une erreur ({statut}) : réessayez plus tard."),
        _ => format!("Réponse inattendue de la forge ({statut}){detail}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn erreurs_expliquees() {
        let vide = HeaderMap::new();
        assert!(expliquer(401, &vide, "").starts_with("Jeton refusé"));
        let mut quota = HeaderMap::new();
        quota.insert("x-ratelimit-remaining", HeaderValue::from_static("0"));
        assert!(expliquer(403, &quota, "").starts_with("Quota de l'API atteint"));
        assert!(expliquer(403, &vide, "").starts_with("Accès refusé"));
        let corps = r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists for equipe:fonction."}]}"#;
        assert_eq!(
            expliquer(422, &vide, corps),
            "Demande refusée par la forge (422) (Validation Failed\u{a0}: A pull request already exists for equipe:fonction.)."
        );
    }
}
