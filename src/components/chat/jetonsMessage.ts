// couleurs — découpe un texte de message en segments colorés : commande slash
// en tête (/goal, /heartbeat… : couleur d'accent ; /goal et /heartbeat aussi au milieu ou après une autre commande), skills (/nom-du-skill : violet),
// fichiers mentionnés (@chemin). Module pur (sans React) : partagé par le
// compositeur (calque sous la zone de saisie) et la bulle du message envoyé.

export type GenreJeton = "texte" | "commande" | "skill" | "fichier";
export type SegmentJeton = { genre: GenreJeton; texte: string };

const FIN_JETON = /[\s.,;:!?)\]}'"`]/;

/** commandes reconnues aussi au milieu du message (première occurrence), comme le service. */
export const COMMANDES_PARTOUT = ["goal", "heartbeat", "nonstop"] as const;

export type CommandeTrouvee = { nom: string; debut: number; fin: number };

/**
 * Commandes que le service interprète, dans l'ordre du texte : celle du début du message (toute
 * commande connue), puis la première occurrence de chaque commande de COMMANDES_PARTOUT (autre
 * que celle du début) placée après elle, précédée d'un blanc (ou du début) et suivie d'un blanc
 * (ou de la fin). Ex. « /autonomous /goal finir » : /autonomous et /goal. Même règle que le
 * service (session_commands::parse_slashes).
 */
export function commandesInterpretees(texte: string, commandes: readonly string[]): CommandeTrouvee[] {
  const trouvees: CommandeTrouvee[] = [];
  let depuis = 0;
  const tete = /^\s*\/([a-z][a-z0-9_-]*)/i.exec(texte);
  if (tete) {
    const nom = tete[1].toLowerCase();
    const fin = tete[0].length;
    if (commandes.includes(nom) && (fin === texte.length || /\s/.test(texte[fin]))) {
      trouvees.push({ nom, debut: fin - tete[1].length - 1, fin });
      depuis = fin;
    }
  }
  for (const nom of COMMANDES_PARTOUT) {
    if (!commandes.includes(nom) || trouvees.some((t) => t.nom === nom)) continue;
    const motif = new RegExp(`(^|\\s)\\/${nom}(?=\\s|$)`, "gi");
    motif.lastIndex = depuis;
    const m = motif.exec(texte);
    if (!m) continue;
    const debut = m.index + m[1].length;
    trouvees.push({ nom, debut, fin: debut + 1 + nom.length });
  }
  return trouvees.sort((a, b) => a.debut - b.debut);
}

/** Première commande interprétée (voir commandesInterpretees), ou null. */
export function commandeInterpretee(texte: string, commandes: readonly string[]): [number, number] | null {
  const premiere = commandesInterpretees(texte, commandes)[0];
  return premiere ? [premiere.debut, premiere.fin] : null;
}

/**
 * Commandes à proposer (dans l'ordre de `commandes`) pour le jeton « /requete » qui commence à
 * `debut` dans `texte` : celles qui commencent par la requête (sauf le nom exact déjà tapé) et que
 * le service interpréterait à cet endroit une fois complétées. En tête du message : toutes ; après
 * un blanc ailleurs : /goal et /heartbeat, s'ils n'y sont pas déjà. Une commande proposée est donc
 * toujours colorée une fois choisie.
 */
export function commandesAProposer(
  texte: string,
  debut: number,
  requete: string,
  commandes: readonly string[],
): string[] {
  if (texte[debut] !== "/" || !/^[a-z0-9_-]*$/i.test(requete)) return [];
  const q = requete.toLowerCase();
  const avant = texte.slice(0, debut);
  const apres = texte.slice(debut + 1 + requete.length);
  const blanc = /^\s/.test(apres) ? "" : " ";
  return commandes.filter((nom) => {
    if (!nom.startsWith(q) || nom === q) return false;
    const complete = `${avant}/${nom}${blanc}${apres}`;
    return commandesInterpretees(complete, commandes).some((c) => c.nom === nom && c.debut === debut);
  });
}

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

  // Commandes que le service interprète (en tête, puis /goal et /heartbeat ailleurs).
  for (const c of commandesInterpretees(texte, commandes)) zones.push({ debut: c.debut, fin: c.fin, genre: "commande" });

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
