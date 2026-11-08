//! Commandes Tauri des forges (onglets PR et Issues du panneau Git).

use super::api;
use super::detection::{detecter, DepotForge};
use super::http::ClientForge;
use super::jetons;
use super::masque::masquer;
use super::modele::*;
use crate::git::{branch_upstream, current_branch, etat_depot, pousser, require_repo_root};
use crate::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForgeEtat {
    pub(crate) depot: Option<DepotForge>,
    /// Un jeton sera utilisé (enregistré dans l'appli, ou celui de gh pour GitHub).
    pub(crate) jeton: bool,
    pub(crate) jeton_enregistre: bool,
    pub(crate) gh: bool,
    /// Forge non prise en charge, ou pas de remote : pourquoi.
    pub(crate) message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JetonInput {
    pub(crate) hote: String,
    #[serde(default)]
    pub(crate) jeton: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListeInput {
    pub(crate) workspace_path: String,
    #[serde(default)]
    pub(crate) toutes: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrInput {
    pub(crate) workspace_path: String,
    pub(crate) numero: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalInput {
    pub(crate) workspace_path: String,
    pub(crate) check: String,
    #[serde(default)]
    pub(crate) url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreerPrInput {
    pub(crate) workspace_path: String,
    pub(crate) titre: String,
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) base: String,
    #[serde(default)]
    pub(crate) brouillon: bool,
}

fn depot_git(workspace_path: &str) -> std::result::Result<PathBuf, String> {
    let racine = normalize_workspace_root(workspace_path).map_err(error_to_string)?;
    require_repo_root(&racine).map_err(error_to_string)
}

fn non_pris_en_charge(d: &DepotForge) -> Option<String> {
    match d.genre.as_str() {
        "github" | "gitea" | "gitlab" => None,
        _ => Some(format!("{} n'est pas pris en charge : seulement GitHub, GitLab et Forgejo / Gitea.", d.hote)),
    }
}

async fn jeton_de(d: &DepotForge) -> Option<String> {
    let (genre, hote) = (d.genre.clone(), d.hote.clone());
    tokio::task::spawn_blocking(move || jetons::jeton_pour(&genre, &hote))
        .await
        .ok()
        .flatten()
}

async fn client(workspace_path: &str) -> std::result::Result<(DepotForge, ClientForge, PathBuf), String> {
    let repo = depot_git(workspace_path)?;
    let d = detecter(&repo)
        .map_err(error_to_string)?
        .ok_or_else(|| "Aucun dépôt distant reconnu : ajoutez un remote (git remote add origin <adresse>).".to_string())?;
    if let Some(message) = non_pris_en_charge(&d) {
        return Err(message);
    }
    let jeton = jeton_de(&d).await;
    let mut c = ClientForge::nouveau(&d.url_api, jeton, d.genre == "github")?;
    if d.genre == "gitlab" {
        c = c.gitlab();
    }
    Ok((d, c, repo))
}

#[tauri::command]
pub(crate) async fn forge_etat(input: WorkspaceInput) -> std::result::Result<ForgeEtat, String> {
    let repo = depot_git(&input.workspace_path)?;
    let depot = detecter(&repo).map_err(error_to_string)?;
    let gh = crate::git::resolve_executable("gh").is_some();
    let Some(d) = depot else {
        return Ok(ForgeEtat {
            depot: None,
            jeton: false,
            jeton_enregistre: false,
            gh,
            message: Some("Aucun dépôt distant reconnu : ajoutez un remote (git remote add origin <adresse>).".into()),
        });
    };
    let message = non_pris_en_charge(&d);
    let jeton_enregistre = jetons::jeton_enregistre(&d.hote).is_some();
    let jeton = jeton_enregistre || (message.is_none() && jeton_de(&d).await.is_some());
    Ok(ForgeEtat { depot: Some(d), jeton, jeton_enregistre, gh, message })
}

#[tauri::command]
pub(crate) async fn forge_jeton(input: JetonInput) -> std::result::Result<(), String> {
    jetons::enregistrer(&input.hote, input.jeton.as_deref())?;
    jetons::oublier_gh();
    Ok(())
}

#[tauri::command]
pub(crate) async fn forge_prs(input: ListeInput) -> std::result::Result<Vec<PrResume>, String> {
    let (d, c, _) = client(&input.workspace_path).await?;
    api::prs(&c, &d, input.toutes).await
}

#[tauri::command]
pub(crate) async fn forge_pr(input: PrInput) -> std::result::Result<PrDetail, String> {
    let (d, c, _) = client(&input.workspace_path).await?;
    api::detail(&c, &d, input.numero).await
}

#[tauri::command]
pub(crate) async fn forge_issues(input: WorkspaceInput) -> std::result::Result<Vec<Issue>, String> {
    let (d, c, _) = client(&input.workspace_path).await?;
    api::issues(&c, &d).await
}

/// Fin du journal (400 lignes), horodatages de GitHub retirés, secrets masqués.
pub(crate) fn fin_journal(brut: &str) -> String {
    let lignes: Vec<&str> = brut.lines().collect();
    let debut = lignes.len().saturating_sub(400);
    let propre = lignes[debut..]
        .iter()
        .map(|l| {
            let horodatage = l.len() > 29
                && l.as_bytes().get(4) == Some(&b'-')
                && l.as_bytes().get(10) == Some(&b'T')
                && l[..29.min(l.len())].contains('Z');
            match (horodatage, l.find("Z ")) {
                (true, Some(i)) if i < 32 => &l[i + 2..],
                _ => l,
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    masquer(&propre).0
}

#[tauri::command]
pub(crate) async fn forge_journal(input: JournalInput) -> std::result::Result<Option<String>, String> {
    let (d, c, _) = client(&input.workspace_path).await?;
    Ok(api::journal(&c, &d, &input.check, input.url.as_deref())
        .await?
        .map(|t| fin_journal(&t)))
}

#[tauri::command]
pub(crate) async fn forge_creer_pr(input: CreerPrInput) -> std::result::Result<PrCreee, String> {
    let titre = input.titre.trim();
    if titre.is_empty() {
        return Err("le titre de la PR ne peut pas être vide".into());
    }
    let (d, c, repo) = client(&input.workspace_path).await?;
    let branche = current_branch(&repo)
        .map_err(error_to_string)?
        .ok_or_else(|| "HEAD détachée : placez-vous sur une branche".to_string())?;
    let base = input.base.trim();
    if base.is_empty() || base == branche {
        return Err("choisissez une branche cible différente de la branche actuelle".into());
    }
    if !c.a_un_jeton() {
        return Err(if d.genre == "github" {
            "Connectez GitHub : « gh auth login » dans un terminal, ou enregistrez un jeton dans l'onglet PR.".into()
        } else {
            format!("Enregistrez un jeton d'accès pour {} dans l'onglet PR.", d.hote)
        });
    }
    // La branche doit être sur la forge : poussée d'abord si besoin.
    let etat = etat_depot(&repo).map_err(error_to_string)?;
    if etat.amont.is_none() || etat.avance > 0 {
        let poussee = pousser(&repo, false).map_err(error_to_string)?;
        if !poussee.ok {
            return Err(format!(
                "{} {}",
                poussee.message,
                poussee.sortie.unwrap_or_default()
            )
            .trim()
            .to_string());
        }
    }
    let tete = branch_upstream(&repo, &branche)
        .map_err(error_to_string)?
        .map(|up| up.branch)
        .unwrap_or(branche);
    api::creer_pr(&c, &d, titre, input.description.trim(), &tete, base, input.brouillon).await
}
