// fournisseurs-178 — modèles d'un fournisseur configurable : l'IDENTIFIANT est le nom
// exact envoyé au fournisseur (ex. « qwen3:8b » pour Ollama), le NOM AFFICHÉ n'est qu'un
// libellé (vide = identifiant). Validation, renommage, fusion de « Découvrir ».
// Fonctions pures, sans dépendance (testées par tests/fournisseursModeles.test.cjs).

/** Erreur par ligne : identifiant vide ou en double (espaces de début et de fin ignorés). */
export function erreursIdentifiants(modeles: readonly { id: string }[]): Record<number, string> {
  const erreurs: Record<number, string> = {};
  const vus = new Map<string, number>();
  modeles.forEach((m, i) => {
    const id = m.id.trim();
    if (!id) {
      erreurs[i] = "Identifiant obligatoire";
      return;
    }
    const premier = vus.get(id);
    if (premier === undefined) {
      vus.set(id, i);
      return;
    }
    erreurs[i] = `Identifiant en double : ${id}`;
    erreurs[premier] ??= `Identifiant en double : ${id}`;
  });
  return erreurs;
}

/** Au moins une ligne invalide dans l'un des fournisseurs. */
export function modelesInvalides(fournisseurs: readonly { models: readonly { id: string }[] }[]): boolean {
  return fournisseurs.some((f) => Object.keys(erreursIdentifiants(f.models)).length > 0);
}

/** « Saisir » : message d'erreur pour l'identifiant tapé, sinon null. */
export function erreurNouvelIdentifiant(modeles: readonly { id: string }[], id: string): string | null {
  const v = id.trim();
  if (!v) return "Identifiant obligatoire";
  if (modeles.some((m) => m.id.trim() === v)) return `Identifiant en double : ${v}`;
  return null;
}

/** Nouvel identifiant pour la ligne `index`. Un nom affiché égal à l'ancien identifiant
 *  est vidé : il suit alors l'identifiant (nom affiché par défaut). */
export function renommerModele<T extends { id: string; label: string }>(
  modeles: readonly T[],
  index: number,
  id: string,
): T[] {
  return modeles.map((m, i) => {
    if (i !== index) return m;
    const suit = m.label.trim() !== "" && m.label.trim() === m.id.trim();
    return { ...m, id, label: suit ? "" : m.label };
  });
}

/** Identifiants nettoyés (espaces) avant l'enregistrement. */
export function identifiantsNettoyes<T extends { id: string; label: string }>(modeles: readonly T[]): T[] {
  return modeles.map((m) => ({ ...m, id: m.id.trim(), label: m.label.trim() }));
}

/** Surcharge « Imposé » (clé `fournisseur:modèle`) déplacée avec le modèle renommé. */
export function deplacerSurcharge<T>(
  surcharges: Record<string, T>,
  fournisseur: string,
  ancien: string,
  nouveau: string,
): Record<string, T> {
  if (!fournisseur || ancien === nouveau) return surcharges;
  const a = `${fournisseur}:${ancien}`;
  const n = `${fournisseur}:${nouveau}`;
  if (!(a in surcharges) || n in surcharges) return surcharges;
  const reste = { ...surcharges };
  const valeur = reste[a];
  delete reste[a];
  reste[n] = valeur;
  return reste;
}

// fenetre-locale — fenêtre par défaut d'un modèle ajouté (même règle que le Rust :
// axecode_core::default_context_window_for). Ollama réserve la mémoire de toute la fenêtre
// (num_ctx) : à 128 000 jetons, qwen3:4b prenait 22 Go. Toujours modifiable ensuite.
export const FENETRE_CLOUD = 128000;
export const FENETRE_LOCALE = 32768;
export const SORTIE_MAX = 16384;

/** Adresse de ce PC : localhost, 127.x.x.x, [::1], 0.0.0.0 (avec ou sans schéma, port, chemin). */
export function estUrlLocale(url: string): boolean {
  const u = url.trim();
  const reste = u.includes("://") ? u.slice(u.indexOf("://") + 3) : u;
  let hote = reste.split(/[/?#]/)[0] ?? "";
  hote = (hote.includes("@") ? hote.slice(hote.lastIndexOf("@") + 1) : hote).toLowerCase();
  const nom = hote.startsWith("[") ? hote.slice(0, hote.indexOf("]") + 1) : hote.split(":")[0];
  return nom === "localhost" || nom.startsWith("127.") || nom === "[::1]" || nom === "0.0.0.0";
}

/** Serveur de modèles local : Ollama / LM Studio (`typeLocal`), ou point d'accès compatible
 *  OpenAI sur ce PC. Un compatible Anthropic sur localhost (compteur de coûts) reste cloud. */
export function fournisseurLocal(kind: string, typeLocal: boolean, baseUrl: string): boolean {
  return typeLocal || (kind !== "anthropic_compatible" && estUrlLocale(baseUrl));
}

/** Local : 32 768, ou moins si le serveur annonce moins ; cloud : l'annonce, sinon 128 000. */
export function fenetreParDefaut(local: boolean, annoncee?: number | null): number {
  const a = annoncee && annoncee > 0 ? Math.floor(annoncee) : null;
  if (local) return a ? Math.min(a, FENETRE_LOCALE) : FENETRE_LOCALE;
  return a ?? FENETRE_CLOUD;
}

/** Sortie maximale par défaut : 16 384, jamais plus de la moitié de la fenêtre. */
export function sortieParDefaut(fenetre: number): number {
  return Math.min(SORTIE_MAX, Math.max(1, Math.floor(fenetre / 2)));
}

/** « Découvrir » avec un début d'identifiant tapé : seuls les modèles dont
 *  l'identifiant commence pareil (sans tenir compte de la casse) ; rien de tapé = tous. */
export function filtrerDecouverte<T extends { id: string }>(trouves: readonly T[], debut: string): T[] {
  const d = debut.trim().toLowerCase();
  if (!d) return [...trouves];
  return trouves.filter((m) => m.id.trim().toLowerCase().startsWith(d));
}

/** des modifications non enregistrées (fournisseurs ou contextes imposés) ? */
export function modificationsEnCours(
  brouillons: readonly unknown[],
  enregistres: readonly unknown[],
  surcharges: unknown,
  surchargesEnregistrees: unknown,
): boolean {
  return JSON.stringify(brouillons) !== JSON.stringify(enregistres) || JSON.stringify(surcharges ?? {}) !== JSON.stringify(surchargesEnregistrees ?? {});
}

/** modèles restants après « Retirer la sélection » (rangs cochés). */
export function retirerRangs<T>(modeles: readonly T[], rangs: ReadonlySet<number>): T[] {
  return modeles.filter((_, i) => !rangs.has(i));
}

/** « Découvrir » : les identifiants réels rendus par le serveur, dans son ordre ; un modèle
 *  déjà déclaré garde ses réglages ; ceux que le serveur ne liste pas restent en fin de liste. */
export function fusionnerDecouverte<T extends { id: string }>(existants: readonly T[], trouves: readonly T[]): T[] {
  const connus = new Map(existants.map((m) => [m.id.trim(), m]));
  const ids = new Set(trouves.map((m) => m.id.trim()));
  const fusion = trouves.map((m) => connus.get(m.id.trim()) ?? m);
  for (const m of existants) if (!ids.has(m.id.trim())) fusion.push(m);
  return fusion;
}
