"use strict";
// Mise à jour automatique : installation seulement quand rien ne tourne.
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
const a = require(path.resolve(__dirname, "../src/lib/activite.ts"));

test("installation automatique : attend la fin des tours", () => {
  const info = { available: true, version: "0.1.58" };
  assert.equal(a.activiteEnCours(), false);
  assert.equal(a.doitInstallerMaintenant(info, a.activiteEnCours()), true);
  a.declarerActivite("workspace", true);
  assert.equal(a.doitInstallerMaintenant(info, a.activiteEnCours()), false);
  a.declarerActivite("workspace", false);
  assert.equal(a.doitInstallerMaintenant(info, a.activiteEnCours()), true);
  assert.equal(a.doitInstallerMaintenant({ available: false }, false), false);
  assert.equal(a.doitInstallerMaintenant(null, false), false);
});

test("configuration : mise à jour depuis le dépôt GitHub public de SavIDE", () => {
  const conf = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(conf.plugins.updater.active, true);
  assert.deepEqual(conf.plugins.updater.endpoints, ["https://github.com/SavinienD/-SavIDE/releases/latest/download/latest.json"]);
  const badge = fs.readFileSync(path.resolve(__dirname, "../src/components/UpdateBadge.tsx"), "utf8");
  assert.match(badge, /60 \* 60 \* 1000/);
});
