// Lot palette (P4) — couleurs git de l'explorateur : état de chaque fichier (modifié, nouveau,
// ignoré, en conflit) et d'un dossier (le plus important de ce qu'il contient). Module pur,
// testé par tests/explorateurGit.test.cjs.

export type EtatGitBrut = "modifie" | "nouveau" | "ignore" | "conflit" | "supprime";
export type EtatGit = "modifie" | "nouveau" | "ignore" | "conflit";
export type FichierGit = { chemin: string; etat: EtatGitBrut };

export type CarteGit = {
  fichiers: Map<string, EtatGit>;
  /** État propagé aux dossiers parents (conflit > modifié > nouveau). */
  dossiers: Map<string, EtatGit>;
  /** Dossiers entiers non suivis (« nouveau ») ou ignorés, sans « / » final. */
  entiers: { prefixe: string; etat: EtatGit }[];
};

const RANG: Record<EtatGit, number> = { ignore: 0, nouveau: 1, modifie: 2, conflit: 3 };

function plusFort(a: EtatGit | undefined, b: EtatGit): EtatGit {
  return a && RANG[a] >= RANG[b] ? a : b;
}

/** Carte de l'état git à partir de la liste du système (chemins relatifs, « / »). */
export function carteGit(liste: readonly FichierGit[]): CarteGit {
  const fichiers = new Map<string, EtatGit>();
  const dossiers = new Map<string, EtatGit>();
  const entiers: CarteGit["entiers"] = [];
  for (const { chemin, etat: brut } of liste) {
    // Un fichier supprimé n'est plus dans l'arbre : seuls ses dossiers le montrent (modifiés).
    const etat: EtatGit = brut === "supprime" ? "modifie" : brut;
    const entier = chemin.endsWith("/");
    const propre = chemin.replace(/\/+$/, "");
    if (!propre) continue;
    if (entier) entiers.push({ prefixe: propre, etat });
    else if (brut !== "supprime") fichiers.set(propre, etat);
    if (etat === "ignore") {
      if (entier) dossiers.set(propre, "ignore");
      continue;
    }
    if (entier) dossiers.set(propre, plusFort(dossiers.get(propre), etat));
    // Les dossiers parents prennent l'état le plus important de leur contenu.
    let i = propre.lastIndexOf("/");
    while (i > 0) {
      const parent = propre.slice(0, i);
      dossiers.set(parent, plusFort(dossiers.get(parent), etat));
      i = parent.lastIndexOf("/");
    }
  }
  return { fichiers, dossiers, entiers };
}

/** État à afficher pour une entrée de l'arbre (null : rien de particulier). */
export function etatDe(carte: CarteGit | null | undefined, chemin: string, dossier: boolean): EtatGit | null {
  if (!carte) return null;
  const propre = chemin.replace(/\\/g, "/").replace(/\/+$/, "");
  const direct = dossier ? carte.dossiers.get(propre) : carte.fichiers.get(propre);
  if (direct) return direct;
  // Dans un dossier entier non suivi ou ignoré : même état que lui.
  for (const e of carte.entiers) {
    if (propre === e.prefixe || propre.startsWith(e.prefixe + "/")) return e.etat;
  }
  return null;
}

export const LIBELLES_GIT: Record<EtatGit, { lettre: string; titre: string }> = {
  modifie: { lettre: "M", titre: "Modifié (git)" },
  nouveau: { lettre: "N", titre: "Nouveau, pas encore suivi par git" },
  ignore: { lettre: "", titre: "Ignoré par git (.gitignore)" },
  conflit: { lettre: "C", titre: "En conflit (git)" },
};
