// Worktrees — simulation du backend des worktrees (scènes « worktrees-* » du banc) :
// réglages du dépôt (worktrees.toml), tâches de fond, sortie du script, liste et nettoyage.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { emit } from "@tauri-apps/api/event";
import * as D from "./donnees";

const DEPOT = D.WS;
const CONTENEUR = `${D.WS}-worktrees`;
const AUTRE_DEPOT = D.WS.replace(/[^\\]+$/, "cabinet-martin");
export const SORTIE_SCRIPT =
  "\x1b[2m> npm install\x1b[0m\r\n\r\nadded 312 packages, and audited 313 packages in 9s\r\n\r\n" +
  "\x1b[2m> npm run build\x1b[0m\r\n\r\nvite v5.4.11 building for production...\r\n\x1b[32m✓\x1b[0m 1532 modules transformed.\r\n";

function config(sansFichier: boolean) {
  const vide = { base: null, scriptCreation: null, scriptSuppression: null, sourceCreation: null, sourceSuppression: null, liens: [], copies: [], terminaux: [], fichiers: [], erreurs: [], empreinte: null };
  return {
    depot: DEPOT,
    nom: D.NOM_WS,
    branchePrincipale: "main",
    branches: ["main", "develop", "corriger-le-panier"],
    config: sansFichier
      ? vide
      : {
          ...vide,
          scriptCreation: "npm install\nnpm run build",
          scriptSuppression: "npm run clean",
          sourceCreation: "worktrees.toml",
          sourceSuppression: "worktrees.toml",
          liens: ["node_modules"],
          copies: [".env"],
          terminaux: [{ nom: "Serveur", commande: "npm run dev" }, { nom: "Tests", commande: "npm test -- --watch" }],
          fichiers: ["worktrees.toml"],
          empreinte: "a1b2c3d4e5f6a1b2c3d4e5f6",
        },
    modele: sansFichier ? "# Réglages des worktrees de ce dépôt.\n" : null,
  };
}

function tache(id: string, genre: string, titre: string, branche: string, etape: string, etat: string, extra: any = {}) {
  const creation = genre === "creation";
  return {
    id, genre, depot: DEPOT, dossier: `${CONTENEUR}\\${branche}`, branche, base: creation ? "main" : null, titre,
    etapes: creation ? ["git", "partage", "script", "fin"] : ["script", "git", "fin"], etape, etat,
    pret: creation && etape !== "git" && etape !== "partage", message: "", detail: null, raison: null,
    avertissements: [], partages: creation ? [{ chemin: "node_modules", mode: "jonction" }, { chemin: ".env", mode: "copie" }] : [],
    script: null, debutMs: D.T0, majMs: D.T0, ...extra,
  };
}

function tachesInitiales() {
  return [
    tache("t-cours", "creation", "Corriger le calcul du panier", "corriger-le-panier", "script", "en_cours", {
      message: "Préparation du worktree…",
      script: { sessionId: "worktree-t-cours", token: "jeton-1", enCours: true, code: null, commandes: "npm install\nnpm run build" },
    }),
    tache("t-echec", "creation", "Migration des postes du standard téléphonique (fichier CSV) pour le cabinet Martin et l'atelier Durand", "migration-des-postes-du-standard-telephonique", "script", "echec", {
      raison: "script", message: "Le script de préparation a échoué (code 1)",
      avertissements: ["« .env » absent du dépôt principal : rien à copier"],
      script: { sessionId: "worktree-t-echec", token: "jeton-2", enCours: false, code: 1, commandes: "npm install" },
    }),
    tache("t-fini", "suppression", "Ancienne tâche", "ancienne-tache", "fin", "reussi", {
      message: "Worktree supprimé",
      avertissements: ["Branche ancienne-tache gardée : elle a des commits qui ne sont pas dans la branche principale"],
    }),
  ];
}

export function simulationWorktrees(scene: any): Record<string, (a: any, brut: any) => unknown> {
  let sansFichier = !!scene.wtSansFichier;
  const taches: any[] = scene.wtTaches ? tachesInitiales() : [];
  (window as any).__bancWorktrees = { creations: [] as any[], suppressions: [] as any[] };
  return {
    worktrees_config: () => config(sansFichier),
    worktrees_config_creer: () => {
      sansFichier = false;
      return config(false);
    },
    worktree_creer: (a: any) => {
      (window as any).__bancWorktrees.creations.push(a);
      const t = tache("t-nouveau", "creation", a.titre || a.branche, a.branche, "git", "en_cours", {
        base: a.base, message: `Création de la branche ${a.branche} et du dossier…`,
        etapes: a.lancerScript ? ["git", "partage", "script", "fin"] : ["git", "partage", "fin"], partages: [],
      });
      taches.push(t);
      // Étape suivante publiée comme le ferait le backend (le worktree n'est pas encore prêt).
      window.setTimeout(() => void emit("worktrees-tache", { ...t, etape: "partage", message: "Partage des fichiers du dépôt…", majMs: t.majMs + 1 }), 300);
      return t;
    },
    worktrees_taches: () => taches,
    worktree_tache_sortie: () => ({ texte: SORTIE_SCRIPT, fin: SORTIE_SCRIPT.length }),
    worktree_tache_annuler: () => null,
    worktree_tache_reprendre: (a: any) => taches.find((t) => t.id === a.id) ?? null,
    worktree_tache_oublier: () => null,
    write_terminal: () => null,
    resize_terminal: () => null,
  };
}

export { AUTRE_DEPOT, CONTENEUR, DEPOT };
