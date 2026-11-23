// brouillons de l'éditeur riche : modifications non enregistrées gardées en mémoire
// quand l'onglet est quitté (la visionneuse rouvre alors l'éditeur). Module léger, sans TipTap.

export type Brouillon = { html: string; modifie: boolean };

export const BROUILLONS = new Map<string, Brouillon>();

/** Brouillon non enregistré d'un fichier. */
export function brouillonDe(chemin: string): Brouillon | undefined {
  return BROUILLONS.get(chemin);
}
