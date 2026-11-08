// Appels au système pour les palettes (Ctrl+P, Ctrl+K).
import { invoke } from "@tauri-apps/api/core";
import { api, cloudConnectionFromPath } from "../../lib/ipc";

export type ListeFichiers = {
  /** Chemins relatifs au dossier, séparateur « / ». */
  fichiers: string[];
  /** Liste coupée (très gros dossier). */
  tronque: boolean;
  /** « rg », « liste » (secours sans .gitignore) ou « espace » (dossier cloud). */
  source: string;
};

const MAX_FICHIERS = 50_000;
const cache = new Map<string, ListeFichiers>();

/** Dernière liste connue du dossier (affichée tout de suite à la réouverture). */
export function fichiersEnCache(dossier: string): ListeFichiers | null {
  return cache.get(dossier) ?? null;
}

async function listeInterne(dossier: string, source: string): Promise<ListeFichiers> {
  const entrees = await api.listAllFiles(dossier);
  const fichiers = entrees
    .filter((e) => e.kind === "file")
    .map((e) => e.relativePath.replace(/\\/g, "/"))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { fichiers: fichiers.slice(0, MAX_FICHIERS), tronque: fichiers.length > MAX_FICHIERS, source };
}

/** Fichiers du dossier : `rg --files` (le .gitignore est respecté), sinon la liste interne. */
export async function listerFichiers(dossier: string): Promise<ListeFichiers> {
  let liste: ListeFichiers;
  if (cloudConnectionFromPath(dossier)) liste = await listeInterne(dossier, "espace");
  else {
    try {
      liste = await invoke<ListeFichiers>("palette_fichiers", { input: { workspacePath: dossier } });
    } catch {
      liste = await listeInterne(dossier, "liste");
    }
  }
  cache.set(dossier, liste);
  return liste;
}

export type ConversationListee = { id: string; dossier: string; titre: string; majMs: number };
export type ListeConversations = { racineLibre: string; conversations: ConversationListee[] };
export type ResultatContenu = {
  conversationId: string;
  dossier: string;
  titre: string;
  majMs: number;
  role: "user" | "assistant";
  /** Texte autour du mot trouvé. */
  extrait: string;
  /** Messages de la conversation qui contiennent tous les mots. */
  messages: number;
};
export type RechercheConversations = {
  resultats: ResultatContenu[];
  conversations: number;
  relues: number;
  dureeMs: number;
  tronque: boolean;
};

/** Conversations de tous les dossiers du poste (archivées exclues), la plus récente d'abord. */
export function listerConversations(): Promise<ListeConversations> {
  return invoke<ListeConversations>("palette_conversations");
}

/** Recherche dans le texte des conversations (requête vide : prépare seulement la recherche). */
export function rechercherConversations(requete: string, limite = 30): Promise<RechercheConversations> {
  return invoke<RechercheConversations>("palette_recherche_conversations", { input: { requete, limite } });
}
