// cases à cocher de l'aperçu Markdown : « - [ ] » <-> « - [x] » sur UNE ligne
// de la source (numéro donné par l'analyseur : les fausses cases d'un bloc de code n'en ont pas).
// Rien d'autre ne change : ni le reste de la ligne, ni les fins de ligne (CRLF gardé).

const CASE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])\]/;

/** Colonne (base 0) du caractère de la case dans la ligne, et sa nouvelle valeur ; null si pas de case. */
export function caseDansLigne(ligne: string): { colonne: number; actuel: string; nouveau: string } | null {
  const m = CASE.exec(ligne);
  if (!m) return null;
  const actuel = m[2];
  return { colonne: m[1].length, actuel, nouveau: actuel === " " ? "x" : " " };
}

/** Bascule la case de la ligne `numero` (base 1) de `texte` ; null si cette ligne n'a pas de case. */
export function basculerCase(texte: string, numero: number): string | null {
  if (!Number.isInteger(numero) || numero < 1) return null;
  let debut = 0;
  for (let i = 1; i < numero; i += 1) {
    const n = texte.indexOf("\n", debut);
    if (n < 0) return null;
    debut = n + 1;
  }
  let fin = texte.indexOf("\n", debut);
  if (fin < 0) fin = texte.length;
  const ligne = texte.slice(debut, fin).replace(/\r$/, "");
  const c = caseDansLigne(ligne);
  if (!c) return null;
  const pos = debut + c.colonne;
  return texte.slice(0, pos) + c.nouveau + texte.slice(pos + 1);
}
