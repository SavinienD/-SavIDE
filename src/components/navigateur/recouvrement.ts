// la page du navigateur est une vue native posée AU-DESSUS de l'interface :
// un menu, une fenêtre ou une bulle de l'interface qui passe sur l'onglet serait caché
// dessous. Tant qu'un tel élément recouvre la zone, la vue native est cachée.
// Module sans React (testé par node).
import type { Rect } from "./appareils";

/** Éléments de l'interface qui flottent au-dessus du reste. */
export const SELECTEUR_FLOTTANTS = [
  "[role='dialog']",
  "[role='menu']",
  "[role='listbox']",
  "[role='tooltip']",
  "[aria-modal='true']",
  ".axe-tree-overlay",
  ".fenetre-onglet",
  ".volet-flottant",
  ".menu-onglet-fichier",
  "[data-recouvre-navigateur]",
].join(", ");

export function seCoupent(a: Rect, b: Rect): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
    a.left < b.left + b.width && b.left < a.left + a.width &&
    a.top < b.top + b.height && b.top < a.top + a.height;
}

/** Vrai si un des rectangles flottants passe sur la zone. */
export function zoneRecouverte(zone: Rect, flottants: Rect[]): boolean {
  return flottants.some((r) => seCoupent(zone, r));
}

/** Rectangles des éléments flottants visibles du document (hors de l'onglet lui-même). */
export function rectsFlottants(doc: Document, onglet: Element | null): Rect[] {
  const sortie: Rect[] = [];
  doc.querySelectorAll(SELECTEUR_FLOTTANTS).forEach((el) => {
    if (onglet && (onglet.contains(el) || el.contains(onglet))) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) sortie.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  });
  return sortie;
}
