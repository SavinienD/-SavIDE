// Réglages > MCP : bouton « Supprimer » d'un serveur (retire l'entrée de la config).
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
const C = charger("../src/axe/mcpCatalog.ts");

const serveur = (id, extra = {}) => ({ id, name: id, command: "npx", args: [], env: [], headers: [], enabled: true, ...extra });

test("le serveur supprimé disparaît, les autres restent dans l'ordre", () => {
  const r = C.retirerServeurMcp({ servers: [serveur("a"), serveur("b"), serveur("c")] }, "b");
  assert.deepEqual(r.servers.map((s) => s.id), ["a", "c"]);
});

test("la sélection passe au serveur suivant, sinon au précédent, sinon à rien", () => {
  assert.equal(C.retirerServeurMcp({ servers: [serveur("a"), serveur("b"), serveur("c")] }, "b").selection, "c");
  assert.equal(C.retirerServeurMcp({ servers: [serveur("a"), serveur("b")] }, "b").selection, "a");
  assert.equal(C.retirerServeurMcp({ servers: [serveur("a")] }, "a").selection, null);
});

test("serveur inconnu : rien ne change", () => {
  const r = C.retirerServeurMcp({ servers: [serveur("a")] }, "zz");
  assert.deepEqual(r.servers.map((s) => s.id), ["a"]);
  assert.equal(r.selection, "a");
});

test("les secrets gardés du serveur supprimé sont oubliés (pas ceux des autres)", () => {
  const coffre = new Map();
  C.collectMcpSecrets({ servers: [
    serveur("a", { env: [{ key: "API_KEY", value: "secret-a" }] }),
    serveur("b", { env: [{ key: "API_KEY", value: "secret-b" }] }),
  ] }, coffre);
  C.retirerServeurMcp({ servers: [serveur("a"), serveur("b")] }, "a", coffre);
  assert.deepEqual([...coffre.values()], ["secret-b"]);
});
