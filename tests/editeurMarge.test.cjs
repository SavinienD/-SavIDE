"use strict";
// ED1b : marques de changements dans la marge par rapport à HEAD
// (ajouté, modifié, supprimé), version de HEAD lue par editeur_fichier_head (src-tauri/src/editeur.rs).
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
const M = require(path.join(racine, "src/components/editeur/margeGit.ts"));
const L = (...l) => l.join("\n") + "\n";

test("texte identique (fins de ligne comprises) : aucune marque", () => {
  assert.deepEqual(M.marquesDiff(L("a", "b", "c"), L("a", "b", "c")), []);
  assert.deepEqual(M.marquesDiff("a\r\nb\r\n", "a\nb\n"), [], "CRLF / LF");
  assert.deepEqual(M.marquesDiff("a\nb", "a\nb\n"), [], "retour final");
  assert.deepEqual(M.marquesDiff("", ""), []);
});

test("lignes ajoutées, modifiées, supprimées", () => {
  assert.deepEqual(M.marquesDiff(L("a", "b"), L("a", "x", "y", "b")), [{ genre: "ajout", debut: 2, fin: 3 }]);
  assert.deepEqual(M.marquesDiff(L("a", "b", "c"), L("a", "B", "c")), [{ genre: "modif", debut: 2, fin: 2 }]);
  assert.deepEqual(M.marquesDiff(L("a", "b", "c", "d"), L("a", "d")), [{ genre: "suppr", debut: 1, fin: 1 }]);
  assert.deepEqual(M.marquesDiff(L("a", "b"), L("b")), [{ genre: "suppr", debut: 1, fin: 1, haut: true }], "supprimé tout en haut");
  assert.deepEqual(M.marquesDiff(L("a", "b"), L("a")), [{ genre: "suppr", debut: 1, fin: 1 }], "supprimé à la fin");
  assert.deepEqual(M.marquesDiff("", L("a", "b")), [{ genre: "ajout", debut: 1, fin: 2 }], "fichier vide au départ");
});

test("plusieurs blocs : l'exemple du banc (app.ts)", () => {
  const head = L("export function total(lignes: number[]): number {", "  let somme = 0;", "  for (const l of lignes) somme += l;", "  return somme;", "}", "",
    "export function moyenne(lignes: number[]): number {", "  return total(lignes) / lignes.length;", "}", "", 'export const VERSION = "1.0";');
  const actuel = L("export function total(lignes: number[]): number {", "  return lignes.reduce((a, b) => a + b, 0);", "}", "",
    "export function moyenne(lignes: number[]): number {", "  if (!lignes.length) return 0;", "  return total(lignes) / lignes.length;", "}");
  assert.deepEqual(M.marquesDiff(head, actuel), [
    { genre: "modif", debut: 2, fin: 2 },
    { genre: "ajout", debut: 6, fin: 6 },
    { genre: "suppr", debut: 8, fin: 8 },
  ]);
});

test("script de Myers minimal, et repli quand il y a trop de différences", () => {
  assert.deepEqual(M.scriptMyers([1, 2, 3], [1, 3]), ["=", "-", "="]);
  assert.deepEqual(M.scriptMyers([], [5]), ["+"]);
  assert.equal(M.scriptMyers([1, 2, 3, 4], [5, 6, 7, 8], 3), null);
  const avant = Array.from({ length: 3000 }, (_, i) => `ancienne ${i}`).join("\n");
  const apres = Array.from({ length: 3000 }, (_, i) => `nouvelle ${i}`).join("\n");
  const t = Date.now();
  assert.deepEqual(M.marquesDiff(avant, apres), [{ genre: "modif", debut: 1, fin: 3000 }]);
  assert.ok(Date.now() - t < 2000, "repli rapide");
  const gros = Array.from({ length: 20000 }, (_, i) => `ligne ${i}`);
  const modifie = gros.slice();
  modifie[10000] = "changée";
  const t2 = Date.now();
  assert.deepEqual(M.marquesDiff(gros.join("\n"), modifie.join("\n")), [{ genre: "modif", debut: 10001, fin: 10001 }]);
  assert.ok(Date.now() - t2 < 1000, "20 000 lignes : rapide");
});

test("branchements : commande Rust enregistrée, marge dans l'éditeur, couleurs", () => {
  const lib = lire("src-tauri/src/lib.rs");
  assert.match(lib, /mod editeur;/);
  assert.match(lib, /editeur::editeur_fichier_head/);
  const rs = lire("src-tauri/src/editeur.rs");
  assert.match(rs, /"cat-file", "--filters"/);
  assert.match(lire("src-tauri/src/git.rs"), /pub\(crate\) fn resolve_executable/);
  const ed = lire("src/components/EditorPane.tsx");
  assert.match(ed, /useMargeGit\(/);
  const css = lire("src/components/editeur/editeur.css");
  for (const g of ["ajout", "modif", "suppr"]) assert.match(css, new RegExp(`\\.marge-git--${g}`));
});
