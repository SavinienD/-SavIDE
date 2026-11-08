// Tableaux (CSV, TSV, classeurs) : tri par colonne et filtre des lignes.
// Renvoie l'ordre des lignes d'origine à afficher ; la 1re ligne (en-tête) reste en tête quand
// elle est figée. Tri : nombres comparés comme des nombres (espaces, virgule décimale, %, €),
// textes sans tenir compte de la casse ni des accents, cellules vides toujours à la fin.
// Pur : testé par tests/editeurCsv.test.cjs.

export type Tri = { col: number; sens: "asc" | "desc" } | null;

const ESPACES = /[\s\u00a0\u202f]/g;
const NOMBRE = /^[-+]?(\d+([.,]\d+)?|[.,]\d+)$/;
const comparateur = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

export function valeurNumerique(texte: string): number | null {
  const t = texte.replace(ESPACES, "").replace(/[%€$£]$/, "");
  if (!t || !NOMBRE.test(t)) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Clic sur l'en-tête de la colonne : croissant, puis décroissant, puis sans tri. */
export function triSuivant(tri: Tri, col: number): Tri {
  if (!tri || tri.col !== col) return { col, sens: "asc" };
  return tri.sens === "asc" ? { col, sens: "desc" } : null;
}

export function ordreLignes(
  nbLignes: number,
  texte: (ligne: number, colonne: number) => string,
  options: {
    entete: boolean;
    tri: Tri;
    filtre: string;
    colonnes: number;
    /** Valeur numérique connue de la cellule (classeur : nombre, date), sinon lue dans le texte. */
    nombre?: (ligne: number, colonne: number) => number | null;
  },
): number[] {
  const debut = options.entete && nbLignes > 0 ? 1 : 0;
  const filtre = options.filtre.trim().toLocaleLowerCase("fr");
  let lignes: number[] = [];
  for (let r = debut; r < nbLignes; r++) {
    if (!filtre) {
      lignes.push(r);
      continue;
    }
    for (let c = 0; c < options.colonnes; c++) {
      if (texte(r, c).toLocaleLowerCase("fr").includes(filtre)) {
        lignes.push(r);
        break;
      }
    }
  }
  const tri = options.tri;
  if (tri) {
    const sens = tri.sens === "asc" ? 1 : -1;
    const cles = lignes.map((r) => {
      const t = texte(r, tri.col);
      const n = options.nombre?.(r, tri.col) ?? valeurNumerique(t);
      // groupe : 0 nombre, 1 texte, 2 vide (toujours à la fin)
      return { r, t, n, g: n !== null ? 0 : t.trim() === "" ? 2 : 1 };
    });
    cles.sort((a, b) => {
      if (a.g !== b.g) return a.g - b.g;
      const d = a.g === 0 ? ((a.n as number) - (b.n as number)) * sens : a.g === 1 ? comparateur.compare(a.t, b.t) * sens : 0;
      return d || a.r - b.r;
    });
    lignes = cles.map((k) => k.r);
  }
  return debut ? [0, ...lignes] : lignes;
}
