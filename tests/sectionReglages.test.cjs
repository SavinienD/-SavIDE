// axe:parcours-collegue (D1b) — « Connect a provider » ouvre les Réglages sur « Providers ».
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
const S = charger("../src/lib/sectionReglages.ts");

test("volet des Réglages pas encore monté : personne n'écoute, la demande est gardée pour le montage", () => {
  const fenetre = new EventTarget();
  S.demanderSectionReglages("providers", fenetre);
  assert.equal(S.sectionReglagesDemandee(), "providers");
  S.oublierSectionReglages(); // fait par le volet à son montage
  assert.equal(S.sectionReglagesDemandee(), null);
});

test("volet déjà monté : l'événement porte la section et le volet l'oublie aussitôt", () => {
  const fenetre = new EventTarget();
  const recues = [];
  fenetre.addEventListener(S.EVENEMENT_SECTION_REGLAGES, (e) => {
    recues.push(e.detail.section);
    S.oublierSectionReglages();
  });
  S.demanderSectionReglages("providers", fenetre);
  assert.deepEqual(recues, ["providers"]);
  assert.equal(S.sectionReglagesDemandee(), null);
});

test("même événement que les autres émetteurs (commandes /login et /settings)", () => {
  const slash = fs.readFileSync(path.resolve(__dirname, "../src/components/chat/SlashCommands.tsx"), "utf8");
  assert.match(slash, new RegExp(`OPEN_SETTINGS_EVENT = "${S.EVENEMENT_SECTION_REGLAGES}"`));
});
