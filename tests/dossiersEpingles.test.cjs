"use strict";
// Dossiers épinglés : toujours en tête des récents, ordre d'épinglage, mêmes Ctrl+1…9.
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
const Rec = require(path.resolve(__dirname, "../src/lib/recents.ts"));
const chemins = () => Rec.dossiersNumerotes().map((r) => r.path);
let horloge = 1000;
const ouvrir = (p) => {
  horloge += 10;
  const vrai = Date.now;
  Date.now = () => horloge;
  try {
    Rec.recordRecent(p, path.basename(p));
  } finally {
    Date.now = vrai;
  }
};
const remise = () => {
  memoire.clear();
  Rec.libererOrdre();
};

test("épinglés en tête, dans l'ordre d'épinglage, puis récents du plus récent au plus ancien", () => {
  remise();
  ["/a", "/b", "/c", "/d"].forEach(ouvrir);
  Rec.epingler("/b");
  Rec.epingler("/d");
  assert.deepEqual(chemins(), ["/b", "/d", "/c", "/a"]);
  assert.equal(Rec.dossierRecentNumero(1).path, "/b");
  assert.equal(Rec.dossierRecentNumero(2).path, "/d");
  assert.equal(Rec.dossierRecentNumero(1).epingle, true);
  assert.equal(Rec.dossierRecentNumero(3).epingle, undefined);
  // Ouvrir un autre dossier ne déplace pas les épinglés.
  ouvrir("/a");
  assert.deepEqual(chemins(), ["/b", "/d", "/a", "/c"]);
});

test("ouverture pendant le travail : les épinglés gardent Ctrl+1 et Ctrl+2", () => {
  remise();
  ["/a", "/b", "/c"].forEach(ouvrir);
  Rec.epingler("/a");
  Rec.noterOuverture("/c", "c");
  Rec.noterOuverture("/a", "a");
  Rec.noterOuverture("/z", "z");
  const liste = chemins();
  assert.equal(liste[0], "/a");
  assert.equal(liste[1], "/z");
});

test("jamais retirés par la limite des récents ; épinglé sans historique gardé", () => {
  remise();
  Rec.epingler("/garde", "garde");
  for (let i = 0; i < 40; i++) ouvrir(`/x${i}`);
  assert.equal(Rec.loadRecents().length, 30);
  assert.equal(chemins()[0], "/garde");
  assert.equal(Rec.dossiersNumerotes()[0].name, "garde");
  Rec.removeRecent("/garde");
  assert.equal(chemins()[0], "/garde");
});

test("désépingler, basculer, réordonner, pas de doublon", () => {
  remise();
  ["/a", "/b", "/c"].forEach(ouvrir);
  Rec.epingler("/a");
  Rec.epingler("/a");
  Rec.epingler("/b");
  Rec.epingler("/c");
  assert.equal(Rec.loadPins().length, 3);
  Rec.deplacerEpingle("/c", 0);
  assert.deepEqual(Rec.loadPins().map((p) => p.path), ["/c", "/a", "/b"]);
  Rec.deplacerEpingle("/c", 99);
  assert.deepEqual(Rec.loadPins().map((p) => p.path), ["/a", "/b", "/c"]);
  assert.equal(Rec.basculerEpingle("/b"), false);
  assert.equal(Rec.estEpingle("/b"), false);
  assert.equal(Rec.basculerEpingle("/b"), true);
  Rec.desepingler("/a");
  // Réépinglé, /b passe après les épinglés existants.
  assert.deepEqual(Rec.loadPins().map((p) => p.path), ["/c", "/b"]);
});

test("épinglé introuvable : marqué absent, puis de nouveau présent à l'ouverture", () => {
  remise();
  ouvrir("/a");
  Rec.epingler("/a");
  Rec.marquerEpingleAbsent("/a", true);
  assert.equal(Rec.dossiersNumerotes()[0].absent, true);
  Rec.noterOuverture("/a", "a");
  assert.equal(Rec.dossiersNumerotes()[0].absent, undefined);
  Rec.libererOrdre();
});

test("dossier déplacé : l'épinglé garde sa place sous le nouveau chemin", () => {
  remise();
  Rec.epingler("/a");
  Rec.epingler("/b");
  Rec.remplacerCheminEpingle("/a", "/nouveau/a2");
  assert.deepEqual(Rec.loadPins().map((p) => p.path), ["/nouveau/a2", "/b"]);
  assert.equal(Rec.loadPins()[0].name, "a2");
});

test("stockage illisible : aucun épinglé", () => {
  remise();
  memoire.set("axecode.pinnedWorkspaces", "{pas du json");
  assert.deepEqual(Rec.loadPins(), []);
  memoire.set("axecode.pinnedWorkspaces", JSON.stringify([{ path: 3 }, null, { path: "/ok", name: "ok" }]));
  assert.deepEqual(Rec.loadPins().map((p) => p.path), ["/ok"]);
});

test("accueil et Ctrl+K : punaise, clic droit, commande Épingler", () => {
  const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
  const accueil = lire("../src/components/Welcome.tsx");
  assert.match(accueil, /welcome__recent-epingler/);
  assert.match(accueil, /onContextMenu/);
  assert.match(accueil, /"Désépingler" : "Épingler"/);
  const palette = lire("../src/components/palette/PaletteAller.tsx");
  assert.match(palette, /basculerEpingle/);
  assert.match(palette, /dossiersNumerotes\(\)/);
});
