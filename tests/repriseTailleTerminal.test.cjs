// Terminal de l'agent / cloud : la taille est renvoyée au retour vers le terminal (tmux partagé).
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
const { reprendreTaille } = charger("../src/components/cloud/repriseTaille.ts");
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

test("focus, clic, retour sur la fenêtre : la taille est renvoyée", async () => {
  const hote = new EventTarget(), fen = new EventTarget(), doc = new EventTarget();
  doc.visibilityState = "visible";
  let n = 0;
  const off = reprendreTaille(hote, () => n++, fen, doc);
  hote.dispatchEvent(new Event("focusin"));
  hote.dispatchEvent(new Event("pointerdown")); // même geste : regroupé
  assert.equal(n, 1);
  await attendre(170);
  fen.dispatchEvent(new Event("focus"));
  assert.equal(n, 2);
  await attendre(170);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(n, 2);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(n, 3);
  off();
  await attendre(170);
  hote.dispatchEvent(new Event("focusin"));
  fen.dispatchEvent(new Event("focus"));
  assert.equal(n, 3);
});

test("les deux terminaux tmux s'en servent et renvoient la taille au ResizeObserver", () => {
  const src = (f) => fs.readFileSync(path.resolve(__dirname, "../src/components/cloud", f), "utf8");
  for (const f of ["AgentTerminal.tsx", "RemoteTerminal.tsx"]) assert.match(src(f), /reprendreTaille\(/, f);
  assert.match(src("AgentTerminal.tsx"), /new ResizeObserver\(\(\) => \{[\s\S]*?envoyerTaille\(\)/);
});
