// catalogue des fournisseurs intégrés complété par GET /v1/models.
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
const C = charger("../src/lib/catalogueModeles.ts");

const T = ["off", "low", "medium", "high"];
const base = [
  { value: "anthropic:claude-opus-5-5", provider: "anthropic", label: "Opus 5.5", thinking: T, defaultThinking: "medium" },
  { value: "anthropic:claude-haiku-5-5", provider: "anthropic", label: "Haiku 5.5", thinking: T, defaultThinking: "medium" },
  { value: "openai:gpt-6-sol", provider: "openai", label: "GPT-6 Sol", thinking: T, defaultThinking: "medium", supportsFast: true },
  { value: "google:gemini-3.8-flash", provider: "google", label: "Gemini", thinking: T, defaultThinking: "high" },
];

test("nouveaux modèles ajoutés après ceux du fournisseur, sans doublon ni version datée", () => {
  const out = C.completerCatalogue(base, {
    fournisseurs: {
      anthropic: [
        { id: "claude-opus-6", label: "Claude Opus 6" },
        { id: "claude-opus-5-5", label: "Claude Opus 5.5 (nouveau nom)" },
        { id: "claude-opus-5-5-20261001" },
        { id: "claude-opus-6" },
      ],
      openai: [{ id: "gpt-6-nova" }, { id: "text-embedding-4" }, { id: "gpt-6-sol-2026-10-01" }, { id: "gpt-6-tts" }],
    },
  });
  assert.deepEqual(out.map((m) => m.value), [
    "anthropic:claude-opus-5-5", "anthropic:claude-haiku-5-5", "anthropic:claude-opus-6",
    "openai:gpt-6-sol", "openai:gpt-6-nova", "google:gemini-3.8-flash",
  ]);
  // Réglages connus gardés (nom de la liste en dur) ; réglages du fournisseur pour les nouveaux.
  assert.equal(out[0].label, "Opus 5.5");
  assert.equal(out[2].label, "Opus 6");
  assert.deepEqual(out[2].thinking, T);
  assert.equal(out[4].label, "GPT-6 Nova");
  assert.equal(out[4].supportsFast, true);
});

test("rien de découvert (hors ligne, pas connecté) : la liste en dur telle quelle", () => {
  assert.deepEqual(C.completerCatalogue(base, null), base);
  assert.deepEqual(C.completerCatalogue(base, { fournisseurs: {} }), base);
});

test("noms tirés de l'identifiant", () => {
  assert.equal(C.libelleModele("anthropic", "claude-sonnet-6-1"), "Sonnet 6.1");
  assert.equal(C.libelleModele("anthropic", "claude-fable-6", "Claude Fable 6"), "Fable 6");
  assert.equal(C.libelleModele("openai", "gpt-7"), "GPT-7");
  assert.equal(C.modeleDeChat("openai", "o5-mini"), true);
  assert.equal(C.modeleDeChat("openai", "whisper-2"), false);
});
