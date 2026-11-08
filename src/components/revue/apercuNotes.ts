// Revue des changements : texte choisi dans l'aperçu Markdown -> lignes de la source.
// Module pur (testé par tests/revueApercu.test.cjs).

/** Ligne de source sans la syntaxe Markdown courante (titres, citations, listes, emphase, code, liens). */
export function texteSansMarkdown(ligne: string): string {
  return ligne
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normal(t: string): string {
  return t.replace(/[*_`~]+/g, "").replace(/\s+/g, " ").trim();
}

/** Premières lettres utiles d'une ligne choisie (assez pour être unique, sans dépasser la ligne). */
function amorce(t: string): string {
  return normal(t).slice(0, 48);
}

/** Lignes (1 = première) de la source qui contiennent le début et la fin du texte choisi, ou null. */
export function lignesDansSource(source: string, choisi: string): { debut: number; fin: number } | null {
  const lignesChoisies = choisi.split(/\r?\n/).map(normal).filter(Boolean);
  if (!lignesChoisies.length) return null;
  const lignes = source.split(/\r?\n/).map(texteSansMarkdown);
  const premiere = amorce(lignesChoisies[0]);
  const debut = lignes.findIndex((l) => premiere && l.includes(premiere));
  if (debut < 0) return null;
  const derniere = amorce(lignesChoisies[lignesChoisies.length - 1]);
  let fin = debut;
  if (lignesChoisies.length > 1) {
    const j = lignes.findIndex((l, i) => i >= debut && derniere && l.includes(derniere));
    if (j >= 0) fin = j;
  }
  return { debut: debut + 1, fin: fin + 1 };
}
