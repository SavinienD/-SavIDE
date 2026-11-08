// Images d'un fichier Markdown : collées (presse-papiers) ou déposées (explorateur
// du système) dans l'éditeur, enregistrées dans `images/` à côté du .md, lien inséré ; et
// affichage des images à chemin relatif dans l'aperçu. Pur : testé par tests/editeurImages.test.cjs.

export const EXTENSIONS_IMAGES = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "image/bmp": "bmp", "image/avif": "avif",
};

export function extensionDe(chemin: string): string {
  const nom = chemin.split(/[\\/]/).pop() ?? "";
  const point = nom.lastIndexOf(".");
  return point > 0 ? nom.slice(point + 1).toLowerCase() : "";
}

export function estCheminImage(chemin: string): boolean {
  return EXTENSIONS_IMAGES.includes(extensionDe(chemin));
}

/** Extension d'une image collée d'après son type (png, jpg…), sinon null. */
export function extensionDuType(type: string): string | null {
  return TYPES[type.split(";")[0].trim().toLowerCase()] ?? null;
}

/** « 20261108-143012 » (heure locale). */
export function horodatage(d: Date): string {
  const n = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
}

/** Nom (sans extension) d'une image collée : le nom du fichier s'il en a un vrai, sinon image-<date>. */
export function nomImageCollee(nomFichier: string | undefined, date: Date): string {
  const tige = (nomFichier ?? "").replace(/\.[^.]*$/, "").trim();
  if (!tige || /^(image|blob|unnamed|sans titre|untitled)$/i.test(tige)) return `image-${horodatage(date)}`;
  return tige;
}

/** Texte alternatif tiré du nom du fichier enregistré (« images/capture-ecran.png » -> « capture ecran »). */
export function texteAlternatif(relatif: string): string {
  const nom = relatif.split("/").pop() ?? "";
  return nom.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ").trim() || "image";
}

/** Lien Markdown d'une image (destination entre <> si elle contient un espace ou une parenthèse). */
export function lienImage(relatif: string, alt = texteAlternatif(relatif)): string {
  const altSur = alt.replace(/[[\]]/g, "");
  const destination = /[\s()<>]/.test(relatif) ? `<${relatif.replace(/[<>]/g, "")}>` : relatif;
  return `![${altSur}](${destination})`;
}

/** Dossier qui contient le fichier (même séparateur que le chemin). */
export function dossierDe(chemin: string): string {
  const i = Math.max(chemin.lastIndexOf("/"), chemin.lastIndexOf("\\"));
  return i > 0 ? chemin.slice(0, i) : "";
}

/**
 * Adresse d'une image de l'aperçu : les adresses web et data: restent, un chemin relatif est
 * résolu depuis le dossier du .md puis passé au protocole des fichiers locaux (`convertir`).
 */
export function sourceImage(src: string | undefined, dossier: string, convertir: (chemin: string) => string): string | undefined {
  if (!src) return src;
  if (/^(https?:|data:|blob:|asset:|tauri:)/i.test(src) || src.startsWith("//")) return src;
  let chemin = src.split(/[?#]/)[0];
  try {
    chemin = decodeURI(chemin);
  } catch {
    // adresse mal encodée : gardée telle quelle
  }
  const absolu = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(chemin);
  if (!absolu && !dossier) return src;
  const separateur = dossier.includes("\\") ? "\\" : "/";
  const complet = absolu ? chemin : `${dossier}${separateur}${chemin.replace(/^\.\//, "").replace(/[\\/]/g, separateur)}`;
  return convertir(complet);
}
