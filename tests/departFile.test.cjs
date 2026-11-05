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
const D = charger("../src/components/chat/departFile.ts");
const el = (id, text = `texte ${id}`) => ({ id, text, attachments: [] });

test("envoyer maintenant : le message quitte la file affichée tout de suite", () => {
  const s = new D.SuiviDeparts();
  const file = [el("a"), el("b")];
  s.recevoir("c1", file);
  let notifs = 0;
  s.abonner(() => (notifs += 1));
  s.annoncer("c1", file[1], 1000);
  assert.equal(notifs, 1);
  assert.equal(s.enDepart("c1").id, "b");
  assert.deepEqual(s.visibles("c1", file).map((e) => e.id), ["a"]);
  // queue.move : le service le met en tête, il reste masqué.
  assert.deepEqual(s.recevoir("c1", [file[1], file[0]]), []);
  assert.deepEqual(s.visibles("c1", [file[1], file[0]]).map((e) => e.id), ["a"]);
  assert.equal(s.enDepart("c1").id, "b");
  // une autre conversation n'est pas touchée
  assert.equal(s.enDepart("c2"), null);
  assert.deepEqual(s.visibles("c2", file).map((e) => e.id), ["a", "b"]);
});

test("le service annonce le départ (sending) : bulle dans la conversation, départ terminé", () => {
  const s = new D.SuiviDeparts();
  s.recevoir("c1", [el("b"), el("a")]);
  s.annoncer("c1", el("b"));
  const m = s.recevoir("c1", [el("a")], { sending: "b" });
  assert.deepEqual(m.map((x) => [x.type, x.item.id]), [["parti", "b"]]);
  assert.equal(s.enDepart("c1"), null);
});

test("départ automatique en fin de tour (sans « envoyer maintenant »)", () => {
  const s = new D.SuiviDeparts();
  s.recevoir("c1", [el("a", "premier"), el("b")]);
  const m = s.recevoir("c1", [el("b")], { sending: "a" });
  assert.equal(m.length, 1);
  assert.equal(m[0].type, "parti");
  assert.equal(m[0].item.text, "premier");
  // élément inconnu (file jamais lue) : rien à montrer
  assert.deepEqual(new D.SuiviDeparts().recevoir("c9", [], { sending: "zz" }), []);
});

test("échec côté service (failed) : la bulle redevient un message en file, avec l'erreur", () => {
  const s = new D.SuiviDeparts();
  s.recevoir("c1", [el("a"), el("b")]);
  s.recevoir("c1", [el("b")], { sending: "a" });
  const m = s.recevoir("c1", [el("a"), el("b")], { failed: "a", error: "journal plein" });
  assert.equal(m.length, 1);
  assert.equal(m[0].type, "echec");
  assert.equal(m[0].item.id, "a");
  assert.match(m[0].erreur, /revenu dans la file/);
  assert.match(m[0].erreur, /journal plein/);
  // un 2e signal identique ne rejoue rien
  assert.deepEqual(s.recevoir("c1", [el("a"), el("b")], { failed: "a" }), []);
});

test("échec avant le départ (failed sur le message annoncé) : retour dans la file", () => {
  const s = new D.SuiviDeparts();
  s.recevoir("c1", [el("a")]);
  s.annoncer("c1", el("a"));
  const m = s.recevoir("c1", [el("a")], { failed: "a" });
  assert.deepEqual(m.map((x) => x.type), ["echec"]);
  assert.equal(s.enDepart("c1"), null);
  assert.deepEqual(s.visibles("c1", [el("a")]).map((e) => e.id), ["a"]);
});

test("échec côté interface : annuler rend le message à la file", () => {
  const s = new D.SuiviDeparts();
  s.annoncer("c1", el("a"));
  assert.equal(s.annuler("c1").id, "a");
  assert.equal(s.annuler("c1"), null);
  assert.deepEqual(s.visibles("c1", [el("a")]).map((e) => e.id), ["a"]);
});

test("service ancien (sans sending) : le message en départ qui quitte la file est parti", () => {
  const s = new D.SuiviDeparts();
  s.recevoir("c1", [el("a"), el("b")]);
  s.annoncer("c1", el("b"));
  const m = s.recevoir("c1", [el("a")]);
  assert.deepEqual(m.map((x) => [x.type, x.item.id]), [["parti", "b"]]);
  // un élément qui disparaît sans être en départ n'est pas un départ (service ancien)
  assert.deepEqual(s.recevoir("c1", []), []);
});

test("message retiré par l'utilisateur : pas un départ", () => {
  const s = new D.SuiviDeparts();
  s.recevoir("c1", [el("a")]);
  s.annoncer("c1", el("a"));
  s.retirer("a");
  assert.deepEqual(s.recevoir("c1", []), []);
});

test("sans nouvelles du service : le message revient dans la file", () => {
  const s = new D.SuiviDeparts();
  s.annoncer("c1", el("a"), 1_000);
  assert.equal(s.expirer("c1", 1_000 + D.DEPART_SANS_NOUVELLES_MS - 1), null);
  assert.equal(s.expirer("c1", 1_000 + D.DEPART_SANS_NOUVELLES_MS).id, "a");
  assert.equal(s.enDepart("c1"), null);
});
