// Éditeur de fichiers :
// - `editeur_fichier_head` : contenu d'un fichier au dernier commit (HEAD), tel qu'il serait
//   extrait sur ce poste (fins de ligne, filtres), pour les marques de changements dans la
//   marge et la comparaison d'images avant / après ;
// - `editeur_image_markdown` : image collée ou déposée dans un .md, enregistrée dans `images/`
//   à côté du fichier ; renvoie le lien relatif à insérer.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

/// Au-delà, le contenu à HEAD n'est pas renvoyé (comparaison impossible, état « trop-gros »).
const MAX_HEAD_OCTETS: u64 = 20 * 1024 * 1024;
/// Image collée ou déposée : taille maximale.
const MAX_IMAGE_OCTETS: u64 = 50 * 1024 * 1024;
/// Une commande git qui dépasse ce délai est arrêtée (filtre bloqué, disque réseau…).
const DELAI_GIT: Duration = Duration::from_secs(10);
const EXTENSIONS_IMAGES: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EditeurCheminInput {
    pub(super) chemin: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct FichierHead {
    /// « suivi » (présent dans HEAD), « nouveau » (absent de HEAD), « hors-depot »,
    /// « trop-gros » ou « sans-git ».
    etat: String,
    /// Le fichier du disque diffère de sa version à HEAD.
    modifie: bool,
    /// Contenu à HEAD en base64 (état « suivi » seulement).
    base64: Option<String>,
    /// Taille à HEAD (octets).
    taille: u64,
}

fn etat(nom: &str) -> FichierHead {
    FichierHead { etat: nom.to_string(), modifie: false, base64: None, taille: 0 }
}

/// Lance git dans `dossier` ; `None` si git ne démarre pas ou dépasse le délai.
fn git_sortie(git: &Path, dossier: &Path, args: &[&str]) -> Option<(bool, Vec<u8>)> {
    let mut commande = crate::__nw_std(git);
    commande
        .arg("-C")
        .arg(dossier)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut enfant = commande.spawn().ok()?;
    let mut sortie = enfant.stdout.take()?;
    let lecteur = std::thread::spawn(move || {
        let mut octets = Vec::new();
        let _ = sortie.read_to_end(&mut octets);
        octets
    });
    let debut = Instant::now();
    let statut = loop {
        match enfant.try_wait() {
            Ok(Some(statut)) => break statut,
            Ok(None) if debut.elapsed() < DELAI_GIT => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = enfant.kill();
                let _ = enfant.wait();
                return None;
            }
        }
    };
    let octets = lecteur.join().ok()?;
    Some((statut.success(), octets))
}

fn fichier_head(git: &Path, chemin: &Path) -> FichierHead {
    let (Some(dossier), Some(nom)) = (chemin.parent(), chemin.file_name().and_then(|n| n.to_str())) else {
        return etat("hors-depot");
    };
    if !dossier.is_dir() {
        return etat("hors-depot");
    }
    let spec = format!("HEAD:./{nom}");
    let taille = match git_sortie(git, dossier, &["cat-file", "-s", &spec]) {
        Some((true, sortie)) => String::from_utf8_lossy(&sortie).trim().parse::<u64>().unwrap_or(0),
        _ => {
            let depot = matches!(
                git_sortie(git, dossier, &["rev-parse", "--is-inside-work-tree"]),
                Some((true, ref s)) if String::from_utf8_lossy(s).trim() == "true"
            );
            return etat(if depot { "nouveau" } else { "hors-depot" });
        }
    };
    let disque = fs::metadata(chemin).ok().filter(|m| m.is_file());
    if taille > MAX_HEAD_OCTETS {
        return FichierHead {
            etat: "trop-gros".into(),
            modifie: disque.map(|m| m.len() != taille).unwrap_or(true),
            base64: None,
            taille,
        };
    }
    // Forme extraite sur ce poste (fins de ligne CRLF, filtres) ; à défaut le contenu brut.
    let contenu = match git_sortie(git, dossier, &["cat-file", "--filters", &spec]) {
        Some((true, octets)) => octets,
        _ => match git_sortie(git, dossier, &["cat-file", "blob", &spec]) {
            Some((true, octets)) => octets,
            _ => return etat("nouveau"),
        },
    };
    let modifie = match disque {
        Some(_) => fs::read(chemin).map(|d| d != contenu).unwrap_or(true),
        None => true,
    };
    FichierHead { etat: "suivi".into(), modifie, base64: Some(B64.encode(&contenu)), taille }
}

/// Contenu à HEAD du fichier `chemin` (absolu, sur ce poste).
#[tauri::command]
pub(super) async fn editeur_fichier_head(input: EditeurCheminInput) -> Result<FichierHead, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(git) = crate::git::resolve_executable("git") else {
            return etat("sans-git");
        };
        fichier_head(&git, Path::new(&input.chemin))
    })
    .await
    .map_err(|err| format!("lecture de la version Git impossible : {err}"))
}

// ------------------------------------------------------------ images du Markdown ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImageMarkdownInput {
    /// Fichier .md ouvert (chemin absolu).
    pub(super) chemin_markdown: String,
    /// Image déposée depuis l'explorateur du système (chemin absolu)…
    #[serde(default)]
    pub(super) source: Option<String>,
    /// … ou image collée, en base64 (préfixe « data:…;base64, » accepté).
    #[serde(default)]
    pub(super) donnees: Option<String>,
    #[serde(default)]
    pub(super) type_media: Option<String>,
    /// Nom voulu (sans dossier) ; sinon le nom du fichier déposé.
    #[serde(default)]
    pub(super) nom: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImageMarkdown {
    /// Lien à insérer, relatif au .md : « images/<nom> ».
    relatif: String,
    absolu: String,
}

/// Nom de fichier sans espace ni ponctuation (lettres accentuées gardées).
fn nom_sur(brut: &str) -> String {
    let mut sortie = String::new();
    let mut tiret = false;
    for c in brut.chars() {
        if c.is_alphanumeric() || c == '_' {
            sortie.push(c);
            tiret = false;
        } else if !sortie.is_empty() && !tiret {
            sortie.push('-');
            tiret = true;
        }
    }
    while sortie.ends_with('-') {
        sortie.pop();
    }
    sortie.chars().take(80).collect()
}

fn extension_image(nom: Option<&str>, type_media: Option<&str>) -> Option<String> {
    let depuis_nom = nom
        .and_then(|n| Path::new(n).extension())
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| EXTENSIONS_IMAGES.contains(&e.as_str()));
    if depuis_nom.is_some() {
        return depuis_nom;
    }
    let media = type_media?.split(';').next()?.trim().to_ascii_lowercase();
    let ext = match media.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        _ => return None,
    };
    Some(ext.to_string())
}

/// `dossier/<base>.<ext>`, ou `<base>-2.<ext>`… si le nom est pris.
fn chemin_libre(dossier: &Path, base: &str, ext: &str) -> PathBuf {
    let premier = dossier.join(format!("{base}.{ext}"));
    if !premier.exists() {
        return premier;
    }
    for n in 2..10_000 {
        let candidat = dossier.join(format!("{base}-{n}.{ext}"));
        if !candidat.exists() {
            return candidat;
        }
    }
    dossier.join(format!("{base}-{}.{ext}", std::process::id()))
}

fn image_markdown(input: &ImageMarkdownInput) -> Result<ImageMarkdown, String> {
    let markdown = PathBuf::from(&input.chemin_markdown);
    let est_markdown = markdown
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx"))
        .unwrap_or(false);
    if !est_markdown || !markdown.is_file() {
        return Err("fichier Markdown introuvable sur ce poste".into());
    }
    let source = input.source.as_deref().map(PathBuf::from);
    let nom_source = source.as_ref().and_then(|s| s.file_name()).and_then(|n| n.to_str()).map(str::to_string);
    let nom_voulu = input.nom.clone().or(nom_source);
    let ext = extension_image(nom_voulu.as_deref(), input.type_media.as_deref())
        .ok_or_else(|| "ce fichier n'est pas une image (png, jpg, gif, webp, svg, bmp, avif)".to_string())?;
    let octets = match (&source, &input.donnees) {
        (Some(chemin), _) => {
            let meta = fs::metadata(chemin).map_err(|err| format!("image introuvable : {err}"))?;
            if !meta.is_file() || meta.len() > MAX_IMAGE_OCTETS {
                return Err("image absente ou trop volumineuse (50 Mo au plus)".into());
            }
            fs::read(chemin).map_err(|err| format!("lecture de l'image impossible : {err}"))?
        }
        (None, Some(donnees)) => {
            let brut = donnees.split_once(',').map(|(_, d)| d).unwrap_or(donnees).trim();
            let octets = B64.decode(brut).map_err(|err| format!("image collée illisible : {err}"))?;
            if octets.len() as u64 > MAX_IMAGE_OCTETS {
                return Err("image trop volumineuse (50 Mo au plus)".into());
            }
            octets
        }
        (None, None) => return Err("aucune image à enregistrer".into()),
    };
    if octets.is_empty() {
        return Err("l'image est vide".into());
    }
    let tige = nom_voulu
        .as_deref()
        .and_then(|n| Path::new(n).file_stem())
        .and_then(|t| t.to_str())
        .map(nom_sur)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "image".to_string());
    let dossier = markdown.parent().map(|p| p.join("images")).ok_or("dossier du fichier introuvable")?;
    fs::create_dir_all(&dossier).map_err(|err| format!("création de images/ impossible : {err}"))?;
    let cible = chemin_libre(&dossier, &tige, &ext);
    fs::write(&cible, &octets).map_err(|err| format!("écriture de l'image impossible : {err}"))?;
    let nom = cible.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    Ok(ImageMarkdown { relatif: format!("images/{nom}"), absolu: cible.display().to_string() })
}

/// Enregistre une image collée ou déposée dans `images/` à côté du .md.
#[tauri::command]
pub(super) async fn editeur_image_markdown(input: ImageMarkdownInput) -> Result<ImageMarkdown, String> {
    tauri::async_runtime::spawn_blocking(move || image_markdown(&input))
        .await
        .map_err(|err| format!("enregistrement de l'image impossible : {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COMPTEUR: AtomicUsize = AtomicUsize::new(0);

    fn dossier_temp(nom: &str) -> PathBuf {
        let n = COMPTEUR.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("axecode-editeur-{}-{nom}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn git(d: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(d)
            .args(["-c", "user.email=banc@exemple.test", "-c", "user.name=banc", "-c", "core.autocrlf=false"])
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn git_exe() -> PathBuf {
        crate::git::resolve_executable("git").expect("git présent pour les tests")
    }

    #[test]
    fn version_head_suivie_modifiee_nouvelle_hors_depot() {
        let d = dossier_temp("head");
        git(&d, &["init", "-q"]);
        fs::create_dir_all(d.join("src")).unwrap();
        fs::write(d.join("src/app.ts"), "un\ndeux\n").unwrap();
        fs::write(d.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        git(&d, &["add", "."]);
        git(&d, &["commit", "-q", "-m", "init"]);
        let g = git_exe();

        let inchange = fichier_head(&g, &d.join("src/app.ts"));
        assert_eq!(inchange.etat, "suivi");
        assert!(!inchange.modifie);
        assert_eq!(B64.decode(inchange.base64.unwrap()).unwrap(), b"un\ndeux\n");
        assert_eq!(inchange.taille, 8);

        fs::write(d.join("src/app.ts"), "un\n2\ntrois\n").unwrap();
        let modifie = fichier_head(&g, &d.join("src/app.ts"));
        assert!(modifie.modifie);
        assert_eq!(B64.decode(modifie.base64.unwrap()).unwrap(), b"un\ndeux\n", "toujours la version de HEAD");

        fs::write(d.join("logo.png"), [0x89, b'P', b'N', b'G', 9, 9]).unwrap();
        let image = fichier_head(&g, &d.join("logo.png"));
        assert_eq!((image.etat.as_str(), image.modifie), ("suivi", true));
        assert_eq!(B64.decode(image.base64.unwrap()).unwrap(), vec![0x89, b'P', b'N', b'G', 0, 1, 2]);

        fs::write(d.join("src/nouveau.ts"), "x").unwrap();
        assert_eq!(fichier_head(&g, &d.join("src/nouveau.ts")), etat("nouveau"));

        let hors = dossier_temp("hors");
        fs::write(hors.join("a.txt"), "a").unwrap();
        assert_eq!(fichier_head(&g, &hors.join("a.txt")).etat, "hors-depot");
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_dir_all(&hors);
    }

    #[test]
    fn depot_sans_commit_et_fichier_supprime() {
        let d = dossier_temp("vide");
        git(&d, &["init", "-q"]);
        fs::write(d.join("a.md"), "a").unwrap();
        let g = git_exe();
        assert_eq!(fichier_head(&g, &d.join("a.md")).etat, "nouveau");
        git(&d, &["add", "."]);
        git(&d, &["commit", "-q", "-m", "a"]);
        fs::remove_file(d.join("a.md")).unwrap();
        let parti = fichier_head(&g, &d.join("a.md"));
        assert_eq!((parti.etat.as_str(), parti.modifie), ("suivi", true));
        let _ = fs::remove_dir_all(&d);
    }

    fn entree(md: &Path) -> ImageMarkdownInput {
        ImageMarkdownInput {
            chemin_markdown: md.display().to_string(),
            source: None,
            donnees: None,
            type_media: None,
            nom: None,
        }
    }

    #[test]
    fn image_collee_puis_deposee_dans_images_a_cote_du_md() {
        let d = dossier_temp("images");
        fs::create_dir_all(d.join("docs")).unwrap();
        let md = d.join("docs/notes.md");
        fs::write(&md, "# Notes\n").unwrap();

        let mut collee = entree(&md);
        collee.donnees = Some(format!("data:image/png;base64,{}", B64.encode([1u8, 2, 3])));
        collee.type_media = Some("image/png".into());
        collee.nom = Some("image-20261108-143012".into());
        let r = image_markdown(&collee).unwrap();
        assert_eq!(r.relatif, "images/image-20261108-143012.png");
        assert_eq!(fs::read(d.join("docs/images/image-20261108-143012.png")).unwrap(), vec![1, 2, 3]);
        // Même nom : pas d'écrasement.
        assert_eq!(image_markdown(&collee).unwrap().relatif, "images/image-20261108-143012-2.png");

        let source = d.join("Capture d’écran (2).PNG");
        fs::write(&source, [7u8, 7]).unwrap();
        let mut deposee = entree(&md);
        deposee.source = Some(source.display().to_string());
        let r = image_markdown(&deposee).unwrap();
        assert_eq!(r.relatif, "images/Capture-d-écran-2.png");
        assert_eq!(fs::read(d.join("docs/images/Capture-d-écran-2.png")).unwrap(), vec![7, 7]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn image_refusee_hors_markdown_ou_pas_une_image() {
        let d = dossier_temp("refus");
        let txt = d.join("notes.txt");
        fs::write(&txt, "x").unwrap();
        let mut e = entree(&txt);
        e.donnees = Some(B64.encode([1u8]));
        e.type_media = Some("image/png".into());
        assert!(image_markdown(&e).is_err(), "pas un .md");
        let md = d.join("notes.md");
        fs::write(&md, "x").unwrap();
        let pdf = d.join("doc.pdf");
        fs::write(&pdf, "%PDF").unwrap();
        let mut e = entree(&md);
        e.source = Some(pdf.display().to_string());
        assert!(image_markdown(&e).is_err(), "pas une image");
        let mut vide = entree(&md);
        vide.donnees = Some(String::new());
        vide.type_media = Some("image/png".into());
        assert!(image_markdown(&vide).is_err(), "image vide");
        assert!(!d.join("images").exists() || fs::read_dir(d.join("images")).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn noms_surs() {
        assert_eq!(nom_sur("Capture d’écran 2026-11-08 à 14.30.12"), "Capture-d-écran-2026-11-08-à-14-30-12");
        assert_eq!(nom_sur("../../etc/passwd"), "etc-passwd");
        assert_eq!(nom_sur("***"), "");
        assert_eq!(extension_image(Some("a.JPEG"), None).as_deref(), Some("jpeg"));
        assert_eq!(extension_image(Some("a"), Some("image/svg+xml")).as_deref(), Some("svg"));
        assert_eq!(extension_image(Some("a.exe"), Some("application/octet-stream")), None);
    }
}
