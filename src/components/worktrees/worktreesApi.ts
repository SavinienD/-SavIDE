// Worktrees — appels au backend (src-tauri/src/worktrees.rs) et types.
import { invoke } from "@tauri-apps/api/core";

export type TerminalDefaut = { nom: string; commande: string | null };

export type ConfigWorktrees = {
  base: string | null;
  scriptCreation: string | null;
  scriptSuppression: string | null;
  sourceCreation: string | null;
  sourceSuppression: string | null;
  liens: string[];
  copies: string[];
  terminaux: TerminalDefaut[];
  fichiers: string[];
  erreurs: string[];
  empreinte: string | null;
};

export type ConfigDepot = {
  depot: string;
  nom: string;
  branchePrincipale: string | null;
  branches: string[];
  config: ConfigWorktrees;
  modele: string | null;
};

export type GenreTache = "creation" | "suppression" | "archivage";
export type EtapeTache = "git" | "partage" | "script" | "fin";
export type EtatTache = "en_cours" | "reussi" | "echec" | "annule";

export type ScriptVue = { sessionId: string; token: string; enCours: boolean; code: number | null; commandes: string };
export type Partage = { chemin: string; mode: "lien" | "jonction" | "copie" };

export type TacheWorktree = {
  id: string;
  genre: GenreTache;
  depot: string;
  dossier: string;
  branche: string | null;
  base: string | null;
  titre: string;
  etapes: EtapeTache[];
  etape: EtapeTache;
  etat: EtatTache;
  pret: boolean;
  message: string;
  detail: string | null;
  raison: string | null;
  avertissements: string[];
  partages: Partage[];
  script: ScriptVue | null;
  debutMs: number;
  majMs: number;
};

export type DemandeCreation = {
  depot: string;
  titre: string;
  branche: string;
  base: string | null;
  lancerScript: boolean;
  empreinte: string | null;
};

export type DemandeSuppression = {
  depot: string;
  dossier: string;
  archiver: boolean;
  supprimerBranche: boolean;
  forcerBranche: boolean;
  forcer: boolean;
  lancerScript: boolean;
  empreinte: string | null;
  titre?: string | null;
};

export type Reprise = { sansScript?: boolean; empreinte?: string | null; forcer?: boolean };

export type WorktreeInfo = {
  dossier: string;
  nom: string;
  branche: string | null;
  principal: boolean;
  detache: boolean;
  verrouille: boolean;
  /** Dossier disparu (git propose de l'oublier). */
  introuvable: boolean;
  /** Fichiers modifiés ou non suivis (null : inconnu). */
  modifies: number | null;
  avance: number | null;
  retard: number | null;
  /** Branche de comparaison de avance / retard. */
  reference: string | null;
  dernierCommitMs: number | null;
};

export type DepotWorktrees = {
  depot: string;
  nom: string;
  branchePrincipale: string | null;
  worktrees: WorktreeInfo[];
  erreur: string | null;
};

export type InfoNettoyage = {
  depot: string;
  dossier: string;
  branche: string | null;
  fusionne: boolean;
  introuvable: boolean;
  modifies: number | null;
  octets: number | null;
  tailleCoupee: boolean;
  activiteMs: number | null;
};

export const EVENEMENT_TACHE = "worktrees-tache";
export const EVENEMENT_SORTIE = "worktrees-sortie";
export type SortieScript = { id: string; debut: number; texte: string };

export const worktreesApi = {
  config: (depot: string) => invoke<ConfigDepot>("worktrees_config", { input: { depot } }),
  creerConfig: (depot: string) => invoke<ConfigDepot>("worktrees_config_creer", { input: { depot } }),
  creer: (demande: DemandeCreation) => invoke<TacheWorktree>("worktree_creer", { input: demande }),
  supprimer: (demande: DemandeSuppression) => invoke<TacheWorktree>("worktree_supprimer", { input: demande }),
  taches: () => invoke<TacheWorktree[]>("worktrees_taches"),
  annuler: (id: string) => invoke<void>("worktree_tache_annuler", { input: { id } }),
  reprendre: (id: string, reprise: Reprise) => invoke<TacheWorktree>("worktree_tache_reprendre", { input: { id, ...reprise } }),
  oublier: (id: string) => invoke<void>("worktree_tache_oublier", { input: { id } }),
  sortie: (id: string) => invoke<{ texte: string; fin: number }>("worktree_tache_sortie", { input: { id } }),
  lister: (chemins: string[], bases: Record<string, string> = {}) => invoke<DepotWorktrees[]>("worktrees_lister", { input: { chemins, bases } }),
  nettoyage: (depots: string[], bases: Record<string, string> = {}) => invoke<InfoNettoyage[]>("worktrees_nettoyage", { input: { depots, bases } }),
  oublierIntrouvables: (depot: string) => invoke<number>("worktrees_prune", { input: { depot } }),
};

export function texteErreur(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
