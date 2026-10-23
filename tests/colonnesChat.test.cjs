const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const C = charger("../src/components/chat/colonnes.ts");
const { createConversationActions } = charger("../src/components/chat/actionsConversation.ts");

test("deux colonnes, deux conversations : chaque message va dans son fil", async () => {
  let etat = { colonnes: [[]], focus: 0 };
  etat = C.ouvrir(etat, "a");
  etat = C.ouvrir(etat, "b");
  etat = C.deplacer(etat, "b", etat.colonnes.length); // « + colonne » par glisser
  assert.deepEqual(etat.colonnes, [["a"], ["b"]]);
  const fils = { a: [], b: [] };
  const exec = {
    send: async (conv, text) => fils[conv.id].push(text),
    compact: async () => {}, changeMode: async () => {}, changeModelPreference: async () => {},
    implementPlanFresh: async () => {}, stop: async () => {},
  };
  const panes = etat.colonnes.map((col) => createConversationActions({ id: col[0], history: [] }, exec));
  await panes[0].onSend("bonjour A", []);
  await panes[1].onSend("bonjour B", []);
  assert.deepEqual(fils, { a: ["bonjour A"], b: ["bonjour B"] });
});

test("glisser-déposer un onglet d'une colonne à l'autre", () => {
  let etat = { colonnes: [["a", "b"], ["c"]], focus: 0 };
  etat = C.deplacer(etat, "b", 1, 0);
  assert.deepEqual(etat.colonnes, [["a"], ["b", "c"]]);
  assert.equal(etat.focus, 1);
  // vider une colonne la supprime et garde le focus sur la cible
  etat = C.deplacer(etat, "a", 1);
  assert.deepEqual(etat.colonnes, [["b", "c", "a"]]);
  assert.equal(etat.focus, 0);
});

test("ajouterColonne et focus borné", () => {
  let etat = C.ajouterColonne({ colonnes: [["a"]], focus: 0 });
  assert.deepEqual(etat, { colonnes: [["a"], []], focus: 1 });
  assert.equal(C.focaliser(etat, 9).focus, 1);
});

test("archiver retire l'id de colonnesChat", () => {
  let etat = { colonnes: [["a"], ["b", "c"]], focus: 1 };
  etat = C.retirer(etat, "a");
  assert.deepEqual(etat.colonnes, [["b", "c"]]);
  assert.equal(etat.focus, 0);
  assert.equal(C.trouver(etat.colonnes, "a"), null);
});

test("relire ignore les doublons et les états corrompus", () => {
  assert.equal(C.relire("{pas du json"), null);
  assert.deepEqual(C.relire(JSON.stringify({ colonnes: [["a", "a"], ["a", 3, "b"]], focus: 7 })), {
    colonnes: [["a"], ["b"]],
    focus: 1,
  });
});

test("onglet de fichier : glisser vers une colonne de GAUCHE (tous les sens)", () => {
  let etat = { colonnes: [["a.py"], ["b.py", "test_interne.py"], ["c.py"]], focus: 2 };
  // droite -> 1re colonne
  let e = C.deplacer(etat, "test_interne.py", 0);
  assert.deepEqual(e.colonnes, [["a.py", "test_interne.py"], ["b.py"], ["c.py"]]);
  assert.equal(e.focus, 0);
  // derniere -> gauche, la colonne source se vide et disparait
  e = C.deplacer(etat, "c.py", 0, 0);
  assert.deepEqual(e.colonnes, [["c.py", "a.py"], ["b.py", "test_interne.py"]]);
  assert.equal(e.focus, 0);
  // gauche -> droite, la source (colonne 0) disparait : le focus se recale
  e = C.deplacer(etat, "a.py", 2);
  assert.deepEqual(e.colonnes, [["b.py", "test_interne.py"], ["c.py", "a.py"]]);
  assert.equal(e.focus, 1);
  // meme colonne : aucun element perdu
  e = C.deplacer(etat, "test_interne.py", 1, 0);
  assert.deepEqual(e.colonnes, [["a.py"], ["test_interne.py", "b.py"], ["c.py"]]);
});

const S = charger("../src/components/chat/colonnes.ts");
test("e17b glisser pointer : seuil et colonne cible", () => {
  assert.equal(S.depasseSeuil(3, 4), false);
  assert.equal(S.depasseSeuil(6, 0), true);
  assert.equal(S.colonneCible("1", 2), 1);
  assert.equal(S.colonneCible("nouvelle", 2), 2);
  assert.equal(S.colonneCible("5", 2), null);
  assert.equal(S.colonneCible(null, 2), null);
  const e = { colonnes: [["a", "b"], ["c"]], focus: 0 };
  assert.deepEqual(S.deplacer(e, "c", 0).colonnes, [["a", "b", "c"]]);
  assert.deepEqual(S.deplacer(e, "b", 1).colonnes, [["a"], ["c", "b"]]);
  assert.deepEqual(S.deplacer(e, "a", S.colonneCible("nouvelle", 2)).colonnes, [["b"], ["c"], ["a"]]);
});

test("axe:hotfix fermerColonne : les onglets rejoignent la voisine, le focus suit", () => {
  const etat = { colonnes: [["a"], ["b"], ["c"]], focus: 2 };
  assert.deepEqual(C.fermerColonne(etat, 2), { colonnes: [["a"], ["b", "c"]], focus: 1 });
  assert.deepEqual(C.fermerColonne(etat, 0), { colonnes: [["b", "a"], ["c"]], focus: 1 });
  assert.deepEqual(C.fermerColonne({ colonnes: [["a"], ["b"]], focus: 0 }, 0), { colonnes: [["b", "a"]], focus: 0 });
  const seule = { colonnes: [["a"]], focus: 0 };
  assert.equal(C.fermerColonne(seule, 0), seule);
});

test("axe:hotfix synchroniser : le focus suit la conversation active, pas le dernier onglet", () => {
  let etat = { colonnes: [["a"], ["b"], ["c"]], focus: 0 };
  etat = C.synchroniser(etat, ["a", "b", "c"], "a");
  assert.equal(etat.focus, 0);
  etat = C.synchroniser(etat, ["a", "b", "c", "d"], "d");
  assert.deepEqual(etat.colonnes, [["a", "d"], ["b"], ["c"]]);
  assert.equal(etat.focus, 0);
  etat = C.synchroniser({ colonnes: [["a"], ["b"], ["c"]], focus: 2 }, ["a", "c"], "c");
  assert.deepEqual(etat, { colonnes: [["a"], ["c"]], focus: 1 });
  const stable = { colonnes: [["a"], ["b"]], focus: 1 };
  assert.equal(C.synchroniser(stable, ["a", "b"], "b"), stable);
});

test("axe:hotfix suivre : le focus va sur la colonne de la conversation active", () => {
  const etat = { colonnes: [["a"], ["b"]], focus: 0 };
  assert.deepEqual(C.suivre(etat, "b"), { colonnes: [["a"], ["b"]], focus: 1 });
  assert.equal(C.suivre(etat, "a"), etat);
  assert.equal(C.suivre(etat, "z"), etat);
});

test("axe:hotfix-largeurs poignée entre deux colonnes : la gauche prend ce que perd la droite, jamais sous 220 px", () => {
  const proche = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  assert.deepEqual(C.poidsColonnes(undefined, 2), [1, 1]);
  assert.deepEqual(C.poidsColonnes([1.5, 0.5], 2), [1.5, 0.5]);
  assert.deepEqual(C.poidsColonnes([1.5, 0.5], 3), [1, 1, 1]);
  assert.deepEqual(C.poidsColonnes([1, -1], 2), [1, 1]);
  const p = C.redimensionner([1, 1], 0, 100, 1000); // 500/500 -> 600/400
  proche(p[0], 1.2); proche(p[1], 0.8);
  const q = C.redimensionner([1, 1], 0, 900, 1000); // la droite s'arrête à 220 px
  proche(q[1] * 500, 220); proche(q[0] + q[1], 2);
  const g = C.redimensionner([1, 1], 0, -900, 1000); // la gauche aussi
  proche(g[0] * 500, 220);
  const r = C.redimensionner([1, 1, 1], 1, -50, 900); // seules les colonnes 2 et 3 bougent
  proche(r[0], 1); proche(r[1] * 300, 250); proche(r[2] * 300, 350);
  const s = [1, 1];
  assert.equal(C.redimensionner(s, 1, 10, 1000), s); // pas de colonne à droite
  assert.equal(C.redimensionner(s, 0, 10, 0), s); // largeur inconnue
  assert.equal(C.redimensionner(s, 0, 0, 1000), s);
  assert.equal(C.redimensionner(q, 0, 50, 1000), q); // déjà en butée
});
