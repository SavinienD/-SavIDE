// Fournisseur « personnalisé » saisi sur le point d'accès d'un abonnement : connexion par abonnement proposée.
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
const A = charger("../src/lib/abonnementFournisseur.ts");
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("les points d'accès ChatGPT, Gemini et Claude proposent l'abonnement", () => {
  assert.equal(A.abonnementPourAdresse("https://api.openai.com/v1").carte, "openai");
  assert.equal(A.abonnementPourAdresse("api.openai.com").nom, "ChatGPT");
  assert.equal(A.abonnementPourAdresse("https://generativelanguage.googleapis.com/v1beta/openai/").carte, "google");
  assert.equal(A.abonnementPourAdresse("https://API.Anthropic.com").carte, "anthropic");
  assert.equal(A.abonnementPourAdresse("https://user:x@api.openai.com:443/v1?x=1").carte, "openai");
});

test("les autres adresses ne proposent rien", () => {
  for (const url of ["", "  ", "http://localhost:11434", "http://127.0.0.1:8096", "https://api.mistral.ai/v1",
    "https://openrouter.ai/api/v1", "https://api.openai.com.exemple.net/v1", "https://notopenai.com/v1"]) {
    assert.equal(A.abonnementPourAdresse(url), null, url);
  }
});

test("le bouton presse « Connecter » de la carte du fournisseur", () => {
  let clique = 0;
  let montre = 0;
  const bouton = { disabled: false, click: () => clique++ };
  const section = { scrollIntoView: () => montre++, querySelector: (s) => (s.includes('data-primary="true"') ? bouton : null) };
  const racine = { querySelector: (s) => (s.includes('data-fournisseur="openai"') ? section : null) };
  assert.equal(A.connecterAbonnement("openai", racine), true);
  assert.equal(clique, 1);
  assert.equal(montre, 1);
  // Déjà connecté (pas de bouton « Connecter ») : la carte est seulement montrée.
  const connecte = { scrollIntoView: () => montre++, querySelector: () => null };
  assert.equal(A.connecterAbonnement("openai", { querySelector: () => connecte }), true);
  assert.equal(clique, 1);
  assert.equal(A.connecterAbonnement("google", { querySelector: () => null }), false);
});

test("le panneau des fournisseurs propose l'abonnement sans clé enregistrée", () => {
  const panneau = lire("../src/axe/CustomProvidersPanel.tsx");
  assert.match(panneau, /const abonnement = d\.hasApiKey \? null : abonnementPourAdresse\(d\.baseUrl\)/);
  assert.match(panneau, /data-action="connecter-abonnement"/);
  assert.match(panneau, /connecterAbonnement\(abonnement\.carte\)/);
  const reglages = lire("../src/components/SettingsPane.tsx");
  for (const id of ["openai", "google", "anthropic"]) assert.ok(reglages.includes(`id="${id}"`), id);
  assert.match(reglages, /data-fournisseur=\{id\}/);
  assert.match(reglages, /className="settings-pane__provider-actions"/);
});
