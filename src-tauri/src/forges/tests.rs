//! Forges contre un faux serveur HTTP local (aucun appel réseau réel) : GitHub REST et
//! Forgejo / Gitea, PR, checks, revues, commentaires de lignes, journaux, issues, création.

use super::api;
use super::detection::DepotForge;
use super::http::ClientForge;
use crate::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
struct Requete {
    methode: String,
    chemin: String,
    autorisation: Option<String>,
    jeton_prive: Option<String>,
    corps: String,
}

type Route = Box<dyn Fn(&Requete) -> (u16, &'static str, String, Vec<(String, String)>) + Send + Sync>;

struct FauxServeur {
    base: String,
    requetes: Arc<Mutex<Vec<Requete>>>,
}

fn servir(route: Route) -> FauxServeur {
    let ecoute = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", ecoute.local_addr().unwrap());
    let requetes = Arc::new(Mutex::new(Vec::new()));
    let journal = requetes.clone();
    let route = Arc::new(route);
    std::thread::spawn(move || {
        for flux in ecoute.incoming().flatten() {
            let route = route.clone();
            let journal = journal.clone();
            std::thread::spawn(move || {
                let mut lecteur = BufReader::new(flux.try_clone().unwrap());
                let mut ligne = String::new();
                if lecteur.read_line(&mut ligne).unwrap_or(0) == 0 {
                    return;
                }
                let mut parts = ligne.split_whitespace();
                let methode = parts.next().unwrap_or("").to_string();
                let chemin = parts.next().unwrap_or("").to_string();
                let mut longueur = 0usize;
                let mut autorisation = None;
                let mut jeton_prive = None;
                loop {
                    let mut l = String::new();
                    if lecteur.read_line(&mut l).unwrap_or(0) == 0 || l == "\r\n" {
                        break;
                    }
                    let (nom, valeur) = l.split_once(':').unwrap_or((&l, ""));
                    match nom.to_ascii_lowercase().as_str() {
                        "content-length" => longueur = valeur.trim().parse().unwrap_or(0),
                        "authorization" => autorisation = Some(valeur.trim().to_string()),
                        "private-token" => jeton_prive = Some(valeur.trim().to_string()),
                        _ => {}
                    }
                }
                let mut corps = vec![0u8; longueur];
                lecteur.read_exact(&mut corps).ok();
                let req = Requete { methode, chemin, autorisation, jeton_prive, corps: String::from_utf8_lossy(&corps).to_string() };
                journal.lock().unwrap().push(req.clone());
                let (statut, type_, texte, entetes) = route(&req);
                let mut reponse = format!(
                    "HTTP/1.1 {statut} OK\r\nContent-Type: {type_}\r\nContent-Length: {}\r\nConnection: close\r\n",
                    texte.len()
                );
                for (nom, valeur) in entetes {
                    reponse.push_str(&format!("{nom}: {valeur}\r\n"));
                }
                reponse.push_str("\r\n");
                reponse.push_str(&texte);
                let mut flux = flux;
                flux.write_all(reponse.as_bytes()).ok();
            });
        }
    });
    FauxServeur { base, requetes }
}

fn json_ok(v: Value) -> (u16, &'static str, String, Vec<(String, String)>) {
    (200, "application/json", v.to_string(), Vec::new())
}

fn depot(genre: &str, base: &str, proprietaire: &str, nom: &str) -> DepotForge {
    DepotForge {
        genre: genre.into(),
        hote: "127.0.0.1".into(),
        proprietaire: proprietaire.into(),
        nom: nom.into(),
        url_web: format!("{base}/{proprietaire}/{nom}"),
        url_api: if genre == "github" { base.to_string() } else { format!("{base}/api/v1") },
        remote: "origin".into(),
    }
}

fn route_github() -> Route {
    Box::new(|r: &Requete| {
        let p = r.chemin.as_str();
        let pr = json!({"number": 12, "title": "Onglet PR", "user": {"login": "leo"}, "state": "open", "draft": true,
            "head": {"ref": "pr-onglet", "sha": "abc"}, "base": {"ref": "main"}, "body": "Liste et checks",
            "html_url": "https://github.com/equipe/outil/pull/12", "updated_at": "2026-11-08T10:00:00Z"});
        if p.starts_with("/repos/equipe/outil/pulls?") {
            json_ok(json!([pr]))
        } else if p == "/repos/equipe/outil/pulls/12" {
            json_ok(pr)
        } else if p.starts_with("/repos/equipe/outil/commits/abc/check-runs") {
            json_ok(json!({"check_runs": [
                {"id": 992, "name": "lint", "status": "in_progress", "conclusion": null, "app": {"slug": "github-actions"}},
                {"id": 991, "name": "build", "status": "completed", "conclusion": "failure", "app": {"slug": "github-actions"},
                 "html_url": "https://github.com/equipe/outil/actions/runs/5/job/991", "output": {"title": "2 erreurs"}}
            ]}))
        } else if p == "/repos/equipe/outil/commits/abc/status" {
            json_ok(json!({"state": "success", "statuses": [{"id": 5, "context": "ci/autre", "state": "success", "target_url": "https://ci.exemple.fr", "description": "ok"}]}))
        } else if p.starts_with("/repos/equipe/outil/pulls/12/reviews") {
            json_ok(json!([
                {"id": 1, "user": {"login": "nora"}, "state": "CHANGES_REQUESTED", "body": "À revoir", "submitted_at": "2026-11-08T10:04:00Z"},
                {"id": 2, "user": {"login": "leo"}, "state": "COMMENTED", "body": "", "submitted_at": "2026-11-08T10:05:00Z"}
            ]))
        } else if p.starts_with("/repos/equipe/outil/pulls/12/comments") {
            json_ok(json!([{"id": 7, "user": {"login": "nora"}, "body": "Nom trop long", "path": "src/a.ts", "line": 42,
                "created_at": "2026-11-08T10:05:00Z", "html_url": "https://github.com/equipe/outil/pull/12#discussion_r7"}]))
        } else if p.starts_with("/repos/equipe/outil/issues/12/comments") {
            json_ok(json!([{"id": 8, "user": {"login": "leo"}, "body": "Merci", "created_at": "2026-11-08T10:06:00Z"}]))
        } else if p == "/repos/equipe/outil/actions/jobs/991/logs" {
            (302, "text/plain", String::new(), vec![("Location".into(), "/journal-brut/991".into())])
        } else if p == "/journal-brut/991" {
            (200, "text/plain", "2026-11-08T10:00:00.0000000Z Compiling outil\n2026-11-08T10:00:01.0000000Z error[E0425]: cannot find value `x`\nGITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n".into(), Vec::new())
        } else if p.starts_with("/repos/equipe/outil/issues?") {
            json_ok(json!([
                {"number": 7, "title": "Écran PR", "user": {"login": "s"}, "body": "Faire la liste", "labels": [{"name": "ui"}],
                 "html_url": "https://github.com/equipe/outil/issues/7", "updated_at": "2026-11-07T09:00:00Z", "comments": 2},
                {"number": 12, "title": "Onglet PR", "user": {"login": "leo"}, "pull_request": {"url": "x"}}
            ]))
        } else if p == "/repos/equipe/outil/pulls" && r.methode == "POST" {
            json_ok(json!({"number": 13, "html_url": "https://github.com/equipe/outil/pull/13"}))
        } else {
            (404, "application/json", json!({"message": "Not Found"}).to_string(), Vec::new())
        }
    })
}

#[tokio::test]
async fn github_liste_detail_journal_issues_et_creation() {
    let serveur = servir(route_github());
    let d = depot("github", &serveur.base, "equipe", "outil");
    let c = ClientForge::nouveau(&d.url_api, Some("ghp_test".into()), true).unwrap();

    let prs = api::prs(&c, &d, false).await.unwrap();
    assert_eq!(prs.len(), 1);
    assert!(prs[0].brouillon);
    assert_eq!((prs[0].numero, prs[0].branche.as_str(), prs[0].base.as_str()), (12, "pr-onglet", "main"));

    let detail = api::detail(&c, &d, 12).await.unwrap();
    assert_eq!(detail.description, "Liste et checks");
    let noms: Vec<(&str, &str)> = detail.checks.iter().map(|k| (k.nom.as_str(), k.etat.as_str())).collect();
    assert_eq!(noms, vec![("build", "echec"), ("lint", "en_cours"), ("ci/autre", "succes")]);
    assert!(detail.checks[0].journal && !detail.checks[2].journal);
    assert_eq!(detail.checks[0].detail.as_deref(), Some("2 erreurs"));
    assert_eq!(detail.revues.len(), 1, "revue vide des commentaires de lignes écartée");
    assert_eq!(detail.revues[0].etat, "changements");
    assert_eq!(detail.commentaires.len(), 2);
    assert_eq!((detail.commentaires[0].fichier.as_deref(), detail.commentaires[0].ligne), (Some("src/a.ts"), Some(42)));
    assert_eq!(detail.commentaires[1].fichier, None);

    let journal = api::journal(&c, &d, "991", None).await.unwrap().expect("journal");
    let fin = super::commandes::fin_journal(&journal);
    assert!(fin.contains("error[E0425]") && !fin.contains("2026-11-08T10:00:01"), "{fin}");
    assert!(!fin.contains("ghp_ABC"), "secret masqué : {fin}");
    assert_eq!(api::journal(&c, &d, "statut:5", None).await.unwrap(), None);

    let issues = api::issues(&c, &d).await.unwrap();
    assert_eq!(issues.len(), 1, "les PR ne sont pas des issues");
    assert_eq!((issues[0].numero, issues[0].etiquettes.clone()), (7, vec!["ui".to_string()]));

    let creee = api::creer_pr(&c, &d, "Nouvelle PR", "Texte", "fonction", "main", true).await.unwrap();
    assert_eq!((creee.numero, creee.url.as_str()), (13, "https://github.com/equipe/outil/pull/13"));
    let requetes = serveur.requetes.lock().unwrap().clone();
    let post = requetes.iter().find(|r| r.methode == "POST").unwrap();
    let corps: Value = serde_json::from_str(&post.corps).unwrap();
    assert_eq!(corps["draft"], json!(true));
    assert_eq!(corps["head"], json!("fonction"));
    assert!(requetes.iter().filter(|r| !r.chemin.starts_with("/journal-brut")).all(|r| r.autorisation.as_deref() == Some("Bearer ghp_test")));
}

fn route_forgejo(base: Arc<Mutex<String>>) -> Route {
    Box::new(move |r: &Requete| {
        let p = r.chemin.as_str();
        let b = base.lock().unwrap().clone();
        let pr = json!({"number": 3, "title": "WIP: Issues", "user": {"login": "s"}, "state": "open", "merged": false,
            "head": {"ref": "issues", "sha": "def"}, "base": {"ref": "main"}, "body": "",
            "html_url": format!("{b}/equipe/outil/pulls/3"), "updated_at": "2026-11-08T11:00:00+01:00"});
        match (r.methode.as_str(), p) {
            ("GET", "/api/v1/repos/equipe/outil/pulls?state=open&sort=recentupdate&limit=50") => json_ok(json!([pr])),
            ("GET", "/api/v1/repos/equipe/outil/pulls/3") => json_ok(pr),
            ("GET", "/api/v1/repos/equipe/outil/commits/def/status") => json_ok(json!({"state": "failure", "statuses": [
                {"id": 11, "context": "ci / build (push)", "status": "failure", "description": "Failing after 12s",
                 "target_url": format!("{b}/equipe/outil/actions/runs/4/jobs/0")}]})),
            ("GET", "/api/v1/repos/equipe/outil/pulls/3/reviews") => json_ok(json!([
                {"id": 21, "user": {"login": "m"}, "state": "REQUEST_CHANGES", "body": "Voir les lignes", "submitted_at": "2026-11-08T11:05:00+01:00", "comments_count": 1}])),
            ("GET", "/api/v1/repos/equipe/outil/pulls/3/reviews/21/comments") => json_ok(json!([
                {"id": 31, "user": {"login": "m"}, "body": "Faute de frappe", "path": "src/b.rs", "position": 7, "original_position": 0,
                 "created_at": "2026-11-08T11:05:00+01:00", "html_url": format!("{b}/equipe/outil/pulls/3/files#issuecomment-31")}])),
            ("GET", "/api/v1/repos/equipe/outil/issues/3/comments") => json_ok(json!([])),
            ("GET", "/equipe/outil/actions/runs/4/jobs/0/logs") => (200, "text/plain; charset=utf-8", "étape 1\nerror: test failed\n".into(), Vec::new()),
            ("GET", "/api/v1/repos/equipe/outil/issues?state=open&type=issues&limit=50") => json_ok(json!([
                {"number": 7, "title": "Écran PR", "user": {"login": "s"}, "body": "Faire la liste", "labels": [],
                 "html_url": format!("{b}/equipe/outil/issues/7"), "updated_at": "2026-11-07T09:00:00+01:00", "comments": 0}])),
            ("POST", "/api/v1/repos/equipe/outil/pulls") => json_ok(json!({"number": 4, "html_url": format!("{b}/equipe/outil/pulls/4")})),
            _ => (404, "application/json", json!({"message": "introuvable"}).to_string(), Vec::new()),
        }
    })
}

#[tokio::test]
async fn forgejo_liste_detail_journal_issues_et_creation() {
    let base = Arc::new(Mutex::new(String::new()));
    let serveur = servir(route_forgejo(base.clone()));
    *base.lock().unwrap() = serveur.base.clone();
    let d = depot("gitea", &serveur.base, "equipe", "outil");
    let c = ClientForge::nouveau(&d.url_api, Some("jeton-forgejo".into()), false).unwrap();

    let prs = api::prs(&c, &d, false).await.unwrap();
    assert_eq!(prs.len(), 1);
    assert!(prs[0].brouillon, "titre WIP: = brouillon");
    let detail = api::detail(&c, &d, 3).await.unwrap();
    assert_eq!(detail.checks.len(), 1);
    let check = &detail.checks[0];
    assert_eq!((check.etat.as_str(), check.journal), ("echec", true));
    assert_eq!(detail.revues[0].etat, "changements");
    assert_eq!(detail.commentaires.len(), 1);
    assert_eq!((detail.commentaires[0].fichier.as_deref(), detail.commentaires[0].ligne), (Some("src/b.rs"), Some(7)));

    let journal = api::journal(&c, &d, &check.id, check.url.as_deref()).await.unwrap();
    assert!(journal.unwrap_or_default().contains("error: test failed"));

    let issues = api::issues(&c, &d).await.unwrap();
    assert_eq!(issues[0].titre, "Écran PR");

    let creee = api::creer_pr(&c, &d, "Nouvelle PR", "", "fonction", "main", true).await.unwrap();
    assert_eq!(creee.numero, 4);
    let requetes = serveur.requetes.lock().unwrap().clone();
    let post = requetes.iter().find(|r| r.methode == "POST").unwrap();
    let corps: Value = serde_json::from_str(&post.corps).unwrap();
    assert_eq!(corps["title"], json!("WIP: Nouvelle PR"));
    assert!(requetes.iter().all(|r| r.autorisation.as_deref() == Some("token jeton-forgejo")));
}

#[tokio::test]
async fn erreurs_de_la_forge_expliquees() {
    let serveur = servir(Box::new(|r: &Requete| {
        if r.autorisation.is_none() {
            (404, "application/json", json!({"message": "Not Found"}).to_string(), Vec::new())
        } else {
            (401, "application/json", json!({"message": "Bad credentials"}).to_string(), Vec::new())
        }
    }));
    let d = depot("gitea", &serveur.base, "equipe", "prive");
    let sans = ClientForge::nouveau(&d.url_api, None, false).unwrap();
    assert!(api::prs(&sans, &d, false).await.unwrap_err().starts_with("Introuvable (404)"));
    let mauvais = ClientForge::nouveau(&d.url_api, Some("faux".into()), false).unwrap();
    assert!(api::prs(&mauvais, &d, false).await.unwrap_err().starts_with("Jeton refusé (401)"));
    let ferme = ClientForge::nouveau("http://127.0.0.1:9/api/v1", None, false).unwrap();
    assert!(api::issues(&ferme, &d).await.is_err());
}

fn route_gitlab() -> Route {
    Box::new(|r: &Requete| {
        let p = r.chemin.as_str();
        let mr = json!({"iid": 5, "title": "Draft: pipelines dans l'IDE", "author": {"username": "nora"}, "state": "opened", "draft": true,
            "source_branch": "pipelines", "target_branch": "main", "sha": "f00d", "description": "Liste des jobs.",
            "web_url": "https://gitlab.exemple.fr/groupe/sous/outil/-/merge_requests/5", "updated_at": "2026-11-08T10:00:00Z",
            "head_pipeline": {"id": 77, "status": "failed"}});
        match (r.methode.as_str(), p) {
            ("GET", "/api/v4/projects/groupe%2Fsous%2Foutil/merge_requests?state=opened&order_by=updated_at&per_page=50") => json_ok(json!([mr])),
            ("GET", "/api/v4/projects/groupe%2Fsous%2Foutil/merge_requests/5") => json_ok(mr),
            ("GET", "/api/v4/projects/groupe%2Fsous%2Foutil/pipelines/77/jobs?per_page=100") => json_ok(json!([
                {"id": 901, "name": "tests", "stage": "test", "status": "failed", "web_url": "https://gitlab.exemple.fr/j/901", "failure_reason": "script_failure"},
                {"id": 902, "name": "lint", "stage": "test", "status": "success", "web_url": "https://gitlab.exemple.fr/j/902"}])),
            ("GET", "/api/v4/projects/groupe%2Fsous%2Foutil/merge_requests/5/notes?sort=asc&per_page=100") => json_ok(json!([
                {"id": 1, "body": "a poussé 2 commits", "system": true, "author": {"username": "nora"}, "created_at": "2026-11-08T10:01:00Z"},
                {"id": 2, "body": "Variable inutilisée", "system": false, "author": {"username": "leo"}, "created_at": "2026-11-08T10:02:00Z",
                 "position": {"new_path": "src/c.rs", "new_line": 12, "old_path": "src/c.rs", "old_line": null}},
                {"id": 3, "body": "Merci", "system": false, "author": {"username": "nora"}, "created_at": "2026-11-08T10:03:00Z"}])),
            ("GET", "/api/v4/projects/groupe%2Fsous%2Foutil/merge_requests/5/approvals") => json_ok(json!({"approved_by": [{"user": {"id": 4, "username": "leo"}}]})),
            ("GET", "/api/v4/projects/groupe%2Fsous%2Foutil/jobs/901/trace") => (200, "text/plain", "$ cargo test\nerror: test failed, to rerun pass `--lib`\n".into(), Vec::new()),
            ("GET", "/api/v4/projects/groupe%2Fsous%2Foutil/issues?state=opened&order_by=updated_at&per_page=50") => json_ok(json!([
                {"iid": 9, "title": "Pipelines", "author": {"username": "leo"}, "description": "Voir les jobs", "labels": ["ci"],
                 "web_url": "https://gitlab.exemple.fr/groupe/sous/outil/-/issues/9", "updated_at": "2026-11-07T09:00:00Z", "user_notes_count": 1}])),
            ("POST", "/api/v4/projects/groupe%2Fsous%2Foutil/merge_requests") => json_ok(json!({"iid": 6, "web_url": "https://gitlab.exemple.fr/groupe/sous/outil/-/merge_requests/6"})),
            _ => (404, "application/json", json!({"message": "404 Not Found"}).to_string(), Vec::new()),
        }
    })
}

#[tokio::test]
async fn gitlab_liste_detail_journal_issues_et_creation() {
    let serveur = servir(route_gitlab());
    let d = DepotForge {
        genre: "gitlab".into(),
        hote: "127.0.0.1".into(),
        proprietaire: "groupe/sous".into(),
        nom: "outil".into(),
        url_web: format!("{}/groupe/sous/outil", serveur.base),
        url_api: format!("{}/api/v4", serveur.base),
        remote: "origin".into(),
    };
    let c = ClientForge::nouveau(&d.url_api, Some("glpat-test".into()), false).unwrap().gitlab();

    let prs = api::prs(&c, &d, false).await.unwrap();
    assert_eq!((prs.len(), prs[0].numero, prs[0].brouillon), (1, 5, true));
    assert_eq!((prs[0].branche.as_str(), prs[0].base.as_str(), prs[0].auteur.as_str()), ("pipelines", "main", "nora"));

    let detail = api::detail(&c, &d, 5).await.unwrap();
    assert_eq!(detail.description, "Liste des jobs.");
    let checks: Vec<(&str, &str)> = detail.checks.iter().map(|k| (k.nom.as_str(), k.etat.as_str())).collect();
    assert_eq!(checks, vec![("test / tests", "echec"), ("test / lint", "succes")]);
    assert_eq!(detail.revues.len(), 1);
    assert_eq!(detail.revues[0].etat, "approuvee");
    assert_eq!(detail.commentaires.len(), 2, "notes système écartées");
    assert_eq!((detail.commentaires[0].fichier.as_deref(), detail.commentaires[0].ligne), (Some("src/c.rs"), Some(12)));

    let journal = api::journal(&c, &d, &detail.checks[0].id, None).await.unwrap().unwrap_or_default();
    assert!(journal.contains("error: test failed"));
    let issues = api::issues(&c, &d).await.unwrap();
    assert_eq!((issues[0].numero, issues[0].etiquettes.clone()), (9, vec!["ci".to_string()]));

    let creee = api::creer_pr(&c, &d, "Nouvelle MR", "", "fonction", "main", true).await.unwrap();
    assert_eq!(creee.numero, 6);
    let requetes = serveur.requetes.lock().unwrap().clone();
    let post = requetes.iter().find(|r| r.methode == "POST").unwrap();
    let corps: Value = serde_json::from_str(&post.corps).unwrap();
    assert_eq!(corps["title"], json!("Draft: Nouvelle MR"));
    assert_eq!(corps["source_branch"], json!("fonction"));
    assert!(requetes.iter().all(|r| r.autorisation.is_none()), "GitLab : jeton dans PRIVATE-TOKEN, pas Authorization");
    assert!(requetes.iter().all(|r| r.jeton_prive.as_deref() == Some("glpat-test")));
}
