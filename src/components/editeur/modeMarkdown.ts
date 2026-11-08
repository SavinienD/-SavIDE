// Affichage d'un fichier Markdown : source, côte à côte (source + aperçu) ou
// aperçu seul ; mémorisé par fichier (chemin absolu), borné aux MAX_MODES plus récents. Le choix
// « Rendu / Code » d'avant (lib/vueFichier.ts) est relu et tenu à jour (aperçu = rendu).

import { memoriserVue, vueMemorisee } from "../../lib/vueFichier";

export type ModeMarkdown = "source" | "cote" | "apercu";
export const CLE_MODES_MARKDOWN = "axecode.modesMarkdown";
const MAX_MODES = 400;
const MODES: ModeMarkdown[] = ["source", "cote", "apercu"];

function lire(): Record<string, ModeMarkdown> {
  try {
    const brut = localStorage.getItem(CLE_MODES_MARKDOWN);
    const valeur = brut ? JSON.parse(brut) : {};
    return valeur && typeof valeur === "object" && !Array.isArray(valeur) ? valeur : {};
  } catch {
    return {};
  }
}

/** Mode choisi pour ce fichier, sinon null (défaut du type de fichier). */
export function modeMarkdownMemorise(chemin: string): ModeMarkdown | null {
  const mode = lire()[chemin];
  if (MODES.includes(mode)) return mode;
  const vue = vueMemorisee(chemin);
  return vue === null ? null : vue ? "apercu" : "source";
}

export function memoriserModeMarkdown(chemin: string, mode: ModeMarkdown): void {
  try {
    const modes = lire();
    delete modes[chemin];
    modes[chemin] = mode; // dernier inséré = plus récent
    const cles = Object.keys(modes);
    for (const cle of cles.slice(0, Math.max(0, cles.length - MAX_MODES))) delete modes[cle];
    localStorage.setItem(CLE_MODES_MARKDOWN, JSON.stringify(modes));
  } catch {
    /* stockage indisponible : le choix vaut pour la session */
  }
  memoriserVue(chemin, mode === "apercu");
}
