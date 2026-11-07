// choix du modèle : recherche, groupes par compte, place de la liste.
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
const M = charger("../src/lib/menuModeles.ts");

const modeles = [
  { value: "anthropic:claude-opus-5-5", provider: "anthropic", label: "Opus 5.5" },
  { value: "anthropic:claude-sonnet-5-5", provider: "anthropic", label: "Sonnet 5.5" },
  { value: "anthropic~2:claude-opus-5-5", provider: "anthropic~2", label: "Opus 5.5", accountLabel: "b@exemple.fr" },
  { value: "ollama:qwen3:4b", provider: "ollama", label: "qwen3:4b", providerLabel: "Ollama" },
  { value: "ollama:qwen3-coder:30b", provider: "ollama", label: "qwen3-coder:30b", providerLabel: "Ollama" },
];

test("recherche : tous les mots, sans accents ni casse, sur nom, identifiant, fournisseur et compte", () => {
  assert.deepEqual(M.filtrerModeles(modeles, "qwen3").map((m) => m.value), ["ollama:qwen3:4b", "ollama:qwen3-coder:30b"]);
  assert.deepEqual(M.filtrerModeles(modeles, "  OPUS  b@exemple ").map((m) => m.value), ["anthropic~2:claude-opus-5-5"]);
  assert.deepEqual(M.filtrerModeles(modeles, "ollama coder").map((m) => m.value), ["ollama:qwen3-coder:30b"]);
  assert.equal(M.filtrerModeles(modeles, "").length, 5);
  assert.equal(M.filtrerModeles(modeles, "réflexion").length, 0);
});

test("groupes : un par fournisseur et par compte, e-mail en sous-titre", () => {
  const g = M.groupesModeles(modeles, (p) => (p.startsWith("anthropic") ? "Anthropic" : "Ollama"));
  assert.deepEqual(g.map((x) => [x.titre, x.sousTitre, x.modeles.length]), [
    ["Anthropic", null, 2],
    ["Anthropic", "b@exemple.fr", 1],
    ["Ollama", null, 2],
  ]);
});

test("placement : en haut s'il y a la place, sinon du côté le plus grand, hauteur bornée", () => {
  const fenetre = { haut: 0, bas: 768 };
  assert.deepEqual(M.placementMenu({ top: 700, bottom: 730 }, fenetre), { direction: "haut", hauteurMax: 684 });
  assert.deepEqual(M.placementMenu({ top: 100, bottom: 130 }, fenetre), { direction: "bas", hauteurMax: 622 });
  assert.equal(M.placementMenu({ top: 400, bottom: 430 }, { haut: 0, bas: 600 }).direction, "haut");
  assert.equal(M.placementMenu({ top: 4, bottom: 30 }, { haut: 0, bas: 30 }).hauteurMax, 0);
  // Sous la barre de titre (colonne du chat à 40 px) : la liste ne monte pas dessus.
  assert.deepEqual(M.placementMenu({ top: 700, bottom: 730 }, { haut: 40, bas: 768 }), { direction: "haut", hauteurMax: 644 });
});
