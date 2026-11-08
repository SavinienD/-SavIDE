// Panneau Git du banc : état de la branche, fetch, commit (hook qui refuse),
// poussée (refus puis poussée forcée), abandon, rédaction IA, forges (PR, checks,
// revues, issues). Formes réelles des commandes de src-tauri/src/git.rs et forges/.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as D from "./donnees";

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
    ...simulationForge(scene),
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

// ---- Forges (onglets PR et Issues) ----

const T0 = Date.UTC(2026, 10, 8, 9, 0, 0);
const iso = (heures: number) => new Date(T0 - heures * 3_600_000).toISOString();
const WEB = "https://git.exemple.fr/equipe/projet";

const PRS = [
  { numero: 12, titre: "Onglet PR du panneau Git : checks, revues et commentaires renvoyés à l'agent", auteur: "leo", etat: "ouverte", brouillon: false, branche: "night-ui-audit", base: "main", url: `${WEB}/pulls/12`, maj: iso(2) },
  { numero: 11, titre: "WIP: issues dans l'IDE", auteur: "camille", etat: "ouverte", brouillon: true, branche: "issues-ide", base: "main", url: `${WEB}/pulls/11`, maj: iso(30) },
  { numero: 9, titre: "Banc : scènes du panneau Git", auteur: "nora", etat: "ouverte", brouillon: false, branche: "banc-git", base: "main", url: `${WEB}/pulls/9`, maj: iso(200) },
];

const JOURNAL = Array.from({ length: 60 }, (_, i) => `étape ${i + 1} : npm test`).join("\n") +
  "\nnot ok 3 - le panneau Git tient à 800 px\n  error: attendu 0 défaut, trouvé 2\nProcess completed with exit code 1.";

function detailPr(numero: number) {
  const pr = PRS.find((p) => p.numero === numero) ?? PRS[0];
  return {
    ...pr,
    description: "Ajoute l'onglet PR au panneau Git.\n\n- liste des PR\n- checks, revues et commentaires\n- envoi à l'agent",
    sha: "a1b2c3d",
    checks: [
      { id: "statut:41", nom: "ci / build (push)", etat: "echec", detail: "Failing after 1m12s", url: `${WEB}/actions/runs/41/jobs/0`, journal: true },
      { id: "statut:42", nom: "ci / lint (push)", etat: "en_cours", detail: "En cours", url: `${WEB}/actions/runs/41/jobs/1`, journal: true },
      { id: "statut:43", nom: "ci / banc d'affichage (push)", etat: "succes", detail: "Successful in 4m", url: `${WEB}/actions/runs/41/jobs/2`, journal: true },
    ],
    revues: [
      { id: "r1", auteur: "nora", etat: "changements", corps: "Les boutons débordent à 800 px, voir les deux commentaires.", date: iso(5) },
      { id: "r2", auteur: "leo", etat: "approuvee", corps: "", date: iso(4) },
    ],
    commentaires: [
      { id: "c1", auteur: "nora", corps: "Ce bouton passe sous la barre quand le volet est étroit.", fichier: "src/components/pr/PrOnglet.tsx", ligne: 214, date: iso(5), url: `${WEB}/pulls/12/files#issuecomment-1` },
      { id: "c2", auteur: "nora", corps: "Nom de classe à aligner sur git-panel__.", fichier: "src/components/pr/pr.css", ligne: 12, date: iso(5), url: `${WEB}/pulls/12/files#issuecomment-2` },
      { id: "c3", auteur: "leo", corps: "Merci, je relance le banc après la correction.", fichier: null, ligne: null, date: iso(3), url: `${WEB}/pulls/12#issuecomment-3` },
    ],
  };
}

const ISSUES = [
  { numero: 7, titre: "Écran PR : liste des checks Forgejo", auteur: "camille", corps: "Afficher les checks de la PR et pouvoir envoyer un échec à l'agent.", etiquettes: ["ui", "git"], url: `${WEB}/issues/7`, maj: iso(6), commentaires: 2 },
  { numero: 6, titre: "Le message de commit rédigé par l'IA doit suivre le style des commits du dépôt", auteur: "leo", corps: "", etiquettes: [], url: `${WEB}/issues/6`, maj: iso(50), commentaires: 0 },
  { numero: 4, titre: "Fetch automatique", auteur: "nora", corps: "Toutes les 10 minutes ?", etiquettes: ["idée"], url: `${WEB}/issues/4`, maj: iso(400), commentaires: 5 },
];

function simulationForge(scene: Record<string, unknown>) {
  const genre = (scene.forge as string | undefined) ?? "gitea";
  const avecJeton = !scene.sansJeton;
  const worktree = `${D.WS}-issue-7-ecran-pr-liste-des-checks-forgejo`;
  const h: Record<string, (a: any) => any> = {
    forge_etat: () => ({
      depot: { genre, hote: genre === "github" ? "github.com" : "git.exemple.fr", proprietaire: "equipe", nom: "projet", urlWeb: WEB, urlApi: "https://git.exemple.fr/api/v1", remote: "origin" },
      jeton: avecJeton,
      jetonEnregistre: avecJeton,
      gh: false,
      message: null,
    }),
    forge_jeton: () => null,
    forge_prs: () => PRS.map((p) => ({ ...p })),
    forge_pr: (a) => detailPr(Number(a.numero)),
    forge_journal: () => JOURNAL,
    forge_issues: () => ISSUES.map((i) => ({ ...i })),
    forge_creer_pr: () => ({ numero: 12, url: `${WEB}/pulls/12`, message: "PR #12 créée." }),
  };
  if (scene.travaillerIssue) {
    Object.assign(h, {
      git_create_worktree_command: () => ({ worktreePath: worktree, branch: "issue-7-ecran-pr-liste-des-checks-forgejo", pushed: false, message: "Arbre de travail créé pour issue-7-ecran-pr-liste-des-checks-forgejo.", warning: null }),
      create_conversation: (a: any) => ({
        workspace: { path: a.workspacePath ?? worktree, name: "projet-issue-7" },
        conversations: [],
        activeConversation: D.conversationSauvee("c-issue-7"),
        modeModelSettings: D.MODES,
      }),
      rename_conversation: () => [],
    });
  }
  return h;
}
