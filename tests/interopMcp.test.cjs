// Réglages > MCP « Importer » et proposition unique au premier lancement.
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
const M = charger("../src/lib/importMcp.ts");
const srv = (nom, outil, fichier, extra = {}) => ({ cle: `${outil}|${fichier}|${nom}`, nom, outil, fichier, transport: "stdio", commande: `npx ${nom}`, variables: [], entetes: [], nomPris: false, ...extra });

test("cochés au départ : ni nom pris ni doublon ; un nom pris ne se coche pas", () => {
  const liste = [srv("github", "claude_code", "~/.claude.json", { variables: ["GITHUB_TOKEN"] }), srv("github", "cursor", "~/.cursor/mcp.json", { doublon: "même serveur que « github » (Claude Code)" }), srv("fetch", "cursor", "~/.cursor/mcp.json", { nomPris: true, doublon: "déjà configuré (« fetch »)" })];
  assert.deepEqual([...M.selectionDeDepart(liste)], ["claude_code|~/.claude.json|github"]);
  assert.equal(M.importable(liste[1]), true);
  assert.equal(M.importable(liste[2]), false);
  assert.deepEqual(M.grouper(liste).map((g) => [g.titre, g.serveurs.length]), [["Claude Code · ~/.claude.json", 1], ["Cursor · ~/.cursor/mcp.json", 2]]);
  assert.equal(M.detail(liste[0]), "npx github · GITHUB_TOKEN");
  assert.equal(M.detail(srv("sentry", "vscode", ".vscode/mcp.json", { transport: "http", url: "https://mcp.sentry.dev/mcp", entetes: ["Authorization"] })), "https://mcp.sentry.dev/mcp · Authorization");
  assert.equal(M.aProposer(liste), 1);
  assert.equal(M.outilsTrouves([...liste, srv("ctx", "codex", "~/.codex/config.toml"), srv("pw", "vscode", ".vscode/mcp.json")]), "Claude Code, Codex et VS Code");
  assert.equal(M.resumeMcp({ importes: ["a", "b"], erreurs: [] }), "2 serveurs importés");
  assert.equal(M.resumeMcp({ importes: [], erreurs: ["x : nom déjà pris"] }), "Aucun serveur importé · x : nom déjà pris");
});

test("proposée une seule fois : la réponse est gardée", () => {
  const memoire = new Map();
  const stockage = { getItem: (k) => memoire.get(k) ?? null, setItem: (k, v) => memoire.set(k, v) };
  assert.equal(M.propositionFaite(stockage), false);
  M.noterProposition(stockage, "plus-tard");
  assert.equal(M.propositionFaite(stockage), true);
  assert.equal(M.propositionFaite({ getItem: () => { throw new Error("interdit"); } }), true, "stockage illisible : on ne harcèle pas");
});

test("« Choisir… » avant le montage des Réglages : la demande attend le bouton", () => {
  const cible = new EventTarget();
  let recu = 0;
  cible.addEventListener(M.EVENEMENT_IMPORT_MCP, () => (recu += 1));
  M.demanderImportMcp(cible);
  assert.equal(recu, 1);
  assert.equal(M.prendreDemandeImportMcp(), true);
  assert.equal(M.prendreDemandeImportMcp(), false, "prise une seule fois");
});
