/**
 * La dictée va TOUJOURS dans la conversation où elle a commencé.
 *
 * Avant : le texte transcrit allait dans la zone de saisie AFFICHÉE au moment où la
 * transcription revenait (ChatPane ne se remonte pas quand on change de conversation,
 * et useDictee appelait le onTexte du rendu courant). Maintenant la cible (conversation
 * + dossier) est mémorisée au début de l'enregistrement, et à l'arrivée du texte :
 * - la conversation est affichée dans un compositeur -> insertion au curseur, comme avant ;
 * - elle n'est pas affichée -> ajout au brouillon de CETTE conversation (rangé par id,
 *   repris quand on la rouvre) et petit repère sur son onglet / sa ligne ;
 * - elle a été archivée ou supprimée entre-temps -> rien n'est collé ailleurs : texte
 *   copié dans le presse-papiers et message.
 * Module sans React (testé par node) : ChatPane et Workspace s'y branchent.
 */
import { insererTexteDicte } from "./inserer";

export type CibleDictee = { conversationId: string; workspacePath: string | null };
export type Livraison = "saisie" | "brouillon" | "presse-papiers";
export type GenreAvis = "info" | "error";

type Inserer = (texte: string) => void;
type Brouillons = { lire: (id: string) => string; ecrire: (id: string, texte: string) => void };
/** true : la conversation existe ; false : archivée / supprimée ; null : ce dossier ne la connaît pas. */
type Existence = (cible: CibleDictee) => boolean | null;

const composeurs = new Map<string, Inserer[]>();
const existences = new Set<Existence>();
const avis: ((genre: GenreAvis, texte: string) => void)[] = [];
let brouillons: Brouillons | null = null;
let copier: (texte: string) => Promise<void> | void = (texte) =>
  globalThis.navigator?.clipboard?.writeText(texte);

const horsEcran = new Set<string>();
let instantane: ReadonlySet<string> = new Set();
const abonnes = new Set<() => void>();
function publier(): void {
  instantane = new Set(horsEcran);
  for (const f of abonnes) f();
}

/** Un compositeur qui affiche la conversation `id` (retirer : la fonction rendue). */
export function enregistrerComposeur(id: string, inserer: Inserer): () => void {
  const pile = composeurs.get(id) ?? [];
  pile.push(inserer);
  composeurs.set(id, pile);
  marquerVue(id);
  return () => {
    const reste = (composeurs.get(id) ?? []).filter((f) => f !== inserer);
    if (reste.length) composeurs.set(id, reste);
    else composeurs.delete(id);
  };
}

export function brancherBrouillons(b: Brouillons): void {
  brouillons = b;
}

export function brancherExistence(f: Existence): () => void {
  existences.add(f);
  return () => existences.delete(f);
}

/** Le dernier branché (le Workspace affiché) montre les messages. */
export function brancherAvis(f: (genre: GenreAvis, texte: string) => void): () => void {
  avis.push(f);
  return () => {
    const i = avis.lastIndexOf(f);
    if (i >= 0) avis.splice(i, 1);
  };
}

export function brancherPressePapiers(f: (texte: string) => Promise<void> | void): void {
  copier = f;
}

function prevenir(genre: GenreAvis, texte: string): void {
  avis[avis.length - 1]?.(genre, texte);
}

/** La conversation a été ouverte : le repère « texte dicté ajouté » disparaît. */
export function marquerVue(id: string): void {
  if (horsEcran.delete(id)) publier();
}

export function dicteesHorsEcran(): ReadonlySet<string> {
  return instantane;
}

export function abonnerDictees(f: () => void): () => void {
  abonnes.add(f);
  return () => abonnes.delete(f);
}

function existe(cible: CibleDictee): boolean | null {
  let connu: boolean | null = null;
  for (const f of existences) {
    const r = f(cible);
    if (r === false) return false;
    if (r === true) connu = true;
  }
  return connu;
}

/** Ajoute le texte dicté à la fin d'un brouillon, avec une espace propre. */
export function ajouterAuBrouillon(brouillon: string, dicte: string): string {
  return insererTexteDicte(brouillon, brouillon.length, brouillon.length, dicte).valeur;
}

function versPressePapiers(texte: string, message: string): Livraison {
  try {
    void Promise.resolve(copier(texte)).catch(() => undefined);
  } catch {
    /* presse-papiers indisponible : le message le dit quand même */
  }
  prevenir("error", message);
  return "presse-papiers";
}

/** Livre le texte dicté à SA conversation (jamais à celle qui est affichée). */
export function livrerDictee(cible: CibleDictee, texte: string): Livraison {
  const dicte = texte.trim();
  if (!dicte) return "saisie";
  if (existe(cible) === false) {
    return versPressePapiers(
      dicte,
      "La conversation où la dictée a commencé a été archivée ou supprimée : le texte dicté est copié dans le presse-papiers.",
    );
  }
  const pile = composeurs.get(cible.conversationId);
  if (pile?.length) {
    pile[pile.length - 1](dicte);
    return "saisie";
  }
  if (!brouillons) {
    return versPressePapiers(dicte, "Texte dicté copié dans le presse-papiers (conversation introuvable).");
  }
  brouillons.ecrire(cible.conversationId, ajouterAuBrouillon(brouillons.lire(cible.conversationId), dicte));
  horsEcran.add(cible.conversationId);
  publier();
  prevenir("info", "Texte dicté ajouté au brouillon de la conversation où la dictée a commencé.");
  return "brouillon";
}

/** Pour les tests : état remis à zéro. */
export function reinitialiserDictees(): void {
  composeurs.clear();
  existences.clear();
  avis.length = 0;
  brouillons = null;
  horsEcran.clear();
  publier();
}
