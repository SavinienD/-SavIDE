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
