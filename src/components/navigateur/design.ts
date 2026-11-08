// Lot 186 — Design Mode : texte envoyé à la conversation pour l'élément choisi dans la
// page (sélecteur, taille, styles utiles, HTML tronqué). Module sans React (testé par node).
import type { ElementChoisi } from "./navigateurApi";

/** Styles montrés, dans cet ordre ; les valeurs par défaut sans intérêt sont omises. */
const STYLES_UTILES = [
  "display", "position", "width", "height", "margin", "padding", "color", "background-color",
  "border", "border-radius", "font-family", "font-size", "font-weight", "line-height",
  "text-align", "gap", "flex-direction", "justify-content", "align-items",
  "grid-template-columns", "box-shadow", "opacity", "z-index",
];
const SANS_INTERET: Record<string, string[]> = {
  position: ["static"],
  margin: ["0px"],
  padding: ["0px"],
  "background-color": ["rgba(0, 0, 0, 0)", "transparent"],
  border: ["0px none", "0px none rgb(0, 0, 0)", "none"],
  "border-radius": ["0px"],
  gap: ["normal"],
  "flex-direction": ["row"],
  "justify-content": ["normal"],
  "align-items": ["normal"],
  "grid-template-columns": ["none"],
  "box-shadow": ["none"],
  opacity: ["1"],
  "z-index": ["auto"],
  "text-align": ["start"],
};

export function stylesUtiles(styles: Record<string, string>): [string, string][] {
  const sortie: [string, string][] = [];
  for (const nom of STYLES_UTILES) {
    const v = (styles[nom] ?? "").trim();
    if (!v) continue;
    if (SANS_INTERET[nom]?.some((d) => v === d || v.startsWith(`${d} `))) continue;
    sortie.push([nom, v]);
  }
  return sortie;
}

function bloc(code: string): string {
  // Une clôture plus longue que tout ce que contient le HTML : le bloc ne se casse jamais.
  const plusLong = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const cloture = "`".repeat(plusLong + 1);
  return `${cloture}html\n${code}\n${cloture}`;
}

/** Texte prêt pour la saisie du chat (l'utilisateur ajoute sa demande ensuite). */
export function texteElement(e: ElementChoisi): string {
  const lignes = [`Élément choisi dans le navigateur${e.url ? ` (${e.url})` : ""} :`];
  if (e.selecteur) lignes.push(`- Sélecteur : \`${e.selecteur.replace(/`/g, "'")}\``);
  lignes.push(`- Taille : ${Math.round(e.largeur)} × ${Math.round(e.hauteur)} px, position ${Math.round(e.x)}, ${Math.round(e.y)}`);
  const texte = e.texte.trim();
  if (texte) lignes.push(`- Texte : « ${texte} »`);
  const styles = stylesUtiles(e.styles);
  if (styles.length) lignes.push(`- Styles : ${styles.map(([n, v]) => `${n}: ${v}`).join(" ; ")}`);
  if (e.html.trim()) lignes.push("", bloc(e.html.trim()));
  return lignes.join("\n") + "\n\n";
}

/** Libellé court de la carte : `button.primaire` 120 × 32. */
export function resumeElement(e: ElementChoisi): string {
  const id = e.attributs.id ? `#${e.attributs.id}` : "";
  const classes = (e.attributs.class ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join("");
  return `${e.balise}${id}${classes}`;
}
