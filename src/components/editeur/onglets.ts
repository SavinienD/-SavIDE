// Onglets de fichiers : règles pures (sans IPC), testées par tests/editeurOnglets.test.cjs.

import type { SauvegardeAuto } from "./reglagesEditeur";

type OngletMinimal<D> = {
  relativePath: string;
  buffer: string;
  dirty: boolean;
  external?: boolean;
  doc: D;
};

/**
 * Résultat d'un enregistrement appliqué aux onglets, retrouvé par son chemin (l'ordre a pu
 * changer pendant l'écriture). Si l'on a tapé pendant l'écriture, la saisie est gardée et
 * l'onglet reste à enregistrer (avant : le texte écrit remplaçait la frappe en cours).
 */
export function appliquerEnregistrement<D extends { content: string | null }, T extends OngletMinimal<D>>(
  onglets: T[],
  chemin: string,
  ecrit: string,
  doc: D,
): T[] {
  const i = onglets.findIndex((o) => o.relativePath === chemin);
  if (i < 0) return onglets;
  const o = onglets[i];
  const suite = onglets.slice();
  suite[i] =
    o.buffer === ecrit
      ? { ...o, doc, buffer: doc.content ?? o.buffer, dirty: false }
      : { ...o, doc, dirty: o.buffer !== (doc.content ?? "") };
  return suite;
}

/** Un onglet modifié qu'on ferme est enregistré d'abord si la sauvegarde automatique est active. */
export function doitSauverAvantFermeture(
  mode: SauvegardeAuto,
  onglet: { dirty: boolean; external?: boolean } | undefined,
): boolean {
  return Boolean(onglet && onglet.dirty && !onglet.external && mode !== "desactivee");
}

/** Pile des onglets fermés (le plus récent à la fin) : sans doublon, bornée à `max`. */
export function noterFermeture(pile: readonly string[], chemin: string, max = 30): string[] {
  const suite = pile.filter((c) => c !== chemin);
  suite.push(chemin);
  return suite.slice(Math.max(0, suite.length - max));
}

/** Dernier onglet fermé qui n'est pas déjà rouvert ; la pile perd cette entrée (et celles déjà ouvertes). */
export function reprendreFermeture(
  pile: readonly string[],
  ouverts: readonly string[],
): { chemin: string | null; pile: string[] } {
  const suite = pile.slice();
  while (suite.length) {
    const chemin = suite.pop() as string;
    if (!ouverts.includes(chemin)) return { chemin, pile: suite };
  }
  return { chemin: null, pile: suite };
}

/**
 * « Fermer tous les fichiers » : les onglets modifiés restent ouverts si la sauvegarde
 * automatique est désactivée (rien n'est perdu sans le vouloir) ; sinon tout se ferme
 * (chaque onglet modifié est enregistré avant).
 */
export function partagerFermetureTous<T extends { dirty: boolean; external?: boolean }>(
  onglets: readonly T[],
  mode: SauvegardeAuto,
): { garder: T[]; fermer: T[] } {
  const garder: T[] = [];
  const fermer: T[] = [];
  for (const o of onglets) {
    if (o.dirty && !o.external && mode === "desactivee") garder.push(o);
    else fermer.push(o);
  }
  return { garder, fermer };
}
