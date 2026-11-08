// Commandes Git ajoutées au panneau (état de la branche, fetch, commit avec « modifier le
// dernier », poussée forcée sûre, abandon, contexte des rédactions IA). Espaces locaux
// seulement : un espace cloud garde les commandes de base (lib/ipc.ts).
import { invoke } from "@tauri-apps/api/core";
import type { GitOperationResult } from "../../types";
import type { ContexteIa } from "./consignes";

export type GitEtat = {
  branche: string | null;
  amont: string | null;
  avance: number;
  retard: number;
  operation: "fusion" | "rebase" | "am" | "cherry-pick" | "revert" | null;
  dernierCommit: { hash: string; message: string; pousse: boolean } | null;
  remoteParDefaut: string | null;
};

export type GitValiderResultat = {
  ok: boolean;
  message: string;
  sortie: string | null;
  crochet: string | null;
};

export type GitPousserResultat = {
  ok: boolean;
  rejete: boolean;
  message: string;
  sortie: string | null;
};

const entree = (workspacePath: string) => ({ input: { workspacePath } });

export const gitApi = {
  etat(workspacePath: string) {
    return invoke<GitEtat>("git_etat_command", entree(workspacePath));
  },
  fetch(workspacePath: string) {
    return invoke<GitOperationResult>("git_fetch_command", entree(workspacePath));
  },
  valider(workspacePath: string, message: string, paths: string[], modifierDernier: boolean) {
    return invoke<GitValiderResultat>("git_valider_command", {
      input: { workspacePath, message, paths, modifierDernier },
    });
  },
  pousser(workspacePath: string, forcer: boolean) {
    return invoke<GitPousserResultat>("git_pousser_command", { input: { workspacePath, forcer } });
  },
  abandonner(workspacePath: string) {
    return invoke<GitOperationResult>("git_abandonner_command", entree(workspacePath));
  },
  contexteCommit(workspacePath: string, paths: string[]) {
    return invoke<ContexteIa>("git_contexte_ia_command", {
      input: { workspacePath, genre: "commit", paths },
    });
  },
  contextePr(workspacePath: string, base: string | null) {
    return invoke<ContexteIa>("git_contexte_ia_command", {
      input: { workspacePath, genre: "pr", base },
    });
  },
};

/** Libellé d'une opération en cours (bandeau « … en cours »). */
export function libelleOperation(op: GitEtat["operation"]): string {
  switch (op) {
    case "fusion":
      return "Fusion";
    case "rebase":
      return "Rebase";
    case "am":
      return "Application de patchs";
    case "cherry-pick":
      return "Cherry-pick";
    case "revert":
      return "Revert";
    default:
      return "";
  }
}

/** Titre du dialogue d'abandon (« Abandonner la fusion ? »…). */
export function titreAbandon(op: GitEtat["operation"]): string {
  switch (op) {
    case "fusion":
      return "Abandonner la fusion ?";
    case "rebase":
      return "Abandonner le rebase ?";
    case "am":
      return "Abandonner l'application des patchs ?";
    case "cherry-pick":
      return "Abandonner le cherry-pick ?";
    case "revert":
      return "Abandonner le revert ?";
    default:
      return "Abandonner l'opération ?";
  }
}
