const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:stop-force — logique du bouton Stop (src/components/chat/arretForce.ts).
const sourcePath = path.resolve(__dirname, "../src/components/chat/arretForce.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(javascript, sourcePath);
const a = loaded.exports;

test("Stop puis 10 s sans fin de tour : « Arrêt forcé… », puis un clic libère", () => {
  let demandes = a.demander(new Map(), "c1", 1_000);
  const demande = demandes.get("c1");
  assert.deepEqual(demande, { demandeeA: 1_000, forcee: false });
  assert.equal(a.delaiAvantForcage(demande, 1_000), 10_000);
  assert.equal(a.delaiAvantForcage(demande, 8_000), 3_000);
  assert.equal(a.delaiAvantForcage(demande, 50_000), 0);
  assert.equal(a.demander(demandes, "c1", 9_000), demandes, "un second Stop garde l'heure du premier");
  assert.equal(a.libereAuClic(demande), false);
  assert.equal(a.libelleStop(false), "Arrêter");

  demandes = a.forcer(demandes, "c1");
  const forcee = demandes.get("c1");
  assert.equal(forcee.forcee, true);
  assert.equal(forcee.demandeeA, 1_000);
  assert.equal(a.delaiAvantForcage(forcee, 50_000), null, "on ne force qu'une fois");
  assert.equal(a.forcer(demandes, "c1"), demandes);
  assert.equal(a.libereAuClic(forcee), true, "un clic sur « Arrêt forcé… » libère");
  assert.equal(a.libelleStop(true), "Arrêt forcé…");
});

test("la fin du tour (ou un nouveau tour) clôt la demande", () => {
  for (const type of ["turn_finished", "interrupted", "error", "turn_started"]) {
    assert.equal(a.clotLaDemande(type), true, type);
  }
  for (const type of ["text_chunk", "tool_started", "token_usage"]) {
    assert.equal(a.clotLaDemande(type), false, type);
  }
  const demandes = a.demander(new Map(), "c1", 0);
  assert.equal(a.clore(demandes, "c1").has("c1"), false);
  assert.equal(a.clore(demandes, "autre"), demandes);
  assert.equal(a.delaiAvantForcage(undefined, 0), null);
  assert.equal(a.libereAuClic(undefined), false);
});

test("le forçage attend plus que la grâce du moteur (8 s)", () => {
  assert.ok(a.ARRET_FORCE_APRES_MS > 8_000);
});
