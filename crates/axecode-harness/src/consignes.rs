//! consignes du dossier pour l'agent : `AGENTS.md`, puis les
//! fichiers de Claude Code (`CLAUDE.md`, `.claude/CLAUDE.md`), dans cet ordre de
//! priorité et sous un plafond commun. Un fichier qui répète un fichier déjà lu
//! (même contenu, lien, simple renvoi `@AGENTS.md`) n'est pas envoyé deux fois.
//! Les Réglages (Harnais) montrent l'état de chaque fichier.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Fichiers lus, du plus prioritaire au moins prioritaire (chemins relatifs au dossier).
pub const FICHIERS: [&str; 3] = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];
/// Plafond commun à tous les fichiers de consignes (caractères envoyés au modèle).
pub const PLAFOND_CARACTERES: usize = 64_000;
/// Texte que les versions d'avant écrivaient dans un nouveau CLAUDE.md : ignoré
/// (« Note: <appli> does not use this CLAUDE.md file … », quel que soit le nom de l'appli).
pub const ANCIEN_MODELE_CLAUDE: &str =
    "Note: SavIDE does not use this CLAUDE.md file as its reference instructions. Use AGENTS.md instead.";

fn est_ancien_modele(contenu: &str) -> bool {
    !contenu.contains('\n')
        && contenu.starts_with("Note: ")
        && contenu.ends_with("does not use this CLAUDE.md file as its reference instructions. Use AGENTS.md instead.")
}

/// État d'un fichier de consignes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EtatConsignes {
    /// Envoyé en entier.
    Lu,
    /// Envoyé en partie : le plafond est atteint.
    Tronque,
    /// Rien n'est envoyé : le plafond était déjà atteint par les fichiers d'avant.
    Plafond,
    /// Même fichier ou même contenu qu'un fichier d'avant (ou simple renvoi `@AGENTS.md`).
    Doublon,
    /// Fichier vide.
    Vide,
    /// Ancien texte par défaut (« does not use this CLAUDE.md file »).
    AncienModele,
    /// Fichier présent mais illisible (droits, encodage).
    Illisible,
    /// Pas de fichier.
    Absent,
}

/// Un fichier de consignes et ce qui en part vers le modèle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConsignes {
    /// Chemin relatif au dossier (`CLAUDE.md`).
    pub fichier: String,
    /// Chemin absolu.
    pub chemin: String,
    /// Taille du contenu (caractères, sans les blancs du début et de la fin).
    pub caracteres: usize,
    /// Caractères envoyés au modèle.
    pub retenus: usize,
    pub etat: EtatConsignes,
    /// Précision lisible : fichier répété, erreur de lecture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Consignes d'un dossier : texte à mettre dans le prompt et état de chaque fichier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Consignes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texte: Option<String>,
    pub sources: Vec<SourceConsignes>,
    pub plafond: usize,
}

/// Lit les consignes du dossier avec le plafond par défaut.
pub fn lire(workspace_root: &Path) -> Consignes {
    lire_avec_plafond(workspace_root, PLAFOND_CARACTERES)
}

/// Texte des consignes seulement (`None` : aucun fichier utile).
pub fn texte(workspace_root: &Path) -> Option<String> {
    lire(workspace_root).texte
}

pub fn lire_avec_plafond(workspace_root: &Path, plafond: usize) -> Consignes {
    let mut sources = Vec::new();
    // (fichier, chemin canonique, contenu) des fichiers déjà envoyés.
    let mut lus: Vec<(String, Option<PathBuf>, String)> = Vec::new();
    let mut morceaux: Vec<(String, String)> = Vec::new();
    let mut reste = plafond;
    for fichier in FICHIERS {
        let chemin = fichier.split('/').fold(workspace_root.to_path_buf(), |c, part| c.join(part));
        let mut source = SourceConsignes {
            fichier: fichier.to_string(),
            chemin: crate::os_path(&chemin).display().to_string(),
            caracteres: 0,
            retenus: 0,
            etat: EtatConsignes::Absent,
            detail: None,
        };
        let brut = match std::fs::read(&chemin) {
            Ok(octets) => octets,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                sources.push(source);
                continue;
            }
            Err(err) => {
                // Un dossier `CLAUDE.md` ou un fichier verrouillé : signalé, jamais bloquant.
                source.etat = if chemin.is_dir() { EtatConsignes::Absent } else { EtatConsignes::Illisible };
                if source.etat == EtatConsignes::Illisible {
                    source.detail = Some(err.to_string());
                }
                sources.push(source);
                continue;
            }
        };
        let texte = String::from_utf8_lossy(&brut);
        let contenu = texte.strip_prefix('\u{feff}').unwrap_or(&texte).trim().to_string();
        source.caracteres = contenu.chars().count();
        let canonique = std::fs::canonicalize(&chemin).ok();
        if contenu.is_empty() {
            source.etat = EtatConsignes::Vide;
        } else if est_ancien_modele(&contenu) {
            source.etat = EtatConsignes::AncienModele;
        } else if let Some(de) = doublon_de(&lus, canonique.as_deref(), &contenu) {
            source.etat = EtatConsignes::Doublon;
            source.detail = Some(de);
        } else if reste == 0 {
            source.etat = EtatConsignes::Plafond;
        } else {
            let garde: String = contenu.chars().take(reste).collect();
            source.retenus = garde.chars().count();
            reste -= source.retenus;
            let mut morceau = garde;
            if source.retenus < source.caracteres {
                source.etat = EtatConsignes::Tronque;
                morceau.push_str(&format!(
                    "\n\n[… {} characters cut: the instruction files go over {plafond} characters. Read the rest of {fichier} in the workspace if you need it.]",
                    source.caracteres - source.retenus
                ));
            } else {
                source.etat = EtatConsignes::Lu;
            }
            morceaux.push((fichier.to_string(), morceau));
            lus.push((fichier.to_string(), canonique, contenu));
        }
        sources.push(source);
    }
    let texte = match morceaux.len() {
        0 => None,
        // Un seul fichier : texte tel quel (comme AGENTS.md avant).
        1 => morceaux.pop().map(|(_, t)| t),
        _ => Some(
            morceaux
                .iter()
                .map(|(fichier, t)| format!("<instructions file=\"{fichier}\">\n{t}\n</instructions>"))
                .collect::<Vec<_>>()
                .join("\n\n"),
        ),
    };
    Consignes { texte, sources, plafond }
}

/// Fichier déjà envoyé que celui-ci répète : même fichier (lien), même contenu,
/// ou seulement des renvois `@FICHIER` (syntaxe d'import de Claude Code) vers eux.
fn doublon_de(lus: &[(String, Option<PathBuf>, String)], canonique: Option<&Path>, contenu: &str) -> Option<String> {
    for (fichier, chemin, texte) in lus {
        if canonique.is_some() && chemin.as_deref() == canonique {
            return Some(format!("même fichier que {fichier}"));
        }
        if texte == contenu {
            return Some(format!("même contenu que {fichier}"));
        }
    }
    let renvois: Vec<&str> = contenu.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let cible = |ligne: &str| {
        let nom = ligne.strip_prefix('@')?.trim_start_matches("./");
        lus.iter().find(|(f, _, _)| f.eq_ignore_ascii_case(nom)).map(|(f, _, _)| f.clone())
    };
    if !renvois.is_empty() && renvois.iter().all(|l| cible(l).is_some()) {
        let noms: Vec<String> = renvois.iter().filter_map(|l| cible(l)).collect();
        return Some(format!("renvoie à {}", noms.join(", ")));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dossier(nom: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("test-consignes-{nom}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".claude")).unwrap();
        d
    }

    fn etat(c: &Consignes, fichier: &str) -> EtatConsignes {
        c.sources.iter().find(|s| s.fichier == fichier).map(|s| s.etat).unwrap()
    }

    #[test]
    fn agents_seul_garde_le_texte_tel_quel() {
        let d = dossier("agents");
        std::fs::write(d.join("AGENTS.md"), "\n# Règles\nToujours répondre en français.\n").unwrap();
        let c = lire(&d);
        assert_eq!(c.texte.as_deref(), Some("# Règles\nToujours répondre en français."));
        assert_eq!(etat(&c, "AGENTS.md"), EtatConsignes::Lu);
        assert_eq!(etat(&c, "CLAUDE.md"), EtatConsignes::Absent);
        assert_eq!(etat(&c, ".claude/CLAUDE.md"), EtatConsignes::Absent);
    }

    #[test]
    fn claude_md_lu_apres_agents_md_avec_le_nom_de_chaque_fichier() {
        let d = dossier("deux");
        std::fs::write(d.join("AGENTS.md"), "Règle A").unwrap();
        std::fs::write(d.join("CLAUDE.md"), "Règle C").unwrap();
        std::fs::write(d.join(".claude/CLAUDE.md"), "Règle D").unwrap();
        let c = lire(&d);
        let t = c.texte.unwrap();
        let (a, b, e) = (t.find("Règle A").unwrap(), t.find("Règle C").unwrap(), t.find("Règle D").unwrap());
        assert!(a < b && b < e, "ordre de priorité : {t}");
        assert!(t.contains("file=\"CLAUDE.md\"") && t.contains("file=\".claude/CLAUDE.md\""), "{t}");
        assert!(c.sources.iter().all(|s| s.etat == EtatConsignes::Lu));
    }

    #[test]
    fn claude_md_seul_est_lu() {
        let d = dossier("claude");
        std::fs::write(d.join("CLAUDE.md"), "Utiliser pnpm.").unwrap();
        let c = lire(&d);
        assert_eq!(c.texte.as_deref(), Some("Utiliser pnpm."));
        assert_eq!(etat(&c, "CLAUDE.md"), EtatConsignes::Lu);
    }

    #[test]
    fn doublons_ancien_modele_et_vide_sont_ignores() {
        let d = dossier("doublons");
        std::fs::write(d.join("AGENTS.md"), "Même texte\n").unwrap();
        std::fs::write(d.join("CLAUDE.md"), "  Même texte").unwrap();
        std::fs::write(d.join(".claude/CLAUDE.md"), "@AGENTS.md\n").unwrap();
        let c = lire(&d);
        assert_eq!(c.texte.as_deref(), Some("Même texte"));
        assert_eq!(etat(&c, "CLAUDE.md"), EtatConsignes::Doublon);
        assert_eq!(etat(&c, ".claude/CLAUDE.md"), EtatConsignes::Doublon);
        let d = dossier("modele");
        std::fs::write(d.join("CLAUDE.md"), format!("{ANCIEN_MODELE_CLAUDE}\n")).unwrap();
        // Même avis écrit par une autre édition de l'appli.
        std::fs::write(d.join(".claude/CLAUDE.md"), "Note: Code does not use this CLAUDE.md file as its reference instructions. Use AGENTS.md instead.").unwrap();
        std::fs::write(d.join("AGENTS.md"), " \n").unwrap();
        let c = lire(&d);
        assert_eq!(c.texte, None);
        assert_eq!(etat(&c, "CLAUDE.md"), EtatConsignes::AncienModele);
        assert_eq!(etat(&c, ".claude/CLAUDE.md"), EtatConsignes::AncienModele);
        assert_eq!(etat(&c, "AGENTS.md"), EtatConsignes::Vide);
    }

    #[test]
    fn plafond_commun_tronque_puis_coupe_les_fichiers_suivants() {
        let d = dossier("plafond");
        std::fs::write(d.join("AGENTS.md"), "a".repeat(80)).unwrap();
        std::fs::write(d.join("CLAUDE.md"), "é".repeat(80)).unwrap();
        std::fs::write(d.join(".claude/CLAUDE.md"), "c".repeat(10)).unwrap();
        let c = lire_avec_plafond(&d, 100);
        let src = |f: &str| c.sources.iter().find(|s| s.fichier == f).unwrap().clone();
        assert_eq!((src("AGENTS.md").etat, src("AGENTS.md").retenus), (EtatConsignes::Lu, 80));
        assert_eq!((src("CLAUDE.md").etat, src("CLAUDE.md").retenus), (EtatConsignes::Tronque, 20));
        assert_eq!((src(".claude/CLAUDE.md").etat, src(".claude/CLAUDE.md").retenus), (EtatConsignes::Plafond, 0));
        let t = c.texte.unwrap();
        assert!(t.contains(&"é".repeat(20)) && !t.contains(&"é".repeat(21)), "coupé au bon caractère");
        assert!(t.contains("60 characters cut") && t.contains("CLAUDE.md"), "{t}");
        assert!(!t.contains("cccc"));
    }
}
