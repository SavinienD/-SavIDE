"use strict";
// ED3b : tableaux (CSV, TSV, classeurs) : tri par colonne (clic sur l'en-tête :
// croissant, décroissant, sans tri) et filtre (n'afficher que les lignes trouvées par la recherche).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
const T = require(path.join(racine, "src/components/viewers/triFiltre.ts"));

const TABLE = [
  ["Client", "Ville", "Montant"],
  ["Martin", "Lyon", "1 250,50"],
  ["Durand", "Paris", "980"],
  ["Petit", "lyon", "15400"],
  ["Roux", "", "87.25"],
  ["Morel", "Nantes", "abc"],
];
const texte = (r, c) => TABLE[r]?.[c] ?? "";

test("nombres reconnus (espaces, virgule décimale, %, €)", () => {
  assert.equal(T.valeurNumerique("1 250,50"), 1250.5);
  assert.equal(T.valeurNumerique("87.25"), 87.25);
  assert.equal(T.valeurNumerique("-3"), -3);
  assert.equal(T.valeurNumerique("12 %"), 12);
  assert.equal(T.valeurNumerique("9,90 €"), 9.9);
  assert.equal(T.valeurNumerique("2026-11-08"), null);
  assert.equal(T.valeurNumerique("abc"), null);
  assert.equal(T.valeurNumerique(""), null);
});

test("tri : nombres comme des nombres, textes sans tenir compte de la casse, vides à la fin ; en-tête gardé en tête", () => {
  const asc = T.ordreLignes(TABLE.length, texte, { entete: true, tri: { col: 2, sens: "asc" }, filtre: "", colonnes: 3 });
  assert.deepEqual(asc, [0, 4, 2, 1, 3, 5]);
  const desc = T.ordreLignes(TABLE.length, texte, { entete: true, tri: { col: 2, sens: "desc" }, filtre: "", colonnes: 3 });
  assert.deepEqual(desc, [0, 3, 1, 2, 4, 5], "le texte non numérique reste après les nombres");
  const villes = T.ordreLignes(TABLE.length, texte, { entete: true, tri: { col: 1, sens: "asc" }, filtre: "", colonnes: 3 });
  assert.deepEqual(villes, [0, 1, 3, 5, 2, 4], "lyon = Lyon, vide à la fin");
  const sansEntete = T.ordreLignes(3, texte, { entete: false, tri: { col: 0, sens: "asc" }, filtre: "", colonnes: 3 });
  assert.deepEqual(sansEntete, [0, 2, 1]);
});

test("classeurs : la valeur du nombre (ou de la date) prime sur le texte affiché selon le format", () => {
  const affiche = [["Montant"], ["1,250.50"], ["980.00"], ["12/03/2026"]];
  const valeurs = [null, 1250.5, 980, null];
  const ordre = T.ordreLignes(4, (r, c) => affiche[r][c], { entete: true, tri: { col: 0, sens: "asc" }, filtre: "", colonnes: 1, nombre: (r) => valeurs[r] });
  assert.deepEqual(ordre, [0, 2, 1, 3], "980 avant 1 250,50 ; le texte non numérique après");
});

test("filtre : seulement les lignes qui contiennent le texte (toutes colonnes, sans casse), en-tête gardé", () => {
  assert.deepEqual(T.ordreLignes(TABLE.length, texte, { entete: true, tri: null, filtre: "LYON", colonnes: 3 }), [0, 1, 3]);
  assert.deepEqual(T.ordreLignes(TABLE.length, texte, { entete: true, tri: { col: 2, sens: "desc" }, filtre: "lyon", colonnes: 3 }), [0, 3, 1]);
  assert.deepEqual(T.ordreLignes(TABLE.length, texte, { entete: false, tri: null, filtre: "zzz", colonnes: 3 }), []);
  assert.deepEqual(T.ordreLignes(TABLE.length, texte, { entete: true, tri: null, filtre: "", colonnes: 3 }), [0, 1, 2, 3, 4, 5]);
});

test("clic sur l'en-tête : croissant, décroissant, sans tri ; autre colonne : croissant", () => {
  assert.deepEqual(T.triSuivant(null, 2), { col: 2, sens: "asc" });
  assert.deepEqual(T.triSuivant({ col: 2, sens: "asc" }, 2), { col: 2, sens: "desc" });
  assert.equal(T.triSuivant({ col: 2, sens: "desc" }, 2), null);
  assert.deepEqual(T.triSuivant({ col: 2, sens: "desc" }, 0), { col: 0, sens: "asc" });
});

test("100 000 lignes triées et filtrées vite", () => {
  const n = 100_000;
  const t0 = Date.now();
  const ordre = T.ordreLignes(n, (r, c) => (c === 0 ? `client ${n - r}` : String((r * 7919) % 10007)), { entete: true, tri: { col: 1, sens: "asc" }, filtre: "client", colonnes: 2 });
  assert.equal(ordre.length, n);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test("branchements : en-têtes cliquables (aria-sort), bouton Filtrer, numéros de ligne d'origine", () => {
  const grille = lire("src/components/viewers/SheetGrid.tsx");
  assert.match(grille, /aria-sort=/);
  assert.match(grille, /rowNumbers\?: number\[\]/);
  const v = lire("src/components/viewers/SpreadsheetViewer.tsx");
  assert.match(v, /ordreLignes\(/);
  assert.match(v, /data-action="filtrer"/);
});
