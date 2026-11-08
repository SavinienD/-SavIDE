// Revue des changements : appels au backend (src-tauri/src/diff.rs, conflits.rs).
import { invoke } from "@tauri-apps/api/core";

export type GroupeRevue = "non-indexe" | "indexe" | "base" | "conflit";

export type FichierRevue = {
  /** Relatif au dossier ouvert, séparateur « / ». */
  chemin: string;
  groupe: GroupeRevue;
  /** Lettre de git (M, A, D, T, U) ou « ? » pour un fichier non suivi. */
  statut: string;
  ajouts: number | null;
  suppressions: number | null;
  binaire: boolean;
};

export type ListeRevue = {
  branche: string | null;
  /** « HEAD » ou nom de la branche de base. */
  base: string;
  baseCommit: string | null;
  branchePrincipale: string | null;
  branches: string[];
  fichiers: FichierRevue[];
  /** fusion, rebase, cherry-pick ou revert en cours. */
  operation: string | null;
  conflits: number;
};

export type DiffRevue = {
  chemin: string;
  groupe: GroupeRevue;
  ancien: string | null;
  nouveau: string | null;
  binaire: boolean;
  tropGros: boolean;
  nonSuivi: boolean;
  empreinte: string;
};

export type ActionRevue = "indexer" | "desindexer" | "annuler";

export type LignesChoisies = { anciennes: number[]; nouvelles: number[] };

export const revueApi = {
  liste(workspacePath: string, base: string | null) {
    return invoke<ListeRevue>("revue_liste", { input: { workspacePath, base } });
  },
  diff(workspacePath: string, chemin: string, groupe: GroupeRevue, base: string | null) {
    return invoke<DiffRevue>("revue_diff", { input: { workspacePath, chemin, groupe, base } });
  },
  /** `lignes` absent : tout le fichier. */
  appliquer(
    workspacePath: string,
    chemin: string,
    groupe: GroupeRevue,
    action: ActionRevue,
    lignes: LignesChoisies | null,
    empreinte: string | null,
  ) {
    return invoke<string>("revue_appliquer", {
      input: { workspacePath, chemin, groupe, action, lignes, empreinte },
    });
  },
};

/** Message d'erreur lisible (Tauri rend une chaîne ou un objet). */
export function texteErreur(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Le backend dit que le fichier a changé depuis l'affichage. */
export function estFichierChange(err: unknown): boolean {
  return texteErreur(err).includes("a changé depuis l'affichage");
}

// ---------------------------------------------------------------------------
// Conflits (src-tauri/src/conflits.rs)

export type FichierConflit = { chemin: string; code: string };

export type EtatConflits = {
  /** fusion, rebase, cherry-pick, revert, ou null. */
  operation: string | null;
  nous: string;
  eux: string;
  fichiers: FichierConflit[];
};

export type DetailConflit = {
  chemin: string;
  base: string | null;
  nous: string | null;
  eux: string | null;
  resultat: string | null;
  binaire: boolean;
};

export const conflitsApi = {
  etat(workspacePath: string) {
    return invoke<EtatConflits>("revue_conflits", { input: { workspacePath } });
  },
  fichier(workspacePath: string, chemin: string) {
    return invoke<DetailConflit>("revue_conflit_fichier", { input: { workspacePath, chemin } });
  },
  resoudre(workspacePath: string, chemin: string, contenu: string | null, options: { supprimer?: boolean; marquer: boolean }) {
    return invoke<string>("revue_conflit_resoudre", {
      input: { workspacePath, chemin, contenu, supprimer: options.supprimer ?? false, marquer: options.marquer },
    });
  },
  action(workspacePath: string, action: "continuer" | "abandonner") {
    return invoke<string>("revue_conflits_action", { input: { workspacePath, action } });
  },
};
