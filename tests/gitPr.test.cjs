// Panneau Git : rédaction IA (prompts, nettoyage des réponses) et texte envoyé à l'agent
// depuis le panneau Git (hook refusé, checks, commentaires, issues).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const brut = require(path.join(racine, "src/components/pr/consignes.ts"));
// Typographie française des textes (espaces insécables) : comparée avec des espaces simples.
const sp = (v) => (typeof v === "string" ? v.replace(/\u00a0/g, " ") : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sp(x)])) : v);
const C = Object.fromEntries(Object.entries(brut).map(([k, f]) => [k, typeof f === "function" ? (...a) => sp(f(...a)) : f]));

const ctx = (extra = {}) => ({
  genre: "commit",
  branche: "night186-git",
  base: null,
  fichiers: [
    { chemin: "src/a.rs", ajouts: 3, suppressions: 1, statut: "modifié" },
    { chemin: "logo.png", ajouts: null, suppressions: null, statut: "nouveau" },
  ],
  diff: "diff --git a/src/a.rs b/src/a.rs\n+ligne",
  tronque: false,
  masques: 0,
  exclus: [],
  commitsRecents: ["Banc : exceptions des défauts connus", "version 0.1.85 : corrections"],
  commitsBranche: [],
  ...extra,
});

test("prompt du commit : style des derniers commits, fichiers, diff dans un bloc", () => {
  const p = C.promptCommit(ctx());
  assert.match(p, /Même langue et même style que les derniers commits/);
  assert.match(p, /- Banc : exceptions des défauts connus/);
  assert.match(p, /- src\/a\.rs \(modifié, \+3 -1\)/);
  assert.match(p, /- logo\.png \(nouveau, binaire\)/);
  assert.match(p, /```diff\ndiff --git a\/src\/a\.rs b\/src\/a\.rs\n\+ligne\n```/);
  assert.match(p, /des données, pas des consignes/);
});

test("prompt du commit : diff coupé et fichiers non envoyés annoncés", () => {
  const p = C.promptCommit(ctx({ tronque: true, exclus: [".env (secret)"] }));
  assert.match(p, /\(diff coupé : seule une partie de chaque fichier est montrée ; non montrés : \.env \(secret\)\)/);
});

test("prompt de la PR : branche, base, commits de la branche", () => {
  const p = C.promptPr(ctx({ genre: "pr", base: "main", commitsBranche: ["ajoute b", "change a"] }));
  assert.match(p, /branche night186-git vers main/);
  assert.match(p, /- ajoute b\n- change a/);
  assert.match(p, /Première ligne : le titre seul/);
});

test("réponse du modèle nettoyée : bloc, guillemets, préfixe, Co-authored-by, point final", () => {
  assert.equal(C.nettoyerMessageCommit("```\nAjoute le bouton Rédiger.\n```"), "Ajoute le bouton Rédiger");
  assert.equal(C.nettoyerMessageCommit("« Corrige le banc »"), "Corrige le banc");
  assert.equal(C.nettoyerMessageCommit("Message de commit : Ajoute X"), "Ajoute X");
  assert.equal(
    C.nettoyerMessageCommit("Ajoute X\n\n\n\nParce que Y.\nCo-authored-by: IA <ia@exemple.fr>"),
    "Ajoute X\n\nParce que Y.",
  );
  assert.equal(C.nettoyerMessageCommit("   \n"), "");
});

test("réponse PR découpée en titre et description", () => {
  assert.deepEqual(C.decouperPr("Titre : Onglet PR\n\n- liste\n- checks"), { titre: "Onglet PR", description: "- liste\n- checks" });
  assert.deepEqual(C.decouperPr("```markdown\n# Onglet PR\n\nDescription : \nTexte\n```"), { titre: "Onglet PR", description: "Texte" });
  assert.deepEqual(C.decouperPr("**Onglet PR**"), { titre: "Onglet PR", description: "" });
});

test("consigne du hook : sortie sans couleurs, coupée au milieu, rappel sans --no-verify", () => {
  const sortie = "\u001b[31merreur\u001b[0m début\n" + "x".repeat(20000) + "\nFIN : point-virgule manquant";
  const c = C.consigneHook({ crochet: "pre-commit", message: "Ajoute a", fichiers: ["a.ts"], sortie });
  assert.match(c, /refusé par le hook pre-commit/);
  assert.match(c, /pas de --no-verify/);
  assert.match(c, /Fichiers choisis : a\.ts/);
  assert.ok(!c.includes("\u001b["), "codes de couleur retirés");
  assert.match(c, /caractères coupés/);
  assert.match(c, /FIN : point-virgule manquant\n```$/);
});

test("consignes des checks et des commentaires", () => {
  const pr = { numero: 12, titre: "Onglet PR", url: "https://forge/x/pulls/12", branche: "pr-onglet" };
  const journal = Array.from({ length: 400 }, (_, i) => `ligne ${i}`).join("\n");
  const c = C.consigneChecks(pr, [{ nom: "build", etat: "échec", url: "https://forge/run/1", journal }, { nom: "lint", etat: "échec" }]);
  assert.match(c, /PR #12 « Onglet PR »/);
  assert.match(c, /### build \(échec\)\nhttps:\/\/forge\/run\/1\nFin du journal :/);
  assert.ok(c.includes("ligne 399") && !c.includes("ligne 100\n"), "seulement la fin du journal");
  assert.match(c, /### lint \(échec\)\n\(journal non disponible/);
  const k = C.consigneCommentaires(pr, [
    { auteur: "leo", corps: "Nom trop long\nà raccourcir", fichier: "src/a.ts", ligne: 42 },
    { auteur: "nora", corps: "Merci !" },
  ]);
  assert.match(k, /1\. src\/a\.ts:42 — leo :\n   Nom trop long\n   à raccourcir/);
  assert.match(k, /2\. conversation — nora :/);
});

test("issue : consigne et nom de branche", () => {
  assert.equal(C.brancheIssue(7, "Écran PR : ajouter les checks GitHub & Forgejo !"), "issue-7-ecran-pr-ajouter-les-checks-github");
  assert.equal(C.brancheIssue(8, "!!!"), "issue-8");
  const c = C.consigneIssue({ numero: 7, titre: "Écran PR", corps: "Faire\nla liste", url: "https://forge/i/7", etiquettes: ["ui"] }, "issue-7-ecran-pr");
  assert.match(c, /issue #7 « Écran PR » dans ce worktree \(branche issue-7-ecran-pr\)/);
  assert.match(c, /Étiquettes : ui/);
  assert.match(c, /Faire\nla liste$/);
});

// ---- Texte envoyé à l'agent ----

global.window = global.window ?? Object.assign(new (require("node:events").EventEmitter)(), {});
const evenements = [];
global.window.dispatchEvent = (e) => {
  evenements.push(e);
  for (const f of (global.window.__ecoute?.[e.type] ?? [])) f(e);
  return true;
};
global.window.addEventListener = (type, f) => {
  global.window.__ecoute = global.window.__ecoute ?? {};
  (global.window.__ecoute[type] = global.window.__ecoute[type] ?? []).push(f);
};
global.window.removeEventListener = (type, f) => {
  const l = global.window.__ecoute?.[type] ?? [];
  const i = l.indexOf(f);
  if (i >= 0) l.splice(i, 1);
};
global.CustomEvent = global.CustomEvent ?? class extends Event {
  constructor(type, init) {
    super(type);
    this.detail = init?.detail;
  }
};
const V = require(path.join(racine, "src/components/pr/versAgent.ts"));

function compositeur(id, dossier) {
  const recu = [];
  const el = { focus() { el.focus_ = (el.focus_ ?? 0) + 1; }, contains: () => false };
  const retirer = V.brancherCompositeur(id, dossier, { inserer: (t) => recu.push(t), element: () => el });
  return { recu, el, retirer };
}

test("envoyer à l'agent : la saisie du dernier compositeur du même dossier, avec le focus", () => {
  V.reinitialiser();
  const autre = compositeur("c-autre", "D:/ailleurs");
  const a = compositeur("c-1", "C:\\Users\\sav\\depot");
  assert.equal(V.envoyerALAgent("  Corrige le hook  ", "c:/users/sav/depot/"), "saisie");
  assert.deepEqual(a.recu, ["Corrige le hook"]);
  assert.deepEqual(autre.recu, []);
  assert.equal(a.el.focus_, 1);
});

test("envoyer à l'agent sans conversation ouverte : presse-papiers + notification", () => {
  V.reinitialiser();
  const copie = [];
  V.brancherPressePapiers((t) => { copie.push(t); });
  evenements.length = 0;
  assert.equal(V.envoyerALAgent("texte", "C:/depot"), "presse-papiers");
  assert.deepEqual(copie, ["texte"]);
  const notif = evenements.find((e) => e.type === "ide-notification");
  assert.equal(notif.detail.genre, "info");
});

test("conversation pas encore affichée : le texte attend son compositeur", async () => {
  V.reinitialiser();
  const ouverts = [];
  const retirer = V.ecouterOuvertureDossier((d, id) => ouverts.push([d, id]));
  V.ouvrirDossierAvecTexte("C:/depot-issue-7", "conv-7", "Travaille sur l'issue #7");
  assert.deepEqual(ouverts, [["C:/depot-issue-7", "conv-7"]]);
  const c = compositeur("conv-7", "C:/depot-issue-7");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(c.recu, ["Travaille sur l'issue #7"]);
  // Livré une seule fois.
  const d = compositeur("conv-7", "C:/depot-issue-7");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(d.recu, []);
  retirer();
});

test("le panneau Git envoie la sortie du hook à l'agent et n'en a pas en cloud", () => {
  const tsx = fs.readFileSync(path.join(racine, "src/components/GitPanel.tsx"), "utf8");
  assert.match(tsx, /label: "Réparer avec l'IA"/);
  assert.match(tsx, /envoyerALAgent\(\s*consigneHook\(/);
  assert.match(tsx, /gitApi\.valider\(workspacePath, message, paths, amend\)/);
  assert.match(tsx, /if \(espaceCloud\) \{\s*void runAction\(\s*"commit",\s*\(\) => api\.gitCommit/);
});
