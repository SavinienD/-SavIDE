// Revue des changements : blocs du diff Monaco -> lignes choisies (numéros côté ancien / nouveau).
// Module pur (testé par tests/revueSelection.test.cjs).

/** Un bloc du diff tel que Monaco le rend (ILineChange) : une fin à 0 = côté vide,
 *  le début est alors la ligne d'avant. */
export type Bloc = {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
};

export type Cote = "ancien" | "nouveau";
export type Lignes = { anciennes: number[]; nouvelles: number[] };

export function plage(debut: number, fin: number): number[] {
  const sortie: number[] = [];
  for (let n = Math.max(1, debut); n <= fin; n += 1) sortie.push(n);
  return sortie;
}

function bornes(b: Bloc, cote: Cote): [number, number] {
  return cote === "ancien"
    ? [b.originalStartLineNumber, b.originalEndLineNumber]
    : [b.modifiedStartLineNumber, b.modifiedEndLineNumber];
}

/** Toutes les lignes d'un bloc. */
export function lignesDuBloc(b: Bloc): Lignes {
  return {
    anciennes: b.originalEndLineNumber > 0 ? plage(b.originalStartLineNumber, b.originalEndLineNumber) : [],
    nouvelles: b.modifiedEndLineNumber > 0 ? plage(b.modifiedStartLineNumber, b.modifiedEndLineNumber) : [],
  };
}

/** Lignes choisies par une sélection [debut, fin] d'un côté du diff. Comme VS Code :
 *  un bloc touché prend les lignes choisies de ce côté, et de l'autre côté les lignes
 *  en face (même nombre de lignes) ou tout le bloc ; un côté vide (ajout ou suppression
 *  pure) est pris si la sélection touche sa position. */
export function lignesDeSelection(blocs: readonly Bloc[], cote: Cote, debut: number, fin: number): Lignes {
  const [s, e] = debut <= fin ? [debut, fin] : [fin, debut];
  const ici: number[] = [];
  const enFace: number[] = [];
  const autre: Cote = cote === "ancien" ? "nouveau" : "ancien";
  for (const b of blocs) {
    const [d, f] = bornes(b, cote);
    const [od, of] = bornes(b, autre);
    if (f === 0) {
      // Rien de ce côté : le bloc est entre les lignes d et d + 1.
      if (s <= d + 1 && e >= d && of > 0) enFace.push(...plage(od, of));
      continue;
    }
    const is = Math.max(s, d);
    const ie = Math.min(e, f);
    if (is > ie) continue;
    ici.push(...plage(is, ie));
    if (of === 0) continue;
    if (of - od === f - d) enFace.push(...plage(od + (is - d), od + (ie - d)));
    else enFace.push(...plage(od, of));
  }
  const unique = (l: number[]) => Array.from(new Set(l)).sort((a, b) => a - b);
  return cote === "ancien"
    ? { anciennes: unique(ici), nouvelles: unique(enFace) }
    : { anciennes: unique(enFace), nouvelles: unique(ici) };
}

/** Index du bloc qui contient la ligne (ou qui la touche quand ce côté est vide), sinon -1. */
export function blocALaLigne(blocs: readonly Bloc[], cote: Cote, ligne: number): number {
  return blocs.findIndex((b) => {
    const [d, f] = bornes(b, cote);
    return f === 0 ? ligne === d || ligne === d + 1 : ligne >= d && ligne <= f;
  });
}

/** Première ligne affichée d'un bloc d'un côté (pour y placer le curseur). */
export function ligneDuBloc(b: Bloc, cote: Cote): number {
  const [d, f] = bornes(b, cote);
  return f === 0 ? Math.max(1, d) : d;
}

/** Bloc suivant (sens 1) ou précédent (-1) par rapport à une ligne, en boucle. */
export function blocVoisin(blocs: readonly Bloc[], cote: Cote, ligne: number, sens: 1 | -1): number {
  if (!blocs.length) return -1;
  if (sens === 1) {
    const i = blocs.findIndex((b) => ligneDuBloc(b, cote) > ligne);
    return i >= 0 ? i : 0;
  }
  for (let i = blocs.length - 1; i >= 0; i -= 1) {
    const b = blocs[i];
    const [d, f] = bornes(b, cote);
    if ((f === 0 ? d : f) < ligne) return i;
  }
  return blocs.length - 1;
}

/** Nombre de lignes ajoutées / retirées d'après les blocs. */
export function compteurs(blocs: readonly Bloc[]): { ajouts: number; suppressions: number } {
  let ajouts = 0;
  let suppressions = 0;
  for (const b of blocs) {
    if (b.modifiedEndLineNumber > 0) ajouts += b.modifiedEndLineNumber - b.modifiedStartLineNumber + 1;
    if (b.originalEndLineNumber > 0) suppressions += b.originalEndLineNumber - b.originalStartLineNumber + 1;
  }
  return { ajouts, suppressions };
}
