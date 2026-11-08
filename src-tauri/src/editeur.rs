// Éditeur de fichiers :
// - `editeur_fichier_head` : contenu d'un fichier au dernier commit (HEAD), tel qu'il serait
//   extrait sur ce poste (fins de ligne, filtres), pour les marques de changements dans la
//   marge et la comparaison d'images avant / après.

use std::{
    fs,
    io::Read,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

/// Au-delà, le contenu à HEAD n'est pas renvoyé (comparaison impossible, état « trop-gros »).
const MAX_HEAD_OCTETS: u64 = 20 * 1024 * 1024;
/// Une commande git qui dépasse ce délai est arrêtée (filtre bloqué, disque réseau…).
const DELAI_GIT: Duration = Duration::from_secs(10);

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


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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
}
