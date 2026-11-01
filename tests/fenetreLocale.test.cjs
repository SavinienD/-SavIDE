// fenetre-locale — modèle ajouté à un fournisseur local (Ollama, LM Studio, URL localhost /
// 127.0.0.1) : 32 768 jetons de contexte par défaut, ou moins si le serveur annonce moins
// (Ollama /api/show) ; cloud inchangé (128 000). Bug signalé : qwen3:4b à 128 000 → Ollama
// réservait 22 Go de RAM.
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
const M = charger("../src/axe/modelesFournisseur.ts");

test("adresses de ce PC (comme axecode_core::is_local_url)", () => {
  for (const u of ["http://localhost:11434", "http://127.0.0.1:8080/v1", "localhost:1234", "http://[::1]:5000/v1", "http://0.0.0.0:8000", "http://user@127.0.0.1:1/v1"]) {
    assert.equal(M.estUrlLocale(u), true, u);
  }
  for (const u of ["https://api.openai.com/v1", "https://localhost.example.com/v1", "http://10.0.0.5:8000/v1", ""]) {
    assert.equal(M.estUrlLocale(u), false, u);
  }
});

test("fournisseurs locaux : Ollama / LM Studio partout, compatible OpenAI sur ce PC ; relais Anthropic local = cloud", () => {
  assert.equal(M.fournisseurLocal("ollama", true, "http://192.168.1.20:11434"), true);
  assert.equal(M.fournisseurLocal("lm_studio", true, ""), true);
  assert.equal(M.fournisseurLocal("open_ai_compatible", false, "http://127.0.0.1:8080/v1"), true);
  assert.equal(M.fournisseurLocal("open_ai_compatible", false, "https://api.openai.com/v1"), false);
  assert.equal(M.fournisseurLocal("mistral", false, "https://api.mistral.ai/v1"), false);
  assert.equal(M.fournisseurLocal("anthropic_compatible", false, "http://127.0.0.1:8096"), false);
});

test("fenêtre par défaut : 32 768 en local (moins si annoncé), 128 000 dans le cloud", () => {
  assert.equal(M.fenetreParDefaut(true), 32768);
  assert.equal(M.fenetreParDefaut(true, 262144), 32768);
  assert.equal(M.fenetreParDefaut(true, 8192), 8192);
  assert.equal(M.fenetreParDefaut(true, 0), 32768);
  assert.equal(M.fenetreParDefaut(false), 128000);
  assert.equal(M.fenetreParDefaut(false, 200000), 200000);
  assert.equal(M.sortieParDefaut(32768), 16384);
  assert.equal(M.sortieParDefaut(8192), 4096);
  assert.equal(M.sortieParDefaut(128000), 16384);
});

test("« Saisir » ne met plus 128 000 en dur : fenêtre selon le fournisseur, demandée au Rust", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/axe/CustomProvidersPanel.tsx"), "utf8");
  assert.doesNotMatch(src, /contextWindow:\s*128000/);
  assert.match(src, /providerApi\s*\.defaultWindow\(/);
  assert.match(src, /fenetreParDefaut\(local\)/);
  assert.match(src, /m\.contextWindow === fenetre/, "la fenêtre annoncée ne remplace pas une valeur changée à la main");
  const ipc = fs.readFileSync(path.resolve(__dirname, "../src/axe/providers.ts"), "utf8");
  assert.match(ipc, /"provider_model_default_window"/);
  const lib = fs.readFileSync(path.resolve(__dirname, "../src-tauri/src/lib.rs"), "utf8");
  assert.match(lib, /custom_providers::provider_model_default_window/);
});

test("mêmes valeurs que le Rust (axecode-core)", () => {
  const rs = fs.readFileSync(path.resolve(__dirname, "../crates/axecode-core/src/provider_config.rs"), "utf8");
  assert.match(rs, /pub const LOCAL_CONTEXT_WINDOW: u32 = 32_768;/);
  assert.match(rs, /pub const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;/);
  assert.equal(M.FENETRE_LOCALE, 32768);
  assert.equal(M.FENETRE_CLOUD, 128000);
});
