// Worktrees — ouvrir les écrans des worktrees depuis n'importe où (panneau
// Git, liste, palette…) : WorktreesRacine écoute cet événement.
export const EVENEMENT_OUVRIR_WORKTREES = "worktrees-ouvrir";
export type DemandeOuverture = { vue?: "nouveau" | "nettoyage"; depot?: string };

export function ouvrirWorktrees(vue: "nouveau" | "nettoyage", depot?: string): void {
  window.dispatchEvent(new CustomEvent<DemandeOuverture>(EVENEMENT_OUVRIR_WORKTREES, { detail: { vue, depot } }));
}

/** Dossier de ce poste (pas un espace cloud) : les worktrees n'existent que là. */
export function dossierLocal(chemin: string): boolean {
  return Boolean(chemin) && !chemin.startsWith("axe-cloud://");
}
