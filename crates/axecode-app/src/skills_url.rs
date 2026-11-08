//! installer un skill depuis une adresse : dépôt git (GitHub,
//! GitLab, `.git`, `…/tree/<branche>/<dossier>`) ou archive `.zip`.
//!
//! 1. `apercu` télécharge dans un dossier temporaire (jeton), trouve les
//!    `SKILL.md` et dit pour chacun s'il est nouveau, installé ou à mettre à jour.
//! 2. `installer` copie les skills choisis dans le harnais (ou remplace ceux
//!    déjà installés depuis la même adresse), avec la source et la version notées.
//! Le contenu n'est jamais exécuté ici : l'utilisateur le lit avant d'installer.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use axecode_harness::skills_externes::{self, Origine, SourceSkill};
use axecode_harness::{Entry, EntryKind, HarnessStore, Scope};
use serde::{Deserialize, Serialize};

/// Archive téléchargée au plus.
pub const MAX_ARCHIVE: u64 = 20 * 1024 * 1024;
/// Contenu décompressé au plus.
pub const MAX_DECOMPRESSE: u64 = 50 * 1024 * 1024;
/// Entrées d'archive au plus.
pub const MAX_ENTREES: usize = 2_000;
/// Délai d'un téléchargement ou d'un clonage.
const DELAI: Duration = Duration::from_secs(120);
/// Un aperçu non installé est effacé au bout de ce temps.
const VIE_APERCU_MS: i64 = 60 * 60 * 1000;

/// Ce que désigne une adresse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cible {
    /// Dépôt git, branche ou étiquette éventuelle, sous-dossier éventuel.
    Git { depot: String, reference: Option<String>, sous_dossier: Option<String> },
    /// Archive .zip à télécharger.
    Zip { url: String },
}

/// Un skill trouvé dans le téléchargement.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApercuSkill {
    /// Dossier du skill dans le dépôt ou l'archive (`""` : la racine).
    pub sous_dossier: String,
    pub nom: String,
    pub nom_source: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub fichiers: Vec<String>,
    pub octets: u64,
    /// Début du SKILL.md (à lire avant d'installer).
    pub extrait: String,
    /// `nouveau`, `installe`, `mise_a_jour` ou `conflit`.
    pub etat: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_harnais: Option<String>,
    /// Version installée (pour une mise à jour).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_installee: Option<String>,
}

/// Résultat d'un téléchargement, avant installation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Apercu {
    pub jeton: String,
    pub url: String,
    /// `git` ou `zip`.
    pub genre: String,
    /// Commit (git) ou empreinte de l'archive (zip).
    pub version: String,
    pub skills: Vec<ApercuSkill>,
}

/// Skill du harnais installé depuis une adresse.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstalle {
    pub id: String,
    pub scope: Scope,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sous_dossier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub importe_le: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetaApercu {
    url: String,
    genre: String,
    version: String,
    cree_le: i64,
}

/// Dossier des téléchargements en attente d'installation.
pub fn dossier_cache() -> PathBuf {
    axecode_harness::app_data_dir().join("interop-telechargements")
}

/// Lit une adresse de skill.
pub fn analyser_url(url: &str) -> Result<Cible> {
    let url = url.trim();
    if url.is_empty() {
        bail!("adresse vide");
    }
    let (schema, reste) = url.split_once("://").ok_or_else(|| anyhow!("adresse sans https:// : {url}"))?;
    let schema = schema.to_ascii_lowercase();
    if !matches!(schema.as_str(), "https" | "http" | "file") {
        bail!("adresse non prise en charge ({schema}://) : https:// seulement");
    }
    let chemin = reste.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    if chemin.to_ascii_lowercase().ends_with(".zip") {
        return Ok(Cible::Zip { url: url.to_string() });
    }
    if schema == "file" || chemin.ends_with(".git") {
        return Ok(Cible::Git { depot: format!("{schema}://{chemin}"), reference: None, sous_dossier: None });
    }
    let morceaux: Vec<&str> = chemin.split('/').filter(|m| !m.is_empty()).collect();
    let hote = morceaux.first().map(|h| h.to_ascii_lowercase()).unwrap_or_default();
    if matches!(hote.as_str(), "github.com" | "gitlab.com" | "codeberg.org" | "bitbucket.org") && morceaux.len() >= 3 {
        let depot = format!("https://{}/{}/{}.git", hote, morceaux[1], morceaux[2].trim_end_matches(".git"));
        // github.com/o/r/tree/<branche>/<dossier>, gitlab.com/o/r/-/tree/<branche>/<dossier>
        let suite: Vec<&str> = morceaux[3..].iter().copied().skip_while(|m| *m == "-").collect();
        let (reference, sous_dossier) = match suite.as_slice() {
            ["tree" | "blob", reference, dossier @ ..] => {
                let dossier = dossier.join("/");
                let dossier = dossier.strip_suffix("/SKILL.md").or(dossier.strip_suffix("SKILL.md")).unwrap_or(&dossier).to_string();
                (Some(reference.to_string()), Some(dossier).filter(|d| !d.is_empty()))
            }
            [] => (None, None),
            _ => bail!("adresse de dépôt non reconnue : {url}"),
        };
        return Ok(Cible::Git { depot, reference, sous_dossier });
    }
    bail!("adresse non reconnue : un dépôt git (GitHub, GitLab, .git) ou une archive .zip")
}

fn maintenant_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Efface les aperçus abandonnés.
fn nettoyer(cache: &Path) {
    let Ok(lecture) = std::fs::read_dir(cache) else { return };
    for item in lecture.flatten() {
        let meta: Option<MetaApercu> = std::fs::read_to_string(item.path().join("meta.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
        if meta.is_none_or(|m| maintenant_ms() - m.cree_le > VIE_APERCU_MS) {
            let _ = std::fs::remove_dir_all(item.path());
        }
    }
}

fn commande_git() -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new("git");
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c.env("GIT_TERMINAL_PROMPT", "0").stdin(std::process::Stdio::null()).kill_on_drop(true);
    c
}

async fn git(args: &[&str], dossier: Option<&Path>) -> Result<String> {
    let mut c = commande_git();
    c.args(args);
    if let Some(d) = dossier {
        c.current_dir(d);
    }
    let sortie = tokio::time::timeout(DELAI, c.output())
        .await
        .map_err(|_| anyhow!("git : pas de réponse en {} s", DELAI.as_secs()))?
        .map_err(|e| anyhow!("git introuvable ({e}) : installez Git ou utilisez une archive .zip"))?;
    if !sortie.status.success() {
        let err = String::from_utf8_lossy(&sortie.stderr);
        bail!("git {} : {}", args.first().copied().unwrap_or(""), err.trim().lines().last().unwrap_or("échec"));
    }
    Ok(String::from_utf8_lossy(&sortie.stdout).trim().to_string())
}

async fn telecharger(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder().timeout(DELAI).user_agent("skills-installer").build()?;
    let mut rep = client.get(url).send().await.with_context(|| format!("téléchargement de {url}"))?;
    if !rep.status().is_success() {
        bail!("téléchargement refusé : HTTP {}", rep.status().as_u16());
    }
    if rep.content_length().is_some_and(|n| n > MAX_ARCHIVE) {
        bail!("archive trop grosse : {} Mo au plus", MAX_ARCHIVE / 1024 / 1024);
    }
    let mut octets = Vec::new();
    while let Some(morceau) = rep.chunk().await? {
        octets.extend_from_slice(&morceau);
        if octets.len() as u64 > MAX_ARCHIVE {
            bail!("archive trop grosse : {} Mo au plus", MAX_ARCHIVE / 1024 / 1024);
        }
    }
    Ok(octets)
}

/// Décompresse en refusant les chemins qui sortent du dossier.
fn decompresser(octets: &[u8], cible: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(octets)).context("archive .zip illisible")?;
    if archive.len() > MAX_ENTREES {
        bail!("archive de {} entrées : {MAX_ENTREES} au plus", archive.len());
    }
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let Some(rel) = f.enclosed_name() else { continue };
        let chemin = cible.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&chemin)?;
            continue;
        }
        total += f.size();
        if total > MAX_DECOMPRESSE {
            bail!("archive trop grosse une fois décompressée : {} Mo au plus", MAX_DECOMPRESSE / 1024 / 1024);
        }
        if let Some(parent) = chemin.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut sortie = std::fs::File::create(&chemin)?;
        std::io::copy(&mut f, &mut sortie)?;
    }
    Ok(())
}

/// Dossiers contenant un SKILL.md (profondeur 5 au plus), chemins relatifs avec `/`.
fn trouver_skills(racine: &Path, rel: &str, profondeur: usize, out: &mut Vec<String>) {
    if racine.join("SKILL.md").is_file() {
        out.push(rel.to_string());
        return;
    }
    if profondeur == 0 {
        return;
    }
    let Ok(lecture) = std::fs::read_dir(racine) else { return };
    let mut items: Vec<_> = lecture.flatten().filter(|e| e.path().is_dir()).collect();
    items.sort_by_key(|e| e.file_name());
    for item in items {
        let nom = item.file_name().to_string_lossy().to_string();
        if nom.starts_with('.') || nom == "node_modules" || nom == "__pycache__" {
            continue;
        }
        let sous = if rel.is_empty() { nom } else { format!("{rel}/{nom}") };
        trouver_skills(&item.path(), &sous, profondeur - 1, out);
    }
}

fn origines_url(store: &HarnessStore) -> Vec<(Entry, Origine)> {
    store
        .list(Some(EntryKind::Skill), None)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| skills_externes::origine(&e).filter(|o| o.genre == "url").map(|o| (e, o)))
        .collect()
}

/// Télécharge l'adresse et liste les skills qu'elle contient.
pub async fn apercu(url: &str, cache: &Path, store: &HarnessStore) -> Result<Apercu> {
    let url = url.trim().to_string();
    let cible = analyser_url(&url)?;
    nettoyer(cache);
    let jeton = uuid::Uuid::new_v4().simple().to_string();
    let dossier = cache.join(&jeton);
    let contenu = dossier.join("contenu");
    std::fs::create_dir_all(&dossier)?;
    let resultat = async {
        let (genre, version, base) = match &cible {
            Cible::Zip { url } => {
                let octets = telecharger(url).await?;
                std::fs::create_dir_all(&contenu)?;
                decompresser(&octets, &contenu)?;
                ("zip", skills_externes::empreinte_octets(&octets), contenu.clone())
            }
            Cible::Git { depot, reference, sous_dossier } => {
                let cible_txt = contenu.display().to_string();
                let mut args = vec!["clone", "--depth", "1", "--quiet"];
                if let Some(r) = reference {
                    args.extend(["--branch", r.as_str()]);
                }
                args.extend([depot.as_str(), cible_txt.as_str()]);
                git(&args, None).await?;
                let version = git(&["rev-parse", "--short=12", "HEAD"], Some(&contenu)).await?;
                let base = match sous_dossier {
                    Some(s) => contenu.join(s),
                    None => contenu.clone(),
                };
                if !base.is_dir() {
                    bail!("le dossier {} n'existe pas dans le dépôt", sous_dossier.clone().unwrap_or_default());
                }
                ("git", version, base)
            }
        };
        let mut trouves = Vec::new();
        trouver_skills(&base, "", 5, &mut trouves);
        if trouves.is_empty() {
            bail!("aucun SKILL.md trouvé à cette adresse");
        }
        let prefixe = base.strip_prefix(&contenu).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let installes = origines_url(store);
        let harnais = store.list(Some(EntryKind::Skill), None).unwrap_or_default();
        let mut skills = Vec::new();
        for rel in trouves {
            let sous_dossier = [prefixe.as_str(), rel.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("/");
            let source = skills_externes::lire_source(&contenu.join(&sous_dossier))?;
            let lie = installes.iter().find(|(_, o)| o.url.as_deref() == Some(url.as_str()) && o.sous_dossier.as_deref().unwrap_or("") == sous_dossier);
            let (etat, id_harnais, version_installee) = match lie {
                Some((e, o)) => (
                    if o.empreinte == source.empreinte { "installe" } else { "mise_a_jour" },
                    Some(e.meta.id.clone()),
                    o.version.clone(),
                ),
                None => match harnais.iter().find(|e| e.meta.title == source.nom || e.meta.id == source.nom) {
                    Some(e) => ("conflit", Some(e.meta.id.clone()), None),
                    None => ("nouveau", None, None),
                },
            };
            let skill_md = std::fs::read_to_string(source.dossier.join("SKILL.md")).unwrap_or_default();
            let mut fichiers = vec!["SKILL.md".to_string()];
            fichiers.extend(source.fichiers.iter().map(|(r, _)| r.to_string_lossy().replace('\\', "/")));
            skills.push(ApercuSkill {
                sous_dossier,
                nom: source.nom.clone(),
                nom_source: source.nom_source.clone(),
                description: source.description.clone(),
                version: source.version.clone(),
                fichiers,
                octets: source.octets,
                extrait: skill_md.chars().take(6_000).collect(),
                etat: etat.to_string(),
                id_harnais,
                version_installee,
            });
        }
        let meta = MetaApercu { url: url.clone(), genre: genre.to_string(), version: version.clone(), cree_le: maintenant_ms() };
        std::fs::write(dossier.join("meta.json"), serde_json::to_string(&meta)?)?;
        Ok(Apercu { jeton: jeton.clone(), url: url.clone(), genre: genre.to_string(), version, skills })
    }
    .await;
    if resultat.is_err() {
        let _ = std::fs::remove_dir_all(&dossier);
    }
    resultat
}

/// Résultat d'une installation : skills installés ou mis à jour, et erreurs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub skills: Vec<Entry>,
    pub erreurs: Vec<String>,
}

/// Installe (ou met à jour) les skills choisis d'un aperçu.
pub fn installer(jeton: &str, sous_dossiers: &[String], portee: Scope, cache: &Path, store: &HarnessStore) -> Result<Installation> {
    if jeton.is_empty() || !jeton.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("aperçu inconnu");
    }
    let dossier = cache.join(jeton);
    let meta: MetaApercu = std::fs::read_to_string(dossier.join("meta.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| anyhow!("aperçu expiré : téléchargez à nouveau"))?;
    let contenu = dossier.join("contenu");
    let installes = origines_url(store);
    let mut faits = Vec::new();
    let mut erreurs = Vec::new();
    for sous in sous_dossiers {
        if sous.split('/').any(|m| m == "..") || sous.starts_with('/') || sous.contains(['\\', ':']) {
            erreurs.push(format!("{sous} : chemin refusé"));
            continue;
        }
        let resultat = (|| -> Result<Entry> {
            let source: SourceSkill = skills_externes::lire_source(&contenu.join(sous))?;
            let origine = Origine {
                genre: "url".into(),
                outil: "url".into(),
                url: Some(meta.url.clone()),
                sous_dossier: Some(sous.clone()).filter(|s| !s.is_empty()),
                version: Some(meta.version.clone()),
                empreinte: source.empreinte.clone(),
                importe_le: maintenant_ms(),
                ..Default::default()
            };
            match installes.iter().find(|(_, o)| o.url == origine.url && o.sous_dossier == origine.sous_dossier) {
                Some((e, _)) => skills_externes::remplacer_depuis(store, &e.meta.id, &source, &origine),
                None => skills_externes::creer_depuis(store, portee, &source, &origine),
            }
        })();
        match resultat {
            Ok(e) => faits.push(e),
            Err(e) => erreurs.push(format!("{sous} : {e}")),
        }
    }
    let _ = std::fs::remove_dir_all(&dossier);
    if faits.is_empty() && !erreurs.is_empty() {
        bail!("{}", erreurs.join(" ; "));
    }
    Ok(Installation { skills: faits, erreurs })
}

/// Skills du harnais installés depuis une adresse.
pub fn installes(store: &HarnessStore) -> Vec<SkillInstalle> {
    origines_url(store)
        .into_iter()
        .map(|(e, o)| SkillInstalle {
            id: e.meta.id,
            scope: e.meta.scope,
            url: o.url.unwrap_or_default(),
            sous_dossier: o.sous_dossier,
            version: o.version,
            importe_le: o.importe_le,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::faux_http::{lancer, Reponse};
    use axecode_harness::HarnessPaths;
    use std::io::Write as _;

    fn banc(nom: &str) -> (PathBuf, HarnessStore) {
        let base = std::env::temp_dir().join(format!("test-skills-url-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let ws = base.join("projet");
        std::fs::create_dir_all(&ws).unwrap();
        let store = HarnessStore::new(HarnessPaths::with_home(&ws, Some(base.join("home"))));
        (base, store)
    }

    fn zip(fichiers: &[(&str, &str)]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut out);
            let o = zip::write::SimpleFileOptions::default();
            for (nom, contenu) in fichiers {
                z.start_file(*nom, o).unwrap();
                z.write_all(contenu.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        out.into_inner()
    }

    const SKILL_A: &str = "---\nname: pdf-outils\ndescription: Lire et remplir des PDF.\nversion: 1.2\n---\n# PDF\nUtiliser pypdf.";
    const SKILL_B: &str = "---\nname: tableurs\ndescription: >-\n  Ouvrir des classeurs\n  et les résumer.\n---\nCorps B.";

    #[test]
    fn adresses_github_gitlab_git_et_zip() {
        assert_eq!(
            analyser_url("https://github.com/anthropics/skills").unwrap(),
            Cible::Git { depot: "https://github.com/anthropics/skills.git".into(), reference: None, sous_dossier: None }
        );
        assert_eq!(
            analyser_url(" https://github.com/anthropics/skills/tree/main/document-skills/pdf/ ").unwrap(),
            Cible::Git {
                depot: "https://github.com/anthropics/skills.git".into(),
                reference: Some("main".into()),
                sous_dossier: Some("document-skills/pdf".into())
            }
        );
        assert_eq!(
            analyser_url("https://gitlab.com/groupe/projet.git").unwrap(),
            Cible::Git { depot: "https://gitlab.com/groupe/projet.git".into(), reference: None, sous_dossier: None }
        );
        assert_eq!(
            analyser_url("https://exemple.fr/skills/revue.zip?x=1").unwrap(),
            Cible::Zip { url: "https://exemple.fr/skills/revue.zip?x=1".into() }
        );
        assert!(analyser_url("ftp://exemple.fr/x.zip").is_err());
        assert!(analyser_url("https://exemple.fr/page.html").is_err());
        assert!(analyser_url("").is_err());
    }

    #[tokio::test]
    async fn zip_apercu_installation_puis_mise_a_jour() {
        let (base, store) = banc("zip");
        let version = std::sync::Arc::new(std::sync::Mutex::new(1));
        let v = version.clone();
        let serveur = lancer(move |_, _| {
            let corps_b = if *v.lock().unwrap() == 1 { SKILL_B.to_string() } else { SKILL_B.replace("Corps B.", "Corps B, version 2.") };
            Reponse::bytes(
                "application/zip",
                &zip(&[("depot-main/skills/a/SKILL.md", SKILL_A), ("depot-main/skills/a/aide.md", "Aide."), ("depot-main/skills/b/SKILL.md", &corps_b), ("depot-main/README.md", "x")]),
            )
        })
        .await;
        let url = format!("{}/skills.zip", serveur.base);
        let cache = base.join("cache");
        let ap = apercu(&url, &cache, &store).await.unwrap();
        assert_eq!(ap.genre, "zip");
        assert_eq!(ap.version.len(), 12);
        let noms: Vec<&str> = ap.skills.iter().map(|s| s.nom.as_str()).collect();
        assert_eq!(noms, vec!["pdf_outils", "tableurs"]);
        let a = &ap.skills[0];
        assert_eq!((a.sous_dossier.as_str(), a.version.as_deref(), a.etat.as_str()), ("depot-main/skills/a", Some("1.2"), "nouveau"));
        assert_eq!(a.fichiers, vec!["SKILL.md".to_string(), "aide.md".to_string()]);
        assert!(a.extrait.contains("Utiliser pypdf."));
        assert_eq!(ap.skills[1].description, "Ouvrir des classeurs et les résumer.");

        let faits = installer(&ap.jeton, &["depot-main/skills/b".to_string()], Scope::Global, &cache, &store).unwrap();
        assert_eq!((faits.skills.len(), faits.erreurs.len()), (1, 0));
        assert!(!cache.join(&ap.jeton).exists(), "téléchargement effacé après l'installation");
        let b = store.get_kind(EntryKind::Skill, "tableurs").unwrap().unwrap();
        assert!(b.body.starts_with("Ouvrir des classeurs et les résumer.") && b.body.contains("Corps B."));
        let o = skills_externes::origine(&b).unwrap();
        assert_eq!((o.genre.as_str(), o.url.as_deref(), o.sous_dossier.as_deref()), ("url", Some(url.as_str()), Some("depot-main/skills/b")));
        assert_eq!(o.version.as_deref(), Some(ap.version.as_str()));
        let liste = installes(&store);
        assert_eq!((liste.len(), liste[0].id.as_str()), (1, "tableurs"));

        let ap2 = apercu(&url, &cache, &store).await.unwrap();
        assert_eq!(ap2.skills[1].etat, "installe");
        assert_eq!(ap2.skills[0].etat, "nouveau");
        *version.lock().unwrap() = 2;
        let ap3 = apercu(&url, &cache, &store).await.unwrap();
        assert_eq!(ap3.skills[1].etat, "mise_a_jour");
        assert_eq!(ap3.skills[1].version_installee.as_deref(), Some(ap.version.as_str()));
        installer(&ap3.jeton, &["depot-main/skills/b".to_string()], Scope::Global, &cache, &store).unwrap();
        let b = store.get_kind(EntryKind::Skill, "tableurs").unwrap().unwrap();
        assert!(b.body.contains("Corps B, version 2."), "{}", b.body);
        assert_eq!(skills_externes::origine(&b).unwrap().version.as_deref(), Some(ap3.version.as_str()));
        store.delete("tableurs").unwrap();
        assert!(installes(&store).is_empty(), "désinstallé");
    }

    #[tokio::test]
    async fn zip_dangereux_ou_sans_skill_refuse() {
        let (base, store) = banc("zipmal");
        let serveur = lancer(|req, _| {
            if req.path.contains("evasion") {
                Reponse::bytes("application/zip", &zip(&[("../../evasion/SKILL.md", SKILL_A)]))
            } else if req.path.contains("vide") {
                Reponse::bytes("application/zip", &zip(&[("README.md", "rien")]))
            } else {
                Reponse::status(404, "introuvable")
            }
        })
        .await;
        let cache = base.join("cache");
        let e = apercu(&format!("{}/evasion.zip", serveur.base), &cache, &store).await.unwrap_err().to_string();
        assert!(e.contains("SKILL.md"), "entrée hors du dossier ignorée, donc aucun skill : {e}");
        assert!(!base.join("evasion").exists());
        let e = apercu(&format!("{}/vide.zip", serveur.base), &cache, &store).await.unwrap_err().to_string();
        assert!(e.contains("SKILL.md"), "{e}");
        let e = apercu(&format!("{}/absent.zip", serveur.base), &cache, &store).await.unwrap_err().to_string();
        assert!(e.contains("404"), "{e}");
    }

    #[tokio::test]
    async fn depot_git_local_version_du_commit() {
        let (base, store) = banc("git");
        let depot = base.join("depot");
        std::fs::create_dir_all(depot.join("revue")).unwrap();
        std::fs::write(depot.join("revue/SKILL.md"), "---\nname: revue\ndescription: Relire.\n---\nV1").unwrap();
        let git = |args: &[&str]| {
            let s = std::process::Command::new("git").args(args).current_dir(&depot).output().unwrap();
            assert!(s.status.success(), "{}", String::from_utf8_lossy(&s.stderr));
        };
        git(&["init", "-q"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1"]);
        let url = format!("file://{}", depot.display());
        let cache = base.join("cache");
        let ap = apercu(&url, &cache, &store).await.unwrap();
        assert_eq!((ap.genre.as_str(), ap.skills.len(), ap.skills[0].sous_dossier.as_str()), ("git", 1, "revue"));
        assert_eq!(ap.version.len(), 12, "commit court");
        installer(&ap.jeton, &["revue".to_string()], Scope::Project, &cache, &store).unwrap();
        let e = store.get_kind(EntryKind::Skill, "revue").unwrap().unwrap();
        assert_eq!(e.meta.scope, Scope::Project);
        std::fs::write(depot.join("revue/SKILL.md"), "---\nname: revue\ndescription: Relire.\n---\nV2").unwrap();
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "v2"]);
        let ap2 = apercu(&url, &cache, &store).await.unwrap();
        assert_eq!(ap2.skills[0].etat, "mise_a_jour");
        assert_ne!(ap2.version, ap.version);
        assert!(installer("jeton-inconnu", &["revue".to_string()], Scope::Global, &cache, &store).is_err());
    }
}
