//! Conflits : fusion, rebase, cherry-pick ou revert arrêté
//! sur des conflits. Versions « base / nôtre / leur » d'un fichier, résultat
//! écrit puis marqué résolu (`git add`), « Continuer » et « Abandonner ».

use crate::diff::{git, Depot};
use crate::*;

/// Opération en cours dans le dépôt : « fusion », « rebase », « cherry-pick », « revert ».
pub(crate) fn operation(depot: &Depot) -> Option<String> {
    let existe = |nom: &str| chemin_git(depot, nom).map(|p| p.exists()).unwrap_or(false);
    if existe("rebase-merge") || existe("rebase-apply") {
        Some("rebase".into())
    } else if existe("MERGE_HEAD") {
        Some("fusion".into())
    } else if existe("CHERRY_PICK_HEAD") {
        Some("cherry-pick".into())
    } else if existe("REVERT_HEAD") {
        Some("revert".into())
    } else {
        None
    }
}

fn chemin_git(depot: &Depot, nom: &str) -> Option<PathBuf> {
    let s = git(&depot.racine, &["rev-parse", "--git-path", nom], None, &[]).ok()?;
    let texte = s.texte().trim().to_string();
    if !s.ok || texte.is_empty() {
        return None;
    }
    let p = PathBuf::from(texte);
    Some(if p.is_absolute() { p } else { depot.racine.join(p) })
}
