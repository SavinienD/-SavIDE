//! Petits appels à git pour les worktrees (sans dépendre de git.rs) : toujours
//! `git -C <dossier>`, sans fenêtre de console sous Windows, sans invite d'identifiants.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Résultat brut d'une commande git.
#[derive(Debug, Clone)]
pub(crate) struct Sortie {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) ok: bool,
}

/// Un worktree tel que `git worktree list --porcelain` le décrit.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WorktreeBrut {
    pub(crate) chemin: PathBuf,
    pub(crate) head: Option<String>,
    pub(crate) branche: Option<String>,
    pub(crate) detache: bool,
    pub(crate) verrouille: bool,
    /// Dossier disparu : git propose de l'oublier (`git worktree prune`).
    pub(crate) prunable: bool,
    pub(crate) principal: bool,
}

/// Chemin à donner à un autre programme (sans le préfixe Windows `\\?\`).
pub(crate) fn chemin_os(chemin: &Path) -> PathBuf {
    axecode_app::workspace::os_path(chemin)
}

/// Exécutable git : PATH, puis les emplacements habituels de Git pour Windows.
pub(crate) fn programme_git() -> &'static Path {
    static GIT: OnceLock<PathBuf> = OnceLock::new();
    GIT.get_or_init(|| trouver_git().unwrap_or_else(|| PathBuf::from("git")))
}

fn trouver_git() -> Option<PathBuf> {
    let noms: &[&str] = if cfg!(target_os = "windows") { &["git.exe", "git.cmd"] } else { &["git"] };
    let mut dossiers: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        let mut racines = vec![PathBuf::from(r"C:\Program Files\Git"), PathBuf::from(r"C:\Program Files (x86)\Git")];
        if let Some(p) = std::env::var_os("ProgramFiles") {
            racines.push(PathBuf::from(p).join("Git"));
        }
        if let Some(p) = std::env::var_os("LOCALAPPDATA") {
            racines.push(PathBuf::from(p).join("Programs").join("Git"));
        }
        for r in racines {
            dossiers.push(r.join("cmd"));
            dossiers.push(r.join("bin"));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        dossiers.extend(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin"].map(PathBuf::from));
    }
    dossiers
        .into_iter()
        .flat_map(|d| noms.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

/// Commande `git -C <dossier>` prête à lancer (entrée fermée, console masquée).
pub(crate) fn commande(dossier: &Path) -> Command {
    let mut cmd = Command::new(programme_git());
    masquer_console(&mut cmd);
    cmd.arg("-C").arg(chemin_os(dossier));
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.stdin(Stdio::null());
    cmd
}

#[cfg(target_os = "windows")]
pub(crate) fn masquer_console(cmd: &mut Command) {
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn masquer_console(_cmd: &mut Command) {}

/// Lance git et rend sa sortie, même en cas d'échec (`ok` = code 0).
pub(crate) fn git(dossier: &Path, args: &[&str]) -> Result<Sortie, String> {
    let mut cmd = commande(dossier);
    for a in args {
        cmd.arg(OsStr::new(a));
    }
    let sortie = cmd
        .output()
        .map_err(|err| format!("git introuvable ou impossible à lancer ({err}) : installez Git"))?;
    Ok(Sortie {
        stdout: String::from_utf8_lossy(&sortie.stdout).to_string(),
        stderr: String::from_utf8_lossy(&sortie.stderr).to_string(),
        ok: sortie.status.success(),
    })
}

/// Comme `git`, mais un échec devient une erreur lisible.
pub(crate) fn git_ok(dossier: &Path, args: &[&str]) -> Result<String, String> {
    let sortie = git(dossier, args)?;
    if sortie.ok {
        Ok(sortie.stdout)
    } else {
        Err(message_echec(args, &sortie))
    }
}

pub(crate) fn message_echec(args: &[&str], sortie: &Sortie) -> String {
    let detail = [sortie.stderr.trim(), sortie.stdout.trim()]
        .into_iter()
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let commande = args.iter().take(3).copied().collect::<Vec<_>>().join(" ");
    if detail.is_empty() {
        format!("échec de git {commande}")
    } else {
        format!("échec de git {commande} : {detail}")
    }
}

/// Forme canonique (celle des clés de l'appli), ou le chemin tel quel.
pub(crate) fn canonique(chemin: &Path) -> PathBuf {
    std::fs::canonicalize(chemin).unwrap_or_else(|_| chemin.to_path_buf())
}

pub(crate) fn meme_chemin(a: &Path, b: &Path) -> bool {
    let na = canonique(a);
    let nb = canonique(b);
    if cfg!(target_os = "windows") {
        na.to_string_lossy().to_lowercase() == nb.to_string_lossy().to_lowercase()
    } else {
        na == nb
    }
}

/// Worktrees du dépôt, le principal en premier.
pub(crate) fn lister(dossier: &Path) -> Result<Vec<WorktreeBrut>, String> {
    let texte = git_ok(dossier, &["worktree", "list", "--porcelain"])?;
    Ok(analyser_liste(&texte))
}

pub(crate) fn analyser_liste(texte: &str) -> Vec<WorktreeBrut> {
    let mut liste: Vec<WorktreeBrut> = Vec::new();
    let mut courant: Option<WorktreeBrut> = None;
    for ligne in texte.lines().map(str::trim_end) {
        if let Some(chemin) = ligne.strip_prefix("worktree ") {
            if let Some(w) = courant.take() {
                liste.push(w);
            }
            courant = Some(WorktreeBrut {
                chemin: canonique(Path::new(chemin.trim())),
                head: None,
                branche: None,
                detache: false,
                verrouille: false,
                prunable: false,
                principal: liste.is_empty(),
            });
            continue;
        }
        let Some(w) = courant.as_mut() else { continue };
        if let Some(v) = ligne.strip_prefix("HEAD ") {
            w.head = Some(v.trim().to_string());
        } else if let Some(v) = ligne.strip_prefix("branch ") {
            let v = v.trim();
            w.branche = Some(v.strip_prefix("refs/heads/").unwrap_or(v).to_string());
        } else if ligne == "detached" {
            w.detache = true;
        } else if ligne == "locked" || ligne.starts_with("locked ") {
            w.verrouille = true;
        } else if ligne == "prunable" || ligne.starts_with("prunable ") {
            w.prunable = true;
        } else if ligne.is_empty() {
            if let Some(w) = courant.take() {
                liste.push(w);
            }
        }
    }
    if let Some(w) = courant.take() {
        liste.push(w);
    }
    liste
}

/// Dossier du worktree principal (là où vit `.git`), depuis n'importe quel worktree.
pub(crate) fn racine_principale(dossier: &Path) -> Result<PathBuf, String> {
    let liste = lister(dossier)?;
    liste
        .into_iter()
        .next()
        .map(|w| w.chemin)
        .ok_or_else(|| "aucun dépôt git dans ce dossier".to_string())
}

pub(crate) fn branche_courante(dossier: &Path) -> Option<String> {
    let s = git(dossier, &["branch", "--show-current"]).ok()?;
    let b = s.stdout.trim();
    (s.ok && !b.is_empty()).then(|| b.to_string())
}

pub(crate) fn branche_locale_existe(racine: &Path, branche: &str) -> bool {
    let reference = format!("refs/heads/{branche}");
    git(racine, &["show-ref", "--verify", "--quiet", &reference])
        .map(|s| s.ok)
        .unwrap_or(false)
}

/// Branche principale : origin/HEAD, puis main / master / trunk, puis la branche courante.
pub(crate) fn branche_principale(racine: &Path) -> Option<String> {
    if let Ok(s) = git(racine, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        if s.ok {
            if let Some((_, nom)) = s.stdout.trim().split_once('/') {
                if !nom.is_empty() && branche_locale_existe(racine, nom) {
                    return Some(nom.to_string());
                }
            }
        }
    }
    for nom in ["main", "master", "trunk"] {
        if branche_locale_existe(racine, nom) {
            return Some(nom.to_string());
        }
    }
    branche_courante(racine)
}

pub(crate) fn branches_locales(racine: &Path) -> Vec<String> {
    git(racine, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .ok()
        .filter(|s| s.ok)
        .map(|s| s.stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

pub(crate) fn revision_existe(racine: &Path, revision: &str) -> bool {
    let spec = format!("{revision}^{{commit}}");
    git(racine, &["rev-parse", "--verify", "--quiet", &spec]).map(|s| s.ok).unwrap_or(false)
}

pub(crate) fn nom_branche_valide(racine: &Path, branche: &str) -> bool {
    !branche.is_empty()
        && !branche.starts_with('-')
        && git(racine, &["check-ref-format", "--branch", branche]).map(|s| s.ok).unwrap_or(false)
}

/// Vrai si git ignore ce chemin (relatif à la racine).
pub(crate) fn est_ignore(racine: &Path, relatif: &str) -> bool {
    git(racine, &["check-ignore", "-q", "--no-index", "--", relatif]).map(|s| s.ok).unwrap_or(false)
}

/// Vrai si git suit ce chemin (fichier ou dossier) dans la racine.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn est_suivi(racine: &Path, relatif: &str) -> bool {
    git(racine, &["ls-files", "--error-unmatch", "--", relatif]).map(|s| s.ok).unwrap_or(false)
}

/// Nombre de fichiers modifiés ou non suivis (None si le dossier n'est pas lisible).
pub(crate) fn fichiers_modifies(dossier: &Path) -> Option<usize> {
    let s = git(dossier, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).ok()?;
    if !s.ok {
        return None;
    }
    let mut n = 0;
    let mut morceaux = s.stdout.split('\0').filter(|m| !m.is_empty());
    while let Some(entree) = morceaux.next() {
        n += 1;
        // Renommage / copie : le chemin d'origine suit dans l'entrée suivante.
        if entree.starts_with('R') || entree.starts_with('C') {
            morceaux.next();
        }
    }
    Some(n)
}

/// (en retard, en avance) de `branche` par rapport à `reference`.
pub(crate) fn retard_avance(racine: &Path, reference: &str, branche: &str) -> Option<(u32, u32)> {
    let plage = format!("{reference}...{branche}");
    let s = git(racine, &["rev-list", "--left-right", "--count", &plage, "--"]).ok()?;
    if !s.ok {
        return None;
    }
    let mut nombres = s.stdout.split_whitespace().filter_map(|n| n.parse::<u32>().ok());
    Some((nombres.next()?, nombres.next()?))
}

pub(crate) fn amont(racine: &Path, branche: &str) -> Option<String> {
    let spec = format!("{branche}@{{upstream}}");
    let s = git(racine, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", &spec]).ok()?;
    let v = s.stdout.trim();
    (s.ok && !v.is_empty()).then(|| v.to_string())
}

pub(crate) fn commit_de(racine: &Path, revision: &str) -> Option<String> {
    let spec = format!("{revision}^{{commit}}");
    let s = git(racine, &["rev-parse", "--verify", "--quiet", &spec]).ok()?;
    let v = s.stdout.trim();
    (s.ok && !v.is_empty()).then(|| v.to_string())
}

/// Vrai si tous les commits de `branche` sont déjà dans `base` (et qu'elle a avancé).
pub(crate) fn fusionnee(racine: &Path, branche: &str, base: &str) -> bool {
    if branche == base {
        return false;
    }
    let (Some(tete), Some(tete_base)) = (commit_de(racine, branche), commit_de(racine, base)) else {
        return false;
    };
    tete != tete_base
        && git(racine, &["merge-base", "--is-ancestor", &tete, &tete_base]).map(|s| s.ok).unwrap_or(false)
}

/// Date (ms) du dernier commit de HEAD dans ce dossier.
pub(crate) fn date_dernier_commit_ms(dossier: &Path) -> Option<u64> {
    let s = git(dossier, &["log", "-1", "--format=%ct"]).ok()?;
    let secondes: u64 = s.stdout.trim().parse().ok()?;
    Some(secondes * 1000)
}

/// Dossier d'administration git du worktree (`.git/worktrees/<nom>`).
pub(crate) fn dossier_admin(dossier: &Path) -> Option<PathBuf> {
    let s = git(dossier, &["rev-parse", "--absolute-git-dir"]).ok()?;
    let v = s.stdout.trim();
    (s.ok && !v.is_empty()).then(|| PathBuf::from(v))
}
