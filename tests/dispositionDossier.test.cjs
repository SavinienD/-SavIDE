"use strict";
// Disposition de l'espace gardée par dossier (largeurs des volets, volets réduits, terminal),
// relue au changement de dossier sans démontage (Ctrl+1…9) et après un redémarrage.
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
const D = charger("../src/lib/dispositionDossier.ts");

function stockage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test("chaque dossier garde sa disposition, sans toucher à celle des autres", () => {
  const s = stockage();
  const a = { ...D.DISPOSITION_DEFAUT, droite: 640 };
  const b = { ...D.DISPOSITION_DEFAUT, gauche: 400, terminalDisponible: true, terminalOuvert: true, terminalHauteur: 340 };
  D.ecrireDisposition(s, "/p/a", a);
  D.ecrireDisposition(s, "/p/b", b);
  assert.deepEqual(D.lireDisposition(s, "/p/a"), a);
  assert.deepEqual(D.lireDisposition(s, "/p/b"), b);
  assert.deepEqual(D.lireDisposition(s, "/p/c"), D.DISPOSITION_DEFAUT);
});

test("un dossier sans disposition part des anciens volets réduits (communs à tous)", () => {
  const s = stockage({ "axe:volet-gauche-reduit": "1", "axe:volet-droit-reduit": "0" });
  const d = D.lireDisposition(s, "/p/neuf");
  assert.equal(d.gaucheReduite, true);
  assert.equal(d.droiteReduite, false);
  D.ecrireDisposition(s, "/p/neuf", { ...d, gaucheReduite: false });
  assert.equal(D.lireDisposition(s, "/p/neuf").gaucheReduite, false);
});

test("stockage abîmé ou absent : valeurs par défaut, champ par champ", () => {
  const s = stockage({
    [D.cleDisposition("/x")]: JSON.stringify({ droite: 700, gauche: "large", partageHaut: 3, terminalOuvert: true, terminalHauteur: -5 }),
    [D.cleDisposition("/y")]: "{pas du json",
    [D.cleDisposition("/z")]: "[1,2]",
  });
  const x = D.lireDisposition(s, "/x");
  assert.equal(x.droite, 700);
  assert.equal(x.gauche, D.DISPOSITION_DEFAUT.gauche);
  assert.equal(x.partageHaut, D.DISPOSITION_DEFAUT.partageHaut);
  assert.equal(x.terminalOuvert, false, "terminal affiché sans panneau monté : refusé");
  assert.equal(x.terminalHauteur, D.DISPOSITION_DEFAUT.terminalHauteur);
  assert.deepEqual(D.lireDisposition(s, "/y"), D.DISPOSITION_DEFAUT);
  assert.deepEqual(D.lireDisposition(s, "/z"), D.DISPOSITION_DEFAUT);
  assert.deepEqual(D.lireDisposition(null, "/x"), D.DISPOSITION_DEFAUT);
  const plein = { getItem: () => null, setItem: () => { throw new Error("plein"); } };
  assert.doesNotThrow(() => D.ecrireDisposition(plein, "/x", D.DISPOSITION_DEFAUT));
});

test("une largeur choisie en plein écran est gardée telle quelle (pas rognée à la lecture)", () => {
  const s = stockage();
  D.ecrireDisposition(s, "/p", { ...D.DISPOSITION_DEFAUT, droite: 1150 });
  assert.equal(D.lireDisposition(s, "/p").droite, 1150);
});

test("l'espace relit la disposition du dossier pendant le rendu, avant les écritures", () => {
  const w = fs.readFileSync(path.resolve(__dirname, "../src/components/Workspace.tsx"), "utf8");
  assert.match(w, /useState\(\(\) => lireDisposition\(stockageLocal\(\), workspacePath\)\)/);
  const bloc = w.slice(w.indexOf("if (cheminDisposition !== workspacePath)"));
  assert.ok(bloc.length > 0);
  for (const f of ["setLeftWidth(d.gauche)", "setRightWidth(d.droite)", "setTerminalOpen(d.terminalOuvert)", "setGaucheReduite(d.gaucheReduite)",
    "setOngletsChat(lireOngletsChat(workspacePath))", "setEtatColonnesChat(lireColonnesChat(workspacePath))"]) {
    assert.ok(bloc.slice(0, 1500).includes(f), f);
  }
  assert.match(w, /ecrireDisposition\(stockageLocal\(\), workspacePath, \{/);
  // Plus de valeurs fixes ni de volets réduits communs à tous les dossiers.
  assert.doesNotMatch(w, /useState\(INITIAL_(LEFT|RIGHT)\)/);
  assert.doesNotMatch(w, /setItem\("axe:volet-(gauche|droit)-reduit"/);
});
