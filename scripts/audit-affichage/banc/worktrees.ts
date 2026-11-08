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
    // W3 / W4
    worktrees_lister: () => (scene.wtListe ? depotsListe() : []),
    worktree_supprimer: (a: any) => {
      (window as any).__bancWorktrees.suppressions.push(a);
      const t = tache("t-suppr-" + taches.length, a.archiver ? "archivage" : "suppression", a.titre ?? "worktree", "corriger-le-panier", a.lancerScript ? "script" : "git", "en_cours", { message: "Suppression du dossier…" });
      taches.push(t);
      return t;
    },
    worktrees_nettoyage: () => infosNettoyage(),
    worktrees_prune: () => 1,
  };
}


// W3 / W4 — dépôts de la liste et examen du nettoyage.
const ligne = (dossier: string, nom: string, branche: string | null, extra: any = {}) => ({
  dossier, nom, branche, principal: false, detache: !branche, verrouille: false, introuvable: false,
  modifies: 0, avance: 0, retard: 0, reference: "main", dernierCommitMs: D.T0 - 3_600_000, ...extra,
});
const LONG = "migration-des-postes-du-standard-telephonique-pour-le-cabinet";
export function depotsListe() {
  return [
    {
      depot: DEPOT, nom: D.NOM_WS, branchePrincipale: "main", erreur: null,
      worktrees: [
        ligne(DEPOT, D.NOM_WS, "main", { principal: true, modifies: 2, retard: 3, reference: "origin/main" }),
        ligne(`${CONTENEUR}\\corriger-le-panier`, "corriger-le-panier", "corriger-le-panier", { modifies: 4, avance: 2, retard: 1 }),
        ligne(`${CONTENEUR}\\${LONG}`, LONG, LONG, { avance: 5 }),
        ligne(`${CONTENEUR}\\ancienne-tache`, "ancienne-tache", "ancienne-tache", { introuvable: true, modifies: null, avance: null, retard: null, reference: null, dernierCommitMs: null }),
        ligne(`${CONTENEUR}\\revue-pr-42`, "revue-pr-42", null, { reference: null, avance: null, retard: null }),
      ],
    },
    {
      depot: AUTRE_DEPOT, nom: "cabinet-martin", branchePrincipale: "master", erreur: null,
      worktrees: [
        ligne(AUTRE_DEPOT, "cabinet-martin", "master", { principal: true, reference: null, avance: null, retard: null }),
        ligne(`${AUTRE_DEPOT}-worktrees\\export-csv`, "export-csv", "export-csv", { avance: 1, reference: "master" }),
      ],
    },
  ];
}
export const REGLAGES_LISTE = {
  depots: { [DEPOT]: { base: "main" } },
  epingles: [`${CONTENEUR}\\corriger-le-panier`],
  liens: { [`${CONTENEUR}\\corriger-le-panier`]: "https://github.com/exemple/projet/pull/42" },
  endormis: [`${CONTENEUR}\\${LONG}`],
  archives: [{ depot: DEPOT, branche: "vieille-idee", titre: "Vieille idée de cache", dossier: `${CONTENEUR}\\vieille-idee`, dateMs: D.T0 - 5 * 86_400_000 }],
};
export function infosNettoyage() {
  const jour = 86_400_000;
  const maintenant = Date.now();
  return [
    { depot: DEPOT, dossier: `${CONTENEUR}\\fusionnee`, branche: "fusionnee", fusionne: true, introuvable: false, modifies: 0, octets: 1_530_000_000, tailleCoupee: false, activiteMs: maintenant - 12 * jour },
    { depot: DEPOT, dossier: `${CONTENEUR}\\ancienne-tache`, branche: "ancienne-tache", fusionne: false, introuvable: true, modifies: null, octets: null, tailleCoupee: false, activiteMs: null },
    { depot: DEPOT, dossier: `${CONTENEUR}\\${LONG}`, branche: LONG, fusionne: false, introuvable: false, modifies: 3, octets: 4_200_000_000, tailleCoupee: true, activiteMs: maintenant - 45 * jour },
    { depot: AUTRE_DEPOT, dossier: `${AUTRE_DEPOT}-worktrees\\export-csv`, branche: "export-csv", fusionne: false, introuvable: false, modifies: 0, octets: 82_000_000, tailleCoupee: false, activiteMs: maintenant - 2 * 3_600_000 },
  ];
}

export { AUTRE_DEPOT, CONTENEUR, DEPOT };
