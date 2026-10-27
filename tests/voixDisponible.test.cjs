// axe:0.1.71 — dictée proposée seulement si un moteur répond.
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
const V = charger("../src/axe/voix/disponibilite.ts");
const refuse = { connexion: "service local", ok: true, moteurs: [{ url: "http://127.0.0.1:8178/inference", label: "whisper small (VM) de secours", ok: false, error: "connexion refusée" }] };

test("aucun moteur qui répond (cas de la capture) : dictée indisponible", () => {
  assert.equal(V.dicteeDisponible({ services: [refuse], openai: false }), false);
  assert.equal(V.dicteeDisponible(null), false);
  assert.equal(V.dicteeDisponible({ services: [{ connexion: "service local", ok: false, erreur: "x" }], openai: false }), false);
});

test("moteur local qui répond : dictée proposée, y compris en mode 100 % local", () => {
  const ok = { connexion: "service local", ok: true, moteurs: [{ url: "u", label: "whisper", ok: true }] };
  assert.equal(V.dicteeDisponible({ services: [refuse, ok], openai: false }, { localSeulement: true }), true);
});

test("mode local : ni espace distant ni OpenAI ne comptent", () => {
  const vm = { connexion: "axe-cloud", ok: true, moteurs: [{ url: "u", label: "whisper (VM)", ok: true }] };
  assert.equal(V.dicteeDisponible({ services: [vm, refuse], openai: true }, { localSeulement: true }), false);
  assert.equal(V.dicteeDisponible({ services: [vm, refuse], openai: false }), true);
  assert.equal(V.dicteeDisponible({ services: [refuse], openai: true }), true);
});

test("le micro du compositeur et les réglages suivent la disponibilité", () => {
  const bouton = fs.readFileSync(path.resolve(__dirname, "../src/axe/voix/DicteeBouton.tsx"), "utf8");
  assert.match(bouton, /useDicteeDisponible\(workspacePath, \{ localSeulement: true \}\)/);
  assert.match(bouton, /if \(dispo !== true\) return null;/);
  const section = fs.readFileSync(path.resolve(__dirname, "../src/axe/voix/VoixSection.tsx"), "utf8");
  assert.match(section, /MESSAGE_DICTEE_INDISPONIBLE_LOCAL/);
  assert.match(section, /if \(dispo === false\) \{/);
});

test("barre et bulles de la dictée placées dans le compositeur (jamais rognées par une colonne étroite)", () => {
  const bouton = fs.readFileSync(path.resolve(__dirname, "../src/axe/voix/DicteeBouton.tsx"), "utf8");
  assert.equal((bouton.match(/placer\(/g) ?? []).length, 4);
  assert.match(bouton, /closest<HTMLElement>\("\.composer__box"\)/);
  const css = fs.readFileSync(path.resolve(__dirname, "../src/axe/voix/voix.css"), "utf8");
  assert.match(css, /\.composer__box > \.axe-voix__bulle \{[^}]*max-width: calc\(100% - 16px\)/);
  assert.match(css, /\.composer__actions > \.axe-voix__barre \{[^}]*max-width: calc\(100% - 10px\)/);
});
