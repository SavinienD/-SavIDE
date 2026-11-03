// Dossiers récents de l'accueil : historique d'au moins 20 dossiers, retrait d'une entrée.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const memoire = new Map();
global.localStorage = {
  getItem: (k) => (memoire.has(k) ? memoire.get(k) : null),
  setItem: (k, v) => memoire.set(k, String(v)),
  removeItem: (k) => memoire.delete(k),
  clear: () => memoire.clear(),
};

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
const R = charger("../src/lib/recents.ts");

test("au moins 20 dossiers gardés", () => {
  memoire.clear();
  for (let i = 0; i < 30; i++) R.recordRecent(`/d/${i}`, `d${i}`);
  const l = R.loadRecents();
  assert.ok(l.length >= 20, `seulement ${l.length}`);
});

test("retirer un dossier : seulement cette entrée, persistant", () => {
  memoire.clear();
  R.recordRecent("/a", "a");
  R.recordRecent("/b", "b");
  R.recordRecent("/c", "c");
  const reste = R.removeRecent("/b");
  assert.deepEqual(reste.map((r) => r.path).sort(), ["/a", "/c"]);
  assert.deepEqual(R.loadRecents().map((r) => r.path).sort(), ["/a", "/c"]);
});

test("retirer un dossier absent ne change rien", () => {
  memoire.clear();
  R.recordRecent("/a", "a");
  assert.equal(R.removeRecent("/zz").length, 1);
});
