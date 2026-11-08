// Lot palette — « aller partout vite ».
//   palette_fichiers : fichiers d'un dossier pour Ctrl+P, listés par `rg --files` (le
//   .gitignore est respecté, même hors dépôt git) ; repli sur la liste interne quand rg
//   manque ou échoue.

use crate::*;
use std::process::Stdio;
use tokio::io::AsyncBufReadExt;

/// Au-delà, la liste est coupée (la palette reste fluide) et l'interface le dit.
pub(crate) const MAX_FICHIERS: usize = 50_000;
/// Un très gros dossier (disque entier ouvert) ne bloque pas la palette plus longtemps.
const DELAI_LISTE: Duration = Duration::from_secs(8);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DossierInput {
    workspace_path: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListeFichiers {
    /// Chemins relatifs au dossier, séparateur « / », triés sans tenir compte de la casse.
    pub(crate) fichiers: Vec<String>,
    /// Vrai si la liste a été coupée (trop de fichiers, ou trop longue à lire).
    pub(crate) tronque: bool,
    /// « rg » ; « liste » = liste interne de secours (le .gitignore n'y est pas lu).
    pub(crate) source: &'static str,
}

#[tauri::command]
pub(crate) async fn palette_fichiers(
    input: DossierInput,
) -> std::result::Result<ListeFichiers, String> {
    let racine = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    match axecode_app::ensure_ripgrep_executable().await {
        Ok(rg) => match lister_rg(&rg, &racine, MAX_FICHIERS, DELAI_LISTE).await {
            Ok(liste) => return Ok(liste),
            Err(err) => tracing::warn!(%err, "rg --files en échec : liste interne"),
        },
        Err(err) => tracing::warn!(%err, "rg introuvable : liste interne"),
    }
    let mut fichiers: Vec<String> = list_workspace_files(&racine)
        .map_err(error_to_string)?
        .into_iter()
        .map(|entree| entree.relative_path.replace('\\', "/"))
        .collect();
    let tronque = fichiers.len() > MAX_FICHIERS;
    fichiers.truncate(MAX_FICHIERS);
    fichiers.sort_by_cached_key(|c| c.to_lowercase());
    Ok(ListeFichiers { fichiers, tronque, source: "liste" })
}

/// `rg --files` dans `racine` : fichiers cachés compris (.github, .env…), sans .git ni
/// node_modules ; le .gitignore, .ignore et .rgignore sont respectés.
pub(crate) async fn lister_rg(
    rg: &Path,
    racine: &Path,
    max: usize,
    delai: Duration,
) -> Result<ListeFichiers> {
    let mut commande = tokio::process::Command::new(rg);
    commande
        .args([
            "--files",
            "--hidden",
            "--no-require-git",
            "--no-config",
            "--no-messages",
            "--color",
            "never",
            "--path-separator",
            "/",
            "--glob",
            "!.git",
            "--glob",
            "!node_modules",
        ])
        .current_dir(racine)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    commande.creation_flags(0x0800_0000);
    let mut enfant = commande.spawn().context("lancement de rg")?;
    let sortie = enfant.stdout.take().context("sortie de rg absente")?;
    let mut lecteur = tokio::io::BufReader::new(sortie);
    let mut fichiers = Vec::new();
    let mut tronque = false;
    let fin = tokio::time::Instant::now() + delai;
    let mut ligne = Vec::new();
    loop {
        ligne.clear();
        match tokio::time::timeout_at(fin, lecteur.read_until(b'\n', &mut ligne)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {
                let texte = String::from_utf8_lossy(&ligne);
                let chemin = texte.trim_end_matches(['\n', '\r']).trim_start_matches("./");
                if chemin.is_empty() {
                    continue;
                }
                if fichiers.len() >= max {
                    tronque = true;
                    break;
                }
                fichiers.push(chemin.to_string());
            }
            Ok(Err(err)) => return Err(err).context("lecture de la sortie de rg"),
            Err(_) => {
                tronque = true;
                break;
            }
        }
    }
    if tronque {
        let _ = enfant.kill().await;
    } else {
        let _ = enfant.wait().await;
    }
    fichiers.sort_by_cached_key(|c| c.to_lowercase());
    Ok(ListeFichiers { fichiers, tronque, source: "rg" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ecrire(racine: &Path, chemin: &str, texte: &str) {
        let p = racine.join(chemin);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, texte).unwrap();
    }

    fn dossier_temporaire(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "axe-palette-{nom}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    async fn rg() -> PathBuf {
        axecode_app::ensure_ripgrep_executable()
            .await
            .expect("rg introuvable (AXECODE_RG_PATH)")
    }

    #[tokio::test]
    async fn rg_files_respecte_le_gitignore_meme_hors_depot() {
        let d = dossier_temporaire("gitignore");
        ecrire(&d, ".gitignore", "ignore.txt\nbuild/\n");
        ecrire(&d, "a.txt", "a");
        ecrire(&d, "ignore.txt", "x");
        ecrire(&d, "build/sortie.txt", "x");
        ecrire(&d, "src/Réglages.tsx", "x");
        ecrire(&d, ".github/ci.yml", "x");
        ecrire(&d, "node_modules/m/index.js", "x");
        ecrire(&d, ".git/config", "x");
        let liste = lister_rg(&rg().await, &d, MAX_FICHIERS, DELAI_LISTE).await.unwrap();
        assert_eq!(
            liste.fichiers,
            vec![".github/ci.yml", ".gitignore", "a.txt", "src/Réglages.tsx"]
        );
        assert!(!liste.tronque);
        assert_eq!(liste.source, "rg");
        let _ = fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn liste_coupee_au_maximum() {
        let d = dossier_temporaire("max");
        for i in 0..12 {
            ecrire(&d, &format!("f{i:02}.txt"), "x");
        }
        let liste = lister_rg(&rg().await, &d, 5, DELAI_LISTE).await.unwrap();
        assert_eq!(liste.fichiers.len(), 5);
        assert!(liste.tronque);
        let _ = fs::remove_dir_all(&d);
    }
}
