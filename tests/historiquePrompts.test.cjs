const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:hist169 - historique des prompts (src/components/chat/historiquePrompts.ts).
const sourcePath = path.resolve(__dirname, "../src/components/chat/historiquePrompts.ts");
const js = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const m = new Module(sourcePath, module);
m.filename = sourcePath;
m._compile(js, sourcePath);
const { naviguer, memoriserPrompt, historiquePrompts } = m.exports;
const store = new Map();
global.window = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };

test("haut puis bas rend le brouillon", () => {
  const l = ["un", "deux", "trois"];
  let r = naviguer("haut", "brou", 4, l, { index: null, brouillon: "" });
  assert.equal(r.texte, "trois");
  r = naviguer("haut", r.texte, 0, l, r.etat);
  assert.equal(r.texte, "deux");
  r = naviguer("bas", r.texte, 4, l, r.etat);
  assert.equal(r.texte, "trois");
  r = naviguer("bas", r.texte, 5, l, r.etat);
  assert.equal(r.texte, "brou");
  assert.equal(r.etat.index, null);
});
test("curseur hors 1re ligne : touche laissee au champ", () => {
  assert.equal(naviguer("haut", "a\nb", 3, ["x"], { index: null, brouillon: "" }), null);
  assert.equal(naviguer("bas", "a\nb", 0, ["x"], { index: 0, brouillon: "" }), null);
});
test("memorise par conversation + global", () => {
  memoriserPrompt("c1", "alpha");
  memoriserPrompt("c2", "beta");
  memoriserPrompt("c1", "gamma");
  memoriserPrompt("c1", "gamma");
  assert.deepEqual(historiquePrompts("c1"), ["beta", "alpha", "gamma"]);
});
