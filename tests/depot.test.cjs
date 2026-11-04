// depot — glisser-déposer : position physique de Tauri → pixels CSS, dépôt sans chemin.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const Module = require("node:module");
function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = new Module(p, module); m.filename = p; m._compile(js, p); return m.exports;
}
const D = charger("../src/lib/depot.ts");
const ws = fs.readFileSync(path.resolve(__dirname, "../src/components/Workspace.tsx"), "utf8");

test("Retina ×2 et zoom : le point physique est ramené en CSS", () => {
  assert.deepEqual(D.pointCss({ x: 1600, y: 1200 }, 2), { x: 800, y: 600 });
  assert.deepEqual(D.pointCss({ x: 1500, y: 900 }, 1.5, 1.25), { x: 800, y: 480 });
  assert.deepEqual(D.pointCss({ x: 10, y: 10 }, 0, NaN), { x: 10, y: 10 });
  const champ = { left: 700, right: 900, top: 550, bottom: 650 };
  assert.equal(D.dansRect(D.pointCss({ x: 1600, y: 1200 }, 2), champ), true);
  assert.equal(D.dansRect({ x: 1600, y: 1200 }, champ), false); // ancien comportement : à côté
});

test("dépôt sans chemin : message clair (macOS : vignette de capture, ⌘V)", () => {
  assert.match(D.messageDepotVide(true), /⌘V/);
  assert.match(D.messageDepotVide(false), /Ctrl\+V/);
  assert.match(ws, /messageDepotVide\(estMac\(\)\)/);
  assert.match(ws, /pointCss\(physique,/);
});
