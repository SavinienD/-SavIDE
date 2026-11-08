//! Écran de nettoyage des worktrees : fusionnés, introuvables, anciens,
//! taille sur disque. La suppression elle-même passe par les tâches (taches.rs).

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{config, depot, partage};

/// Au-delà, la taille est donnée « au moins » (dossiers énormes).
const MESURE_MAX_ENTREES: usize = 200_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InfoNettoyage {
    pub(crate) depot: String,
    pub(crate) dossier: String,
    pub(crate) branche: Option<String>,
    /// Tous les commits de la branche sont déjà dans la branche de départ.
    pub(crate) fusionne: bool,
    pub(crate) introuvable: bool,
    pub(crate) modifies: Option<usize>,
    pub(crate) octets: Option<u64>,
    pub(crate) taille_coupee: bool,
    /// Dernière activité : dernier commit ou dernier fichier modifié (le plus récent).
    pub(crate) activite_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NettoyageInput {
    pub(crate) depots: Vec<String>,
    #[serde(default)]
    pub(crate) bases: std::collections::HashMap<String, String>,
}

/// Worktrees (hors dossier principal) des dépôts donnés, avec ce qu'il faut pour trier.
pub(crate) fn examiner(depots: &[String], bases: &std::collections::HashMap<String, String>) -> Vec<InfoNettoyage> {
    let racines = super::racines(depots);
    std::thread::scope(|s| {
        let fils: Vec<_> = racines
            .iter()
            .map(|r| {
                let base = bases
                    .iter()
                    .find(|(k, _)| depot::meme_chemin(Path::new(k), r))
                    .map(|(_, v)| v.clone());
                s.spawn(move || examiner_depot(r, base))
            })
            .collect();
        fils.into_iter().flat_map(|f| f.join().unwrap_or_default()).collect()
    })
}

fn examiner_depot(racine: &Path, base_locale: Option<String>) -> Vec<InfoNettoyage> {
    let base = base_locale
        .or_else(|| config::lire(racine).base)
        .filter(|b| depot::revision_existe(racine, b))
        .or_else(|| depot::branche_principale(racine));
    let Ok(liste) = depot::lister(racine) else { return Vec::new() };
    std::thread::scope(|s| {
        let fils: Vec<_> = liste
            .iter()
            .filter(|w| !w.principal)
            .map(|w| {
                let base = base.clone();
                s.spawn(move || {
                    let introuvable = w.prunable || !w.chemin.is_dir();
                    let fusionne = match (&w.branche, &base) {
                        (Some(b), Some(base)) => depot::fusionnee(racine, b, base),
                        _ => false,
                    };
                    let (octets, recent, coupee) = if introuvable {
                        (None, None, false)
                    } else {
                        let (o, r, c) = partage::mesurer(&w.chemin, MESURE_MAX_ENTREES);
                        (Some(o), (r > 0).then_some(r), c)
                    };
                    let commit = if introuvable { None } else { depot::date_dernier_commit_ms(&w.chemin) };
                    InfoNettoyage {
                        depot: racine.display().to_string(),
                        dossier: w.chemin.display().to_string(),
                        branche: w.branche.clone(),
                        fusionne,
                        introuvable,
                        modifies: if introuvable { None } else { depot::fichiers_modifies(&w.chemin) },
                        octets,
                        taille_coupee: coupee,
                        activite_ms: commit.max(recent),
                    }
                })
            })
            .collect();
        fils.into_iter().filter_map(|f| f.join().ok()).collect()
    })
}

/// `git worktree prune` : oublie les worktrees dont le dossier a disparu ; renvoie leur nombre.
pub(crate) fn oublier_introuvables(chemin: &str) -> Result<usize, String> {
    let racine = depot::racine_principale(Path::new(chemin.trim()))?;
    let avant = depot::lister(&racine)?.iter().filter(|w| w.prunable).count();
    depot::git_ok(&racine, &["worktree", "prune"])?;
    let apres = depot::lister(&racine)?.iter().filter(|w| w.prunable).count();
    Ok(avant.saturating_sub(apres))
}
