"use strict";
// Réglages > Harnais : recherche dans les titres et contenus, sans casse ni accents, mot surligné.
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
const R = require(path.resolve(__dirname, "../src/components/settings/rechercheHarnais.ts"));
const e = (id, kind, title, body, updated = 1) => ({ id, kind, scope: "global", title, body, updated, created: 1, source: "", evidence: [], tags: [], path: "" });

test("titre ou contenu, sans casse ni accents ; titre d'abord", () => {
  const liste = [e("a", "memory", "Rapports", "voir la FACTURE 42", 5), e("b", "prompt_note", "Facture : jamais supprimée", "", 1), e("c", "skill", "qcm", "rien")];
  assert.deepEqual(R.chercher(liste, "facture").map((x) => x.id), ["b", "a"]);
  assert.deepEqual(R.chercher([e("d", "memory", "Mémoires", "")], "memoire").map((x) => x.id), ["d"]);
  assert.deepEqual(R.chercher(liste, "  "), []);
});

test("positions pour le surlignage (même longueur que le texte, accents compris)", () => {
  assert.deepEqual(R.occurrences("Élan, élan", "elan"), [[0, 4], [6, 10]]);
  assert.equal(R.plier("Écrit").length, "Écrit".length);
});

test("extrait autour de la première occurrence, « … » aux coupures", () => {
  const long = "a".repeat(100) + " cible " + "b".repeat(200);
  const x = R.extrait(long, "cible");
  assert.match(x, /^… a+ cible b+ …$/);
  assert.equal(R.extrait("sans", "cible"), null);
});

test("branché dans le volet Harnais : champ, résultats groupés, <mark>", () => {
  const s = fs.readFileSync(path.resolve(__dirname, "../src/components/settings/HarnessPane.tsx"), "utf8");
  assert.match(s, /className="axe-harness__search"/);
  assert.match(s, /<mark key=/);
  assert.match(s, /className="axe-harness__hit"/);
});
