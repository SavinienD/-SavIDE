// Réglages > Serveurs MCP : état des lignes, sonde retrouvée par nom, serveurs internes de Codex.
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
const S = charger("../src/lib/mcpServeurs.ts");
const I = charger("../src/lib/importMcp.ts");
const outil = (name) => ({ serverId: "x", serverName: "x", name, toolName: name });
const sonde = (extra) => ({ serverId: "node_repl", serverName: "node_repl", enabled: true, ok: true, tools: [outil("eval"), outil("reset")], transport: "stdio", authRequired: false, authenticated: false, ...extra });
const CODEX = "C:\\Users\\S\\AppData\\Local\\OpenAI\\Codex\\runtimes\\node\\node.exe";

test("sonde retrouvée par identifiant, sinon par nom", () => {
  const sondes = [sonde({ serverId: "id-du-service" })];
  assert.equal(S.sondeDuServeur(sondes, { id: "id-du-service", name: "autre" }), sondes[0]);
  assert.equal(S.sondeDuServeur(sondes, { id: "mcp_node_repl", name: "node_repl" }), sondes[0]);
  assert.equal(S.sondeDuServeur(sondes, { id: "y", name: "y" }), null);
});

test("état d'une ligne : outils, désactivé, erreur, connexion", () => {
  assert.deepEqual(S.etatLigne({ enabled: true }, sonde(), false), { ton: "ok", libelle: "2 outils" });
  assert.deepEqual(S.etatLigne({ enabled: false }, sonde({ enabled: false, tools: [] }), false, 4), { ton: "off", libelle: "Désactivé · 4 outils" });
  assert.deepEqual(S.etatLigne({ enabled: false }, sonde({ enabled: false, tools: [] }), false), { ton: "off", libelle: "Désactivé" });
  assert.equal(S.etatLigne({ enabled: true }, sonde({ ok: false, error: "x" }), false).libelle, "Erreur");
  assert.equal(S.etatLigne({ enabled: true }, sonde({ ok: false, authRequired: true }), false).libelle, "À connecter");
  assert.equal(S.etatLigne({ enabled: true }, null, true).libelle, "Vérification…");
});

test("node_repl de Codex : signalé interne, pas coché ni proposé à l'import", () => {
  assert.ok(S.serveurInterne({ command: CODEX, args: [] }));
  assert.equal(S.serveurInterne({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }), null);
  const liste = [
    { cle: "codex|cfg|node_repl", nom: "node_repl", outil: "codex", fichier: "~/.codex/config.toml", transport: "stdio", commande: CODEX, variables: [], entetes: [], nomPris: false },
    { cle: "codex|cfg|github", nom: "github", outil: "codex", fichier: "~/.codex/config.toml", transport: "stdio", commande: "npx github", variables: [], entetes: [], nomPris: false },
  ];
  assert.ok(I.interneCodex(liste[0]));
  assert.deepEqual([...I.selectionDeDepart(liste)], ["codex|cfg|github"]);
  assert.equal(I.aProposer(liste), 1);
  assert.ok(I.importable(liste[0]), "on peut encore le cocher à la main");
});
