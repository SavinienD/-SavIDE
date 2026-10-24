// axe:couleurs — découpe un texte de message en segments colorés : commande slash
// en tête (/goal, /heartbeat… : couleur d'accent), skills (/nom-du-skill : violet),
// fichiers mentionnés (@chemin). Module pur (sans React) : partagé par le
// compositeur (calque sous la zone de saisie) et la bulle du message envoyé.

export type GenreJeton = "texte" | "commande" | "skill" | "fichier";
export type SegmentJeton = { genre: GenreJeton; texte: string };

const FIN_JETON = /[\s.,;:!?)\]}'"`]/;

function finDeJeton(texte: string, fin: number): boolean {
  const apres = texte[fin] ?? "";
  return apres === "" || FIN_JETON.test(apres);
}

/**
 * Segments dont la concaténation redonne exactement `texte` (indispensable pour
 * le calque du compositeur, qui doit tomber caractère pour caractère sous la saisie).
 */
export function decouperJetons(
  texte: string,
  commandes: readonly string[] = [],
  skills: readonly string[] = [],
  fichiers: readonly string[] = [],
): SegmentJeton[] {
  type Zone = { debut: number; fin: number; genre: GenreJeton };
  const zones: Zone[] = [];

  // Commande : seulement en tête du message (c'est ainsi qu'elle est interprétée).
  const tete = /^\s*\/([a-z][a-z0-9_-]*)/i.exec(texte);
  if (tete) {
    const nom = tete[1].toLowerCase();
    const fin = tete[0].length;
    if (commandes.includes(nom) && (fin === texte.length || /\s/.test(texte[fin]))) {
      zones.push({ debut: fin - tete[1].length - 1, fin, genre: "commande" });
    }
  }

  for (const nom of skills) {
    if (!nom) continue;
    const aiguille = `/${nom}`;
    let i = 0;
    while (i < texte.length) {
      const trouve = texte.indexOf(aiguille, i);
      if (trouve < 0) break;
      const avant = trouve === 0 ? "" : texte[trouve - 1];
      const fin = trouve + aiguille.length;
      if ((avant === "" || /\s/.test(avant)) && finDeJeton(texte, fin)) {
        zones.push({ debut: trouve, fin, genre: "skill" });
      }
      i = fin;
    }
  }

  for (const chemin of fichiers) {
    if (!chemin) continue;
    const aiguille = `@${chemin}`;
    let i = 0;
    while (i < texte.length) {
      const trouve = texte.indexOf(aiguille, i);
      if (trouve < 0) break;
      const fin = trouve + aiguille.length;
      if (finDeJeton(texte, fin)) zones.push({ debut: trouve, fin, genre: "fichier" });
      i = fin;
    }
  }

  if (zones.length === 0) return texte ? [{ genre: "texte", texte }] : [];
  // À position égale, la commande (poussée en premier) l'emporte ; pas de chevauchement.
  zones.sort((a, b) => a.debut - b.debut);
  const retenues: Zone[] = [];
  for (const z of zones) {
    if (retenues.length === 0 || z.debut >= retenues[retenues.length - 1].fin) retenues.push(z);
  }
  const segments: SegmentJeton[] = [];
  let curseur = 0;
  for (const z of retenues) {
    if (z.debut > curseur) segments.push({ genre: "texte", texte: texte.slice(curseur, z.debut) });
    segments.push({ genre: z.genre, texte: texte.slice(z.debut, z.fin) });
    curseur = z.fin;
  }
  if (curseur < texte.length) segments.push({ genre: "texte", texte: texte.slice(curseur) });
  return segments;
}

/** Classe CSS d'un segment coloré (null pour le texte simple). */
export function classeJeton(genre: GenreJeton): string | null {
  switch (genre) {
    case "commande":
      return "jeton-commande";
    case "skill":
      return "jeton-skill";
    case "fichier":
      return "mention-pill";
    default:
      return null;
  }
}
