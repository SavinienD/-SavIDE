"use strict";
// Commandes et prompts enregistrés (src/components/agents-cli/stockageCommandes.ts).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const C = charger("../src/components/agents-cli/stockageCommandes.ts");
const memoire = (init = {}) => {
  const d = { ...init };
  return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, d };
};

test("stockage : exemples au premier lancement, liste vide si illisible, entrées nettoyées", () => {
  assert.deepEqual(C.lireCommandes(memoire()).map((c) => c.id), ["exemple-git", "exemple-relire"]);
  assert.deepEqual(C.lireCommandes(memoire({ [C.CLE_COMMANDES]: "{ illisible" })), []);
  assert.deepEqual(C.lireCommandes(memoire({ [C.CLE_COMMANDES]: "[]" })), [], "liste vidée par l'utilisateur : pas d'exemples");
  const s = memoire({ [C.CLE_COMMANDES]: JSON.stringify([
    { id: "a", genre: "prompt", nom: "Résumé", texte: "Résume {fichier}" },
    { id: "a", genre: "commande", nom: "doublon", texte: "x" },
    { id: "b", genre: "autre", texte: "ls" },
    { id: "", texte: "sans id" },
    null,
  ]) });
  assert.deepEqual(C.lireCommandes(s), [
    { id: "a", genre: "prompt", nom: "Résumé", texte: "Résume {fichier}" },
    { id: "b", genre: "commande", nom: "", texte: "ls" },
  ]);
  const s2 = memoire();
  C.ecrireCommandes([{ id: "z", genre: "commande", nom: "N", texte: "npm test" }], s2);
  assert.deepEqual(C.lireCommandes(s2), [{ id: "z", genre: "commande", nom: "N", texte: "npm test" }]);
});

test("variables {dossier} et {fichier}", () => {
  const v = { dossier: "C:\\depot", fichier: "src/a.ts" };
  assert.equal(C.remplacerVariables("cd {dossier} && code {fichier} {autre}", v), "cd C:\\depot && code src/a.ts {autre}");
  assert.deepEqual(C.variablesManquantes("Relis {fichier} dans {dossier}", { dossier: "/d", fichier: null }), ["fichier"]);
  assert.deepEqual(C.variablesManquantes("git status", {}), []);
  assert.equal(C.remplacerVariables("{fichier}", {}), "");
});

test("collage dans le terminal : encadré si demandé, Entrée seulement pour une commande", () => {
  assert.equal(C.donneesCollage("git status", false, true), "git status\r");
  assert.equal(C.donneesCollage("ligne 1\nligne 2", true, false), "\x1b[200~ligne 1\rligne 2\x1b[201~");
  assert.equal(C.donneesCollage("npm test", true, true), "\x1b[200~npm test\x1b[201~\r");
});

test("libellé : le nom, sinon le début du texte", () => {
  assert.equal(C.libelleCommande({ id: "1", genre: "commande", nom: " Tests ", texte: "npm test" }), "Tests");
  assert.equal(C.libelleCommande({ id: "1", genre: "commande", nom: "", texte: "npm   run\nbuild" }), "npm run build");
  assert.equal(C.libelleCommande({ id: "1", genre: "prompt", nom: "", texte: "" }), "Sans titre");
  assert.ok(C.libelleCommande({ id: "1", genre: "prompt", nom: "", texte: "x".repeat(100) }).endsWith("…"));
  const a = C.nouvelleCommande("prompt", 1000);
  const b = C.nouvelleCommande("prompt", 1000);
  assert.notEqual(a.id, b.id);
  assert.equal(a.genre, "prompt");
});

test("fichier actif de l'éditeur", () => {
  C.definirFichierActif("src/main.tsx");
  assert.equal(C.fichierActif(), "src/main.tsx");
  C.definirFichierActif("");
  assert.equal(C.fichierActif(), null);
});
