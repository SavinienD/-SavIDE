// depot — glisser-déposer de fichiers depuis le système (Finder, Explorateur).
// Tauri donne la position du dépôt en pixels PHYSIQUES ; les rectangles de la page
// sont en pixels CSS. Sur un écran Retina (×2) ou Windows à 150 %, sans conversion,
// le point tombe à côté du champ du chat et le dépôt est ignoré.

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
