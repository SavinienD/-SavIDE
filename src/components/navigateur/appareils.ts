// tailles d'écran du navigateur intégré et calcul de la zone de la vue native.
// Module sans React (testé par node).

export type AppareilId = "bureau" | "tablette" | "telephone";

export const APPAREILS: { id: AppareilId; libelle: string; icone: string; largeur: number | null; hauteur: number | null }[] = [
  { id: "bureau", libelle: "Bureau (toute la largeur)", icone: "solar:monitor-linear", largeur: null, hauteur: null },
  { id: "tablette", libelle: "Tablette (820 × 1180)", icone: "solar:tablet-linear", largeur: 820, hauteur: 1180 },
  { id: "telephone", libelle: "Téléphone (390 × 844)", icone: "solar:smartphone-linear", largeur: 390, hauteur: 844 },
];

export type Rect = { left: number; top: number; width: number; height: number };

/** Zone de la page (pixels CSS de l'interface) : toute la place pour « bureau », sinon la
 *  taille de l'appareil (à la largeur CSS de la page, donc × zoom de la page), centrée et
 *  bornée à la place disponible. */
export function zonePage(place: Rect, appareil: AppareilId, zoomPage: number): Rect {
  const a = APPAREILS.find((x) => x.id === appareil) ?? APPAREILS[0];
  if (!a.largeur || !a.hauteur) return { ...place };
  const z = Number.isFinite(zoomPage) && zoomPage > 0 ? zoomPage : 1;
  const largeur = Math.min(place.width, a.largeur * z);
  const hauteur = Math.min(place.height, a.hauteur * z);
  return {
    left: place.left + Math.max(0, (place.width - largeur) / 2),
    top: place.top,
    width: largeur,
    height: hauteur,
  };
}

/** Pixels CSS de l'interface → pixels logiques de la fenêtre (zoom de l'interface, Ctrl +). */
export function versLogique(r: Rect, zoomInterface: number): { x: number; y: number; largeur: number; hauteur: number } {
  const z = Number.isFinite(zoomInterface) && zoomInterface > 0 ? zoomInterface : 1;
  const arrondi = (n: number) => Math.round(n * z * 100) / 100;
  return { x: arrondi(r.left), y: arrondi(r.top), largeur: arrondi(r.width), hauteur: arrondi(r.height) };
}

export const ZOOMS_PAGE = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** Palier de zoom suivant (+1) ou précédent (-1). */
export function zoomVoisin(actuel: number, sens: 1 | -1): number {
  if (sens > 0) return ZOOMS_PAGE.find((z) => z > actuel + 0.001) ?? ZOOMS_PAGE[ZOOMS_PAGE.length - 1];
  return [...ZOOMS_PAGE].reverse().find((z) => z < actuel - 0.001) ?? ZOOMS_PAGE[0];
}
