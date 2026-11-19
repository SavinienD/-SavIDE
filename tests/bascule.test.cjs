"use strict";
// bascule — bascule de fournisseur : réglage, avis dans la conversation.
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
const B = charger("../src/axe/bascule.ts");
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("éteinte par défaut, rien d'inventé", () => {
  assert.deepEqual(B.lireBascule(undefined), { enabled: false, secours: {} });
  assert.deepEqual(B.lireBascule({ enabled: "oui", secours: { a: "b" } }), { enabled: false, secours: {} });
  assert.deepEqual(
    B.lireBascule({ enabled: true, secours: { anthropic: ["anthropic~2", "anthropic", " anthropic~2 ", 3], vide: [] } }),
    { enabled: true, secours: { anthropic: ["anthropic~2"] } },
  );
});

test("liste de secours : ajout, ordre, retrait, jamais soi-même", () => {
  let r = B.BASCULE_ETEINTE;
  r = B.ajouterSecours(r, "anthropic", "anthropic~2");
  r = B.ajouterSecours(r, "anthropic", "axe-cloud");
  r = B.ajouterSecours(r, "anthropic", "anthropic");
  r = B.ajouterSecours(r, "anthropic", "axe-cloud");
  assert.deepEqual(r.secours.anthropic, ["anthropic~2", "axe-cloud"]);
  assert.equal(r.enabled, false, "ajouter un secours n'allume pas la bascule");
  r = B.monterSecours(r, "anthropic", "axe-cloud");
  assert.deepEqual(r.secours.anthropic, ["axe-cloud", "anthropic~2"]);
  assert.deepEqual(B.secoursPossibles(r, "anthropic", ["anthropic", "anthropic~2", "axe-cloud", "openai"]), ["openai"]);
  // Désignation à sens unique : anthropic~2 n'a aucun secours.
  assert.deepEqual(B.secoursPossibles(r, "anthropic~2", ["anthropic", "anthropic~2"]), ["anthropic"]);
  assert.equal(r.secours["anthropic~2"], undefined);
  r = B.retirerSecours(r, "anthropic", "axe-cloud");
  r = B.retirerSecours(r, "anthropic", "anthropic~2");
  assert.deepEqual(r.secours, {});
});

test("avis court dans la conversation, relu au rechargement", () => {
  assert.equal(B.texteBascule("anthropic", "anthropic~2"), "Fournisseur anthropic indisponible\u00a0: suite du travail sur anthropic~2");
  assert.doesNotMatch(B.texteBascule("a", "b"), /€|\$|prix|coût/i);
  assert.deepEqual(B.basculeDeMeta({ bascule: { de: "a", vers: "b" } }), { de: "a", vers: "b" });
  assert.equal(B.basculeDeMeta({ origin: "x" }), null);
  assert.equal(B.basculeDeMeta(null), null);
  const flux = lire("../src/components/chat/stream.ts");
  assert.match(flux, /case "provider_failover"/);
  assert.match(flux, /basculeDeMeta\(/);
  assert.match(lire("../src/components/chat/ChatPane.tsx"), /case "bascule"/);
  assert.match(lire("../src-tauri/src/daemon_client.rs"), /"provider_failover" =>/);
});

test("réglage dans Fournisseurs, enregistré dans repl-settings.json sans perdre le reste", () => {
  const panneau = lire("../src/axe/BasculePanel.tsx");
  assert.match(panneau, /repl_settings_get/);
  assert.match(panneau, /\.\.\.reglages, bascule/);
  assert.match(lire("../src/axe/CustomProvidersPanel.tsx"), /<BasculePanel \/>/);
});
