// Réglages de l'éditeur de fichiers (Réglages > Éditeur) :
// sauvegarde automatique, retour à la ligne, minimap. Gardés sur ce poste (localStorage),
// lus par chaque colonne d'éditeur et suivis en direct (autre fenêtre comprise).

export type SauvegardeAuto = "desactivee" | "delai" | "quitter";

export type ReglagesEditeur = {
  /** désactivée ; après 1 s sans saisie ; en quittant l'onglet (autre onglet, clic ailleurs, fermeture). */
  sauvegardeAuto: SauvegardeAuto;
  retourLigne: boolean;
  minimap: boolean;
};

export const CLE_REGLAGES_EDITEUR = "axecode.reglagesEditeur";
/** « Après 1 s » : délai depuis la dernière frappe. */
export const DELAI_SAUVEGARDE_MS = 1000;
export const REGLAGES_EDITEUR_DEFAUT: ReglagesEditeur = {
  sauvegardeAuto: "desactivee",
  retourLigne: false,
  minimap: false,
};

const MODES: SauvegardeAuto[] = ["desactivee", "delai", "quitter"];
let cache: ReglagesEditeur | null = null;
const abonnes = new Set<(r: ReglagesEditeur) => void>();

/** Valeurs lues (stockage illisible ou ancien : défaut champ par champ). */
export function normaliserReglagesEditeur(brut: unknown): ReglagesEditeur {
  const o = brut && typeof brut === "object" ? (brut as Record<string, unknown>) : {};
  const mode = MODES.includes(o.sauvegardeAuto as SauvegardeAuto)
    ? (o.sauvegardeAuto as SauvegardeAuto)
    : REGLAGES_EDITEUR_DEFAUT.sauvegardeAuto;
  return {
    sauvegardeAuto: mode,
    retourLigne: typeof o.retourLigne === "boolean" ? o.retourLigne : REGLAGES_EDITEUR_DEFAUT.retourLigne,
    minimap: typeof o.minimap === "boolean" ? o.minimap : REGLAGES_EDITEUR_DEFAUT.minimap,
  };
}

export function lireReglagesEditeur(): ReglagesEditeur {
  if (cache) return cache;
  let brut: unknown = null;
  try {
    const texte = typeof localStorage !== "undefined" ? localStorage.getItem(CLE_REGLAGES_EDITEUR) : null;
    brut = texte ? JSON.parse(texte) : null;
  } catch {
    brut = null;
  }
  cache = normaliserReglagesEditeur(brut);
  return cache;
}

function prevenir(): void {
  const r = lireReglagesEditeur();
  for (const f of [...abonnes]) f(r);
}

export function changerReglagesEditeur(partiel: Partial<ReglagesEditeur>): ReglagesEditeur {
  cache = normaliserReglagesEditeur({ ...lireReglagesEditeur(), ...partiel });
  try {
    localStorage.setItem(CLE_REGLAGES_EDITEUR, JSON.stringify(cache));
  } catch {
    // stockage indisponible : le réglage vaut pour cette session
  }
  prevenir();
  return cache;
}

/** Abonnement aux changements ; renvoie la fonction de retrait. */
export function ecouterReglagesEditeur(f: (r: ReglagesEditeur) => void): () => void {
  abonnes.add(f);
  return () => {
    abonnes.delete(f);
  };
}

/** Relit le stockage (autre fenêtre, tests). */
export function rechargerReglagesEditeur(): void {
  cache = null;
  prevenir();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key === CLE_REGLAGES_EDITEUR) rechargerReglagesEditeur();
  });
}

/** Options de Monaco qui suivent les réglages. */
export function optionsMonaco(r: ReglagesEditeur): { wordWrap: "on" | "off"; minimap: { enabled: boolean } } {
  return { wordWrap: r.retourLigne ? "on" : "off", minimap: { enabled: r.minimap } };
}
