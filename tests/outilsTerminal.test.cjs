"use strict";
// Outils du terminal (src/components/agents-cli/outilsTerminal.ts) : recherche dans l'historique,
// copie de toute la sortie, chemin d'un fichier glissé de l'explorateur.
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
const O = charger("../src/components/agents-cli/outilsTerminal.ts");
const T = charger("../src/components/terminalTabs.ts");

test("recherche : toutes les occurrences, sans tenir compte de la casse par défaut", () => {
  const lignes = ["npm run build", "Erreur : build échoué", "", "BUILD buildbuild"];
  assert.deepEqual(O.chercherDansLignes(lignes, "build"), [
    { ligne: 0, colonne: 8, longueur: 5 },
    { ligne: 1, colonne: 9, longueur: 5 },
    { ligne: 3, colonne: 0, longueur: 5 },
    { ligne: 3, colonne: 6, longueur: 5 },
    { ligne: 3, colonne: 11, longueur: 5 },
  ]);
  assert.equal(O.chercherDansLignes(lignes, "BUILD", true).length, 1);
  assert.deepEqual(O.chercherDansLignes(lignes, ""), []);
  assert.equal(O.chercherDansLignes(["a.b"], ".").length, 1, "le motif est du texte, pas une expression");
});

test("recherche : occurrence suivante et précédente, en boucle", () => {
  assert.equal(O.occurrenceVoisine(3, -1, 1), 0);
  assert.equal(O.occurrenceVoisine(3, -1, -1), 2);
  assert.equal(O.occurrenceVoisine(3, 2, 1), 0);
  assert.equal(O.occurrenceVoisine(3, 0, -1), 2);
  assert.equal(O.occurrenceVoisine(0, 0, 1), -1);
});

test("copier toute la sortie : fins de ligne nettoyées, lignes vides finales retirées", () => {
  assert.equal(O.texteComplet(["$ ls   ", "a.txt", "", "  ", ""]), "$ ls\na.txt");
  assert.equal(O.texteComplet([]), "");
});

test("fichier glissé sur le terminal : chemin entre guillemets (WSL : /mnt/c/…)", () => {
  assert.equal(O.cheminPourTerminal("C:\\Users\\moi\\mon projet\\a.ts", { wsl: false }), '"C:\\Users\\moi\\mon projet\\a.ts"');
  assert.equal(O.cheminPourTerminal("C:\\Users\\moi\\a.ts", { wsl: true }), '"/mnt/c/Users/moi/a.ts"');
  assert.equal(O.cheminPourTerminal("/home/moi/dit \"oui\".md", { wsl: false }), "'/home/moi/dit \"oui\".md'");
  const entrees = [
    { absolutePath: "C:\\depot\\src\\a.ts", relativePath: "src/a.ts" },
    { absolutePath: "C:\\depot\\README.md", relativePath: "README.md" },
  ];
  assert.equal(O.cheminsDeposes(entrees, null, false), '"C:\\depot\\src\\a.ts" "C:\\depot\\README.md" ');
  // Agent dans un arbre de travail : le même fichier, dans son dossier.
  assert.equal(O.cheminsDeposes(entrees.slice(0, 1), { dossier: "C:\\depot-agent-claude", branche: "agent/claude-1" }, false), '"C:\\depot-agent-claude\\src\\a.ts" ');
  assert.equal(O.cheminsDeposes(entrees.slice(0, 1), { dossier: "/home/moi/depot-wt", branche: "b" }, false), '"/home/moi/depot-wt/src/a.ts" ');
});

test("terminal scindé : la paire reste affichée quand l'un des deux est actif", () => {
  const ids = ["terminal-1", "terminal-2", "terminal-3"];
  const paire = { gauche: "terminal-1", droite: "terminal-3" };
  assert.deepEqual(T.vueScindee(paire, "terminal-3", ids), paire);
  assert.deepEqual(T.vueScindee(paire, "terminal-1", ids), paire);
  assert.equal(T.vueScindee(paire, "terminal-2", ids), null, "autre onglet : vue simple");
  assert.equal(T.vueScindee({ gauche: "terminal-1", droite: "terminal-9" }, "terminal-1", ids), null, "onglet fermé : plus de paire");
  assert.equal(T.vueScindee(null, "terminal-1", ids), null);
  assert.equal(T.vueScindee(paire, T.GIT_TAB_ID, ids), null);
});
