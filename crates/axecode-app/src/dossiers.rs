//! Dossiers locaux qui changent de chemin (renommés ou déplacés sur le poste).
//!
//! À l'ouverture, l'appli note l'**identité stable** du dossier, hors du projet (consigne :
//! aucun dossier caché créé dans le projet) : identifiant du système de fichiers (Windows :
//! numéro de volume + index de fichier NTFS ; Linux/macOS : périphérique + inode), date de
//! création, nom et remote git. Quand le chemin n'existe plus, [`retrouver`] cherche le dossier
//! autour de l'ancien emplacement (parent, frères, ancêtres), dans Documents/Bureau/
//! Téléchargements et sous les racines des autres dossiers récents, avec une profondeur, un
//! nombre de dossiers et une durée bornés. Seule une correspondance **sûre** est acceptée :
//! même identifiant du système de fichiers (et même date de création quand elle est connue).

use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

/// Identifiant d'un dossier pour le système de fichiers, stable tant que le dossier reste
/// sur le même volume (renommage, déplacement).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdFs {
    pub volume: u64,
    pub index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identite {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs: Option<IdFs>,
    #[serde(default)]
    pub nom: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cree_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_remote: Option<String>,
}

#[cfg(unix)]
fn id_meta(meta: &std::fs::Metadata) -> Option<IdFs> {
    use std::os::unix::fs::MetadataExt;
    Some(IdFs { volume: meta.dev(), index: meta.ino() })
}

/// Identifiant du système de fichiers d'un dossier (`None` si illisible).
#[cfg(unix)]
pub fn id_fs(path: &Path) -> Option<IdFs> {
    id_meta(&std::fs::metadata(path).ok()?)
}

#[cfg(windows)]
pub fn id_fs(path: &Path) -> Option<IdFs> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        lo: u32,
        hi: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ByHandleFileInformation {
        attributes: u32,
        creation: FileTime,
        last_access: FileTime,
        last_write: FileTime,
        volume_serial_number: u32,
        size_high: u32,
        size_low: u32,
        number_of_links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut ByHandleFileInformation) -> i32;
    }
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000; // indispensable pour ouvrir un dossier
    // Aucun droit demandé (lecture des attributs seulement) ; partage complet : le dossier
    // reste renommable et supprimable pendant la lecture.
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(0x7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut info = ByHandleFileInformation::default();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as *mut std::ffi::c_void, &mut info) };
    if ok == 0 {
        return None;
    }
    Some(IdFs {
        volume: u64::from(info.volume_serial_number),
        index: (u64::from(info.index_high) << 32) | u64::from(info.index_low),
    })
}

#[cfg(not(any(unix, windows)))]
pub fn id_fs(_path: &Path) -> Option<IdFs> {
    None
}

fn cree_ms(path: &Path) -> Option<i64> {
    let t = std::fs::metadata(path).ok()?.created().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// Premier `url = …` de `.git/config` (empreinte de repli, affichée seulement).
fn git_remote(path: &Path) -> Option<String> {
    let texte = std::fs::read_to_string(path.join(".git").join("config")).ok()?;
    texte.lines().find_map(|l| {
        let l = l.trim();
        let reste = l.strip_prefix("url")?.trim_start().strip_prefix('=')?;
        Some(reste.trim().to_string()).filter(|u| !u.is_empty())
    })
}

/// Identité d'un dossier existant (champs vides s'il est illisible).
pub fn identite(path: &Path) -> Identite {
    Identite {
        fs: id_fs(path),
        nom: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        cree_ms: cree_ms(path),
        git_remote: git_remote(path),
    }
}

/// Correspondance sûre : même identifiant du système de fichiers, et même date de création
/// quand les deux sont connues (un identifiant réutilisé par un dossier recréé ne passe pas).
pub fn meme_dossier(cible: &Identite, candidat: &Identite) -> bool {
    match (cible.fs, candidat.fs) {
        (Some(a), Some(b)) if a == b => match (cible.cree_ms, candidat.cree_ms) {
            (Some(x), Some(y)) => x == y,
            _ => true,
        },
        _ => false,
    }
}

/// Bornes de la recherche : elle ne doit jamais bloquer ni parcourir tout le disque.
#[derive(Debug, Clone)]
pub struct Limites {
    /// Niveaux remontés au-dessus du premier ancêtre encore présent (le parent, en général).
    pub profondeur_ancetres: usize,
    /// Profondeur explorée sous chaque point de départ.
    pub profondeur: usize,
    /// Nombre maximal de dossiers examinés, toutes zones confondues.
    pub max_dossiers: usize,
    pub duree: Duration,
}

impl Default for Limites {
    fn default() -> Self {
        Self { profondeur_ancetres: 3, profondeur: 3, max_dossiers: 20_000, duree: Duration::from_secs(4) }
    }
}

/// Dossiers où l'on ne descend pas (lourds ou système) ; ils restent comparés eux-mêmes.
fn sans_descente(nom: &str) -> bool {
    nom.starts_with('.')
        || nom.starts_with('$')
        || matches!(
            nom,
            "node_modules" | "target" | "__pycache__" | "venv" | "AppData" | "Library" | "Windows"
                | "Program Files" | "Program Files (x86)" | "ProgramData" | "System Volume Information"
        )
}

/// Points de départ, du plus probable au moins probable (chacun avec sa profondeur).
fn zones(ancien: &Path, racines: &[PathBuf], lim: &Limites) -> Vec<(PathBuf, usize)> {
    let mut zones = Vec::new();
    // 1. Le premier ancêtre encore présent (le parent : renommé sur place, déplacé chez un
    //    frère), puis quelques niveaux au-dessus.
    let mut courant = ancien.parent();
    let mut niveaux = None::<usize>;
    while let Some(p) = courant {
        if p.is_dir() {
            let n = niveaux.map_or(0, |n| n + 1);
            if n > lim.profondeur_ancetres {
                break;
            }
            niveaux = Some(n);
            zones.push((p.to_path_buf(), lim.profondeur));
        }
        courant = p.parent();
    }
    // 2. Dossiers habituels de l'utilisateur.
    if let Some(u) = directories::UserDirs::new() {
        for d in [u.document_dir(), u.desktop_dir(), u.download_dir(), Some(u.home_dir())].into_iter().flatten() {
            zones.push((d.to_path_buf(), lim.profondeur));
        }
    }
    // 3. Racines des autres dossiers récents.
    for r in racines {
        zones.push((r.clone(), lim.profondeur.min(2)));
    }
    zones
}

/// Cherche où se trouve maintenant le dossier `cible` dont l'ancien chemin `ancien`
/// n'existe plus. `racines` : autres points de départ (parents des autres dossiers récents).
/// `None` : pas de correspondance sûre dans les bornes.
pub fn retrouver(ancien: &Path, cible: &Identite, racines: &[PathBuf], lim: &Limites) -> Option<PathBuf> {
    cible.fs?;
    let debut = Instant::now();
    let mut examines = 0usize;
    let mut explores: HashSet<PathBuf> = HashSet::new();
    for (zone, profondeur) in zones(ancien, racines, lim) {
        let mut file = VecDeque::from([(zone, 0usize)]);
        while let Some((dossier, niveau)) = file.pop_front() {
            if !explores.insert(dossier.clone()) {
                continue;
            }
            let Ok(entrees) = std::fs::read_dir(&dossier) else { continue };
            for entree in entrees.flatten() {
                let Ok(genre) = entree.file_type() else { continue };
                if !genre.is_dir() || genre.is_symlink() {
                    continue;
                }
                examines += 1;
                if examines > lim.max_dossiers || debut.elapsed() > lim.duree {
                    return None;
                }
                let chemin = entree.path();
                if chemin == ancien {
                    continue;
                }
                // Date de création lue seulement quand l'identifiant correspond (rare).
                let fs = id_fs(&chemin);
                if fs.is_some() && fs == cible.fs {
                    let candidat = Identite { fs, cree_ms: cree_ms(&chemin), ..Identite::default() };
                    if meme_dossier(cible, &candidat) {
                        return Some(chemin);
                    }
                }
                let nom = entree.file_name();
                if niveau + 1 < profondeur && !sans_descente(&nom.to_string_lossy()) {
                    file.push_back((chemin, niveau + 1));
                }
            }
        }
    }
    None
}

// ----- registre des identités (hors du projet) ---------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entree {
    chemin: String,
    identite: Identite,
    vu_ms: i64,
}

const MAX_ENTREES: usize = 300;
pub const FICHIER_REGISTRE: &str = "dossiers-identites.json";

/// Identités des dossiers ouverts, clé = chemin canonique (celui des conversations).
#[derive(Debug, Clone)]
pub struct Registre {
    fichier: PathBuf,
}

fn maintenant_ms() -> i64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Registre {
    pub fn dans(dossier_donnees: &Path) -> Self {
        Self { fichier: dossier_donnees.join(FICHIER_REGISTRE) }
    }

    fn lire(&self) -> Vec<Entree> {
        std::fs::read(&self.fichier).ok().and_then(|o| serde_json::from_slice(&o).ok()).unwrap_or_default()
    }

    fn ecrire(&self, mut entrees: Vec<Entree>) {
        entrees.sort_by(|a, b| b.vu_ms.cmp(&a.vu_ms));
        entrees.truncate(MAX_ENTREES);
        if let Some(parent) = self.fichier.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = self.fichier.with_extension("json.tmp");
        if let Ok(octets) = serde_json::to_vec_pretty(&entrees) {
            if std::fs::write(&tmp, octets).is_ok() {
                let _ = std::fs::rename(&tmp, &self.fichier);
            }
        }
    }

    /// Note (ou rafraîchit) l'identité d'un dossier qui vient d'être ouvert.
    pub fn enregistrer(&self, chemin: &Path) -> Option<Identite> {
        let cle = chemin.display().to_string();
        if cle.starts_with("axe-cloud://") || !chemin.is_dir() {
            return None;
        }
        let id = identite(chemin);
        let mut entrees = self.lire();
        entrees.retain(|e| e.chemin != cle);
        entrees.push(Entree { chemin: cle, identite: id.clone(), vu_ms: maintenant_ms() });
        self.ecrire(entrees);
        Some(id)
    }

    /// Note l'identité des dossiers encore présents qui n'en ont pas (récents ouverts avant
    /// cette version) : ils pourront être retrouvés s'ils sont déplacés plus tard.
    pub fn noter_absents(&self, chemins: &[String]) -> usize {
        let mut entrees = self.lire();
        let mut ajoutes = 0;
        for cle in chemins {
            let chemin = Path::new(cle);
            if cle.starts_with("axe-cloud://") || entrees.iter().any(|e| &e.chemin == cle) || !chemin.is_dir() {
                continue;
            }
            entrees.push(Entree { chemin: cle.clone(), identite: identite(chemin), vu_ms: maintenant_ms() });
            ajoutes += 1;
        }
        if ajoutes > 0 {
            self.ecrire(entrees);
        }
        ajoutes
    }

    pub fn identite_de(&self, chemin: &str) -> Option<Identite> {
        self.lire().into_iter().find(|e| e.chemin == chemin).map(|e| e.identite)
    }

    /// Le dossier a changé de chemin : une seule entrée, au nouveau chemin.
    pub fn renommer(&self, ancien: &str, nouveau: &str) {
        let mut entrees = self.lire();
        entrees.retain(|e| e.chemin != ancien && e.chemin != nouveau);
        entrees.push(Entree {
            chemin: nouveau.to_string(),
            identite: identite(Path::new(nouveau)),
            vu_ms: maintenant_ms(),
        });
        self.ecrire(entrees);
    }

    pub fn oublier(&self, chemin: &str) {
        let mut entrees = self.lire();
        let avant = entrees.len();
        entrees.retain(|e| e.chemin != chemin);
        if entrees.len() != avant {
            self.ecrire(entrees);
        }
    }
}

