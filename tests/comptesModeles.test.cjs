// plusieurs comptes du même fournisseur dans le choix du modèle.
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
const C = charger("../src/lib/comptesModeles.ts");
const T = ["off", "medium"];
const cat = [
  { value: "anthropic:claude-opus-5-5", provider: "anthropic", label: "Opus 5.5", thinking: T, defaultThinking: "medium" },
  { value: "anthropic:claude-haiku-5-5", provider: "anthropic", label: "Haiku 5.5", thinking: T, defaultThinking: "medium" },
  { value: "openai:gpt-6-sol", provider: "openai", label: "GPT-6 Sol", thinking: T, defaultThinking: "medium" },
];

test("un groupe par compte, juste après le fournisseur, e-mail en sous-titre", () => {
  const out = C.modelesAvecComptes(cat, ["anthropic", "anthropic~2", "openai"], [
    { providerId: "anthropic", base: "anthropic", email: "a@axe.fr" },
    { providerId: "anthropic~2", base: "anthropic", email: "b@gmail.com" },
    { providerId: "openai", base: "openai", email: "c@gmail.com" },
  ]);
  assert.deepEqual(out.map((m) => [m.value, m.accountLabel ?? null]), [
    ["anthropic:claude-opus-5-5", "a@axe.fr"],
    ["anthropic:claude-haiku-5-5", "a@axe.fr"],
    ["anthropic~2:claude-opus-5-5", "b@gmail.com"],
    ["anthropic~2:claude-haiku-5-5", "b@gmail.com"],
    // Un seul compte OpenAI : pas de sous-titre.
    ["openai:gpt-6-sol", null],
  ]);
  assert.equal(out[2].provider, "anthropic~2");
  assert.equal(out[2].label, "Opus 5.5");
});

test("compte principal déconnecté, compte ajouté seul : ses modèles restent", () => {
  const out = C.modelesAvecComptes(cat, ["anthropic~2"], [{ providerId: "anthropic~2", base: "anthropic", email: "b@gmail.com" }]);
  assert.deepEqual(out.filter((m) => m.provider === "anthropic~2").length, 2);
  assert.equal(C.baseDuFournisseur("openai~3"), "openai");
  assert.equal(C.baseDuFournisseur("ollama"), "ollama");
});

test("un seul compte : liste inchangée", () => {
  assert.deepEqual(C.modelesAvecComptes(cat, ["anthropic", "openai"], []), cat);
});
