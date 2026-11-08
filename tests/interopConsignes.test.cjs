// Réglages > Harnais : état des fichiers de consignes (AGENTS.md, CLAUDE.md…).
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
const C = charger("../src/lib/consignes.ts");
const src = (fichier, etat, extra = {}) => ({ fichier, chemin: `/p/${fichier}`, caracteres: 12400, retenus: 12400, etat, ...extra });

test("chaque état a un libellé court en français", () => {
  assert.match(C.libelleSource(src("AGENTS.md", "lu")), /^lu · 12\s400 caractères$/);
  assert.match(C.libelleSource(src("CLAUDE.md", "tronque", { retenus: 400 })), /^coupé · 400 sur 12\s400 caractères$/);
  assert.equal(C.libelleSource(src("CLAUDE.md", "doublon", { detail: "même contenu que AGENTS.md" })), "ignoré · même contenu que AGENTS.md");
  assert.equal(C.libelleSource(src("CLAUDE.md", "ancien_modele")), "ignoré · ancien texte par défaut");
  assert.equal(C.libelleSource(src(".claude/CLAUDE.md", "absent")), "absent");
  assert.equal(C.libelleSource(src(".claude/CLAUDE.md", "plafond")), "non lu · plafond atteint");
});

test("le résumé nomme les fichiers envoyés à l'agent, dans l'ordre", () => {
  const etat = { plafond: 64000, sources: [src("AGENTS.md", "lu"), src("CLAUDE.md", "doublon"), src(".claude/CLAUDE.md", "lu")] };
  assert.deepEqual(C.fichiersLus(etat), ["AGENTS.md", ".claude/CLAUDE.md"]);
  assert.equal(C.resumeConsignes(etat), "Consignes du dossier\u00a0: AGENTS.md, .claude/CLAUDE.md");
  const coupe = { plafond: 10, sources: [src("AGENTS.md", "tronque")] };
  assert.equal(C.resumeConsignes(coupe), "Consignes du dossier\u00a0: AGENTS.md (coupé)");
  assert.equal(C.resumeConsignes({ plafond: 1, sources: [src("AGENTS.md", "absent")] }), "Consignes du dossier\u00a0: aucun fichier");
});
