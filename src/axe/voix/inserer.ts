/**
 * voix — insertion du texte dicté dans la zone de saisie : à la place de
 * la sélection (ou au curseur), avec des espaces propres autour. Le texte n'est
 * jamais envoyé : l'utilisateur le relit et l'envoie lui-même.
 */
export function insererTexteDicte(
  texte: string,
  debut: number,
  fin: number,
  dicte: string,
): { valeur: string; curseur: number } {
  const a = Math.max(0, Math.min(Number.isFinite(debut) ? debut : texte.length, texte.length));
  const b = Math.max(a, Math.min(Number.isFinite(fin) ? fin : a, texte.length));
  let ajout = dicte.trim();
  if (!ajout) return { valeur: texte, curseur: b };
  const avant = texte.slice(0, a);
  const apres = texte.slice(b);
  if (avant && !/\s$/.test(avant)) ajout = ` ${ajout}`;
  if (apres && !/^\s/.test(apres) && !/^[.,;:!?)\]]/.test(apres)) ajout = `${ajout} `;
  return { valeur: avant + ajout + apres, curseur: avant.length + ajout.length };
}

/**
 * Remplace un texte dicté déjà inséré (nettoyage IA arrivé après coup), seulement si la
 * saisie est restée telle qu'après l'insertion : sinon null, ce que l'utilisateur a tapé
 * ou déplacé entre-temps prime. `curseur` = position rendue par insererTexteDicte.
 */
export function remplacerTexteDicte(
  courant: string,
  apresInsertion: string,
  curseur: number,
  ancien: string,
  nouveau: string,
): { valeur: string; curseur: number } | null {
  const a = ancien.trim();
  const n = nouveau.trim();
  if (courant !== apresInsertion || !a || !n) return null;
  let fin = -1;
  if (apresInsertion.slice(curseur - a.length, curseur) === a) fin = curseur;
  else if (apresInsertion.slice(curseur - 1 - a.length, curseur - 1) === a) fin = curseur - 1;
  if (fin < 0) return null;
  const valeur = apresInsertion.slice(0, fin - a.length) + n + apresInsertion.slice(fin);
  return { valeur, curseur: curseur + n.length - a.length };
}

/** 75 000 ms -> « 1:15 ». */
export function formaterDuree(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const secondes = total % 60;
  return `${minutes}:${secondes.toString().padStart(2, "0")}`;
}
