// Défilement synchronisé éditeur <-> aperçu Markdown (côte à côte) : la ligne
// source en haut de l'éditeur est convertie en hauteur dans l'aperçu (et inversement) par
// interpolation entre les ancres « data-ligne ». Pur : testé par tests/editeurMarkdown.test.cjs.

export type Ancre = { ligne: number; y: number };

/** Triées par ligne, une par ligne (la première gardée), hauteurs croissantes. */
export function nettoyerAncres(brutes: readonly Ancre[]): Ancre[] {
  const triees = brutes
    .filter((a) => Number.isFinite(a.ligne) && Number.isFinite(a.y))
    .map((a, i) => ({ ...a, i }))
    .sort((a, b) => a.ligne - b.ligne || a.i - b.i);
  const sortie: Ancre[] = [];
  for (const a of triees) {
    const avant = sortie[sortie.length - 1];
    if (avant && (a.ligne <= avant.ligne || a.y < avant.y)) continue;
    sortie.push({ ligne: a.ligne, y: a.y });
  }
  return sortie;
}

/** Hauteur (px, dans l'aperçu) de la ligne source `ligne` (fractionnaire). */
export function yPourLigne(ancres: readonly Ancre[], ligne: number): number {
  if (!ancres.length) return 0;
  if (ligne <= ancres[0].ligne) return ancres[0].y;
  for (let i = 1; i < ancres.length; i++) {
    const s = ancres[i];
    if (ligne < s.ligne) {
      const p = ancres[i - 1];
      return p.y + ((s.y - p.y) * (ligne - p.ligne)) / (s.ligne - p.ligne);
    }
  }
  return ancres[ancres.length - 1].y;
}

/** Ligne source (fractionnaire) affichée à la hauteur `y` de l'aperçu. */
export function lignePourY(ancres: readonly Ancre[], y: number): number {
  if (!ancres.length) return 1;
  if (y <= ancres[0].y) return ancres[0].ligne;
  for (let i = 1; i < ancres.length; i++) {
    const s = ancres[i];
    if (y < s.y) {
      const p = ancres[i - 1];
      return p.ligne + ((s.ligne - p.ligne) * (y - p.y)) / (s.y - p.y);
    }
  }
  return ancres[ancres.length - 1].ligne;
}

/** « haut », « milieu » ou « bas » d'une zone qui défile. */
export function positionDefilement(haut: number, hauteurTotale: number, hauteurVisible: number): "haut" | "milieu" | "bas" {
  if (haut <= 1) return "haut";
  return haut >= hauteurTotale - hauteurVisible - 2 ? "bas" : "milieu";
}
