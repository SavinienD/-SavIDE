// automatisations — prompts planifiés, tenus par le service (RPC `automatisations.*`).
// Le service les lance même quand l'appli est fermée ; cet écran les liste, les crée
// et montre leur historique. Les appels passent par la connexion active (comme la vue Agents).
import { agentsApi } from "../agents/agentsApi";

export type Horaire =
  | { type: "quotidien"; heure: string }
  | { type: "hebdomadaire"; jours: number[]; heure: string }
  | { type: "intervalle"; heures: number; minute?: number }
  | { type: "cron"; expression: string };

export type StatutExecution = "verification" | "en_cours" | "reussie" | "echouee" | "sautee" | "manquee" | "arretee";
export type Declencheur = "horaire" | "rattrapage" | "manuel";

export type Execution = {
  id: string;
  declencheur: Declencheur;
  prevueMs?: number;
  debutMs: number;
  finMs?: number;
  statut: StatutExecution;
  sessionId?: string;
  resume?: string;
  manquees?: number;
  arretDemande?: boolean;
};

export type Modele = { provider: string; name: string; effort?: string | null };

export type Automatisation = {
  id: string;
  nom: string;
  dossier: string;
  prompt: string;
  modele: Modele;
  horaire: Horaire;
  memeConversation: boolean;
  active: boolean;
  rattrapage: boolean;
  verification?: string;
  creeMs: number;
  modifieMs: number;
  prochaineMs?: number;
  sessionId?: string;
  historique: Execution[];
  /** Horaire en clair, écrit par le service (« Tous les lundis à 8 h »). */
  horaireTexte: string;
  enCours: boolean;
};

/** Ce que l'écran envoie à la création ou à la modification. */
export type Brouillon = {
  nom: string;
  dossier: string;
  prompt: string;
  /** « fournisseur/modèle ». */
  modele: string;
  horaire: Horaire;
  memeConversation: boolean;
  active: boolean;
  rattrapage: boolean;
  verification: string;
};

export type Apercu = { texte: string; prochaines: number[] };

const appel = <T,>(methode: string, params: Record<string, unknown> = {}, connexion?: string) =>
  agentsApi.call<T>(`automatisations.${methode}`, params, connexion);

export const automatisationsApi = {
  lister: (connexion?: string) =>
    appel<{ automatisations: Automatisation[]; maintenantMs: number }>("lister", {}, connexion),
  creer: (b: Brouillon, connexion?: string) => appel<Automatisation>("creer", { ...b }, connexion),
  modifier: (id: string, champs: Partial<Brouillon>, connexion?: string) =>
    appel<Automatisation>("modifier", { id, ...champs }, connexion),
  supprimer: (id: string, connexion?: string) => appel<{ ok: boolean }>("supprimer", { id }, connexion),
  lancer: (id: string, connexion?: string) => appel<Execution>("lancer", { id }, connexion),
  arreter: (id: string, connexion?: string) => appel<{ ok: boolean }>("arreter", { id }, connexion),
  apercu: (horaire: Horaire, connexion?: string) => appel<Apercu>("apercu", { horaire }, connexion),
};

/** Événement du service qui ouvre l'écran (palette, autres vues). */
export const OUVRIR_AUTOMATISATIONS = "ide-ouvrir-automatisations";

