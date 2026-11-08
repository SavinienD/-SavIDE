// Revue des changements : blocs du diff Monaco -> lignes choisies (src/components/revue/selectionDiff.ts).
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
const S = require(path.resolve(__dirname, "../src/components/revue/selectionDiff.ts"));

const bloc = (os, oe, ms, me) => ({ originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });
// Ancien : l1..l5 ; nouveau : l1, X2, l3, l4, Y5, new6 ; et une suppression pure de l'ancienne ligne 8.
const BLOCS = [bloc(2, 2, 2, 2), bloc(5, 5, 5, 6), bloc(8, 8, 7, 0)];

test("un bloc entier : ses lignes des deux côtés (côté vide = aucune ligne)", () => {
  assert.deepEqual(S.lignesDuBloc(BLOCS[1]), { anciennes: [5], nouvelles: [5, 6] });
  assert.deepEqual(S.lignesDuBloc(BLOCS[2]), { anciennes: [8], nouvelles: [] });
  assert.deepEqual(S.lignesDuBloc(bloc(3, 0, 4, 5)), { anciennes: [], nouvelles: [4, 5] });
});

test("sélection côté nouveau : lignes en face si même taille, sinon tout le côté ancien", () => {
  assert.deepEqual(S.lignesDeSelection(BLOCS, "nouveau", 2, 2), { anciennes: [2], nouvelles: [2] });
  assert.deepEqual(S.lignesDeSelection(BLOCS, "nouveau", 6, 6), { anciennes: [5], nouvelles: [6] });
  // Sélection à l'envers (de bas en haut) : même résultat.
  assert.deepEqual(S.lignesDeSelection(BLOCS, "nouveau", 6, 1), { anciennes: [2, 5], nouvelles: [2, 5, 6] });
});

test("une suppression pure est prise quand la sélection touche sa place", () => {
  assert.deepEqual(S.lignesDeSelection(BLOCS, "nouveau", 7, 7), { anciennes: [8], nouvelles: [] });
  assert.deepEqual(S.lignesDeSelection(BLOCS, "nouveau", 3, 4), { anciennes: [], nouvelles: [] });
});

test("sélection côté ancien : symétrique", () => {
  assert.deepEqual(S.lignesDeSelection(BLOCS, "ancien", 5, 8), { anciennes: [5, 8], nouvelles: [5, 6] });
  assert.deepEqual(S.lignesDeSelection([bloc(3, 0, 4, 5)], "ancien", 3, 3), { anciennes: [], nouvelles: [4, 5] });
});

test("bloc sous le curseur, voisins en boucle, compteurs", () => {
  assert.equal(S.blocALaLigne(BLOCS, "nouveau", 6), 1);
  assert.equal(S.blocALaLigne(BLOCS, "nouveau", 3), -1);
  assert.equal(S.blocALaLigne(BLOCS, "nouveau", 8), 2, "ligne juste sous une suppression");
  assert.equal(S.blocVoisin(BLOCS, "nouveau", 0, 1), 0);
  assert.equal(S.blocVoisin(BLOCS, "nouveau", 2, 1), 1);
  assert.equal(S.blocVoisin(BLOCS, "nouveau", 7, 1), 0, "après le dernier : retour au premier");
  assert.equal(S.blocVoisin(BLOCS, "nouveau", 5, -1), 0);
  assert.equal(S.blocVoisin(BLOCS, "nouveau", 1, -1), 2, "avant le premier : le dernier");
  assert.deepEqual(S.compteurs(BLOCS), { ajouts: 3, suppressions: 3 });
});
