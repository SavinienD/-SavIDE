//! GitLab (API REST v4) : merge requests (« PR » dans l'interface), pipelines (checks),
//! approbations, notes (commentaires, dont ceux des lignes du diff), issues, création.
//! Jeton : enregistré dans l'appli (en-tête PRIVATE-TOKEN).

use super::detection::{encoder, DepotForge};
use super::http::ClientForge;
use super::modele::*;
use crate::*;

/// Identifiant du projet dans l'API : chemin complet encodé (groupe/sous-groupe/projet).
fn projet(d: &DepotForge) -> String {
    encoder(&format!("{}/{}", d.proprietaire, d.nom))
}

fn auteur(v: &Value) -> String {
    v.pointer("/author/username").and_then(Value::as_str).unwrap_or("?").to_string()
}

fn brouillon_titre(titre: &str) -> bool {
    let t = titre.trim_start().to_ascii_lowercase();
    t.starts_with("draft:") || t.starts_with("[draft]") || t.starts_with("wip:")
}

pub(crate) fn mr_resume(v: &Value) -> PrResume {
    let titre = texte(v, "title");
    let etat = match texte(v, "state").as_str() {
        "merged" => "fusionnée",
        "closed" | "locked" => "fermée",
        _ => "ouverte",
    };
    PrResume {
        numero: nombre(v, "iid"),
        brouillon: v.get("draft").and_then(Value::as_bool).unwrap_or(false)
            || v.get("work_in_progress").and_then(Value::as_bool).unwrap_or(false)
            || brouillon_titre(&titre),
        titre,
        auteur: auteur(v),
        etat: etat.into(),
        branche: texte(v, "source_branch"),
        base: texte(v, "target_branch"),
        url: texte(v, "web_url"),
        maj: texte(v, "updated_at"),
    }
}

pub(crate) async fn prs(c: &ClientForge, d: &DepotForge, toutes: bool) -> std::result::Result<Vec<PrResume>, String> {
    let etat = if toutes { "all" } else { "opened" };
    let v = c
        .get_json(&format!("/projects/{}/merge_requests?state={etat}&order_by=updated_at&per_page=50", projet(d)))
        .await?;
    Ok(liste(&v).iter().map(mr_resume).collect())
}

pub(crate) async fn issues(c: &ClientForge, d: &DepotForge) -> std::result::Result<Vec<Issue>, String> {
    let v = c
        .get_json(&format!("/projects/{}/issues?state=opened&order_by=updated_at&per_page=50", projet(d)))
        .await?;
    Ok(liste(&v)
        .iter()
        .map(|i| Issue {
            numero: nombre(i, "iid"),
            titre: texte(i, "title"),
            auteur: auteur(i),
            corps: texte(i, "description"),
            etiquettes: liste(i.get("labels").unwrap_or(&Value::Null))
                .iter()
                .filter_map(|l| l.as_str().map(str::to_string).or_else(|| l.get("name").and_then(Value::as_str).map(str::to_string)))
                .collect(),
            url: texte(i, "web_url"),
            maj: texte(i, "updated_at"),
            commentaires: nombre(i, "user_notes_count"),
        })
        .collect())
}

fn etat_job(statut: &str) -> &'static str {
    match statut {
        "success" => "succes",
        "failed" => "echec",
        "canceled" | "skipped" | "manual" => "ignore",
        _ => "en_cours",
    }
}

pub(crate) async fn detail(c: &ClientForge, d: &DepotForge, numero: u64) -> std::result::Result<PrDetail, String> {
    let p = projet(d);
    let mr = c.get_json(&format!("/projects/{p}/merge_requests/{numero}")).await?;
    let resume = mr_resume(&mr);
    let sha = texte(&mr, "sha");
    let pipeline = mr.pointer("/head_pipeline/id").and_then(Value::as_u64);
    let u_jobs = pipeline.map(|id| format!("/projects/{p}/pipelines/{id}/jobs?per_page=100"));
    let u_notes = format!("/projects/{p}/merge_requests/{numero}/notes?sort=asc&per_page=100");
    let u_approbations = format!("/projects/{p}/merge_requests/{numero}/approvals");
    let (jobs, notes, approbations) = tokio::join!(
        async {
            match &u_jobs {
                Some(u) => c.get_json(u).await,
                None => Ok(Value::Null),
            }
        },
        c.get_json(&u_notes),
        c.get_json(&u_approbations),
    );
    let mut checks: Vec<Check> = liste(&jobs.unwrap_or(Value::Null))
        .iter()
        .map(|j| Check {
            id: identifiant(j),
            nom: format!("{} / {}", texte(j, "stage"), texte(j, "name")).trim_start_matches(" / ").to_string(),
            etat: etat_job(&texte(j, "status")).into(),
            detail: texte_opt(j, "failure_reason"),
            url: texte_opt(j, "web_url"),
            journal: true,
        })
        .collect();
    let rang = |e: &str| match e { "echec" => 0, "en_cours" => 1, "succes" => 2, _ => 3 };
    checks.sort_by(|a, b| rang(&a.etat).cmp(&rang(&b.etat)).then_with(|| a.nom.cmp(&b.nom)));

    let revues: Vec<Revue> = approbations
        .ok()
        .map(|a| {
            liste(a.get("approved_by").unwrap_or(&Value::Null))
                .iter()
                .map(|x| Revue {
                    id: format!("approbation:{}", x.pointer("/user/id").map(Value::to_string).unwrap_or_default()),
                    auteur: x.pointer("/user/username").and_then(Value::as_str).unwrap_or("?").to_string(),
                    etat: "approuvee".into(),
                    corps: String::new(),
                    date: String::new(),
                })
                .collect()
        })
        .unwrap_or_default();

    let commentaires: Vec<Commentaire> = liste(&notes.unwrap_or(Value::Null))
        .iter()
        // Notes « système » (commits poussés, changements de statut) : pas des commentaires.
        .filter(|n| !n.get("system").and_then(Value::as_bool).unwrap_or(false))
        .map(|n| {
            let fichier = n
                .pointer("/position/new_path")
                .or_else(|| n.pointer("/position/old_path"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let ligne = n
                .pointer("/position/new_line")
                .and_then(Value::as_u64)
                .or_else(|| n.pointer("/position/old_line").and_then(Value::as_u64));
            Commentaire {
                id: identifiant(n),
                auteur: auteur(n),
                corps: texte(n, "body"),
                fichier,
                ligne,
                date: texte(n, "created_at"),
                url: Some(format!("{}#note_{}", resume.url, identifiant(n))).filter(|_| !resume.url.is_empty()),
            }
        })
        .collect();
    Ok(PrDetail { description: texte(&mr, "description"), resume, sha, checks, revues, commentaires })
}

pub(crate) async fn journal(c: &ClientForge, d: &DepotForge, job: &str) -> std::result::Result<Option<String>, String> {
    if job.is_empty() || !job.chars().all(|ch| ch.is_ascii_digit()) {
        return Ok(None);
    }
    c.get_texte(&format!("/projects/{}/jobs/{job}/trace", projet(d))).await
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
    let titre = if brouillon && !brouillon_titre(titre) { format!("Draft: {titre}") } else { titre.to_string() };
    let corps = json!({ "source_branch": tete, "target_branch": base, "title": titre, "description": description });
    let v = c.post_json(&format!("/projects/{}/merge_requests", projet(d)), &corps).await?;
    let numero = nombre(&v, "iid");
    Ok(PrCreee {
        numero,
        url: texte(&v, "web_url"),
        message: if brouillon { format!("Merge request brouillon !{numero} créée.") } else { format!("Merge request !{numero} créée.") },
    })
}
