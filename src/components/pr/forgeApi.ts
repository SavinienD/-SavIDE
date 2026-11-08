// Forges du dépôt (GitHub, Forgejo / Gitea) : PR, checks, revues, commentaires, issues.
// Commandes de src-tauri/src/forges/commandes.rs (espaces locaux seulement).
import { invoke } from "@tauri-apps/api/core";

export type DepotForge = {
  genre: "github" | "gitea" | "gitlab" | "inconnu";
  hote: string;
  proprietaire: string;
  nom: string;
  urlWeb: string;
  urlApi: string;
  remote: string;
};

export type ForgeEtat = {
  depot: DepotForge | null;
  jeton: boolean;
  jetonEnregistre: boolean;
  gh: boolean;
  message: string | null;
};

export type PrResume = {
  numero: number;
  titre: string;
  auteur: string;
  etat: "ouverte" | "fermée" | "fusionnée";
  brouillon: boolean;
  branche: string;
  base: string;
  url: string;
  maj: string;
};

export type Check = {
  id: string;
  nom: string;
  etat: "succes" | "echec" | "en_cours" | "ignore";
  detail: string | null;
  url: string | null;
  journal: boolean;
};

export type Revue = {
  id: string;
  auteur: string;
  etat: "approuvee" | "changements" | "commentaire" | "attente" | "rejetee";
  corps: string;
  date: string;
};

export type Commentaire = {
  id: string;
  auteur: string;
  corps: string;
  fichier: string | null;
  ligne: number | null;
  date: string;
  url: string | null;
};

export type PrDetail = PrResume & {
  description: string;
  sha: string;
  checks: Check[];
  revues: Revue[];
  commentaires: Commentaire[];
};

export type Issue = {
  numero: number;
  titre: string;
  auteur: string;
  corps: string;
  etiquettes: string[];
  url: string;
  maj: string;
  commentaires: number;
};

export type PrCreee = { numero: number; url: string; message: string };

const entree = (workspacePath: string) => ({ input: { workspacePath } });

export const forgeApi = {
  etat: (workspacePath: string) => invoke<ForgeEtat>("forge_etat", entree(workspacePath)),
  jeton: (hote: string, jeton: string | null) => invoke<void>("forge_jeton", { input: { hote, jeton } }),
  prs: (workspacePath: string, toutes = false) =>
    invoke<PrResume[]>("forge_prs", { input: { workspacePath, toutes } }),
  pr: (workspacePath: string, numero: number) =>
    invoke<PrDetail>("forge_pr", { input: { workspacePath, numero } }),
  journal: (workspacePath: string, check: Check) =>
    invoke<string | null>("forge_journal", { input: { workspacePath, check: check.id, url: check.url } }),
  issues: (workspacePath: string) => invoke<Issue[]>("forge_issues", entree(workspacePath)),
  creerPr: (workspacePath: string, titre: string, description: string, base: string, brouillon: boolean) =>
    invoke<PrCreee>("forge_creer_pr", { input: { workspacePath, titre, description, base, brouillon } }),
};

/** « GitHub », « Forgejo / Gitea »… */
export function nomForge(genre: DepotForge["genre"] | undefined): string {
  switch (genre) {
    case "github":
      return "GitHub";
    case "gitea":
      return "Forgejo / Gitea";
    case "gitlab":
      return "GitLab";
    default:
      return "forge";
  }
}

export function libelleCheck(etat: Check["etat"]): string {
  return { succes: "réussi", echec: "en échec", en_cours: "en cours", ignore: "ignoré" }[etat] ?? etat;
}

export function libelleRevue(etat: Revue["etat"]): string {
  return {
    approuvee: "approuvée",
    changements: "changements demandés",
    commentaire: "commentaire",
    attente: "en attente",
    rejetee: "écartée",
  }[etat] ?? etat;
}

/** Date relative courte : « il y a 3 h », « hier », « 12 oct. ». */
export function dateCourte(iso: string, maintenant = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.round((maintenant - t) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.round(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;
  const jours = Math.round(heures / 24);
  if (jours === 1) return "hier";
  if (jours < 7) return `il y a ${jours} j`;
  return new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
