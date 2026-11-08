// Revue des changements : blocs de conflit et choix « la nôtre / la leur / les deux »
// (src/components/revue/blocsConflit.ts).
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
const B = require(path.resolve(__dirname, "../src/components/revue/blocsConflit.ts"));

const TEXTE = [
  "debut",
  "<<<<<<< HEAD",
  "nous 1",
  "nous 2",
  "=======",
  "eux 1",
  ">>>>>>> autre",
  "milieu",
  "<<<<<<< HEAD",
  "n",
  "||||||| base",
  "b",
  "=======",
  ">>>>>>> autre",
  "fin",
].join("\n");

test("blocs reconnus, avec ou sans section « base » (diff3)", () => {
  const blocs = B.blocsDeConflit(TEXTE);
  assert.equal(blocs.length, 2);
  assert.deepEqual([blocs[0].debut, blocs[0].fin], [2, 7]);
  assert.deepEqual(blocs[0].nous, ["nous 1", "nous 2"]);
  assert.deepEqual(blocs[0].eux, ["eux 1"]);
  assert.equal(blocs[0].base, null);
  assert.equal(blocs[0].etiquetteNous, "HEAD");
  assert.equal(blocs[0].etiquetteEux, "autre");
  assert.deepEqual(blocs[1].base, ["b"]);
  assert.deepEqual(blocs[1].eux, []);
});

test("prendre la nôtre, la leur, les deux", () => {
  assert.equal(B.choisirBloc(TEXTE, 0, "nous").split("\n").slice(0, 4).join("|"), "debut|nous 1|nous 2|milieu");
  assert.equal(B.choisirBloc(TEXTE, 0, "eux").split("\n").slice(0, 3).join("|"), "debut|eux 1|milieu");
  assert.equal(B.choisirBloc(TEXTE, 0, "deux").split("\n").slice(0, 5).join("|"), "debut|nous 1|nous 2|eux 1|milieu");
  // Côté vide choisi : le bloc disparaît.
  const sansBloc2 = B.choisirBloc(TEXTE, 1, "eux");
  assert.equal(B.blocsDeConflit(sansBloc2).length, 1);
  assert.ok(sansBloc2.endsWith("milieu\nfin"));
  const tout = B.choisirBloc(B.choisirBloc(TEXTE, 0, "nous"), 0, "nous");
  assert.equal(B.blocsDeConflit(tout).length, 0);
});

test("fins de ligne CRLF gardées, « ======= » seul n'est pas un conflit", () => {
  const crlf = TEXTE.replace(/\n/g, "\r\n");
  assert.ok(B.choisirBloc(crlf, 0, "nous").includes("debut\r\nnous 1\r\n"));
  assert.equal(B.blocsDeConflit("Titre\n=======\ntexte\n").length, 0);
  assert.equal(B.blocsDeConflit("<<<<<<< HEAD\nsans fin\n").length, 0, "bloc mal fermé ignoré");
});

test("bloc sous le curseur ou suivant", () => {
  const blocs = B.blocsDeConflit(TEXTE);
  assert.equal(B.blocDeLigne(blocs, 4), 0);
  assert.equal(B.blocDeLigne(blocs, 8), 1);
  assert.equal(B.blocDeLigne(blocs, 15), -1);
});

test("message pour l'agent : chaque bloc avec les deux versions", () => {
  const msg = B.messageConflits("Fusion de « autre » dans « main »", [
    { chemin: "src/a.ts", code: "UU", texte: TEXTE },
    { chemin: "img.png", code: "UU", texte: null },
  ], "main", "autre", (f) => (f.endsWith(".ts") ? "typescript" : "")).replace(/\u00a0/g, " ");
  assert.match(msg, /^Fusion de « autre » dans « main » : 2 fichiers en conflit\./);
  assert.match(msg, /1\. src\/a\.ts:2-7 \(bloc 1 sur 2\)\nNotre version \(main\) :\n```typescript\nnous 1\nnous 2\n```\nLa leur \(autre\) :\n```typescript\neux 1\n```/);
  assert.match(msg, /3\. img\.png : conflit sur le fichier entier \(code git UU\)\./);
});
