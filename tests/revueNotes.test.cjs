// Revue des changements : notes gardées par dossier et message unique pour l'agent
// (src/components/revue/notes.ts).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const N = require(path.resolve(__dirname, "../src/components/revue/notes.ts"));

function stockage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const note = (o = {}) => ({ fichier: "src/app.ts", debut: 12, fin: 14, cote: "nouveau", extrait: "const a = 1;\nconst b = 2;", texte: "  Renomme a en total.  ", ...o });

test("notes gardées par dossier, relues après un redémarrage", () => {
  const s = stockage();
  const m = new N.MagasinNotes(s);
  let appels = 0;
  m.abonner(() => (appels += 1));
  const a = m.ajouter("C:/projet", note());
  m.ajouter("C:/autre", note({ fichier: "b.rs" }));
  assert.equal(a.texte, "Renomme a en total.");
  assert.equal(m.notes("C:/projet").length, 1);
  assert.equal(appels, 2);
  const relu = new N.MagasinNotes(s);
  assert.deepEqual(relu.notes("C:/projet").map((n) => n.fichier), ["src/app.ts"]);
  assert.deepEqual(relu.notes("C:/autre").map((n) => n.fichier), ["b.rs"]);
});

test("modifier, supprimer, effacer après l'envoi (seulement les notes envoyées)", () => {
  const s = stockage();
  const m = new N.MagasinNotes(s);
  const a = m.ajouter("D", note(), 1000);
  const b = m.ajouter("D", note({ debut: 3, fin: 3 }), 1001);
  m.modifier("D", a.id, "Autre texte");
  assert.equal(m.notes("D")[0].texte, "Autre texte");
  const avant = m.notes("D");
  m.supprimer("D", b.id);
  assert.notEqual(m.notes("D"), avant, "nouvel instantané à chaque changement");
  const c = m.ajouter("D", note({ fichier: "c.ts" }), 1002);
  m.effacer("D", [a.id]);
  assert.deepEqual(m.notes("D").map((n) => n.id), [c.id]);
  m.effacer("D");
  assert.equal(m.notes("D").length, 0);
  assert.equal(s.m.has(N.cleNotes("D")), false, "clé retirée quand il n'y a plus de note");
});

test("stockage abîmé : rien ne plante, les entrées invalides sont ignorées", () => {
  const s = stockage();
  s.setItem(N.cleNotes("X"), "{pas du json");
  assert.deepEqual(new N.MagasinNotes(s).notes("X"), []);
  s.setItem(N.cleNotes("Y"), JSON.stringify([{ id: 1 }, { ...note(), id: "ok", creeLe: 1 }]));
  assert.deepEqual(new N.MagasinNotes(s).notes("Y").map((n) => n.id), ["ok"]);
});

test("UN message : fichier:lignes, extrait, note, dans l'ordre", () => {
  const m = new N.MagasinNotes(null);
  m.ajouter("D", note());
  m.ajouter("D", note({ fichier: "old.rs", debut: 40, fin: 40, cote: "ancien", extrait: "fn f() {}", texte: "Garde cette fonction." }));
  m.ajouter("D", note({ fichier: "docs/guide.md", debut: 8, fin: 9, cote: "apercu", extrait: "Installer\nLancer", texte: "Ajoute un exemple." }));
  const msg = N.messageNotes(m.notes("D"), (f) => (f.endsWith(".ts") ? "typescript" : f.endsWith(".rs") ? "rust" : ""));
  assert.match(msg, /^3 notes de relecture/);
  assert.match(msg, /1\. src\/app\.ts:12-14\n```typescript\nconst a = 1;\nconst b = 2;\n```\nNote : Renomme a en total\./);
  assert.match(msg, /2\. old\.rs:40 \(avant la modification\)\n```rust\nfn f\(\) \{\}\n```\nNote : Garde cette fonction\./);
  assert.match(msg, /3\. docs\/guide\.md:8-9 \(aperçu Markdown\)\n> Installer\n> Lancer\nNote : Ajoute un exemple\./);
  assert.ok(msg.indexOf("1. ") < msg.indexOf("2. ") && msg.indexOf("2. ") < msg.indexOf("3. "));
});

test("extrait avec des accents graves : clôture plus longue ; extrait trop long coupé", () => {
  const m = new N.MagasinNotes(null);
  m.ajouter("D", note({ extrait: "const s = ```x```;" }));
  assert.match(N.messageNotes(m.notes("D")), /````\nconst s = ```x```;\n````/);
  const long = Array.from({ length: 100 }, (_, i) => `ligne ${i}`).join("\n");
  const n = m.ajouter("D", note({ extrait: long }));
  assert.equal(n.extrait.split("\n").length, N.EXTRAIT_MAX_LIGNES + 1);
  assert.ok(n.extrait.endsWith("…"));
});
