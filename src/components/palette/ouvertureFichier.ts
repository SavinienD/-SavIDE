// Lot palette — ouvrir un fichier choisi dans Ctrl+P, au besoin dans une autre colonne de
// l'éditeur (Ctrl+Entrée). Fonctions pures sur l'état des colonnes (chat/colonnes.ts),
// testées par tests/paletteFichiers.test.cjs.
import { deplacer, trouver, type EtatColonnes } from "../chat/colonnes";
import type { WorkspaceEntry } from "../../types";

/** Entrée d'arbre minimale pour ouvrir un fichier par son chemin relatif. */
export function entreeFichier(chemin: string): WorkspaceEntry {
  const nom = chemin.split("/").pop() || chemin;
  return { name: nom, relativePath: chemin, absolutePath: "", kind: "file", hasChildren: false };
}

/** Colonne « à côté » de `depuis` : celle de droite, sinon celle de gauche, sinon une nouvelle. */
export function colonneVoisine(nb: number, depuis: number): number {
  if (nb <= 1) return nb;
  return depuis + 1 < nb ? depuis + 1 : depuis - 1;
}

/**
 * Une fois l'onglet de `chemin` rangé par l'éditeur, il passe dans la colonne voisine de
 * celle qui avait le focus au moment de Ctrl+Entrée (`depuis`) : à droite, à gauche, ou
 * dans une nouvelle colonne s'il n'y en a qu'une.
 */
export function versColonneVoisine(etat: EtatColonnes<string>, chemin: string, depuis: number): EtatColonnes<string> {
  const ou = trouver(etat.colonnes, chemin);
  if (!ou) return etat;
  const cible = colonneVoisine(etat.colonnes.length, Math.min(Math.max(0, depuis), etat.colonnes.length - 1));
  if (cible === ou[0]) return etat;
  return deplacer(etat, chemin, cible);
}
