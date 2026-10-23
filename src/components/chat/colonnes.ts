// axe:e17b — colonnes de chat et de fichiers.
//
// Etat pur (sans React) pour pouvoir le tester en node : chaque colonne est une
// liste ordonnee d'identifiants ; une colonne "focus" donne la conversation active.
// Regles : jamais de doublon d'un meme id ; une colonne vidée disparait (sauf
// s'il n'en reste qu'une) ; le focus reste toujours sur une colonne existante.

export type Colonnes<T> = T[][];

export type EtatColonnes<T> = {
  colonnes: Colonnes<T>;
  /** Index de la colonne qui a le focus. */
  focus: number;
};

export function borner(focus: number, longueur: number): number {
  if (longueur <= 0) return 0;
  return Math.min(Math.max(0, focus), longueur - 1);
}

function nettoyer<T>(colonnes: Colonnes<T>): Colonnes<T> {
  const pleines = colonnes.filter((c) => c.length > 0);
  return pleines.length > 0 ? pleines : [[]];
}

/** Ou se trouve `id` : [colonne, position] ou null. */
export function trouver<T>(
  colonnes: Colonnes<T>,
  id: T,
  egal: (a: T, b: T) => boolean = Object.is,
): [number, number] | null {
  for (let c = 0; c < colonnes.length; c += 1) {
    const p = colonnes[c].findIndex((x) => egal(x, id));
    if (p !== -1) return [c, p];
  }
  return null;
}

/** Ouvre `id` dans la colonne `cible` (focus par defaut) s'il n'est nulle part. */
export function ouvrir<T>(
  etat: EtatColonnes<T>,
  id: T,
  cible: number = etat.focus,
  egal: (a: T, b: T) => boolean = Object.is,
): EtatColonnes<T> {
  const ou = trouver(etat.colonnes, id, egal);
  if (ou) return { colonnes: etat.colonnes, focus: ou[0] };
  const colonnes = etat.colonnes.length ? etat.colonnes.map((c) => c.slice()) : [[]];
  const c = borner(cible, colonnes.length);
  colonnes[c].push(id);
  return { colonnes, focus: c };
}

/** « + colonne » : ajoute une colonne vide a droite et lui donne le focus. */
export function ajouterColonne<T>(etat: EtatColonnes<T>, premier?: T): EtatColonnes<T> {
  const colonnes = [...etat.colonnes.map((c) => c.slice()), premier === undefined ? [] : [premier]];
  return { colonnes, focus: colonnes.length - 1 };
}

/**
 * Glisser-deposer : deplace `id` dans la colonne `vers` a la position `position`
 * (fin par defaut). `vers === colonnes.length` cree une nouvelle colonne.
 */
export function deplacer<T>(
  etat: EtatColonnes<T>,
  id: T,
  vers: number,
  position?: number,
  egal: (a: T, b: T) => boolean = Object.is,
): EtatColonnes<T> {
  const ou = trouver(etat.colonnes, id, egal);
  if (!ou) return etat;
  const colonnes = etat.colonnes.map((c) => c.slice());
  const [element] = colonnes[ou[0]].splice(ou[1], 1);
  const cible = Math.min(Math.max(0, vers), colonnes.length);
  if (cible === colonnes.length) colonnes.push([]);
  const dest = colonnes[cible];
  const p = position === undefined ? dest.length : Math.min(Math.max(0, position), dest.length);
  dest.splice(p, 0, element);
  // Le focus suit l'element deplace (on vient de le prendre en main).
  const vide = colonnes.findIndex((c) => c.length === 0);
  let focus = cible;
  if (vide !== -1 && vide < cible) focus -= 1;
  const net = nettoyer(colonnes);
  return { colonnes: net, focus: borner(focus, net.length) };
}

/** Retire `id` (fermeture, archive). */
export function retirer<T>(
  etat: EtatColonnes<T>,
  id: T,
  egal: (a: T, b: T) => boolean = Object.is,
): EtatColonnes<T> {
  const ou = trouver(etat.colonnes, id, egal);
  if (!ou) return etat;
  const colonnes = etat.colonnes.map((c) => c.slice());
  colonnes[ou[0]].splice(ou[1], 1);
  let focus = etat.focus;
  if (colonnes[ou[0]].length === 0 && ou[0] < focus) focus -= 1;
  const net = nettoyer(colonnes);
  return { colonnes: net, focus: borner(focus, net.length) };
}

export function focaliser<T>(etat: EtatColonnes<T>, index: number): EtatColonnes<T> {
  const focus = borner(index, etat.colonnes.length);
  return focus === etat.focus ? etat : { ...etat, focus };
}

/** Relit un etat garde dans localStorage, sans jamais planter. */
export function relire(brut: string | null): EtatColonnes<string> | null {
  if (!brut) return null;
  try {
    const v = JSON.parse(brut) as EtatColonnes<string>;
    if (!v || !Array.isArray(v.colonnes)) return null;
    const vus = new Set<string>();
    const colonnes = v.colonnes
      .filter(Array.isArray)
      .map((c) =>
        c.filter((id) => typeof id === "string" && !vus.has(id) && (vus.add(id), true)),
      );
    const net = nettoyer(colonnes);
    return { colonnes: net, focus: borner(Number(v.focus) || 0, net.length) };
  } catch {
    return null;
  }
}

/** Type MIME du glisser d'un onglet de chat (distinct des fichiers deposes). */
export const MIME_ONGLET_CHAT = "application/x-axe-onglet-chat";

/** Type MIME du glisser d'un onglet de fichier entre colonnes. */
export const MIME_ONGLET_FICHIER = "application/x-axe-onglet-fichier";

/** Seuil (px) avant qu'un appui sur un onglet devienne un glisser a la souris. */
export const SEUIL_GLISSER_PX = 6;

/** Le pointeur a-t-il assez bouge pour demarrer un glisser ? */
export function depasseSeuil(dx: number, dy: number, seuil = SEUIL_GLISSER_PX): boolean {
  return dx * dx + dy * dy >= seuil * seuil;
}

/**
 * Colonne cible d'un depot a la souris, d'apres l'attribut data-colonne-index de
 * l'element sous le pointeur ("nouvelle" = creer une colonne). null = pas de cible.
 */
export function colonneCible(attr: string | null | undefined, nb: number): number | null {
  if (attr == null) return null;
  if (attr === "nouvelle") return nb;
  const n = Number(attr);
  return Number.isInteger(n) && n >= 0 && n < nb ? n : null;
}

/** axe:hotfix — le focus va sur la colonne qui contient `id` (conversation active). */
export function suivre<T>(
  etat: EtatColonnes<T>,
  id: T,
  egal: (a: T, b: T) => boolean = Object.is,
): EtatColonnes<T> {
  const ou = trouver(etat.colonnes, id, egal);
  return ou && ou[0] !== etat.focus ? { colonnes: etat.colonnes, focus: ou[0] } : etat;
}

/**
 * axe:hotfix — accorde les colonnes aux onglets ouverts : un onglet fermé quitte
 * sa colonne, un onglet neuf va dans la colonne du focus, et le focus suit la
 * conversation active (avant : il sautait sur la colonne du DERNIER onglet).
 */
export function synchroniser<T>(
  etat: EtatColonnes<T>,
  ids: T[],
  actif: T | null,
  egal: (a: T, b: T) => boolean = Object.is,
): EtatColonnes<T> {
  let suivant = etat;
  for (const colonne of etat.colonnes)
    for (const id of colonne) if (!ids.some((x) => egal(x, id))) suivant = retirer(suivant, id, egal);
  const focus = suivant.focus;
  for (const id of ids) suivant = ouvrir(suivant, id, focus, egal);
  suivant = { colonnes: suivant.colonnes, focus: borner(focus, suivant.colonnes.length) };
  if (actif !== null) suivant = suivre(suivant, actif, egal);
  return suivant.colonnes === etat.colonnes && suivant.focus === etat.focus ? etat : suivant;
}

/**
 * axe:hotfix — « Fermer la colonne » : ses onglets rejoignent la colonne voisine
 * (à gauche, ou à droite pour la première) ; aucune conversation n'est fermée.
 */
export function fermerColonne<T>(etat: EtatColonnes<T>, index: number): EtatColonnes<T> {
  if (etat.colonnes.length <= 1 || index < 0 || index >= etat.colonnes.length) return etat;
  const voisine = index > 0 ? index - 1 : 1;
  const colonnes = etat.colonnes.map((c) => c.slice());
  colonnes[voisine].push(...colonnes[index]);
  colonnes.splice(index, 1);
  const apres = (i: number) => (i > index ? i - 1 : i);
  const focus = etat.focus === index ? apres(voisine) : apres(etat.focus);
  const net = nettoyer(colonnes);
  return { colonnes: net, focus: borner(focus, net.length) };
}

/** axe:hotfix-largeurs — largeur minimale d'une colonne de chat (comme le CSS). */
export const LARGEUR_MIN_COLONNE_PX = 220;

/** Poids (flex-grow) de `n` colonnes : ceux gardés s'ils vont, sinon parts égales. */
export function poidsColonnes(poids: unknown, n: number): number[] {
  if (
    Array.isArray(poids) &&
    poids.length === n &&
    poids.every((p) => typeof p === "number" && Number.isFinite(p) && p > 0)
  )
    return poids as number[];
  return Array.from({ length: Math.max(0, n) }, () => 1);
}

/**
 * Poignée entre les colonnes `index` et `index + 1` tirée de `deltaPx` (> 0 vers la
 * droite) : la colonne de gauche gagne ce que perd sa voisine, les autres ne bougent
 * pas, aucune ne descend sous `minPx`. `largeurPx` = largeur totale des colonnes.
 * Rien à changer = le même tableau.
 */
export function redimensionner(
  poids: number[],
  index: number,
  deltaPx: number,
  largeurPx: number,
  minPx: number = LARGEUR_MIN_COLONNE_PX,
): number[] {
  if (index < 0 || index + 1 >= poids.length) return poids;
  if (!(largeurPx > 0) || !Number.isFinite(deltaPx) || deltaPx === 0) return poids;
  const total = poids.reduce((s, p) => s + p, 0);
  if (!(total > 0)) return poids;
  const px = poids.map((p) => (p / total) * largeurPx);
  const paire = px[index] + px[index + 1];
  const min = Math.min(minPx, paire / 2);
  const gauche = Math.min(Math.max(px[index] + deltaPx, min), paire - min);
  if (gauche === px[index]) return poids;
  px[index] = gauche;
  px[index + 1] = paire - gauche;
  return px.map((v) => (v / largeurPx) * poids.length);
}
