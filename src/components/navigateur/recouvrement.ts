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

/** Un élément monté mais invisible (opacité 0, visibility hidden, display none d'un parent,
 *  hors écran ou passé sous autre chose) ne doit pas cacher la page : sinon, en mode
 *  « Bureau » (toute la largeur), un menu ou une bulle cachés suffisent à masquer la page
 *  alors que la zone étroite « Téléphone » y échappe. */
export function reellementVisible(doc: Document, el: Element, r: Rect): boolean {
  const vue = doc.defaultView;
  if (vue) {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = vue.getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) === 0) return false;
    }
    const l = Math.max(0, r.left), t = Math.max(0, r.top);
    const rr = Math.min(vue.innerWidth, r.left + r.width), b = Math.min(vue.innerHeight, r.top + r.height);
    if (rr <= l || b <= t) return false;
  }
  if (typeof doc.elementFromPoint !== "function") return true;
  // Au moins un point de l'élément est bien au premier plan de l'interface.
  const pts: [number, number][] = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
  return pts.some(([fx, fy]) => {
    const x = r.left + r.width * fx, y = r.top + r.height * fy;
    const haut = doc.elementFromPoint(x, y);
    return !!haut && (el === haut || el.contains(haut));
  });
}

/** Rectangles des éléments flottants visibles du document (hors de l'onglet lui-même). */
export function rectsFlottants(doc: Document, onglet: Element | null): Rect[] {
  const sortie: Rect[] = [];
  doc.querySelectorAll(SELECTEUR_FLOTTANTS).forEach((el) => {
    if (onglet && (onglet.contains(el) || el.contains(onglet))) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && reellementVisible(doc, el, r)) sortie.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  });
  return sortie;
}
