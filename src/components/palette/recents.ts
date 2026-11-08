// Fichiers ouverts récemment, par dossier (Ctrl+P les montre en premier).
// Gardés dans le stockage local du poste ; testé par tests/paletteFichiers.test.cjs.

const PREFIXE = "axecode:palette:fichiers-recents:";
export const MAX_FICHIERS_RECENTS = 30;

export function cleRecents(dossier: string): string {
  return PREFIXE + dossier;
}

function stockage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Chemins relatifs, le plus récent d'abord (liste vide si rien ou illisible). */
export function fichiersRecents(dossier: string): string[] {
  try {
    const brut = stockage()?.getItem(cleRecents(dossier));
    const liste = brut ? (JSON.parse(brut) as unknown) : [];
    return Array.isArray(liste) ? liste.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}

/** Note l'ouverture d'un fichier : il passe devant, sans doublon, 30 au plus. */
export function noterFichierRecent(dossier: string, chemin: string): void {
  if (!chemin) return;
  const liste = [chemin, ...fichiersRecents(dossier).filter((c) => c !== chemin)].slice(0, MAX_FICHIERS_RECENTS);
  try {
    stockage()?.setItem(cleRecents(dossier), JSON.stringify(liste));
  } catch {
    // stockage plein ou interdit : la liste vaut pour la session
  }
}
