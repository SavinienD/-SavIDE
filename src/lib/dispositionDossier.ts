// Disposition de l'espace PAR DOSSIER : largeur des volets de gauche et de droite (chat),
// partage de la colonne de gauche, volets réduits, terminal (affiché, plein, hauteur).
// Chaque dossier garde la sienne dans le stockage local ; on la retrouve en y revenant,
// quelle que soit la façon d'y aller (Ctrl+1…9, barre des dossiers, accueil, palette)
// et après un redémarrage de l'appli.

export type DispositionDossier = {
  /** Largeur du volet de gauche (px). */
  gauche: number;
  /** Largeur du volet de droite, le chat (px). */
  droite: number;
  /** Part du haut de la colonne de gauche (0…1). */
  partageHaut: number;
  gaucheReduite: boolean;
  droiteReduite: boolean;
  /** Panneau du terminal monté (caché ou affiché). */
  terminalDisponible: boolean;
  terminalOuvert: boolean;
  terminalPleineHauteur: boolean;
  /** Hauteur du terminal (px). */
  terminalHauteur: number;
};

type Stockage = Pick<Storage, "getItem" | "setItem">;

export const DISPOSITION_DEFAUT: DispositionDossier = {
  gauche: 280,
  droite: 420,
  partageHaut: 0.55,
  gaucheReduite: false,
  droiteReduite: false,
  terminalDisponible: false,
  terminalOuvert: false,
  terminalPleineHauteur: false,
  terminalHauteur: 240,
};

/** Bornes de lecture : une valeur hors bornes (stockage abîmé) reprend la valeur par défaut. */
const LARGEUR_MIN = 120;
const LARGEUR_MAX = 8000;
const HAUTEUR_MIN = 60;
const HAUTEUR_MAX = 8000;

// Anciennes clés (volets réduits pour tous les dossiers) : seulement lues, comme valeur de
// départ d'un dossier qui n'a pas encore de disposition à lui.
const ANCIENNE_GAUCHE_REDUITE = "axe:volet-gauche-reduit";
const ANCIENNE_DROITE_REDUITE = "axe:volet-droit-reduit";

export function cleDisposition(chemin: string): string {
  return `axe:v2:disposition:${chemin}`;
}

function nombre(v: unknown, min: number, max: number, defaut: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : defaut;
}

function booleen(v: unknown, defaut: boolean): boolean {
  return typeof v === "boolean" ? v : defaut;
}

function lire(stockage: Stockage | null | undefined, cle: string): string | null {
  try {
    return stockage?.getItem(cle) ?? null;
  } catch {
    return null;
  }
}

/** Disposition de départ d'un dossier qui n'en a pas encore. */
export function dispositionDepart(stockage: Stockage | null | undefined): DispositionDossier {
  return {
    ...DISPOSITION_DEFAUT,
    gaucheReduite: lire(stockage, ANCIENNE_GAUCHE_REDUITE) === "1",
    droiteReduite: lire(stockage, ANCIENNE_DROITE_REDUITE) === "1",
  };
}

/** Relit (et valide champ par champ) la disposition d'un dossier. */
export function lireDisposition(stockage: Stockage | null | undefined, chemin: string): DispositionDossier {
  const defaut = dispositionDepart(stockage);
  const brut = lire(stockage, cleDisposition(chemin));
  if (!brut) return defaut;
  let d: Record<string, unknown>;
  try {
    const v = JSON.parse(brut);
    if (!v || typeof v !== "object" || Array.isArray(v)) return defaut;
    d = v as Record<string, unknown>;
  } catch {
    return defaut;
  }
  const terminalDisponible = booleen(d.terminalDisponible, defaut.terminalDisponible);
  return {
    gauche: nombre(d.gauche, LARGEUR_MIN, LARGEUR_MAX, defaut.gauche),
    droite: nombre(d.droite, LARGEUR_MIN, LARGEUR_MAX, defaut.droite),
    partageHaut: nombre(d.partageHaut, 0.01, 0.99, defaut.partageHaut),
    gaucheReduite: booleen(d.gaucheReduite, defaut.gaucheReduite),
    droiteReduite: booleen(d.droiteReduite, defaut.droiteReduite),
    terminalDisponible,
    // Un terminal affiché suppose son panneau monté.
    terminalOuvert: terminalDisponible && booleen(d.terminalOuvert, defaut.terminalOuvert),
    terminalPleineHauteur: booleen(d.terminalPleineHauteur, defaut.terminalPleineHauteur),
    terminalHauteur: nombre(d.terminalHauteur, HAUTEUR_MIN, HAUTEUR_MAX, defaut.terminalHauteur),
  };
}

/** Note la disposition d'un dossier (stockage plein ou interdit : elle vit le temps de la session). */
export function ecrireDisposition(stockage: Stockage | null | undefined, chemin: string, d: DispositionDossier): void {
  try {
    stockage?.setItem(cleDisposition(chemin), JSON.stringify(d));
  } catch {
    /* stockage indisponible */
  }
}

/** Le stockage local de la page, s'il est accessible. */
export function stockageLocal(): Stockage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
