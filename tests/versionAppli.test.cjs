"use strict";
// Réglages > À propos : version lue à l'exécution, date de la dernière mise à jour si connue.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
Module._extensions[".ts"] = (module, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(js, filename);
};
const v = require(path.resolve(__dirname, "../src/lib/versionAppli.ts"));
const stock = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, x) => m.set(k, String(x)) };
};

test("premier lancement suivi : date inconnue ; même version : inchangé", () => {
  const s = stock();
  assert.deepEqual(v.noterLancement(s, "0.1.62", new Date("2026-10-23T08:00:00Z")), { version: "0.1.62", majLe: null });
  assert.deepEqual(v.noterLancement(s, "0.1.62", new Date("2026-10-24T08:00:00Z")), { version: "0.1.62", majLe: null });
});

test("nouvelle version : la date du premier lancement est la date de mise à jour", () => {
  const s = stock();
  v.noterLancement(s, "0.1.61", new Date("2026-10-20T08:00:00Z"));
  const e = v.noterLancement(s, "0.1.62", new Date("2026-10-23T08:00:00Z"));
  assert.equal(e.majLe, "2026-10-23T08:00:00.000Z");
  assert.equal(v.noterLancement(s, "0.1.62", new Date("2026-10-25T08:00:00Z")).majLe, "2026-10-23T08:00:00.000Z");
  assert.match(v.dateMajLisible(e.majLe), /octobre 2026/);
  assert.equal(v.dateMajLisible(null), null);
  assert.equal(v.dateMajLisible("n'importe quoi"), null);
});

test("stockage abîmé : traité comme un premier lancement", () => {
  const s = stock();
  s.setItem(v.CLE_VERSION_LANCEE, "{pas du json");
  assert.deepEqual(v.noterLancement(s, "0.1.62"), { version: "0.1.62", majLe: null });
});

test("À propos : version via getVersion (pas en dur), plus de Forgejo ni de « cerveau »", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/components/SettingsPane.tsx"), "utf8");
  const lib = fs.readFileSync(path.resolve(__dirname, "../src/lib/versionAppli.ts"), "utf8");
  assert.match(lib, /getVersion/);
  assert.match(src, /settings-pane__about-version/);
  assert.doesNotMatch(src, /Forgejo|FORGEJO|cerveau de/);
});
