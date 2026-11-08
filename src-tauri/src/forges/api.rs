//! Lecture et création sur la forge : PR (liste, détail avec checks, revues et
//! commentaires), fin du journal d'un check, issues, nouvelle PR. GitHub (REST) et
//! Forgejo / Gitea (/api/v1) ont des réponses proches : seules les différences sont
//! traitées à part (checks = check runs + statuts chez GitHub, statuts chez Forgejo).

use super::detection::DepotForge;
use super::http::ClientForge;
use super::modele::*;
use crate::*;

fn github(d: &DepotForge) -> bool {
    d.genre == "github"
}

fn brouillon_titre(titre: &str) -> bool {
    let t = titre.trim_start().to_ascii_lowercase();
    t.starts_with("wip:") || t.starts_with("[wip]")
}

pub(crate) fn pr_resume(v: &Value) -> PrResume {
    let fusionnee = v.get("merged_at").and_then(Value::as_str).is_some()
        || v.get("merged").and_then(Value::as_bool) == Some(true);
    let etat = if fusionnee {
        "fusionnée"
    } else if texte(v, "state") == "closed" {
        "fermée"
    } else {
        "ouverte"
    };
    let titre = texte(v, "title");
    PrResume {
        numero: nombre(v, "number"),
        brouillon: v.get("draft").and_then(Value::as_bool).unwrap_or(false) || brouillon_titre(&titre),
        titre,
        auteur: connexion(v),
        etat: etat.into(),
        branche: v.pointer("/head/ref").and_then(Value::as_str).unwrap_or("").into(),
        base: v.pointer("/base/ref").and_then(Value::as_str).unwrap_or("").into(),
        url: texte(v, "html_url"),
        maj: texte(v, "updated_at"),
    }
}

pub(crate) fn issue(v: &Value) -> Issue {
    Issue {
        numero: nombre(v, "number"),
        titre: texte(v, "title"),
        auteur: connexion(v),
        corps: texte(v, "body"),
        etiquettes: liste(v.get("labels").unwrap_or(&Value::Null))
            .iter()
            .filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_string))
            .collect(),
        url: texte(v, "html_url"),
        maj: texte(v, "updated_at"),
        commentaires: nombre(v, "comments"),
    }
}

pub(crate) async fn prs(c: &ClientForge, d: &DepotForge, toutes: bool) -> std::result::Result<Vec<PrResume>, String> {
    let etat = if toutes { "all" } else { "open" };
    let chemin = if github(d) {
        format!("/repos/{}/pulls?state={etat}&per_page=50&sort=updated&direction=desc", d.chemin())
    } else {
        format!("/repos/{}/pulls?state={etat}&sort=recentupdate&limit=50", d.chemin())
    };
    Ok(liste(&c.get_json(&chemin).await?).iter().map(pr_resume).collect())
}

pub(crate) async fn issues(c: &ClientForge, d: &DepotForge) -> std::result::Result<Vec<Issue>, String> {
    let chemin = if github(d) {
        format!("/repos/{}/issues?state=open&per_page=50&sort=updated", d.chemin())
    } else {
        format!("/repos/{}/issues?state=open&type=issues&limit=50", d.chemin())
    };
    Ok(liste(&c.get_json(&chemin).await?)
        .iter()
        // GitHub liste aussi les PR parmi les issues.
        .filter(|v| v.get("pull_request").map_or(true, Value::is_null))
        .map(issue)
        .collect())
}

fn etat_statut(etat: &str) -> &'static str {
    match etat {
        "success" => "succes",
        "pending" => "en_cours",
        "warning" => "ignore",
        _ => "echec",
    }
}

fn check_run(v: &Value) -> Check {
    let etat = if texte(v, "status") != "completed" {
        "en_cours"
    } else {
        match texte(v, "conclusion").as_str() {
            "success" => "succes",
            "neutral" | "skipped" => "ignore",
            "" => "en_cours",
            _ => "echec",
        }
    };
    let actions = v.pointer("/app/slug").and_then(Value::as_str) == Some("github-actions");
    Check {
        id: identifiant(v),
        nom: texte(v, "name"),
        etat: etat.into(),
        detail: v.pointer("/output/title").and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty()),
        url: texte_opt(v, "html_url").or_else(|| texte_opt(v, "details_url")),
        journal: actions,
    }
}

fn statut(v: &Value, forgejo: bool) -> Check {
    let url = texte_opt(v, "target_url");
    // Forgejo / Gitea : « status » ; GitHub : « state ».
    let etat = texte_opt(v, "status").or_else(|| texte_opt(v, "state")).unwrap_or_default();
    Check {
        id: format!("statut:{}", identifiant(v)),
        nom: texte(v, "context"),
        etat: etat_statut(&etat).into(),
        detail: texte_opt(v, "description"),
        journal: forgejo && url.as_deref().is_some_and(|u| u.contains("/actions/runs/")),
        url,
    }
}

fn etat_revue(etat: &str) -> &'static str {
    match etat {
        "APPROVED" => "approuvee",
        "CHANGES_REQUESTED" | "REQUEST_CHANGES" => "changements",
        "DISMISSED" => "rejetee",
        "PENDING" | "REQUEST_REVIEW" => "attente",
        _ => "commentaire",
    }
}

fn commentaire(v: &Value, fichier: bool) -> Commentaire {
    let ligne = ["line", "original_line", "position", "original_position"]
        .iter()
        .filter_map(|cle| v.get(*cle).and_then(Value::as_u64))
        .find(|n| *n > 0);
    Commentaire {
        id: identifiant(v),
        auteur: connexion(v),
        corps: texte(v, "body"),
        fichier: if fichier { texte_opt(v, "path") } else { None },
        ligne: if fichier { ligne } else { None },
        date: texte(v, "created_at"),
        url: texte_opt(v, "html_url"),
    }
}

pub(crate) async fn detail(c: &ClientForge, d: &DepotForge, numero: u64) -> std::result::Result<PrDetail, String> {
    let chemin = d.chemin();
    let pr = c.get_json(&format!("/repos/{chemin}/pulls/{numero}")).await?;
    let sha = pr.pointer("/head/sha").and_then(Value::as_str).unwrap_or("").to_string();
    let resume = pr_resume(&pr);
    let description = texte(&pr, "body");
    let vide = || async { Ok::<Value, String>(Value::Null) };
    let u_runs = format!("/repos/{chemin}/commits/{sha}/check-runs?per_page=100");
    let u_statut = format!("/repos/{chemin}/commits/{sha}/status");
    let (u_revues, u_lignes, u_com) = if github(d) {
        (
            format!("/repos/{chemin}/pulls/{numero}/reviews?per_page=100"),
            format!("/repos/{chemin}/pulls/{numero}/comments?per_page=100"),
            format!("/repos/{chemin}/issues/{numero}/comments?per_page=100"),
        )
    } else {
        (
            format!("/repos/{chemin}/pulls/{numero}/reviews"),
            String::new(),
            format!("/repos/{chemin}/issues/{numero}/comments"),
        )
    };
    let sans_sha = sha.is_empty();
    let (runs, statuts, revues, commentaires_ligne, commentaires) = if github(d) {
        tokio::join!(
            async { if sans_sha { Ok(Value::Null) } else { c.get_json(&u_runs).await } },
            async { if sans_sha { Ok(Value::Null) } else { c.get_json(&u_statut).await } },
            c.get_json(&u_revues),
            c.get_json(&u_lignes),
            c.get_json(&u_com),
        )
    } else {
        tokio::join!(
            vide(),
            async { if sans_sha { Ok(Value::Null) } else { c.get_json(&u_statut).await } },
            c.get_json(&u_revues),
            vide(),
            c.get_json(&u_com),
        )
    };
    let mut checks: Vec<Check> = Vec::new();
    if let Ok(runs) = &runs {
        checks.extend(liste(runs.get("check_runs").unwrap_or(&Value::Null)).iter().map(check_run));
    }
    if let Ok(s) = &statuts {
        checks.extend(liste(s.get("statuses").unwrap_or(&Value::Null)).iter().map(|v| statut(v, !github(d))));
    }
    // Les checks en échec d'abord, puis en cours, puis le reste.
    let rang = |e: &str| match e { "echec" => 0, "en_cours" => 1, "succes" => 2, _ => 3 };
    checks.sort_by(|a, b| rang(&a.etat).cmp(&rang(&b.etat)).then_with(|| a.nom.cmp(&b.nom)));

    let revues_brutes = revues.unwrap_or(Value::Null);
    let revues: Vec<Revue> = liste(&revues_brutes)
        .iter()
        .map(|v| Revue {
            id: identifiant(v),
            auteur: connexion(v),
            etat: etat_revue(&texte(v, "state")).into(),
            corps: texte(v, "body"),
            date: texte(v, "submitted_at"),
        })
        // Revue vide (lot de commentaires de lignes) : ses commentaires suffisent.
        .filter(|r| !(r.etat == "commentaire" && r.corps.trim().is_empty()))
        .collect();

    let mut tous: Vec<Commentaire> = Vec::new();
    if github(d) {
        if let Ok(v) = &commentaires_ligne {
            tous.extend(liste(v).iter().map(|c| commentaire(c, true)));
        }
    } else {
        // Forgejo / Gitea : commentaires de lignes rangés par revue.
        for r in liste(&revues_brutes).iter().filter(|r| nombre(r, "comments_count") > 0) {
            let id = identifiant(r);
            if let Ok(v) = c.get_json(&format!("/repos/{chemin}/pulls/{numero}/reviews/{id}/comments")).await {
                tous.extend(liste(&v).iter().map(|c| commentaire(c, true)));
            }
        }
    }
    if let Ok(v) = &commentaires {
        tous.extend(liste(v).iter().map(|c| commentaire(c, false)));
    }
    tous.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(PrDetail { resume, description, sha, checks, revues, commentaires: tous })
}

/// Fin du journal d'un check (job GitHub Actions ; run Forgejo Actions par son lien).
pub(crate) async fn journal(c: &ClientForge, d: &DepotForge, check: &str, url: Option<&str>) -> std::result::Result<Option<String>, String> {
    if github(d) {
        if !check.chars().all(|ch| ch.is_ascii_digit()) || check.is_empty() {
            return Ok(None);
        }
        return c.get_texte(&format!("/repos/{}/actions/jobs/{check}/logs", d.chemin())).await;
    }
    let Some(url) = url.filter(|u| u.contains("/actions/runs/")) else {
        return Ok(None);
    };
    let url = if url.starts_with("http") {
        url.to_string()
    } else {
        format!("{}{}", d.url_api.trim_end_matches("/api/v1"), url)
    };
    c.get_texte(&format!("{}/logs", url.trim_end_matches('/'))).await
}

pub(crate) async fn creer_pr(
    c: &ClientForge,
    d: &DepotForge,
    titre: &str,
    description: &str,
    tete: &str,
    base: &str,
    brouillon: bool,
) -> std::result::Result<PrCreee, String> {
    let corps = if github(d) {
        json!({ "title": titre, "body": description, "head": tete, "base": base, "draft": brouillon })
    } else {
        // Forgejo / Gitea : le brouillon est un titre qui commence par « WIP: ».
        let titre = if brouillon && !brouillon_titre(titre) { format!("WIP: {titre}") } else { titre.to_string() };
        json!({ "title": titre, "body": description, "head": tete, "base": base })
    };
    let v = c.post_json(&format!("/repos/{}/pulls", d.chemin()), &corps).await?;
    let numero = nombre(&v, "number");
    let url = texte(&v, "html_url");
    Ok(PrCreee {
        numero,
        message: if brouillon { format!("PR brouillon #{numero} créée.") } else { format!("PR #{numero} créée.") },
        url,
    })
}
