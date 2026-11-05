// E-mail et offre des comptes connectés (Réglages > Fournisseurs).
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
const C = charger("../src/lib/comptesFournisseurs.ts");

test("Claude connecté : e-mail et offre du profil", () => {
  assert.deepEqual(
    C.compteConnecte({ connected: true, connectionState: "connected", email: " claude@example.com ", planType: "Max" }),
    { email: "claude@example.com", offre: "Max" },
  );
});

test("connexion d'avant (sans e-mail) ou déconnecté : rien", () => {
  assert.deepEqual(C.compteConnecte({ connected: true, connectionState: "connected" }), { email: null, offre: null });
  assert.deepEqual(C.compteConnecte({ connected: false, email: "a@b.c", planType: "Pro" }), { email: null, offre: null });
  assert.deepEqual(C.compteConnecte(null), { email: null, offre: null });
  assert.deepEqual(C.compteConnecte({ connected: true, email: "pas-un-email" }), { email: null, offre: null });
});

test("offres : OpenAI en minuscules, niveau Google, libellé déjà écrit", () => {
  assert.equal(C.compteConnecte({ connected: true, email: "a@b.c", planType: "plus" }).offre, "Plus");
  assert.equal(C.compteConnecte({ connected: true, email: "a@b.c", userTier: "Google AI Pro" }).offre, "Google AI Pro");
  assert.equal(C.libelleOffre("free-tier"), "Free tier");
  assert.equal(C.libelleOffre("Ultra"), "Ultra");
  assert.equal(C.libelleOffre("  "), null);
  assert.equal(C.libelleOffre(undefined), null);
});
