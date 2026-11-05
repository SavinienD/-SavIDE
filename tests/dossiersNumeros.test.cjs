"use strict";
// Ctrl+1…9 (⌘1…9 sur macOS) ouvre le n-ième dossier récent, dans
// l'ordre affiché sur l'accueil au moment de l'appui (le plus récent d'abord).
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
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const R = require(path.resolve(__dirname, "../src/axe/raccourcis.ts"));
const Rec = require(path.resolve(__dirname, "../src/lib/recents.ts"));
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
const ev = (o) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: "", code: "", ...o });
const reg = (id) => R.RACCOURCIS.find((x) => x.id === id);

test("Ctrl+1…9 (rangée et pavé numérique) : dossier récent n° 1…9", () => {
  const r = reg("dossierRecent");
  assert.ok(r, "entrée dossierRecent absente du registre");
  for (let n = 1; n <= 9; n++) {
    assert.ok(R.correspond(r, ev({ ctrlKey: true, key: String(n), code: `Digit${n}` }), false), `Ctrl+${n}`);
    assert.ok(R.correspond(r, ev({ ctrlKey: true, key: String(n), code: `Numpad${n}` }), false), `Ctrl+pavé ${n}`);
    assert.equal(R.numeroTouche(ev({ ctrlKey: true, code: `Digit${n}` })), n);
    assert.equal(R.numeroTouche(ev({ ctrlKey: true, code: `Numpad${n}` })), n);
  }
  // AZERTY : Ctrl + touche « 1 » donne key « & » ; on lit la touche physique.
  assert.ok(R.correspond(r, ev({ ctrlKey: true, key: "&", code: "Digit1" }), false));
  assert.ok(R.correspond(r, ev({ ctrlKey: true, key: "é", code: "Digit2" }), false));
  // Ctrl+0 reste le zoom à 100 % ; Maj, Alt (= AltGr : #, {, [ …) ne déclenchent rien.
  assert.ok(!R.correspond(r, ev({ ctrlKey: true, key: "0", code: "Digit0" }), false));
  assert.ok(R.correspond(reg("zoomReset"), ev({ ctrlKey: true, key: "0", code: "Digit0" }), false));
  assert.ok(!R.correspond(r, ev({ ctrlKey: true, shiftKey: true, key: "3", code: "Digit3" }), false));
  assert.ok(!R.correspond(r, ev({ ctrlKey: true, altKey: true, key: "#", code: "Digit3" }), false));
  assert.ok(!R.correspond(r, ev({ key: "3", code: "Digit3" }), false));
});

test("macOS : ⌘1…9 (Ctrl seul ne déclenche rien)", () => {
  const r = reg("dossierRecent");
  assert.ok(R.correspond(r, ev({ metaKey: true, key: "3", code: "Digit3" }), true));
  assert.ok(!R.correspond(r, ev({ ctrlKey: true, key: "3", code: "Digit3" }), true));
  assert.equal(R.combinaisonNumero("dossierRecent", 3, true), "⌘3");
  assert.equal(R.combinaisonNumero("dossierRecent", 3, false), "Ctrl+3");
  assert.equal(R.infoBulleNumero("Ouvrir client", "dossierRecent", 7, false), "Ouvrir client · Ctrl+7");
});

test("aucun autre raccourci sur Ctrl+1…9 : explorateur et saisie du chat déplacés", () => {
  for (const r of R.RACCOURCIS) {
    if (r.id === "dossierRecent") continue;
    for (let n = 1; n <= 9; n++) {
      assert.ok(!R.correspond(r, ev({ ctrlKey: true, key: String(n), code: `Digit${n}` }), false), `${r.id} prend Ctrl+${n}`);
    }
  }
  assert.ok(R.correspond(reg("focusExplorateur"), ev({ ctrlKey: true, shiftKey: true, key: "E", code: "KeyE" }), false));
  assert.ok(R.correspond(reg("focusChat"), ev({ ctrlKey: true, shiftKey: true, key: "T", code: "KeyT" }), false));
});

test("ordre : celui de l'accueil au moment de l'appui ; ouvrir un dossier le remet en tête", () => {
  memoire.clear();
  for (const n of ["a", "b", "c", "d"]) Rec.recordRecent(`/p/${n}`, n);
  // Accueil : d, c, b, a.
  assert.equal(Rec.dossierRecentNumero(1).path, "/p/d");
  assert.equal(Rec.dossierRecentNumero(3).path, "/p/b");
  assert.equal(Rec.dossierRecentNumero(5), null);
  assert.equal(Rec.dossierRecentNumero(0), null);
  // Ctrl+3 ouvre b, qui passe en tête : b, d, c, a (Ctrl+2 ramène alors au dossier quitté).
  Rec.recordRecent("/p/b", "b");
  assert.deepEqual(Rec.loadRecents().map((r) => r.path), ["/p/b", "/p/d", "/p/c", "/p/a"]);
  assert.equal(Rec.dossierRecentNumero(2).path, "/p/d");
});

test("branché : App fournit l'action, les cartes portent leur numéro et l'info-bulle", () => {
  const app = lire("../src/App.tsx");
  assert.match(app, /dossierRecent\s*:/);
  const w = lire("../src/components/Welcome.tsx");
  assert.match(w, /welcome__recent-num/);
  assert.match(w, /infoBulleNumero\(/);
  assert.match(lire("../src/axe/RaccourcisSection.tsx"), /data-raccourci=\{r\.id\}/);
});
