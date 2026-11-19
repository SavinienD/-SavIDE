// bascule — bascule de fournisseur : quand le fournisseur d'une conversation reste en panne
// (ou atteint la limite de son abonnement), le tour continue avec le même modèle chez un
// fournisseur de secours que l'utilisateur a désigné pour CE fournisseur. Éteinte par défaut.
// Réglage dans `repl-settings.json` (champ `bascule`, lu par le service à chaque tour).
// Partie pure testée par tests/bascule.test.cjs.

export type BasculeReglage = {
  enabled: boolean;
  /** Fournisseur → fournisseurs de secours, essayés dans cet ordre. */
  secours: Record<string, string[]>;
};

export const BASCULE_ETEINTE: BasculeReglage = { enabled: false, secours: {} };

/** Réglage lu tel quel dans `repl-settings.json` (absent ou abîmé : éteint, aucun secours). */
export function lireBascule(valeur: unknown): BasculeReglage {
  const v = (valeur ?? {}) as { enabled?: unknown; secours?: unknown };
  const secours: Record<string, string[]> = {};
  if (v.secours && typeof v.secours === "object") {
    for (const [fournisseur, liste] of Object.entries(v.secours as Record<string, unknown>)) {
      if (!Array.isArray(liste)) continue;
      const propre = nettoyer(fournisseur, liste.filter((x): x is string => typeof x === "string"));
      if (propre.length > 0) secours[fournisseur.trim()] = propre;
    }
  }
  return { enabled: v.enabled === true, secours };
}

function nettoyer(fournisseur: string, liste: readonly string[]): string[] {
  const sortie: string[] = [];
  for (const brut of liste) {
    const id = brut.trim();
    if (id && id !== fournisseur.trim() && !sortie.includes(id)) sortie.push(id);
  }
  return sortie;
}

/** Ajoute `secours` à la fin de la liste de `fournisseur` (jamais lui-même, jamais en double). */
export function ajouterSecours(r: BasculeReglage, fournisseur: string, secours: string): BasculeReglage {
  const liste = nettoyer(fournisseur, [...(r.secours[fournisseur] ?? []), secours]);
  return { ...r, secours: { ...r.secours, [fournisseur]: liste } };
}

/** Retire `secours` de la liste de `fournisseur` (liste vide : le fournisseur disparaît). */
export function retirerSecours(r: BasculeReglage, fournisseur: string, secours: string): BasculeReglage {
  const liste = (r.secours[fournisseur] ?? []).filter((x) => x !== secours);
  const tous = { ...r.secours };
  if (liste.length > 0) tous[fournisseur] = liste;
  else delete tous[fournisseur];
  return { ...r, secours: tous };
}

/** Monte `secours` d'un rang dans la liste de `fournisseur`. */
export function monterSecours(r: BasculeReglage, fournisseur: string, secours: string): BasculeReglage {
  const liste = [...(r.secours[fournisseur] ?? [])];
  const i = liste.indexOf(secours);
  if (i <= 0) return r;
  [liste[i - 1], liste[i]] = [liste[i], liste[i - 1]];
  return { ...r, secours: { ...r.secours, [fournisseur]: liste } };
}

/** Secours encore proposables pour `fournisseur` parmi les fournisseurs configurés. */
export function secoursPossibles(r: BasculeReglage, fournisseur: string, configures: readonly string[]): string[] {
  const deja = new Set(r.secours[fournisseur] ?? []);
  return configures.filter((id) => id !== fournisseur && !deja.has(id));
}

/** Texte court de l'avis montré dans la conversation à chaque bascule (sans prix). */
export function texteBascule(de: string, vers: string, nom: (id: string) => string = (id) => id): string {
  return `Fournisseur ${nom(de)} indisponible : suite du travail sur ${nom(vers)}`;
}

/** `meta.bascule` d'une partie de message (posé par le service sur la réponse du secours). */
export function basculeDeMeta(meta: unknown): { de: string; vers: string } | null {
  const b = (meta as { bascule?: { de?: unknown; vers?: unknown } } | null | undefined)?.bascule;
  return b && typeof b.de === "string" && typeof b.vers === "string" && b.de && b.vers
    ? { de: b.de, vers: b.vers }
    : null;
}
