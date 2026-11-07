// registre de scripts : textes et formats affichés (src/components/settings/registreFormat.ts).
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
const F = charger("../src/components/settings/registreFormat.ts");

test("durées lisibles", () => {
  assert.equal(F.formatDuree(0), "0 ms");
  assert.equal(F.formatDuree(850), "850 ms");
  assert.equal(F.formatDuree(1840), "1,8 s");
  assert.equal(F.formatDuree(12480), "12 s");
  assert.equal(F.formatDuree(60000), "1 min");
  assert.equal(F.formatDuree(65000), "1 min 5 s");
  assert.equal(F.formatDuree(undefined), "—");
  assert.equal(F.formatDuree(-1), "—");
});

test("date courte jj/mm hh:mm (secondes du portail)", () => {
  const d = new Date(2026, 10, 7, 9, 5);
  assert.equal(F.formatDate(d.getTime() / 1000), "07/11 09:05");
  assert.equal(F.formatDate(null), "—");
  assert.equal(F.formatDate(0), "—");
});

test("libellés et tons des états et statuts", () => {
  assert.equal(F.libelleEtat("propose"), "À valider");
  assert.equal(F.libelleEtat("valide"), "Validé");
  assert.equal(F.libelleEtat("retire"), "Retiré");
  assert.equal(F.libelleEtat("autre"), "autre");
  assert.equal(F.tonEtat("valide"), "ok");
  assert.equal(F.tonEtat("propose"), "attente");
  assert.equal(F.tonEtat("retire"), "neutre");
  assert.equal(F.libelleStatut("ok"), "Réussie");
  assert.equal(F.libelleStatut("delai"), "Trop longue");
  assert.equal(F.tonStatut("erreur"), "erreur");
  assert.equal(F.tonStatut("delai"), "erreur");
  assert.equal(F.tonStatut("refuse"), "neutre");
});

test("Publier : bloqué tant que l'identifiant ou le code manquent (règles du portail)", () => {
  const ok = { id: "export-tickets", version: "1.0.0", code: "print(1)" };
  assert.equal(F.raisonBlocage(ok), null);
  assert.match(F.raisonBlocage({ ...ok, id: "" }), /identifiant/i);
  assert.match(F.raisonBlocage({ ...ok, id: "  " }), /identifiant/i);
  assert.match(F.raisonBlocage({ ...ok, id: "Export Tickets" }), /minuscules/);
  assert.match(F.raisonBlocage({ ...ok, id: "x" }), /minuscules/);
  assert.equal(F.raisonBlocage({ ...ok, id: "rapport.dmarc_v2" }), null);
  assert.match(F.raisonBlocage({ ...ok, version: "1.0" }), /1\.0\.0/);
  assert.match(F.raisonBlocage({ ...ok, code: "\n  " }), /code/);
});
