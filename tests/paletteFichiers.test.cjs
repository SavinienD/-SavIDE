"use strict";
// Ctrl+P : ouvrir un fichier par son nom. Recherche approximative (lettres
// dans l'ordre, sans casse ni accents), fichiers récents en premier, raccourci déclaré une fois.
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
const F = require(path.join(racine, "src/components/palette/flou.ts"));
const Rec = require(path.join(racine, "src/components/palette/recents.ts"));
const O = require(path.join(racine, "src/components/palette/ouvertureFichier.ts"));
const R = require(path.join(racine, "src/axe/raccourcis.ts"));
const lire = (p) => fs.readFileSync(path.join(racine, p), "utf8");

test("lettres du mot dans l'ordre, sans casse ni accents ; rien sinon", () => {
  assert.ok(F.correspondance("pal", "src/components/palette/Palette.tsx"));
  assert.ok(F.correspondance("reglages", "src/Réglages.tsx"));
  assert.ok(F.correspondance("RÉGL", "src/reglages.ts"));
  assert.ok(F.correspondance("wsp", "src/components/Workspace.tsx"));
  assert.equal(F.correspondance("xyz", "src/a.ts"), null);
  assert.equal(F.correspondance("", "src/a.ts"), null);
  // plusieurs mots : tous requis, n'importe où dans le chemin
  assert.ok(F.correspondance("comp work", "src/components/Workspace.tsx"));
  assert.equal(F.correspondance("comp work", "src/Workspace.tsx"), null);
  // un chemin tapé avec « \ » (Windows) vaut « / »
  assert.ok(F.correspondance("palette\\Pal", "src/components/palette/Palette.tsx"));
});

test("positions à surligner : dans le nom du fichier d'abord, même longueur que le texte", () => {
  const c = F.correspondance("pal", "src/components/palette/Palette.tsx");
  const debutNom = "src/components/palette/".length;
  assert.deepEqual(c.positions, [debutNom, debutNom + 1, debutNom + 2]);
  assert.equal(F.plier("Écrit").length, "Écrit".length);
  assert.equal(F.plier("Écrit"), "ecrit");
});

test("classement : nom qui commence par le mot > mot dans le nom > lettres éparses ; chemin court d'abord", () => {
  const fichiers = ["a/b/rework.txt", "src/components/Workspace.tsx", "docs/w-o-r-k.md", "Workspace.tsx"];
  const r = F.classerFichiers("work", fichiers, []).map((x) => x.chemin);
  assert.deepEqual(r.slice(0, 2), ["Workspace.tsx", "src/components/Workspace.tsx"]);
  assert.equal(r[2], "a/b/rework.txt");
  assert.equal(r[3], "docs/w-o-r-k.md");
});

test("récents en premier (ordre d'ouverture), puis le reste ; requête vide = récents puis ordre alphabétique", () => {
  const fichiers = ["src/a.ts", "src/b.ts", "src/c.ts", "lib/zeta.ts"];
  const recents = ["src/c.ts", "lib/zeta.ts", "parti/supprime.ts"];
  assert.deepEqual(F.classerFichiers("", fichiers, recents).map((x) => x.chemin), ["src/c.ts", "lib/zeta.ts", "src/a.ts", "src/b.ts"]);
  const t = F.classerFichiers("ts", fichiers, recents);
  assert.deepEqual(t.map((x) => x.chemin).slice(0, 2), ["src/c.ts", "lib/zeta.ts"]);
  assert.equal(t[0].recent, true);
  assert.equal(t[2].recent, false);
  assert.equal(F.classerFichiers("ts", fichiers, recents, 2).length, 2);
});

test("rapide sur 50 000 fichiers (moins de 150 ms par frappe)", () => {
  const fichiers = Array.from({ length: 50_000 }, (_, i) => `src/module-${i % 97}/sous-dossier-${i % 13}/fichier-${i}.tsx`);
  const prepare = F.preparer(fichiers);
  // Meilleur de 3 passages (la machine de test peut être chargée par d'autres compilations).
  let meilleur = Infinity;
  for (let tour = 0; tour < 3; tour++) {
    const t0 = performance.now();
    for (const q of ["f", "fi", "fic", "fich", "fichier-4999"]) F.classerFichiers(q, prepare, []);
    meilleur = Math.min(meilleur, (performance.now() - t0) / 5);
  }
  assert.ok(meilleur < 150, `${meilleur.toFixed(1)} ms par frappe`);
});

test("fichiers récents par dossier : le plus récent devant, sans doublon, 30 au plus", () => {
  const ws = "C:\\Users\\S\\projet";
  Rec.noterFichierRecent(ws, "a.ts");
  Rec.noterFichierRecent(ws, "b.ts");
  Rec.noterFichierRecent(ws, "a.ts");
  assert.deepEqual(Rec.fichiersRecents(ws), ["a.ts", "b.ts"]);
  assert.deepEqual(Rec.fichiersRecents("C:\\autre"), []);
  for (let i = 0; i < 40; i++) Rec.noterFichierRecent(ws, `f${i}.ts`);
  assert.equal(Rec.fichiersRecents(ws).length, 30);
  assert.equal(Rec.fichiersRecents(ws)[0], "f39.ts");
  memoire.set(Rec.cleRecents(ws), "{pas du json");
  assert.deepEqual(Rec.fichiersRecents(ws), []);
});

test("Ctrl+Entrée : l'onglet passe dans la colonne voisine de celle qui avait le focus", () => {
  // une seule colonne : une nouvelle à droite
  let e = { colonnes: [["a.ts", "b.ts"]], focus: 0 };
  assert.deepEqual(O.versColonneVoisine(e, "b.ts", 0), { colonnes: [["a.ts"], ["b.ts"]], focus: 1 });
  // deux colonnes, focus à gauche : à droite ; focus à droite : à gauche
  e = { colonnes: [["a.ts", "n.ts"], ["c.ts"]], focus: 0 };
  assert.deepEqual(O.versColonneVoisine(e, "n.ts", 0).colonnes, [["a.ts"], ["c.ts", "n.ts"]]);
  e = { colonnes: [["a.ts"], ["c.ts", "n.ts"]], focus: 1 };
  assert.deepEqual(O.versColonneVoisine(e, "n.ts", 1).colonnes, [["a.ts", "n.ts"], ["c.ts"]]);
  // déjà à côté, ou pas encore rangé : rien ne change
  e = { colonnes: [["a.ts"], ["n.ts"]], focus: 1 };
  assert.equal(O.versColonneVoisine(e, "n.ts", 0), e);
  assert.equal(O.versColonneVoisine(e, "absent.ts", 0), e);
  assert.equal(O.entreeFichier("src/x/y.ts").name, "y.ts");
  assert.equal(O.entreeFichier("src/x/y.ts").kind, "file");
});

test("Ctrl+P déclaré dans le registre (une seule action), laissé au terminal", () => {
  const r = R.RACCOURCIS.find((x) => x.id === "ouvrirFichier");
  assert.ok(r, "raccourci ouvrirFichier absent");
  assert.equal(R.combinaisonCourte("ouvrirFichier", false), "Ctrl+P");
  assert.equal(R.combinaisonCourte("ouvrirFichier", true), "⌘P");
  assert.ok(r.horsTerminal || r.horsEditeur);
  const e = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: "p", code: "KeyP" };
  assert.deepEqual(R.RACCOURCIS.filter((x) => R.correspond(x, e, false)).map((x) => x.id), ["ouvrirFichier"]);
});

test("branché : palette dans l'espace, liste par rg --files (commande Tauri), Ctrl+Entrée = autre colonne", () => {
  const ws = lire("src/components/Workspace.tsx");
  assert.match(ws, /<PaletteEspace\b/);
  const pe = lire("src/components/palette/PaletteEspace.tsx");
  assert.match(pe, /ouvrirFichier:/);
  const pf = lire("src/components/palette/PaletteFichiers.tsx");
  assert.match(pf, /autreColonne/);
  const api = lire("src/components/palette/paletteApi.ts");
  assert.match(api, /"palette_fichiers"/);
  const lib = lire("src-tauri/src/lib.rs");
  assert.match(lib, /palette::palette_fichiers/);
  const rs = lire("src-tauri/src/palette.rs");
  assert.match(rs, /"--files"/);
});
