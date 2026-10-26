// axe:html — choix « Rendu / Code » (Markdown, HTML, CSV, SVG…) mémorisé par
// fichier (chemin absolu) dans localStorage, borné aux MAX_VUES plus récents.

export const CLE_VUES = "axecode.vueFichiers";
export const MAX_VUES = 400;

function lire(): Record<string, boolean> {
  try {
    const brut = localStorage.getItem(CLE_VUES);
    const valeur = brut ? JSON.parse(brut) : {};
    return valeur && typeof valeur === "object" && !Array.isArray(valeur) ? valeur : {};
  } catch {
    return {};
  }
}

/** `true` = rendu, `false` = code, `null` = jamais choisi (défaut du type). */
export function vueMemorisee(chemin: string): boolean | null {
  const valeur = lire()[chemin];
  return typeof valeur === "boolean" ? valeur : null;
}

export function memoriserVue(chemin: string, rendu: boolean): void {
  try {
    const vues = lire();
    delete vues[chemin];
    vues[chemin] = rendu; // dernier inséré = plus récent
    const cles = Object.keys(vues);
    for (const cle of cles.slice(0, Math.max(0, cles.length - MAX_VUES))) delete vues[cle];
    localStorage.setItem(CLE_VUES, JSON.stringify(vues));
  } catch {
    /* stockage indisponible : le choix reste valable pour la session */
  }
}
