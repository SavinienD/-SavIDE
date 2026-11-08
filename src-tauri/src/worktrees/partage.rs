//! Partage de fichiers ignorés par git entre le dépôt principal et un worktree :
//! lien (jonction pour un dossier sous Windows : aucun droit d'administrateur)
//! ou copie. Les liens créés sont notés dans le dossier d'administration git
//! du worktree, pour être retirés (sans jamais suivre le lien) avant la suppression.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Fichier de suivi, dans `.git/worktrees/<nom>/` (supprimé avec le worktree).
pub(crate) const FICHIER_SUIVI: &str = "worktree-partages.json";
const COPIE_MAX_ENTREES: usize = 50_000;
const COPIE_MAX_OCTETS: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Partage {
    pub(crate) chemin: String,
    /// "lien", "jonction" ou "copie".
    pub(crate) mode: String,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bilan {
    pub(crate) faits: Vec<Partage>,
    pub(crate) avertissements: Vec<String>,
}

/// Partage `liens` et `copies` (chemins relatifs déjà vérifiés) du dépôt
/// `depot` vers le worktree `worktree`. `ignore(chemin)` dit si git ignore ce
/// chemin dans le dépôt : un lien vers un chemin suivi apparaîtrait comme modifié.
pub(crate) fn appliquer(
    depot: &Path,
    worktree: &Path,
    liens: &[String],
    copies: &[String],
    ignore: &dyn Fn(&str) -> bool,
) -> Bilan {
    let mut bilan = Bilan::default();
    for rel in liens {
        let source = depot.join(rel);
        let cible = worktree.join(rel);
        if fs::symlink_metadata(&source).is_err() {
            bilan.avertissements.push(format!("« {rel} » absent du dépôt principal : rien à partager"));
            continue;
        }
        if fs::symlink_metadata(&cible).is_ok() {
            bilan.avertissements.push(format!("« {rel} » existe déjà dans le worktree : pas de lien"));
            continue;
        }
        if !ignore(rel) {
            bilan.avertissements.push(format!(
                "« {rel} » n'est pas ignoré par git : pas de lien (il apparaîtrait comme modifié)"
            ));
            continue;
        }
        if let Some(parent) = cible.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match creer_lien(&source, &cible) {
            Ok(mode) => bilan.faits.push(Partage { chemin: rel.clone(), mode: mode.to_string() }),
            Err(err) => {
                // Dernier recours : une copie (même règle que « copies »).
                let mut budget = Budget::default();
                match copier(&source, &cible, &mut budget) {
                    Ok(()) => {
                        bilan.faits.push(Partage { chemin: rel.clone(), mode: "copie".into() });
                        bilan.avertissements.push(format!("« {rel} » copié : lien impossible ({err})"));
                    }
                    Err(err2) => bilan.avertissements.push(format!("« {rel} » non partagé : {err2}")),
                }
            }
        }
    }
    for rel in copies {
        let source = depot.join(rel);
        let cible = worktree.join(rel);
        if fs::symlink_metadata(&source).is_err() {
            bilan.avertissements.push(format!("« {rel} » absent du dépôt principal : rien à copier"));
            continue;
        }
        if fs::symlink_metadata(&cible).is_ok() {
            continue; // fichier suivi par git : déjà là
        }
        if let Some(parent) = cible.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut budget = Budget::default();
        match copier(&source, &cible, &mut budget) {
            Ok(()) => bilan.faits.push(Partage { chemin: rel.clone(), mode: "copie".into() }),
            Err(err) => bilan.avertissements.push(format!("« {rel} » non copié : {err}")),
        }
    }
    bilan
}

/// Vrai pour un lien symbolique ou une jonction (jamais suivis).
pub(crate) fn est_lien(chemin: &Path) -> bool {
    fs::symlink_metadata(chemin).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Retire le lien lui-même (jamais ce vers quoi il pointe).
pub(crate) fn retirer_lien(chemin: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::FileTypeExt;
        let meta = fs::symlink_metadata(chemin)?;
        if meta.file_type().is_symlink_dir() || meta.is_dir() {
            return fs::remove_dir(chemin);
        }
        fs::remove_file(chemin)
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::remove_file(chemin)
    }
}

/// Retire les liens de `chemins` (relatifs au worktree) ; renvoie ceux retirés.
pub(crate) fn retirer_liens(worktree: &Path, chemins: &[String]) -> Vec<String> {
    let mut retires = Vec::new();
    for rel in chemins {
        let p = worktree.join(rel);
        if est_lien(&p) && retirer_lien(&p).is_ok() {
            retires.push(rel.clone());
        }
    }
    retires
}

pub(crate) fn noter(admin: &Path, faits: &[Partage]) {
    let chemin = admin.join(FICHIER_SUIVI);
    let mut tous: Vec<Partage> = lire_suivi(admin);
    for p in faits {
        if !tous.iter().any(|x| x.chemin == p.chemin) {
            tous.push(p.clone());
        }
    }
    if let Ok(texte) = serde_json::to_string_pretty(&tous) {
        let _ = fs::write(chemin, texte);
    }
}

pub(crate) fn lire_suivi(admin: &Path) -> Vec<Partage> {
    fs::read_to_string(admin.join(FICHIER_SUIVI))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[cfg(not(target_os = "windows"))]
fn creer_lien(source: &Path, cible: &Path) -> io::Result<&'static str> {
    std::os::unix::fs::symlink(source, cible)?;
    Ok("lien")
}

#[cfg(target_os = "windows")]
fn creer_lien(source: &Path, cible: &Path) -> io::Result<&'static str> {
    let source_os = super::depot::chemin_os(source);
    let cible_os = super::depot::chemin_os(cible);
    if source.is_dir() {
        // Jonction : pas besoin du mode développeur ni d'être administrateur.
        let mut cmd = std::process::Command::new("cmd");
        super::depot::masquer_console(&mut cmd);
        let sortie = cmd
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&cible_os)
            .arg(&source_os)
            .stdin(std::process::Stdio::null())
            .output()?;
        if sortie.status.success() && est_lien(cible) {
            return Ok("jonction");
        }
        std::os::windows::fs::symlink_dir(&source_os, &cible_os)?;
        return Ok("lien");
    }
    std::os::windows::fs::symlink_file(&source_os, &cible_os)?;
    Ok("lien")
}

#[derive(Default)]
struct Budget {
    entrees: usize,
    octets: u64,
}

fn copier(source: &Path, cible: &Path, budget: &mut Budget) -> io::Result<()> {
    let meta = fs::symlink_metadata(source)?;
    budget.entrees += 1;
    if budget.entrees > COPIE_MAX_ENTREES {
        return Err(io::Error::new(io::ErrorKind::Other, "trop de fichiers à copier (50 000 au plus)"));
    }
    if meta.file_type().is_symlink() {
        return Ok(()); // les liens internes ne sont pas suivis
    }
    if meta.is_dir() {
        fs::create_dir_all(cible)?;
        for entree in fs::read_dir(source)? {
            let entree = entree?;
            copier(&entree.path(), &cible.join(entree.file_name()), budget)?;
        }
        return Ok(());
    }
    budget.octets += meta.len();
    if budget.octets > COPIE_MAX_OCTETS {
        return Err(io::Error::new(io::ErrorKind::Other, "copie trop grosse (2 Go au plus)"));
    }
    fs::copy(source, cible).map(|_| ())
}

/// Taille sur disque (octets) et date de la dernière modification (ms) d'un
/// dossier, sans suivre les liens ni les jonctions, `max_entrees` au plus
/// (le troisième élément dit si la limite a été atteinte).
pub(crate) fn mesurer(dossier: &Path, max_entrees: usize) -> (u64, u64, bool) {
    let mut octets = 0u64;
    let mut recent = 0u64;
    let mut vus = 0usize;
    let mut pile = vec![dossier.to_path_buf()];
    while let Some(d) = pile.pop() {
        let Ok(entrees) = fs::read_dir(&d) else { continue };
        for entree in entrees.flatten() {
            vus += 1;
            if vus > max_entrees {
                return (octets, recent, true);
            }
            let Ok(meta) = entree.path().symlink_metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            let nom = entree.file_name();
            if meta.is_dir() {
                pile.push(entree.path());
                continue;
            }
            octets += meta.len();
            if nom != ".git" {
                if let Ok(m) = meta.modified() {
                    if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
                        recent = recent.max(d.as_millis() as u64);
                    }
                }
            }
        }
    }
    (octets, recent, false)
}
