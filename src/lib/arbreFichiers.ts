// axe:explorateur — fonctions pures de l'explorateur de fichiers (chemins, tri, clavier).
// Testées par tests/explorateur.test.cjs ; FileTree.tsx les utilise.

export type CleTri = "nom" | "date" | "taille";
export type TriExplorateur = {
  cle: CleTri;
  sens: "croissant" | "decroissant";
  dossiersDabord: boolean;
};

export const TRI_PAR_DEFAUT: TriExplorateur = {
  cle: "nom",
  sens: "croissant",
  dossiersDabord: true,
};

export const CLE_STOCKAGE_TRI = "axe:explorateur-tri";

type EntreeTriable = {
  name: string;
  kind: "file" | "directory";
  modifiedMs?: number | null;
  size?: number | null;
};

/** Retire le préfixe de chemin long Windows (« \\?\C:\… » -> « C:\… », « \\?\UNC\srv\… » -> « \\srv\… »). */
export function cheminAffiche(chemin: string): string {
  const unc = /^(?:\\\\\?\\|\/\/\?\/)UNC[\\/](.*)$/i.exec(chemin);
  if (unc) return `\\\\${unc[1]}`;
  return chemin.replace(/^(?:\\\\\?\\|\/\/\?\/)/, "");
}

/** Chemin relatif au dossier ouvert, avec le séparateur du système (« \ » sous Windows). */
export function cheminRelatifSysteme(relatif: string, windows: boolean): string {
  return windows ? relatif.replace(/\//g, "\\") : relatif;
}

const collateur =
  typeof Intl !== "undefined"
    ? new Intl.Collator("fr", { numeric: true, sensitivity: "base" })
    : null;

function comparerNoms(a: string, b: string): number {
  return collateur ? collateur.compare(a, b) : a.localeCompare(b);
}

/** Trie une liste d'entrées d'un même dossier (sans la modifier). */
export function trierEntrees<T extends EntreeTriable>(
  entrees: readonly T[],
  tri: TriExplorateur,
): T[] {
  const signe = tri.sens === "decroissant" ? -1 : 1;
  return [...entrees].sort((a, b) => {
    if (tri.dossiersDabord && a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    let ecart = 0;
    if (tri.cle === "date") ecart = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0);
    else if (tri.cle === "taille") ecart = (a.size ?? 0) - (b.size ?? 0);
    if (ecart === 0) ecart = comparerNoms(a.name, b.name);
    return ecart * signe;
  });
}

/** Lit le tri mémorisé (valeurs invalides -> tri par défaut). */
export function lireTri(brut: string | null | undefined): TriExplorateur {
  if (!brut) return { ...TRI_PAR_DEFAUT };
  try {
    const v = JSON.parse(brut) as Partial<TriExplorateur>;
    return {
      cle: v.cle === "date" || v.cle === "taille" ? v.cle : "nom",
      sens: v.sens === "decroissant" ? "decroissant" : "croissant",
      dossiersDabord: v.dossiersDabord !== false,
    };
  } catch {
    return { ...TRI_PAR_DEFAUT };
  }
}

export type ToucheCopie = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/**
 * Raccourci de copie de chemin : Ctrl+C (Cmd+C sur macOS) = chemin absolu,
 * Ctrl+Shift+C (Cmd+Shift+C) = chemin relatif au dossier ouvert.
 */
export function raccourciCopieChemin(
  e: ToucheCopie,
  mac: boolean,
): "absolu" | "relatif" | null {
  const commande = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!commande || e.altKey || e.key.toLowerCase() !== "c") return null;
  return e.shiftKey ? "relatif" : "absolu";
}

/** Libellé du raccourci affiché dans le menu contextuel. */
export function libelleRaccourci(relatif: boolean, mac: boolean): string {
  if (mac) return relatif ? "⇧⌘C" : "⌘C";
  return relatif ? "Ctrl+Maj+C" : "Ctrl+C";
}

/** Touches de navigation gérées par actionClavier (hors Entrée). */
export const TOUCHES_NAVIGATION = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];

export type LigneVisible = { relativePath: string; kind: "file" | "directory" };

export type ActionClavier =
  | { type: "selectionner"; relativePath: string }
  | { type: "deplier"; relativePath: string }
  | { type: "replier"; relativePath: string }
  | { type: "ouvrir"; relativePath: string }
  | null;

function parent(relatif: string): string | null {
  const i = relatif.lastIndexOf("/");
  return i > 0 ? relatif.slice(0, i) : null;
}

/**
 * Navigation clavier dans l'arbre (lignes visibles dans l'ordre affiché) :
 * haut/bas = ligne précédente/suivante, Début/Fin = première/dernière,
 * droite = déplier (ou descendre au premier enfant), gauche = replier (ou remonter au parent),
 * Entrée = ouvrir (fichier) ou déplier/replier (dossier).
 */
export function actionClavier(
  lignes: readonly LigneVisible[],
  courant: string | null,
  touche: string,
  estDeplie: (relativePath: string) => boolean,
): ActionClavier {
  if (!lignes.length) return null;
  const i = courant === null ? -1 : lignes.findIndex((l) => l.relativePath === courant);
  const choisir = (j: number): ActionClavier => ({
    type: "selectionner",
    relativePath: lignes[Math.max(0, Math.min(lignes.length - 1, j))].relativePath,
  });
  switch (touche) {
    case "ArrowDown":
      return choisir(i < 0 ? 0 : i + 1);
    case "ArrowUp":
      return choisir(i < 0 ? 0 : i - 1);
    case "Home":
      return choisir(0);
    case "End":
      return choisir(lignes.length - 1);
  }
  if (i < 0) return null;
  const ligne = lignes[i];
  if (touche === "ArrowRight") {
    if (ligne.kind !== "directory") return null;
    if (!estDeplie(ligne.relativePath)) return { type: "deplier", relativePath: ligne.relativePath };
    const suivant = lignes[i + 1];
    return suivant && parent(suivant.relativePath) === ligne.relativePath
      ? { type: "selectionner", relativePath: suivant.relativePath }
      : null;
  }
  if (touche === "ArrowLeft") {
    if (ligne.kind === "directory" && estDeplie(ligne.relativePath)) {
      return { type: "replier", relativePath: ligne.relativePath };
    }
    const p = parent(ligne.relativePath);
    return p ? { type: "selectionner", relativePath: p } : null;
  }
  if (touche === "Enter") return { type: "ouvrir", relativePath: ligne.relativePath };
  return null;
}
