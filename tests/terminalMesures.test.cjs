"use strict";
// Réajustement de la grille du terminal (src/components/terminalMesures.ts) : changement
// d'échelle de l'écran sans changement de taille du volet, polices chargées après coup.
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
const { suivreMesuresTerminal } = charger("../src/components/terminalMesures.ts");

/** Fenêtre simulée : matchMedia par échelle, « resize », images (requestAnimationFrame). */
function fausseFenetre(echelle = 2) {
  const listes = [];
  const images = new Map();
  let suivant = 1;
  const taille = new Set();
  const f = {
    devicePixelRatio: echelle,
    matchMedia(requete) {
      const l = { requete, ecouteurs: new Set(),
        addEventListener: (_t, cb) => l.ecouteurs.add(cb), removeEventListener: (_t, cb) => l.ecouteurs.delete(cb) };
      listes.push(l);
      return l;
    },
    addEventListener: (_t, cb) => taille.add(cb),
    removeEventListener: (_t, cb) => taille.delete(cb),
    requestAnimationFrame(cb) { const id = suivant++; images.set(id, cb); return id; },
    cancelAnimationFrame(id) { images.delete(id); },
    // Le navigateur change d'échelle : la liste de l'ancienne échelle ne correspond plus.
    changerEchelle(e) {
      const avant = `(resolution: ${f.devicePixelRatio}dppx)`;
      f.devicePixelRatio = e;
      for (const l of listes) if (l.requete === avant) for (const cb of [...l.ecouteurs]) cb();
    },
    redimensionner() { for (const cb of [...taille]) cb(); },
    image() { const a = [...images.values()]; images.clear(); for (const cb of a) cb(); },
    ecouteursActifs: () => listes.reduce((n, l) => n + l.ecouteurs.size, 0) + taille.size,
    imagesEnAttente: () => images.size,
  };
  return f;
}

test("changement d'échelle sans redimensionnement : réajustement à l'image suivante", () => {
  const f = fausseFenetre(2);
  let n = 0;
  const arreter = suivreMesuresTerminal(f, undefined, () => { n += 1; });
  f.changerEchelle(1);
  assert.equal(n, 0, "pas avant que xterm ait recalculé ses cellules");
  f.image();
  assert.equal(n, 1);
  // Retour sur l'écran Retina : la nouvelle échelle est suivie aussi.
  f.changerEchelle(2);
  f.image();
  assert.equal(n, 2);
  arreter();
});

test("plusieurs signaux dans la même image : un seul réajustement", () => {
  const f = fausseFenetre(1);
  let n = 0;
  const arreter = suivreMesuresTerminal(f, undefined, () => { n += 1; });
  f.changerEchelle(1.25);
  f.redimensionner();
  f.changerEchelle(1.5);
  f.image();
  assert.equal(n, 1);
  arreter();
});

test("échelle signalée seulement par « resize » (moteur sans événement media)", () => {
  const f = fausseFenetre(2);
  let n = 0;
  const arreter = suivreMesuresTerminal(f, undefined, () => { n += 1; });
  f.devicePixelRatio = 1; // pas d'événement media
  f.redimensionner();
  f.image();
  assert.equal(n, 1);
  f.redimensionner(); // même échelle : rien à refaire
  f.image();
  assert.equal(n, 1);
  arreter();
});

test("polices chargées après l'ouverture : réajustement", async () => {
  const f = fausseFenetre(1);
  let fini;
  const ecouteurs = new Set();
  const polices = { ready: new Promise((r) => { fini = r; }),
    addEventListener: (_t, cb) => ecouteurs.add(cb), removeEventListener: (_t, cb) => ecouteurs.delete(cb) };
  let n = 0;
  const arreter = suivreMesuresTerminal(f, polices, () => { n += 1; });
  fini();
  await polices.ready;
  await new Promise((r) => setImmediate(r));
  f.image();
  assert.equal(n, 1);
  for (const cb of [...ecouteurs]) cb(); // « loadingdone »
  f.image();
  assert.equal(n, 2);
  arreter();
  assert.equal(ecouteurs.size, 0);
});

test("arrêt : plus d'écouteur ni d'image en attente, plus de réajustement", () => {
  const f = fausseFenetre(2);
  let n = 0;
  const arreter = suivreMesuresTerminal(f, undefined, () => { n += 1; });
  f.changerEchelle(1);
  arreter();
  assert.equal(f.imagesEnAttente(), 0);
  assert.equal(f.ecouteursActifs(), 0);
  f.changerEchelle(2);
  f.image();
  assert.equal(n, 0);
});
