// Image modifiée depuis le dernier commit (avant / après) : type de l'image d'après
// ses premiers octets, cadre commun aux deux versions, position de la glissière.
// Pur : testé par tests/editeurImageAvantApres.test.cjs.

export type Taille = { l: number; h: number };

const PAR_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon", cur: "image/x-icon", heic: "image/heic", heif: "image/heif",
};

/** Type de l'image d'après ses premiers octets, sinon d'après l'extension du nom. */
export function typeImage(o: ArrayLike<number>, nom: string): string {
  const a = (i: number) => o[i] ?? -1;
  const texte = (debut: number, s: string) => [...s].every((c, i) => a(debut + i) === c.charCodeAt(0));
  if (a(0) === 0x89 && texte(1, "PNG")) return "image/png";
  if (a(0) === 0xff && a(1) === 0xd8 && a(2) === 0xff) return "image/jpeg";
  if (texte(0, "GIF8")) return "image/gif";
  if (texte(0, "RIFF") && texte(8, "WEBP")) return "image/webp";
  if (texte(0, "BM")) return "image/bmp";
  if (texte(4, "ftypavif") || texte(4, "ftypavis")) return "image/avif";
  if (a(0) === 0 && a(1) === 0 && (a(2) === 1 || a(2) === 2) && a(3) === 0) return "image/x-icon";
  const ext = (nom.split(".").pop() ?? "").toLowerCase();
  return PAR_EXTENSION[ext] ?? "image/png";
}

/** Même chose depuis le contenu en base64 (seuls les premiers octets sont décodés). */
export function typeImageBase64(base64: string, nom: string): string {
  let octets: number[] = [];
  try {
    octets = [...atob(base64.slice(0, 24))].map((c) => c.charCodeAt(0));
  } catch {
    octets = [];
  }
  return typeImage(octets, nom);
}

/**
 * Cadre commun de la glissière : la plus grande largeur et la plus grande hauteur des deux
 * versions, réduit pour tenir dans la zone (48 px de marge, 40 px pour le curseur), jamais agrandi.
 */
export function cadreCommun(avant: Taille | null, apres: Taille | null, zone: Taille): Taille | null {
  const connues = [avant, apres].filter((t): t is Taille => Boolean(t && t.l > 0 && t.h > 0));
  if (!connues.length) return null;
  const l = Math.max(...connues.map((t) => t.l));
  const h = Math.max(...connues.map((t) => t.h));
  const echelle = Math.min(1, Math.max(0.01, (zone.l - 48) / l), Math.max(0.01, (zone.h - 88) / h));
  return { l: Math.max(1, Math.round(l * echelle)), h: Math.max(1, Math.round(h * echelle)) };
}

/** Position (0 à 100 %) de la glissière sous le pointeur. */
export function positionGlissiere(x: number, gauche: number, largeur: number): number {
  if (!(largeur > 0)) return 50;
  return Math.min(100, Math.max(0, ((x - gauche) / largeur) * 100));
}
