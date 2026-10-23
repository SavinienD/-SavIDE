"use strict";
// Titre par défaut du moteur (« New conversation ») : gardé dans les données, affiché en français.
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
const { titreAffiche } = require(path.resolve(__dirname, "../src/lib/titres.ts"));

test("titre affiché : défaut du moteur en français, titre vide « Sans titre », le reste intact", () => {
  assert.equal(titreAffiche("New conversation"), "Nouvelle conversation");
  assert.equal(titreAffiche("  Untitled "), "Nouvelle conversation");
  assert.equal(titreAffiche(""), "Sans titre");
  assert.equal(titreAffiche(null), "Sans titre");
  assert.equal(titreAffiche(" Facture OVH d'octobre "), "Facture OVH d'octobre");
});

test("le moteur garde « New conversation » comme valeur comparée (store.rs, freechat.rs)", () => {
  const racine = path.resolve(__dirname, "..");
  const store = fs.readFileSync(path.join(racine, "crates/axecode-app/src/store.rs"), "utf8");
  const freechat = fs.readFileSync(path.join(racine, "src-tauri/src/freechat.rs"), "utf8");
  assert.match(store, /DEFAULT_CONVERSATION_TITLE: &str = "New conversation"/);
  assert.match(freechat, /title != "New conversation"/);
});
