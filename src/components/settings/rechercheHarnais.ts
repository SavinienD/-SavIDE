// Réglages > Harnais : recherche d'un mot dans les titres et contenus des entrées
// (notes de prompt, mémoires, skills, sous-agents), sans tenir compte de la casse ni des accents.

import type { HarnessEntry } from "./harnessApi";

/** Forme comparable, caractère par caractère (même longueur que le texte : les positions servent au surlignage). */
export function plier(texte: string): string {
  let out = "";
  for (const c of texte.split("")) out += (c.normalize("NFD")[0] ?? c).toLowerCase();
  return out;
}

/** Positions [début, fin) de chaque occurrence de `mot` dans `texte`. */
export function occurrences(texte: string, mot: string): [number, number][] {
  const m = plier(mot.trim());
  if (!m) return [];
  const t = plier(texte);
  const out: [number, number][] = [];
  for (let i = t.indexOf(m); i >= 0; i = t.indexOf(m, i + m.length)) out.push([i, i + m.length]);
  return out;
}

/** Extrait du contenu autour de la première occurrence (avec « … » aux coupures), ou null. */
export function extrait(texte: string, mot: string, avant = 60, apres = 120): string | null {
  const [premiere] = occurrences(texte, mot);
  if (!premiere) return null;
  const debut = Math.max(0, premiere[0] - avant);
  const fin = Math.min(texte.length, premiere[1] + apres);
  const plat = texte.slice(debut, fin).replace(/\s+/g, " ").trim();
  return `${debut > 0 ? "… " : ""}${plat}${fin < texte.length ? " …" : ""}`;
}

/** Entrées dont le titre ou le contenu contient le mot (titre d'abord, puis le plus récent). */
export function chercher(entrees: HarnessEntry[], mot: string): HarnessEntry[] {
  if (!mot.trim()) return [];
  const dansTitre = (e: HarnessEntry) => occurrences(e.title, mot).length > 0;
  return entrees
    .filter((e) => dansTitre(e) || occurrences(e.body, mot).length > 0)
    .sort((a, b) => Number(dansTitre(b)) - Number(dansTitre(a)) || b.updated - a.updated);
}
