// choix du modèle du chat : groupes (fournisseur, puis compte), recherche
// et place de la liste. Fonctions pures, testées par tests/menuModeles.test.cjs.

/** Au-delà de ce nombre de modèles, un champ de recherche apparaît en tête de liste. */
export const SEUIL_RECHERCHE = 12;
/** Marge gardée entre la liste et le bord de la fenêtre, et écart avec le bouton (px). */
export const MARGE_FENETRE = 8;
export const ECART_BOUTON = 8;
/** En dessous de cette hauteur au-dessus du bouton, la liste s'ouvre vers le bas s'il y a plus de place. */
export const HAUTEUR_CONFORT = 320;

export type EntreeMenu = {
  value: string;
  provider: string;
  label: string;
  providerLabel?: string;
  /** Compte du fournisseur (plusieurs abonnements) : e-mail montré sous le nom du groupe. */
  accountLabel?: string;
};

export type GroupeMenu<T extends EntreeMenu> = {
  cle: string;
  titre: string;
  sousTitre: string | null;
  modeles: T[];
};

function normaliser(texte: string): string {
  return texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Modèles dont le nom, l'identifiant, le fournisseur ou le compte contient tous les mots tapés. */
export function filtrerModeles<T extends EntreeMenu>(
  modeles: readonly T[],
  texte: string,
  titreFournisseur: (provider: string) => string = (p) => p,
): T[] {
  const mots = normaliser(texte).split(/\s+/).filter(Boolean);
  if (!mots.length) return [...modeles];
  return modeles.filter((m) => {
    const botte = normaliser(
      [m.label, m.value, m.providerLabel ?? "", titreFournisseur(m.provider), m.accountLabel ?? ""].join(" "),
    );
    return mots.every((mot) => botte.includes(mot));
  });
}

/** Groupes consécutifs : un par fournisseur (et par compte quand il y en a plusieurs). */
export function groupesModeles<T extends EntreeMenu>(
  modeles: readonly T[],
  titreFournisseur: (provider: string, entree: T) => string,
): GroupeMenu<T>[] {
  const groupes: GroupeMenu<T>[] = [];
  for (const m of modeles) {
    const dernier = groupes[groupes.length - 1];
    if (dernier && dernier.cle === m.provider) {
      dernier.modeles.push(m);
      continue;
    }
    groupes.push({
      cle: m.provider,
      titre: titreFournisseur(m.provider, m),
      sousTitre: m.accountLabel?.trim() || null,
      modeles: [m],
    });
  }
  return groupes;
}

export type PlacementMenu = { direction: "haut" | "bas"; hauteurMax: number };

/** `zone` : haut et bas de la place utilisable (la colonne du chat, sous la barre de titre, et
 *  jamais hors de la fenêtre). Liste ouverte au-dessus du bouton (le compositeur est en bas), sauf s'il y a trop peu de
 *  place au-dessus et plus en dessous ; hauteur bornée à la place disponible. */
export function placementMenu(
  bouton: { top: number; bottom: number },
  zone: { haut: number; bas: number },
): PlacementMenu {
  const dessus = Math.max(0, bouton.top - zone.haut - ECART_BOUTON - MARGE_FENETRE);
  const dessous = Math.max(0, zone.bas - bouton.bottom - ECART_BOUTON - MARGE_FENETRE);
  const direction = dessus >= HAUTEUR_CONFORT || dessus >= dessous ? "haut" : "bas";
  return { direction, hauteurMax: Math.floor(direction === "haut" ? dessus : dessous) };
}
