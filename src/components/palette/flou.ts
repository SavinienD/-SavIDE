// Lot palette — recherche approximative des palettes (Ctrl+P, Ctrl+K) : les lettres tapées
// dans l'ordre, sans tenir compte de la casse ni des accents. Le nom du fichier compte plus
// que ses dossiers ; plusieurs mots séparés par des espaces sont tous requis. Module pur,
// testé par tests/paletteFichiers.test.cjs.

const ASCII = /^[\x00-\x7f]*$/;

/** Forme comparable, caractère par caractère : même longueur que le texte (positions de surlignage). */
export function plier(texte: string): string {
  // Texte ASCII (presque tous les chemins) : même résultat, beaucoup plus vite.
  if (ASCII.test(texte)) return texte.toLowerCase().replace(/\\/g, "/");
  let sortie = "";
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    const code = c.charCodeAt(0);
    if (code < 128) {
      sortie += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : c === "\\" ? "/" : c;
      continue;
    }
    // Apostrophe typographique et espaces insécables : comme leur forme simple.
    if (c === "\u2019") sortie += "'";
    else if (c === "\u00a0" || c === "\u202f") sortie += " ";
    else sortie += (c.normalize("NFD")[0] ?? c).toLowerCase()[0] ?? c;
  }
  return sortie;
}

/** Un chemin prêt à être comparé (plié une seule fois pour toutes les frappes). */
export type Prepare = { chemin: string; plie: string; debutNom: number; nom: string };

function prepare(chemin: string): Prepare {
  const plie = plier(chemin);
  const debutNom = plie.lastIndexOf("/") + 1;
  return { chemin, plie, debutNom, nom: plie.slice(debutNom) };
}

const caches = new WeakMap<readonly string[], Prepare[]>();

/** Prépare une liste de chemins (gardée tant que la même liste est passée). */
export function preparer(chemins: readonly string[]): Prepare[] {
  const connu = caches.get(chemins);
  if (connu) return connu;
  const prepares = chemins.map(prepare);
  caches.set(chemins, prepares);
  return prepares;
}

export type Correspondance = { score: number; positions: number[] };

/** Mots de la requête, pliés (vides retirés). */
export function termesDe(requete: string): string[] {
  return plier(requete.trim()).split(/\s+/).filter(Boolean);
}

const SEPARATEURS = "/._- ";

function frontiere(chemin: string, plie: string, i: number): boolean {
  if (i <= 0) return true;
  if (SEPARATEURS.includes(plie[i - 1])) return true;
  // MotEnCamel : majuscule après une minuscule.
  const c = chemin[i];
  const avant = chemin[i - 1];
  return c !== c.toLowerCase() && avant === avant.toLowerCase() && avant !== avant.toUpperCase();
}

/** Lettres de `terme` dans l'ordre dans `p.plie` à partir de `depart` : note (bords − écarts) ou null. */
function eparses(terme: string, p: Prepare, depart: number, positions?: number[]): number | null {
  let i = depart;
  let precedent = -1;
  let note = 0;
  const debut = positions?.length ?? 0;
  for (const lettre of terme) {
    const j = p.plie.indexOf(lettre, i);
    if (j < 0) {
      if (positions) positions.length = debut;
      return null;
    }
    if (precedent >= 0) note -= j - precedent - 1;
    if (frontiere(p.chemin, p.plie, j)) note += 10;
    positions?.push(j);
    precedent = j;
    i = j + 1;
  }
  return note;
}

function suite(positions: number[] | undefined, debut: number, longueur: number): void {
  if (positions) for (let k = 0; k < longueur; k++) positions.push(debut + k);
}

/** Score d'un mot (positions ajoutées si demandé) : mot dans le nom > dans le chemin > lettres éparses. */
function scoreTerme(terme: string, p: Prepare, positions?: number[]): number | null {
  const dansNom = p.nom.indexOf(terme);
  if (dansNom >= 0) {
    const i = p.debutNom + dansNom;
    suite(positions, i, terme.length);
    return 1000 + (dansNom === 0 ? 300 : 0) + (frontiere(p.chemin, p.plie, i) ? 100 : 0) - dansNom;
  }
  const dansChemin = p.plie.indexOf(terme);
  if (dansChemin >= 0) {
    suite(positions, dansChemin, terme.length);
    return 600 + (frontiere(p.chemin, p.plie, dansChemin) ? 100 : 0) - Math.min(dansChemin, 100) / 10;
  }
  const dansLeNom = eparses(terme, p, p.debutNom, positions);
  if (dansLeNom !== null) return 400 + dansLeNom;
  const partout = eparses(terme, p, 0, positions);
  if (partout !== null) return 200 + partout;
  return null;
}

/** Score seul (sans positions) : sert au tri des 50 000 chemins à chaque frappe. */
function scorePrepare(termes: string[], p: Prepare): number | null {
  let score = 0;
  for (const terme of termes) {
    const s = scoreTerme(terme, p);
    if (s === null) return null;
    score += s;
  }
  return score;
}

/** Correspondance d'un chemin préparé avec des mots déjà pliés (tous requis). */
export function correspondancePreparee(termes: string[], p: Prepare): Correspondance | null {
  if (!termes.length) return null;
  let score = 0;
  const positions: number[] = [];
  for (const terme of termes) {
    const s = scoreTerme(terme, p, positions);
    if (s === null) return null;
    score += s;
  }
  return { score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

/** Correspondance d'une requête avec un texte (null si elle n'y est pas). */
export function correspondance(requete: string, texte: string): Correspondance | null {
  return correspondancePreparee(termesDe(requete), prepare(texte));
}

export type Classe = { chemin: string; score: number; positions: number[]; recent: boolean };

function avant(a: Classe, b: Classe): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.chemin.length !== b.chemin.length) return a.chemin.length < b.chemin.length;
  return a.chemin < b.chemin;
}

/**
 * Fichiers classés pour Ctrl+P : les récents qui correspondent d'abord (ordre d'ouverture),
 * puis les autres par score. Requête vide : récents puis la liste dans son ordre.
 */
export function classerFichiers(
  requete: string,
  fichiers: readonly string[] | readonly Prepare[],
  recents: readonly string[],
  limite = 50,
): Classe[] {
  const prepares = (fichiers.length && typeof fichiers[0] !== "string"
    ? fichiers
    : preparer(fichiers as readonly string[])) as readonly Prepare[];
  const parChemin = indexer(prepares);
  const termes = termesDe(requete);
  const sortie: Classe[] = [];
  const vus = new Set<string>();
  for (const chemin of recents) {
    if (sortie.length >= limite) break;
    const p = parChemin.get(chemin);
    if (!p || vus.has(chemin)) continue;
    if (!termes.length) {
      sortie.push({ chemin, score: 0, positions: [], recent: true });
      vus.add(chemin);
      continue;
    }
    const c = correspondancePreparee(termes, p);
    if (c) {
      sortie.push({ chemin, score: c.score, positions: c.positions, recent: true });
      vus.add(chemin);
    }
  }
  const reste = limite - sortie.length;
  if (reste <= 0) return sortie;
  if (!termes.length) {
    for (const p of prepares) {
      if (sortie.length >= limite) break;
      if (!vus.has(p.chemin)) sortie.push({ chemin: p.chemin, score: 0, positions: [], recent: false });
    }
    return sortie;
  }
  // Les meilleurs seulement (insertion dans une liste courte, sans trier tout).
  const meilleurs: Classe[] = [];
  for (const p of prepares) {
    if (vus.has(p.chemin)) continue;
    const score = scorePrepare(termes, p);
    if (score === null) continue;
    const x: Classe = { chemin: p.chemin, score, positions: [], recent: false };
    if (meilleurs.length >= reste && !avant(x, meilleurs[meilleurs.length - 1])) continue;
    let i = meilleurs.length;
    while (i > 0 && avant(x, meilleurs[i - 1])) i -= 1;
    meilleurs.splice(i, 0, x);
    if (meilleurs.length > reste) meilleurs.pop();
  }
  // Surlignage des seuls retenus.
  for (const x of meilleurs) x.positions = correspondancePreparee(termes, parChemin.get(x.chemin)!)?.positions ?? [];
  return sortie.concat(meilleurs);
}

const index = new WeakMap<readonly Prepare[], Map<string, Prepare>>();
function indexer(prepares: readonly Prepare[]): Map<string, Prepare> {
  const connu = index.get(prepares);
  if (connu) return connu;
  const m = new Map(prepares.map((p) => [p.chemin, p] as const));
  index.set(prepares, m);
  return m;
}

export type Morceau = { texte: string; marque: boolean };

/** Découpe `texte` en morceaux surlignés ou non, d'après des positions (indices de caractères). */
export function morceaux(texte: string, positions: readonly number[] | undefined, decalage = 0): Morceau[] {
  if (!positions?.length) return texte ? [{ texte, marque: false }] : [];
  const marques = new Set(positions.map((p) => p - decalage).filter((p) => p >= 0 && p < texte.length));
  const sortie: Morceau[] = [];
  for (let i = 0; i < texte.length; i++) {
    const marque = marques.has(i);
    const dernier = sortie[sortie.length - 1];
    if (dernier && dernier.marque === marque) dernier.texte += texte[i];
    else sortie.push({ texte: texte[i], marque });
  }
  return sortie;
}
