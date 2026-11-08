// Marques de changements dans la marge de l'éditeur, par rapport au dernier
// commit (HEAD) : lignes ajoutées, modifiées, et l'endroit des lignes supprimées. Diff ligne à
// ligne de Myers (préfixe et suffixe communs retirés d'abord) ; au-delà de MAX_D modifications,
// la zone changée est marquée « modifiée » d'un bloc. Pur (aucune dépendance) : testé par
// tests/editeurMarge.test.cjs.

export type Marque = {
  genre: "ajout" | "modif" | "suppr";
  /** Lignes du texte actuel, base 1, incluses (suppr : la ligne après laquelle on a supprimé). */
  debut: number;
  fin: number;
  /** suppr au tout début du fichier : la marque est en haut de la ligne 1. */
  haut?: boolean;
};

const MAX_D = 1000;
/** Au-delà, pas de marques (fichier énorme). */
export const MAX_LIGNES_MARGE = 50_000;

export function lignesDe(texte: string): string[] {
  if (!texte) return [];
  const lignes = texte.split(/\r\n|\r|\n/);
  if (lignes[lignes.length - 1] === "") lignes.pop();
  return lignes;
}

/** Script d'édition de Myers : "=" garder, "-" supprimer (ancien), "+" ajouter (nouveau). Null si trop de différences. */
export function scriptMyers(a: ArrayLike<number>, b: ArrayLike<number>, maxD = MAX_D): string[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let fin = -1;
  for (let d = 0; d <= max && fin < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        fin = d;
        break;
      }
    }
  }
  if (fin < 0) return null;
  const ops: string[] = [];
  let x = n;
  let y = m;
  for (let d = fin; d >= 0; d--) {
    const w = trace[d];
    const lire = (k: number) => w[k + d + 1];
    const k = x - y;
    const precK = k === -d || (k !== d && lire(k - 1) < lire(k + 1)) ? k + 1 : k - 1;
    const precX = lire(precK);
    const precY = precX - precK;
    while (x > precX && y > precY) {
      ops.push("=");
      x--;
      y--;
    }
    if (d > 0) ops.push(x === precX ? "+" : "-");
    x = precX;
    y = precY;
  }
  return ops.reverse();
}

function marqueDeBloc(debutNouveau: number, supprimees: number, ajoutees: number): Marque {
  // debutNouveau : index (base 0) dans le texte actuel où commence le bloc.
  if (ajoutees === 0) {
    return debutNouveau === 0
      ? { genre: "suppr", debut: 1, fin: 1, haut: true }
      : { genre: "suppr", debut: debutNouveau, fin: debutNouveau };
  }
  return { genre: supprimees === 0 ? "ajout" : "modif", debut: debutNouveau + 1, fin: debutNouveau + ajoutees };
}

/** Marques de la marge : texte de HEAD (`avant`) contre le texte de l'éditeur (`apres`). */
export function marquesDiff(avant: string, apres: string): Marque[] {
  const a = lignesDe(avant);
  const b = lignesDe(apres);
  if (a.length > MAX_LIGNES_MARGE || b.length > MAX_LIGNES_MARGE) return [];
  let prefixe = 0;
  while (prefixe < a.length && prefixe < b.length && a[prefixe] === b[prefixe]) prefixe++;
  let suffixe = 0;
  while (
    suffixe < a.length - prefixe &&
    suffixe < b.length - prefixe &&
    a[a.length - 1 - suffixe] === b[b.length - 1 - suffixe]
  ) {
    suffixe++;
  }
  const milieuA = a.slice(prefixe, a.length - suffixe);
  const milieuB = b.slice(prefixe, b.length - suffixe);
  if (!milieuA.length && !milieuB.length) return [];
  const ids = new Map<string, number>();
  const id = (ligne: string) => {
    let n = ids.get(ligne);
    if (n === undefined) {
      n = ids.size;
      ids.set(ligne, n);
    }
    return n;
  };
  const ops = scriptMyers(milieuA.map(id), milieuB.map(id));
  if (!ops) return [marqueDeBloc(prefixe, milieuA.length, milieuB.length)];
  const marques: Marque[] = [];
  let j = 0;
  let bloc: { debut: number; moins: number; plus: number } | null = null;
  const fermer = () => {
    if (bloc) marques.push(marqueDeBloc(prefixe + bloc.debut, bloc.moins, bloc.plus));
    bloc = null;
  };
  for (const op of ops) {
    if (op === "=") {
      fermer();
      j++;
      continue;
    }
    if (!bloc) bloc = { debut: j, moins: 0, plus: 0 };
    if (op === "-") bloc.moins++;
    else {
      bloc.plus++;
      j++;
    }
  }
  fermer();
  return marques;
}
