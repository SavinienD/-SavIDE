// Lot palette (P4) — « Rechercher dans ce dossier » (clic droit dans l'explorateur) : le
// dossier choisi est gardé ici ; le volet de recherche le lit en s'ouvrant (ou l'apprend par
// l'événement s'il est déjà ouvert), l'espace ouvre le volet. Module pur (testé).

export const EVENEMENT_RECHERCHE_DOSSIER = "axe:rechercher-dans-dossier";

let dossier: string | null = null;

/** Limite le volet de recherche à `chemin` (relatif au dossier ouvert) et demande son ouverture. */
export function demanderRechercheDossier(
  chemin: string,
  cible: EventTarget | null = typeof window === "undefined" ? null : window,
): void {
  dossier = chemin.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || null;
  cible?.dispatchEvent(new CustomEvent(EVENEMENT_RECHERCHE_DOSSIER, { detail: { dossier } }));
}

/** Dossier auquel la recherche est limitée (null : tout le dossier ouvert). */
export function dossierDeRecherche(): string | null {
  return dossier;
}

/** Retour à la recherche dans tout le dossier ouvert. */
export function oublierRechercheDossier(): void {
  dossier = null;
}

/** Le résultat est-il dans le dossier (pour les espaces cloud, filtrés après coup) ? */
export function dansDossier(cheminRelatif: string, dossierLimite: string | null): boolean {
  if (!dossierLimite) return true;
  const c = cheminRelatif.replace(/\\/g, "/");
  return c === dossierLimite || c.startsWith(dossierLimite + "/");
}
