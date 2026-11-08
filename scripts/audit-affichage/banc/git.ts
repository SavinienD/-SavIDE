// Panneau Git du banc : état de la branche, fetch, commit (hook qui refuse),
// poussée (refus puis poussée forcée), abandon, rédaction IA, forges (PR, checks,
// revues, issues). Formes réelles des commandes de src-tauri/src/git.rs et forges/.
/* eslint-disable @typescript-eslint/no-explicit-any */

const SORTIE_HOOK = [
  "lint-staged : eslint --fix",
  "src/components/Workspace.tsx",
  "  412:7  error  'colonne' is assigned a value but never used  no-unused-vars",
  "  518:3  error  Missing semicolon                              semi",
  "✖ 2 problems (2 errors, 0 warnings)",
  "husky - pre-commit hook exited with code 1 (error)",
].join("\n");

const SORTIE_REJET = [
  "To git.exemple.fr:equipe/projet.git",
  " ! [rejected]        night-ui-audit -> night-ui-audit (fetch first)",
  "error: failed to push some refs to 'git.exemple.fr:equipe/projet.git'",
].join("\n");

export function simulationGit(scene: Record<string, unknown>) {
  const etatScene = (scene.gitEtat ?? {}) as Record<string, unknown>;
  let operation = (etatScene.operation as string | undefined) ?? null;
  const etat = () => ({
    branche: "night-ui-audit",
    amont: "origin/night-ui-audit",
    avance: 0,
    retard: 0,
    dernierCommit: { hash: "f7e406f", message: "Banc : panneau Git à 800 px", pousse: true },
    remoteParDefaut: "origin",
    ...etatScene,
    operation,
  });
  return {
    git_etat_command: () => etat(),
    git_fetch_command: () => ({ message: "Branches distantes à jour.", stdout: null, stderr: null }),
    git_valider_command: (a: any) =>
      scene.hookRefuse
        ? { ok: false, message: "Commit refusé par le hook pre-commit.", sortie: SORTIE_HOOK, crochet: "pre-commit" }
        : { ok: true, message: a.modifierDernier ? "Dernier commit modifié." : "Validation (commit) créée.", sortie: null, crochet: null },
    git_pousser_command: (a: any) => {
      if (scene.pousseeRejetee && !a.forcer) {
        return { ok: false, rejete: true, message: "origin/night-ui-audit contient des commits que vous n'avez pas : récupérez-les, ou forcez si vous avez réécrit l'historique.", sortie: SORTIE_REJET };
      }
      return { ok: true, rejete: false, message: a.forcer ? "Poussé en forçant vers origin/night-ui-audit (--force-with-lease)." : "Poussé vers origin/night-ui-audit.", sortie: null };
    },
    git_abandonner_command: () => {
      operation = null;
      return { message: "Fusion abandonnée.", stdout: null, stderr: null };
    },
    git_contexte_ia_command: (a: any) => ({
      genre: a.genre ?? "commit",
      branche: "night-ui-audit",
      base: a.genre === "pr" ? "main" : null,
      fichiers: [{ chemin: "src/styles.css", ajouts: 12, suppressions: 3, statut: "modifié" }],
      diff: "diff --git a/src/styles.css b/src/styles.css\n+.git-panel { min-width: 0; }",
      tronque: false,
      masques: scene.redactionMasques ? 2 : 0,
      exclus: scene.redactionMasques ? [".env (secret)"] : [],
      commitsRecents: ["Banc : panneau Git à 800 px"],
      commitsBranche: ["Banc : panneau Git à 800 px"],
    }),
    ia_appel_unique: (a: any) => ({
      texte: String(a.systeme ?? "").includes("pull request")
        ? "Panneau Git lisible à 800 px\n\n- Colonnes qui ne débordent plus\n- Boutons gardés sur une ligne"
        : "Corrige l'affichage du panneau Git à 800 px",
      modele: "anthropic/claude-sonnet-5",
      usage: { input_tokens: 900, output_tokens: 20, total_tokens: 920, reasoning_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      tronque: false,
    }),
  };
}

