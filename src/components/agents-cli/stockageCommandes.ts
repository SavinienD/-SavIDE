// Commandes et prompts enregistrés (stockage local) : réutilisables d'un clic depuis la barre
// des terminaux (une commande s'exécute, un prompt est collé sans être validé) et depuis le
// compositeur du chat (texte inséré, jamais envoyé). Variables : {dossier}, {fichier}.
// Logique pure (tests/commandesEnregistrees.test.cjs).

export type GenreCommande = "commande" | "prompt";
export type CommandeEnregistree = { id: string; genre: GenreCommande; nom: string; texte: string };
export type Variables = { dossier?: string | null; fichier?: string | null };

export const CLE_COMMANDES = "axecode.commandes-enregistrees";
export const EVENEMENT_COMMANDES = "axecode:commandes-enregistrees";
const TEXTE_MAX = 20_000;
const NOM_MAX = 80;

/** Premier lancement : deux exemples (modifiables, supprimables). */
export const COMMANDES_DEFAUT: CommandeEnregistree[] = [
  { id: "exemple-git", genre: "commande", nom: "Changements git", texte: "git diff --stat" },
  { id: "exemple-relire", genre: "prompt", nom: "Relire le fichier actif", texte: "Relis {fichier} et signale les erreurs, sans rien modifier." },
];

type Stockage = Pick<Storage, "getItem" | "setItem">;
const stockageParDefaut = (): Stockage | null => (typeof localStorage === "undefined" ? null : localStorage);

function propre(brut: unknown): CommandeEnregistree | null {
  const c = brut as Partial<CommandeEnregistree> | null;
  if (!c || typeof c.id !== "string" || !c.id || typeof c.texte !== "string") return null;
  return {
    id: c.id.slice(0, 80),
    genre: c.genre === "prompt" ? "prompt" : "commande",
    nom: typeof c.nom === "string" ? c.nom.slice(0, NOM_MAX) : "",
    texte: c.texte.slice(0, TEXTE_MAX),
  };
}

/** Liste enregistrée ; jamais écrite : les exemples ; illisible : liste vide. */
export function lireCommandes(stockage: Stockage | null = stockageParDefaut()): CommandeEnregistree[] {
  let brut: string | null = null;
  try {
    brut = stockage?.getItem(CLE_COMMANDES) ?? null;
  } catch {
    return [];
  }
  if (brut === null) return COMMANDES_DEFAUT.map((c) => ({ ...c }));
  try {
    const liste = JSON.parse(brut);
    if (!Array.isArray(liste)) return [];
    const vus = new Set<string>();
    return liste.map(propre).filter((c): c is CommandeEnregistree => !!c && !vus.has(c.id) && !!vus.add(c.id));
  } catch {
    return [];
  }
}

/** Enregistre la liste et prévient les menus ouverts. */
export function ecrireCommandes(liste: CommandeEnregistree[], stockage: Stockage | null = stockageParDefaut()): void {
  try {
    stockage?.setItem(CLE_COMMANDES, JSON.stringify(liste.map(propre).filter(Boolean)));
  } catch {
    /* stockage plein ou coupé : la liste vaut pour cette session */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENEMENT_COMMANDES));
}

let compteur = 0;
export function nouvelleCommande(genre: GenreCommande, maintenant = Date.now()): CommandeEnregistree {
  compteur += 1;
  return { id: `c-${maintenant.toString(36)}-${compteur}`, genre, nom: "", texte: "" };
}

const VARIABLE = /\{(dossier|fichier)\}/g;

/** Variables utilisées par le texte mais sans valeur (ex. aucun fichier ouvert). */
export function variablesManquantes(texte: string, v: Variables): string[] {
  const manque = new Set<string>();
  for (const m of texte.matchAll(VARIABLE)) if (!v[m[1] as keyof Variables]) manque.add(m[1]);
  return [...manque];
}

/** Remplace {dossier} et {fichier} ; les autres accolades restent telles quelles. */
export function remplacerVariables(texte: string, v: Variables): string {
  return texte.replace(VARIABLE, (_, nom: keyof Variables) => v[nom] ?? "");
}

/** Octets à écrire dans le terminal : texte collé (encadré si l'application l'a demandé,
 *  fins de ligne en Entrée comme un collage), puis Entrée pour exécuter une commande. */
export function donneesCollage(texte: string, collageEncadre: boolean, executer: boolean): string {
  const corps = texte.replace(/\r?\n/g, "\r");
  const colle = collageEncadre ? `\x1b[200~${corps}\x1b[201~` : corps;
  return executer ? `${colle}\r` : colle;
}

/** Libellé d'une entrée : son nom, sinon le début de son texte. */
export function libelleCommande(c: CommandeEnregistree): string {
  const nom = c.nom.trim();
  if (nom) return nom;
  const t = c.texte.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t || "Sans titre";
}

// Fichier actif de l'éditeur (chemin relatif au dossier), tenu à jour par l'espace de travail.
let fichier: string | null = null;
export function definirFichierActif(chemin: string | null | undefined): void {
  fichier = chemin || null;
}
export function fichierActif(): string | null {
  return fichier;
}
