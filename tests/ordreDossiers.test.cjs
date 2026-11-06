"use strict";
// ordre-dossiers — dossier 1, 2, 3 = Ctrl+1, 2, 3 ; tant qu'on ne revient pas à l'accueil,
// l'ordre ne bouge pas (depuis le dossier 2, Ctrl+1 ramène au dossier 1). L'ordre des récents
// se met à jour au retour à l'accueil, ou quand on ouvre un dossier hors des 9 numérotés.
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
const Rec = require(path.resolve(__dirname, "../src/lib/recents.ts"));
const chemins = () => Rec.dossiersNumerotes().map((r) => r.path);
let horloge = 1_000;
const realNow = Date.now;
Date.now = () => (horloge += 1000);

function accueil(liste) {
  memoire.clear();
  Rec.libererOrdre();
  for (const n of [...liste].reverse()) Rec.recordRecent(`/p/${n}`, n);
}

test("depuis l'accueil, ouvrir le dossier 3 ne change pas les numéros", () => {
  accueil(["a", "b", "c", "d"]);
  assert.deepEqual(chemins(), ["/p/a", "/p/b", "/p/c", "/p/d"]);
  Rec.noterOuverture("/p/c", "c");
  assert.deepEqual(chemins(), ["/p/a", "/p/b", "/p/c", "/p/d"]);
  assert.equal(Rec.dossierRecentNumero(3).path, "/p/c");
});

test("dossier 1 → Ctrl+2 → Ctrl+1 : l'ordre reste 1, 2, 3", () => {
  accueil(["a", "b", "c"]);
  Rec.noterOuverture("/p/a", "a");
  Rec.noterOuverture(Rec.dossierRecentNumero(2).path, "b");
  assert.deepEqual(chemins(), ["/p/a", "/p/b", "/p/c"]);
  assert.equal(Rec.dossierRecentNumero(1).path, "/p/a");
  Rec.noterOuverture(Rec.dossierRecentNumero(1).path, "a");
  assert.deepEqual(chemins(), ["/p/a", "/p/b", "/p/c"]);
});

test("retour à l'accueil : l'ordre des récents se met à jour (le plus récent d'abord)", () => {
  accueil(["a", "b", "c"]);
  Rec.noterOuverture("/p/a", "a");
  Rec.noterOuverture("/p/c", "c");
  Rec.noterOuverture("/p/b", "b");
  assert.deepEqual(chemins(), ["/p/a", "/p/b", "/p/c"]);
  Rec.libererOrdre();
  assert.deepEqual(chemins(), ["/p/b", "/p/c", "/p/a"]);
  assert.deepEqual(Rec.loadRecents().map((r) => r.path), chemins(), "cartes de l'accueil = même ordre");
});

test("dossier hors des 9 numérotés : l'ordre se met à jour, il devient le 1", () => {
  accueil(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
  Rec.noterOuverture("/p/a", "a");
  Rec.noterOuverture("/p/k", "k"); // 11e
  assert.equal(Rec.dossierRecentNumero(1).path, "/p/k");
  Rec.noterOuverture("/p/z", "z"); // nouveau dossier
  assert.equal(Rec.dossierRecentNumero(1).path, "/p/z");
  assert.equal(Rec.dossierRecentNumero(2).path, "/p/k");
});

test("dossier retiré de l'historique pendant qu'il est figé : sauté, sans trou", () => {
  accueil(["a", "b", "c"]);
  Rec.noterOuverture("/p/a", "a");
  Rec.removeRecent("/p/b");
  assert.deepEqual(chemins(), ["/p/a", "/p/c"]);
});

test("branché : App note les ouvertures et libère l'ordre à l'accueil", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
  assert.match(app, /noterOuverture\(/);
  assert.match(app, /libererOrdre\(/);
  assert.doesNotMatch(app, /recordRecent\(/);
  Date.now = realNow;
});
