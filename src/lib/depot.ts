// depot — glisser-déposer de fichiers depuis le système (Finder, Explorateur).
// Tauri donne la position du dépôt relative à la fenêtre ; les rectangles de la page
// sont en pixels CSS. Sous Windows elle est en pixels physiques (à diviser par
// l'échelle, ex. 150 %), sur macOS et Linux déjà en points logiques (voir echelleDepot).

export type Point = { x: number; y: number };
export type Rect = { left: number; right: number; top: number; bottom: number };

/** Point physique → point CSS (échelle de l'écran, puis zoom de l'interface). */
export function pointCss(p: Point, echelle: number, zoom: number = 1): Point {
  const e = echelle > 0 && Number.isFinite(echelle) ? echelle : 1;
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return { x: p.x / e / z, y: p.y / e / z };
}

export function dansRect(p: Point | null, r: Rect | null | undefined): boolean {
  if (!p || !r) return false;
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** Dépôt sans chemin : vignette de capture de macOS (fichier pas encore écrit) ou contenu non fichier. */
export function messageDepotVide(mac: boolean): string {
  return mac
    ? "Rien à joindre : la vignette de capture n’est pas encore un fichier. Attendez qu’elle soit enregistrée puis glissez le fichier depuis le Finder ou le Bureau, ou copiez la capture (⌃⇧⌘4) et collez-la ici avec ⌘V."
    : "Rien à joindre : seuls les fichiers peuvent être déposés. Pour une image, copiez-la puis collez-la avec Ctrl+V.";
}

/**
 * Échelle à appliquer à la position donnée par Tauri (onDragDropEvent).
 * Tauri l'annonce « physique », mais wry ne la fournit en pixels physiques que sous
 * Windows (ScreenToClient). Sur macOS (draggingLocation de NSView) et Linux (GTK),
 * c'est déjà un point logique : le diviser par le facteur d'échelle (2 sur Retina)
 * envoie le point vers le haut à gauche, et seul un coin en bas à droite du chat
 * reste « dessus ».
 */
export function echelleDepot(windows: boolean, facteur: number | null | undefined): number {
  if (!windows) return 1;
  return facteur && facteur > 0 && Number.isFinite(facteur) ? facteur : 1;
}

/**
 * Zone sous le point : la plus petite qui le contient (une conversation détachée,
 * posée devant les colonnes, l'emporte sur la colonne qu'elle recouvre).
 */
export function zoneSous<T>(p: Point | null, zones: { cle: T; rect: Rect }[]): T | null {
  let meilleure: { cle: T; aire: number } | null = null;
  for (const z of zones) {
    if (!dansRect(p, z.rect)) continue;
    const aire = (z.rect.right - z.rect.left) * (z.rect.bottom - z.rect.top);
    if (!meilleure || aire < meilleure.aire) meilleure = { cle: z.cle, aire };
  }
  return meilleure ? meilleure.cle : null;
}
