//! Worktrees git des sous-agents. Un sous-agent peut travailler dans
//! son propre worktree, sur la branche `sous-agent/<nom>`, rangé HORS du dépôt :
//! `<dossier parent du dépôt>/<nom du dépôt>-sous-agents/<nom>`. Le parent lit
//! son état ([`etat`]), fusionne sa branche ([`fusionner`]) puis le libère
//! ([`liberer`]). Tout passe par la commande `git` (aucune dépendance).

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Le worktree d'un sous-agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Racine du dépôt du parent (là où la fusion se fait).
    pub depot: PathBuf,
    /// Racine du worktree.
    pub chemin: PathBuf,
    /// Dossier de travail de l'enfant (le même sous-dossier que le parent).
    pub dossier: PathBuf,
    /// `sous-agent/<nom>`.
    pub branche: String,
    /// Commit de départ.
    pub base: String,
}

/// Lance `git` dans `dir` ; rend la sortie standard, ou l'erreur de git.
pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut commande = Command::new("git");
    commande
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        commande.creation_flags(0x0800_0000);
    }
    let sortie = commande
        .output()
        .map_err(|e| format!("git introuvable ({e}) : installez Git pour utiliser les worktrees"))?;
    if sortie.status.success() {
        Ok(String::from_utf8_lossy(&sortie.stdout).to_string())
    } else {
        let erreur = String::from_utf8_lossy(&sortie.stderr).trim().to_string();
        let sortie_std = String::from_utf8_lossy(&sortie.stdout).trim().to_string();
        Err(if erreur.is_empty() { sortie_std } else { erreur })
    }
}

fn lignes(texte: &str) -> Vec<String> {
    texte.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// Nom utilisable pour une branche et un dossier.
pub fn nettoyer(nom: &str) -> String {
    let mut out = String::new();
    for c in nom.trim().chars() {
        let c = if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' };
        if !(c == '-' && out.ends_with('-')) {
            out.push(c);
        }
    }
    let out = out.trim_matches(|c| c == '-' || c == '.').replace("..", ".");
    let out = out.strip_suffix(".lock").unwrap_or(&out).to_string();
    let out: String = out.chars().take(60).collect();
    if out.is_empty() { "sous-agent".into() } else { out }
}

/// Racine du dépôt git qui contient `dossier`.
pub fn racine_depot(dossier: &Path) -> Result<PathBuf, String> {
    git(dossier, &["rev-parse", "--show-toplevel"])
        .map(|s| PathBuf::from(s.trim()))
        .map_err(|_| {
            format!(
                "« {} » n'est pas un dépôt git : worktree impossible (lancez le sous-agent sans `worktree`, ou faites `git init` puis un premier commit)",
                dossier.display()
            )
        })
}

fn branche_existe(depot: &Path, branche: &str) -> bool {
    git(depot, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branche}")]).is_ok()
}

fn chemin_texte(p: &Path) -> String {
    let s = p.display().to_string();
    if cfg!(windows) { s.replace('/', "\\") } else { s }
}

/// Crée la branche `sous-agent/<nom>` et son worktree à partir du commit
/// courant du dépôt de `dossier_parent`. Rend aussi un avertissement quand
/// le parent a des modifications non validées (elles ne suivent pas).
pub fn creer(dossier_parent: &Path, nom: &str) -> Result<(Worktree, Option<String>), String> {
    let depot = racine_depot(dossier_parent)?;
    let prefixe = git(dossier_parent, &["rev-parse", "--show-prefix"])?.trim().to_string();
    let base = git(&depot, &["rev-parse", "--verify", "HEAD"])
        .map_err(|_| "le dépôt n'a encore aucun commit : faites un premier commit avant de lancer un sous-agent dans un worktree".to_string())?
        .trim()
        .to_string();
    let nom_depot = depot
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "depot".into());
    let conteneur = depot
        .parent()
        .ok_or("le dépôt est à la racine du disque : pas de place à côté pour les worktrees")?
        .join(format!("{nom_depot}-sous-agents"));
    let propre = nettoyer(nom);
    let (chemin, branche) = (1..1000)
        .map(|k| if k == 1 { propre.clone() } else { format!("{propre}-{k}") })
        .map(|n| (conteneur.join(&n), format!("sous-agent/{n}")))
        .find(|(chemin, branche)| !chemin.exists() && !branche_existe(&depot, branche))
        .ok_or("aucun nom de worktree libre")?;
    std::fs::create_dir_all(&conteneur)
        .map_err(|e| format!("impossible de créer « {} » : {e}", conteneur.display()))?;
    let chemin_s = chemin_texte(&chemin);
    git(&depot, &["worktree", "add", "-b", &branche, &chemin_s, &base])
        .map_err(|e| format!("git worktree add a échoué : {e}"))?;
    let dossier = if prefixe.is_empty() { chemin.clone() } else { chemin.join(prefixe.trim_end_matches('/')) };
    let sale = !git(&depot, &["status", "--porcelain"]).unwrap_or_default().trim().is_empty();
    let avertissement = sale.then(|| {
        format!(
            "le dossier du parent a des modifications non validées : elles ne sont pas dans le worktree de l'enfant (parti du commit {})",
            &base[..base.len().min(10)]
        )
    });
    Ok((
        Worktree { depot, chemin, dossier: PathBuf::from(chemin_texte(&dossier)), branche, base },
        avertissement,
    ))
}

/// Fichiers modifiés par rapport à la base (validés ou non, nouveaux compris),
/// chemins relatifs à la racine du dépôt.
pub fn fichiers_modifies(wt: &Worktree) -> Result<Vec<String>, String> {
    if !wt.chemin.exists() {
        return git(&wt.depot, &["diff", "--name-only", &wt.base, &wt.branche]).map(|s| lignes(&s));
    }
    let mut fichiers = lignes(&git(&wt.chemin, &["diff", "--name-only", &wt.base])?);
    for f in lignes(&git(&wt.chemin, &["ls-files", "--others", "--exclude-standard"])?) {
        if !fichiers.contains(&f) {
            fichiers.push(f);
        }
    }
    fichiers.sort();
    Ok(fichiers)
}

/// Chemin, branche, base, fichiers modifiés, `git diff --stat` et commits du worktree.
pub fn etat(wt: &Worktree) -> Result<Value, String> {
    let existe = wt.chemin.exists();
    let fichiers = fichiers_modifies(wt)?;
    let (stat, commits, nouveaux) = if existe {
        (
            git(&wt.chemin, &["diff", "--stat", &wt.base])?,
            git(&wt.chemin, &["log", "--oneline", &format!("{}..HEAD", wt.base)])?,
            lignes(&git(&wt.chemin, &["ls-files", "--others", "--exclude-standard"])?),
        )
    } else {
        (
            git(&wt.depot, &["diff", "--stat", &wt.base, &wt.branche])?,
            git(&wt.depot, &["log", "--oneline", &format!("{}..{}", wt.base, wt.branche)])?,
            Vec::new(),
        )
    };
    let mut stat = stat.trim_end().to_string();
    if !nouveaux.is_empty() {
        if !stat.is_empty() {
            stat.push('\n');
        }
        stat.push_str(&format!(" nouveaux fichiers (non suivis) : {}", nouveaux.join(", ")));
    }
    Ok(json!({
        "chemin": chemin_texte(&wt.chemin),
        "dossier": chemin_texte(&wt.dossier),
        "branche": wt.branche,
        "base": wt.base,
        "existe": existe,
        "fichiers": fichiers,
        "diff_stat": stat,
        "commits": lignes(&commits),
    }))
}

/// Valide sur la branche de l'enfant ce qui ne l'est pas encore (rien ne se
/// perd à la fusion ni à la libération). Vrai si un commit a été fait.
fn valider_en_attente(wt: &Worktree, nom: &str) -> Result<bool, String> {
    if !wt.chemin.exists() || git(&wt.chemin, &["status", "--porcelain"])?.trim().is_empty() {
        return Ok(false);
    }
    git(&wt.chemin, &["add", "-A"])?;
    let mut args: Vec<String> = Vec::new();
    if git(&wt.chemin, &["config", "user.email"]).map_or(true, |s| s.trim().is_empty()) {
        for v in ["user.name=Sous-agent", "user.email=sous-agent@localhost"] {
            args.push("-c".into());
            args.push(v.into());
        }
    }
    let message = format!("Sous-agent {nom} : travail non validé");
    args.extend(["commit", "-q", "--no-verify", "-m"].map(String::from));
    args.push(message);
    git(&wt.chemin, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    Ok(true)
}

/// Fusionne la branche de l'enfant dans la branche courante du parent
/// (`--no-ff`), après avoir validé son travail en attente. Sur un conflit, la
/// fusion est annulée (`git merge --abort`) : la branche du parent reste
/// telle quelle et la réponse donne `fusionne: false` et les `conflits`.
pub fn fusionner(wt: &Worktree, nom: &str) -> Result<Value, String> {
    let valide = valider_en_attente(wt, nom)?;
    let cible = git(&wt.depot, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if cible == "HEAD" {
        return Err("le dossier du parent n'est sur aucune branche (HEAD détachée) : passez sur une branche avant de fusionner".into());
    }
    let en_avance = git(&wt.depot, &["rev-list", "--count", &format!("HEAD..{}", wt.branche)])?
        .trim()
        .parse::<u64>()
        .unwrap_or(0);
    if en_avance == 0 {
        return Ok(json!({
            "fusionne": false, "branche": wt.branche, "cible": cible, "fichiers": [],
            "message": format!("rien à fusionner : {} n'apporte aucun commit absent de {cible}", wt.branche),
        }));
    }
    let avant = git(&wt.depot, &["rev-parse", "HEAD"])?.trim().to_string();
    let message = format!("Fusion du sous-agent {nom} ({})", wt.branche);
    match git(&wt.depot, &["merge", "--no-ff", "--no-edit", "-m", &message, &wt.branche]) {
        Ok(_) => {
            let fichiers = lignes(&git(&wt.depot, &["diff", "--name-only", &avant, "HEAD"])?);
            let stat = git(&wt.depot, &["diff", "--stat", &avant, "HEAD"])?;
            let commit = git(&wt.depot, &["rev-parse", "--short", "HEAD"])?.trim().to_string();
            Ok(json!({
                "fusionne": true, "branche": wt.branche, "cible": cible, "commit": commit,
                "fichiers": fichiers, "diff_stat": stat.trim_end(), "valide_avant": valide,
                "message": format!("{} fusionnée dans {cible} (commit {commit})", wt.branche),
            }))
        }
        Err(erreur) => {
            let conflits = lignes(
                &git(&wt.depot, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default(),
            );
            if git(&wt.depot, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).is_ok() {
                let _ = git(&wt.depot, &["merge", "--abort"]);
            }
            if conflits.is_empty() {
                return Err(format!("fusion impossible, {cible} est inchangée : {erreur}"));
            }
            Ok(json!({
                "fusionne": false, "branche": wt.branche, "cible": cible, "conflits": conflits,
                "message": format!(
                    "conflit sur {} fichier(s) ({}) : fusion annulée, {cible} est inchangée. Faites corriger l'enfant dans son worktree (par ex. `git merge {cible}` puis résolution), puis fusionnez de nouveau.",
                    conflits.len(),
                    conflits.join(", ")
                ),
            }))
        }
    }
}

/// Supprime le worktree (son travail en attente est d'abord validé sur sa
/// branche). La branche est gardée, sauf `garder_branche == false` ET branche
/// déjà fusionnée (`git branch -d`).
pub fn liberer(wt: &Worktree, nom: &str, garder_branche: bool) -> Result<Value, String> {
    let valide = valider_en_attente(wt, nom)?;
    if wt.chemin.exists() {
        git(&wt.depot, &["worktree", "remove", "--force", &chemin_texte(&wt.chemin)])
            .map_err(|e| format!("git worktree remove a échoué : {e}"))?;
    }
    let _ = git(&wt.depot, &["worktree", "prune"]);
    if let Some(conteneur) = wt.chemin.parent() {
        let _ = std::fs::remove_dir(conteneur); // seulement s'il est vide
    }
    let mut message = format!("worktree supprimé ({})", chemin_texte(&wt.chemin));
    let mut branche_gardee = true;
    if !garder_branche {
        match git(&wt.depot, &["branch", "-d", &wt.branche]) {
            Ok(_) => {
                branche_gardee = false;
                message.push_str(&format!(", branche {} supprimée", wt.branche));
            }
            Err(_) => message.push_str(&format!(
                ", branche {} gardée : elle n'est pas fusionnée (supprimez-la vous-même avec `git branch -D` si elle ne sert plus)",
                wt.branche
            )),
        }
    } else {
        message.push_str(&format!(", branche {} gardée", wt.branche));
    }
    Ok(json!({
        "libere": true, "branche": wt.branche, "branche_gardee": branche_gardee,
        "valide_avant": valide, "message": message,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dépôt temporaire « projet » : a.txt, sous/b.txt, un commit sur main.
    fn depot() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("projet");
        std::fs::create_dir_all(d.join("sous")).unwrap();
        git(&d, &["init", "-q", "-b", "main"]).unwrap();
        git(&d, &["config", "user.email", "t@exemple.fr"]).unwrap();
        git(&d, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(d.join("a.txt"), "un\ndeux\n").unwrap();
        std::fs::write(d.join("sous/b.txt"), "b\n").unwrap();
        git(&d, &["add", "-A"]).unwrap();
        git(&d, &["commit", "-q", "-m", "départ"]).unwrap();
        (tmp, d)
    }

    #[test]
    fn noms_nettoyes() {
        assert_eq!(nettoyer("Essai Rapide!"), "Essai-Rapide");
        assert_eq!(nettoyer("../x.lock"), "x");
        assert_eq!(nettoyer("été"), "t");
        assert_eq!(nettoyer("  "), "sous-agent");
    }

    #[test]
    fn creer_etat_fusionner_liberer() {
        let (_tmp, d) = depot();
        let racine = racine_depot(&d).unwrap();
        let (wt, avertissement) = creer(&d.join("sous"), "Essai Rapide!").unwrap();
        assert_eq!(avertissement, None);
        assert_eq!(wt.branche, "sous-agent/Essai-Rapide");
        let attendu = racine.parent().unwrap().join("projet-sous-agents").join("Essai-Rapide");
        assert_eq!(wt.chemin, attendu);
        assert_eq!(wt.dossier, attendu.join("sous"), "même sous-dossier que le parent");
        assert!(wt.dossier.join("b.txt").exists() && !wt.chemin.starts_with(&racine), "hors du dépôt");
        // Même nom : un autre worktree, une autre branche.
        let (wt2, _) = creer(&d, "Essai Rapide!").unwrap();
        assert_eq!(wt2.branche, "sous-agent/Essai-Rapide-2");
        // L'enfant travaille sans valider.
        std::fs::write(wt.chemin.join("a.txt"), "un\nDEUX\n").unwrap();
        std::fs::write(wt.dossier.join("c.txt"), "nouveau\n").unwrap();
        let e = etat(&wt).unwrap();
        assert_eq!(e["fichiers"], json!(["a.txt", "sous/c.txt"]));
        assert!(e["diff_stat"].as_str().unwrap().contains("a.txt"), "{e}");
        assert!(e["diff_stat"].as_str().unwrap().contains("sous/c.txt"), "{e}");
        assert_eq!(e["commits"], json!([]));
        // Fusion : le travail en attente est validé puis fusionné dans main.
        let f = fusionner(&wt, "essai").unwrap();
        assert_eq!(f["fusionne"], true, "{f}");
        assert_eq!(f["cible"], "main");
        assert_eq!(f["fichiers"], json!(["a.txt", "sous/c.txt"]));
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "un\nDEUX\n");
        assert!(git(&d, &["log", "--oneline"]).unwrap().contains("Sous-agent essai : travail non validé"));
        assert_eq!(fusionner(&wt, "essai").unwrap()["fusionne"], false, "plus rien à fusionner");
        // Libération : worktree supprimé, branche fusionnée supprimée sur demande.
        let l = liberer(&wt, "essai", false).unwrap();
        assert_eq!(l["branche_gardee"], false, "{l}");
        assert!(!wt.chemin.exists());
        assert!(git(&d, &["branch", "--list", "sous-agent/Essai-Rapide"]).unwrap().trim().is_empty());
        let l2 = liberer(&wt2, "essai", true).unwrap();
        assert_eq!(l2["branche_gardee"], true);
        assert!(!racine.parent().unwrap().join("projet-sous-agents").exists(), "dossier vide retiré");
    }

    #[test]
    fn conflit_annule_proprement() {
        let (_tmp, d) = depot();
        let (wt, _) = creer(&d, "c").unwrap();
        std::fs::write(wt.chemin.join("a.txt"), "un\nENFANT\n").unwrap();
        std::fs::write(d.join("a.txt"), "un\nPARENT\n").unwrap();
        git(&d, &["commit", "-qam", "parent"]).unwrap();
        let f = fusionner(&wt, "c").unwrap();
        assert_eq!(f["fusionne"], false, "{f}");
        assert_eq!(f["conflits"], json!(["a.txt"]));
        assert!(f["message"].as_str().unwrap().contains("fusion annulée"), "{f}");
        assert!(git(&d, &["status", "--porcelain"]).unwrap().trim().is_empty(), "parent propre");
        assert!(git(&d, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).is_err());
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "un\nPARENT\n");
        // Branche non fusionnée : gardée même si on demande sa suppression.
        let l = liberer(&wt, "c", false).unwrap();
        assert_eq!(l["branche_gardee"], true);
        assert!(l["message"].as_str().unwrap().contains("pas fusionnée"), "{l}");
        assert_eq!(fichiers_modifies(&wt).unwrap(), vec!["a.txt".to_string()], "lu sur la branche");
    }

    #[test]
    fn hors_depot_et_parent_modifie() {
        let tmp = tempfile::tempdir().unwrap();
        let err = creer(tmp.path(), "x").unwrap_err();
        assert!(err.contains("n'est pas un dépôt git"), "{err}");
        let (_tmp, d) = depot();
        std::fs::write(d.join("a.txt"), "modifié\n").unwrap();
        let (_, avertissement) = creer(&d, "x").unwrap();
        assert!(avertissement.unwrap().contains("non validées"));
    }
}
