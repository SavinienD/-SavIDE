// Compte des outils web/images du REPL : clé API, sinon abonnement ChatGPT.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const O = charger("../src/lib/outilsComptes.ts");
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("clé API d'abord, abonnement ChatGPT sans clé, rien sinon", () => {
  assert.equal(O.routeOpenAi({ cle: "sk-x", connecte: true }), "cle");
  assert.equal(O.routeOpenAi({ cle: "", connecte: true }), "abonnement");
  assert.equal(O.routeOpenAi({ cle: "  ", connecte: true }), "abonnement");
  assert.equal(O.routeOpenAi({ cle: "sk-x", connecte: true, forcerAbonnement: true }), "abonnement");
  assert.equal(O.routeOpenAi({ cle: "sk-x", connecte: false, forcerAbonnement: true }), "cle");
  assert.equal(O.routeOpenAi({ cle: "", connecte: false }), "aucun");
});

test("les réglages disent quel compte sert et quoi connecter", () => {
  assert.match(O.libelleImages("aucun"), /Réglages > Fournisseurs > OpenAI/);
  assert.match(O.libelleImages("abonnement"), /abonnement ChatGPT/);
  assert.match(O.libelleRecherche("auto", "aucun"), /Exa \(gratuit\)/);
  assert.match(O.libelleRecherche("auto", "abonnement"), /abonnement ChatGPT/);
  const section = lire("../src/components/settings/ReplServicesSection.tsx");
  assert.ok(section.includes('["auto", "Automatique"]') && section.includes("data-fournisseur={valeur}"), "bouton Automatique");
  assert.ok(section.includes("libelleImages(") && section.includes("libelleRecherche("), "règle affichée");
  assert.ok(!section.includes('"classic"'), "plus de valeur classic côté écran");
});
