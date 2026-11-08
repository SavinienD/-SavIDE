"use strict";
// ED1c : « Fermer tous les fichiers » et « Rouvrir l'onglet fermé »
// (raccourcis libres déclarés dans src/axe/raccourcis.ts, menu du clic droit sur un onglet).
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
};
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
const R = require(path.join(racine, "src/axe/raccourcis.ts"));
const O = require(path.join(racine, "src/components/editeur/onglets.ts"));
const ev = (o) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: "", code: "", ...o });
const reg = (id) => R.RACCOURCIS.find((x) => x.id === id);

const FERMER_TOUS = ev({ ctrlKey: true, shiftKey: true, key: "W", code: "KeyW" });
const ROUVRIR = ev({ ctrlKey: true, altKey: true, key: "o", code: "KeyO" });

test("raccourcis déclarés : Ctrl+Maj+W (fermer tous les fichiers), Ctrl+Alt+O (rouvrir l'onglet fermé)", () => {
  const tous = reg("fermerTousFichiers");
  const rouvrir = reg("rouvrirOnglet");
  assert.ok(tous && rouvrir);
  assert.equal(tous.combinaison, "Ctrl + Maj + W");
  assert.equal(rouvrir.combinaison, "Ctrl + Alt + O");
  assert.equal(tous.categorie, "Onglets");
  assert.ok(R.correspond(tous, FERMER_TOUS, false));
  assert.ok(R.correspond(rouvrir, ROUVRIR, false));
  // macOS : ⌘⇧W, ⌘⌥O (Option change le caractère : lu sur la touche physique).
  assert.ok(R.correspond(tous, ev({ metaKey: true, shiftKey: true, key: "w", code: "KeyW" }), true));
  assert.ok(R.correspond(rouvrir, ev({ metaKey: true, altKey: true, key: "ø", code: "KeyO" }), true));
});

test("sans conflit : aucune autre entrée du registre ne prend ces touches, ni les touches déjà prises", () => {
  for (const [id, e] of [["fermerTousFichiers", FERMER_TOUS], ["rouvrirOnglet", ROUVRIR]]) {
    for (const r of R.RACCOURCIS) if (r.id !== id) assert.ok(!R.correspond(r, e, false), `${r.id} prend aussi ${id}`);
    assert.equal(R.verifierCombinaison(id, R.lireCombinaison(e, false), false), null);
  }
  // Déjà prises ou réservées à la palette : jamais celles-ci.
  const prises = [
    ev({ ctrlKey: true, shiftKey: true, key: "T", code: "KeyT" }), ev({ ctrlKey: true, shiftKey: true, key: "E", code: "KeyE" }),
    ev({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" }), ev({ ctrlKey: true, key: "p", code: "KeyP" }), ev({ ctrlKey: true, key: "k", code: "KeyK" }),
  ];
  for (const e of prises) for (const id of ["fermerTousFichiers", "rouvrirOnglet"]) assert.ok(!R.correspond(reg(id), e, false), `${id} : ${e.key}`);
  // Ctrl+Alt+O n'est pas un caractère AltGr du clavier français ; Ctrl+Maj+W n'est pas au menu natif.
  assert.match(lire("src-tauri/src/platform.rs"), /accelerator\("CmdOrCtrl\+W"\)/);
  assert.doesNotMatch(lire("src-tauri/src/platform.rs"), /CmdOrCtrl\+Shift\+W/);
});

test("pile des onglets fermés : sans doublon, bornée, saute ce qui est déjà ouvert", () => {
  let pile = [];
  for (const c of ["a.md", "b.ts", "a.md", "c.csv"]) pile = O.noterFermeture(pile, c);
  assert.deepEqual(pile, ["b.ts", "a.md", "c.csv"]);
  assert.equal(O.noterFermeture(Array.from({ length: 30 }, (_, i) => `f${i}`), "x").length, 30);
  let r = O.reprendreFermeture(pile, ["c.csv"]);
  assert.deepEqual(r, { chemin: "a.md", pile: ["b.ts"] });
  r = O.reprendreFermeture(r.pile, []);
  assert.deepEqual(r, { chemin: "b.ts", pile: [] });
  assert.deepEqual(O.reprendreFermeture([], []), { chemin: null, pile: [] });
});

test("fermer tous : les fichiers modifiés restent ouverts sans sauvegarde automatique, sinon tout se ferme", () => {
  const onglets = [{ dirty: false, n: 1 }, { dirty: true, n: 2 }, { dirty: true, external: true, n: 3 }];
  const sans = O.partagerFermetureTous(onglets, "desactivee");
  assert.deepEqual(sans.garder.map((o) => o.n), [2]);
  assert.deepEqual(sans.fermer.map((o) => o.n), [1, 3]);
  const avec = O.partagerFermetureTous(onglets, "quitter");
  assert.deepEqual(avec.garder, []);
  assert.equal(avec.fermer.length, 3);
});

test("branchements : fermeture notée, actions des raccourcis, entrées du menu d'onglet", () => {
  const ws = lire("src/components/Workspace.tsx");
  assert.match(ws, /memoriserFermeture\(workspacePathRef\.current, tabsRef\.current\[index\]\)/);
  assert.match(ws, /fermerTousFichiers: \(\) => fermerTousFichiers\(\)/);
  assert.match(ws, /rouvrirOnglet: \(\) => rouvrirOngletFerme\(\)/);
  assert.match(ws, /<EntreesMenuOnglet/);
});
