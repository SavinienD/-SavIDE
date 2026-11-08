//! Téléchargements du navigateur intégré : toujours dans le dossier Téléchargements
//! de l'utilisateur, sans écraser un fichier existant (« rapport (1).pdf »).

use std::path::{Path, PathBuf};

/// Dossier Téléchargements de l'utilisateur (repli : `~/Downloads`, puis le dossier temporaire).
pub(crate) fn dossier_telechargements() -> PathBuf {
    directories::UserDirs::new()
        .and_then(|u| u.download_dir().map(Path::to_path_buf).or_else(|| Some(u.home_dir().join("Downloads"))))
        .unwrap_or_else(std::env::temp_dir)
}

/// Nom de fichier sûr : dernier segment, sans séparateur ni caractère interdit sous Windows.
pub(crate) fn nom_sur(propose: &str) -> String {
    let dernier = propose.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let propre: String = dernier
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let propre = propre.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if propre.is_empty() {
        "telechargement".into()
    } else {
        propre.chars().take(180).collect()
    }
}

/// Nom proposé par la vue web (chemin), sinon tiré de l'URL (sans requête ni ancre).
pub(crate) fn nom_de_fichier(propose: &Path, url: &str) -> String {
    let depuis_vue = propose.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !depuis_vue.trim().is_empty() {
        return nom_sur(&depuis_vue);
    }
    let sans_requete = url.split(['?', '#']).next().unwrap_or("");
    nom_sur(sans_requete.trim_end_matches('/'))
}

/// Premier chemin libre de `dossier` pour `nom` : « a.pdf », « a (1).pdf », « a (2).pdf »…
pub(crate) fn chemin_libre(dossier: &Path, nom: &str) -> PathBuf {
    let candidat = dossier.join(nom);
    if !candidat.exists() {
        return candidat;
    }
    let chemin = Path::new(nom);
    let base = chemin.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| nom.to_string());
    let extension = chemin.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..10_000)
        .map(|i| dossier.join(format!("{base} ({i}){extension}")))
        .find(|p| !p.exists())
        .unwrap_or_else(|| dossier.join(format!("{base} ({}){extension}", std::process::id())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noms_surs() {
        assert_eq!(nom_sur("rapport.pdf"), "rapport.pdf");
        assert_eq!(nom_sur("../../etc/passwd"), "passwd");
        assert_eq!(nom_sur("C:\\Windows\\a<b>.txt"), "a_b_.txt");
        assert_eq!(nom_sur("  ..  "), "telechargement");
        assert_eq!(nom_de_fichier(Path::new(""), "https://a.fr/docs/notice.pdf?jeton=1#p"), "notice.pdf");
        assert_eq!(nom_de_fichier(Path::new("/tmp/x/propose.zip"), "https://a.fr/autre"), "propose.zip");
        assert_eq!(nom_de_fichier(Path::new(""), "https://a.fr/"), "a.fr");
    }

    #[test]
    fn jamais_d_ecrasement() {
        let dossier = std::env::temp_dir().join(format!("axecode-telech-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dossier);
        std::fs::create_dir_all(&dossier).unwrap();
        assert_eq!(chemin_libre(&dossier, "a.pdf"), dossier.join("a.pdf"));
        std::fs::write(dossier.join("a.pdf"), b"1").unwrap();
        assert_eq!(chemin_libre(&dossier, "a.pdf"), dossier.join("a (1).pdf"));
        std::fs::write(dossier.join("a (1).pdf"), b"2").unwrap();
        assert_eq!(chemin_libre(&dossier, "a.pdf"), dossier.join("a (2).pdf"));
        std::fs::write(dossier.join("LISEZMOI"), b"3").unwrap();
        assert_eq!(chemin_libre(&dossier, "LISEZMOI"), dossier.join("LISEZMOI (1)"));
        let _ = std::fs::remove_dir_all(&dossier);
    }

    #[test]
    fn dossier_absolu() {
        assert!(dossier_telechargements().is_absolute());
    }
}
