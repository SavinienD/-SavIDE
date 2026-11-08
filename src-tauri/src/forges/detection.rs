//! Forge du dépôt, déduite de l'adresse du remote : GitHub (github.com), GitLab (hôte
//! « gitlab… », API /api/v4, groupes et sous-groupes), sinon Forgejo / Gitea (API /api/v1).

use crate::git::{git_output, remote_par_defaut};
use crate::*;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DepotForge {
    /// « github », « gitea » (Forgejo ou Gitea), « gitlab » ou « inconnu ».
    pub(crate) genre: String,
    /// Hôte web (avec le port s'il y en a un) : clé du jeton enregistré.
    pub(crate) hote: String,
    pub(crate) proprietaire: String,
    pub(crate) nom: String,
    pub(crate) url_web: String,
    pub(crate) url_api: String,
    pub(crate) remote: String,
}

impl DepotForge {
    pub(crate) fn chemin(&self) -> String {
        format!("{}/{}", encoder(&self.proprietaire), encoder(&self.nom))
    }
}

/// Encodage minimal d'un segment d'URL (propriétaire, dépôt, branche).
pub(crate) fn encoder(segment: &str) -> String {
    let mut s = String::new();
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            s.push(b as char);
        } else {
            s.push_str(&format!("%{b:02X}"));
        }
    }
    s
}

/// Adresse d'un remote → forge. `None` si l'adresse n'est pas reconnue (chemin local…).
pub(crate) fn analyser_remote(remote: &str, url: &str) -> Option<DepotForge> {
    let url = url.trim();
    let (schema, reste) = if let Some((s, r)) = url.split_once("://") {
        (s.to_ascii_lowercase(), r.to_string())
    } else if let Some((hote, chemin)) = url.split_once(':') {
        // Forme scp : git@hote:proprietaire/depot.git (pas un chemin Windows « C:\… »).
        if hote.len() <= 1 || hote.contains('/') || hote.contains('\\') {
            return None;
        }
        ("ssh".to_string(), format!("{hote}/{chemin}"))
    } else {
        return None;
    };
    if schema == "file" {
        return None;
    }
    let (autorite, chemin) = reste.split_once('/')?;
    let autorite = autorite.rsplit('@').next().unwrap_or(autorite);
    let web = matches!(schema.as_str(), "http" | "https");
    // En SSH, le port est celui de SSH : l'interface web est sur le port HTTPS normal.
    let hote = if web {
        autorite.to_ascii_lowercase()
    } else {
        autorite.split(':').next().unwrap_or(autorite).to_ascii_lowercase()
    };
    if hote.is_empty() {
        return None;
    }
    let segments: Vec<&str> = chemin
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() < 2 {
        return None;
    }
    let nom = segments[segments.len() - 1].to_string();
    let proprietaire = segments[segments.len() - 2].to_string();
    // Forge installée dans un sous-dossier (https://hote/gitea/proprietaire/depot).
    let prefixe = segments[..segments.len() - 2].join("/");
    let schema_web = if schema == "http" { "http" } else { "https" };
    let base = if prefixe.is_empty() {
        format!("{schema_web}://{hote}")
    } else {
        format!("{schema_web}://{hote}/{prefixe}")
    };
    let genre = if hote == "github.com" || hote == "www.github.com" {
        "github"
    } else if hote.contains("gitlab") {
        "gitlab"
    } else if hote.contains("bitbucket") || hote.contains("dev.azure.com") || hote.contains("visualstudio.com") {
        "inconnu"
    } else {
        "gitea"
    };
    let (proprietaire, url_web, url_api) = match genre {
        "github" => (
            proprietaire.clone(),
            format!("https://github.com/{proprietaire}/{nom}"),
            "https://api.github.com".to_string(),
        ),
        // GitLab : tout le chemin est celui du projet (groupe/sous-groupe/projet).
        "gitlab" => {
            let groupe = segments[..segments.len() - 1].join("/");
            let racine = format!("{schema_web}://{hote}");
            (groupe.clone(), format!("{racine}/{groupe}/{nom}"), format!("{racine}/api/v4"))
        }
        _ => (proprietaire.clone(), format!("{base}/{proprietaire}/{nom}"), format!("{base}/api/v1")),
    };
    Some(DepotForge {
        genre: genre.into(),
        hote: if genre == "github" { "github.com".into() } else { hote },
        proprietaire,
        nom,
        url_web,
        url_api,
        remote: remote.to_string(),
    })
}

/// Forge du dépôt : remote suivi par la branche, sinon origin, sinon le premier.
pub(crate) fn detecter(repo: &Path) -> Result<Option<DepotForge>> {
    let branche = crate::git::current_branch(repo)?;
    let suivi = match &branche {
        Some(b) => {
            let out = git_output(repo, &["config", "--get", &format!("branch.{b}.remote")])?;
            let r = out.stdout.trim().to_string();
            (out.success && !r.is_empty() && r != ".").then_some(r)
        }
        None => None,
    };
    let Some(remote) = suivi.or(remote_par_defaut(repo)?) else {
        return Ok(None);
    };
    let out = git_output(repo, &["remote", "get-url", &remote])?;
    if !out.success {
        return Ok(None);
    }
    Ok(analyser_remote(&remote, out.stdout.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(url: &str) -> DepotForge {
        analyser_remote("origin", url).unwrap_or_else(|| panic!("non reconnu : {url}"))
    }

    #[test]
    fn github_en_https_et_en_ssh() {
        for url in [
            "https://github.com/equipe/projet.git",
            "git@github.com:equipe/projet.git",
            "ssh://git@github.com/equipe/projet",
            "https://jeton@github.com/equipe/projet/",
        ] {
            let f = d(url);
            assert_eq!((f.genre.as_str(), f.proprietaire.as_str(), f.nom.as_str()), ("github", "equipe", "projet"), "{url}");
            assert_eq!(f.url_api, "https://api.github.com");
            assert_eq!(f.url_web, "https://github.com/equipe/projet");
            assert_eq!(f.hote, "github.com");
        }
    }

    #[test]
    fn forgejo_gitea_et_sous_dossier() {
        let f = d("ssh://git@git.exemple.fr:2222/equipe/outil.git");
        assert_eq!(f.genre, "gitea");
        assert_eq!(f.hote, "git.exemple.fr");
        assert_eq!(f.url_api, "https://git.exemple.fr/api/v1");
        assert_eq!(f.url_web, "https://git.exemple.fr/equipe/outil");
        let f = d("http://127.0.0.1:3000/equipe/outil.git");
        assert_eq!((f.hote.as_str(), f.url_api.as_str()), ("127.0.0.1:3000", "http://127.0.0.1:3000/api/v1"));
        let f = d("https://exemple.fr/gitea/equipe/outil");
        assert_eq!(f.url_api, "https://exemple.fr/gitea/api/v1");
        assert_eq!(f.chemin(), "equipe/outil");
        let g = d("git@gitlab.com:groupe/sous-groupe/outil.git");
        assert_eq!((g.genre.as_str(), g.proprietaire.as_str(), g.nom.as_str()), ("gitlab", "groupe/sous-groupe", "outil"));
        assert_eq!((g.url_api.as_str(), g.url_web.as_str()), ("https://gitlab.com/api/v4", "https://gitlab.com/groupe/sous-groupe/outil"));
        assert_eq!(d("https://bitbucket.org/a/b.git").genre, "inconnu");
    }

    #[test]
    fn chemins_locaux_ignores() {
        for url in ["C:\\depots\\outil", "/srv/git/outil.git", "file:///srv/git/outil.git", "../outil"] {
            assert!(analyser_remote("origin", url).is_none(), "{url}");
        }
    }

    #[test]
    fn segments_encodes() {
        assert_eq!(encoder("fix/é 1"), "fix%2F%C3%A9%201");
    }
}
