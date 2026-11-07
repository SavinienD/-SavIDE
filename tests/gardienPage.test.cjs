"use strict";
// écran noir : reprise de l'écran après un rechargement, battement, journal des erreurs.
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
const G = require(path.resolve(__dirname, "../src/lib/gardienPage.ts"));
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

function stockage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
function cible(extra = {}) {
  const ec = new Map();
  return {
    ...extra,
    addEventListener: (t, f) => ec.set(t, [...(ec.get(t) ?? []), f]),
    removeEventListener: (t, f) => ec.set(t, (ec.get(t) ?? []).filter((g) => g !== f)),
    emettre: (t, e) => (ec.get(t) ?? []).forEach((f) => f(e)),
    nombre: () => [...ec.values()].reduce((n, l) => n + l.length, 0),
  };
}

test("après un rechargement, le dossier et la conversation active sont rouverts", () => {
  const s = stockage();
  G.noterEcran(s, "main", { kind: "dossier", chemin: "C:\\Projets\\monappli" }, 1000);
  G.noterConversation(s, "main", "c-007", 2000);
  assert.deepEqual(G.ecranARouvrir(s, "main", { repriseDemandee: true, rechargement: false, maintenant: 3000 }), { kind: "dossier", chemin: "C:\\Projets\\monappli", conversationId: "c-007" });
  assert.deepEqual(G.ecranARouvrir(s, "main", { repriseDemandee: false, rechargement: true, maintenant: 3000 })?.conversationId, "c-007");
});

test("ouverture normale de l'appli, écran trop ancien, accueil, autre fenêtre : rien n'est rouvert", () => {
  const s = stockage();
  G.noterEcran(s, "main", { kind: "libre", conversationId: "l-1" }, 1000);
  assert.equal(G.ecranARouvrir(s, "main", { repriseDemandee: false, rechargement: false, maintenant: 2000 }), null);
  assert.equal(G.ecranARouvrir(s, "main", { repriseDemandee: true, rechargement: false, maintenant: 1000 + G.VALIDITE_MS + 1 }), null);
  assert.equal(G.ecranARouvrir(s, "fenetre-2", { repriseDemandee: true, rechargement: true, maintenant: 2000 }), null);
  G.noterEcran(s, "main", { kind: "accueil" }, 3000);
  G.noterConversation(s, "main", "c-1", 3500);
  assert.equal(G.ecranARouvrir(s, "main", { repriseDemandee: true, rechargement: true, maintenant: 4000 }), null);
});

test("type de navigation : seul « reload » compte", () => {
  assert.equal(G.estUnRechargement({ getEntriesByType: () => [{ type: "reload" }] }), true);
  assert.equal(G.estUnRechargement({ getEntriesByType: () => [{ type: "navigate" }] }), false);
  assert.equal(G.estUnRechargement(undefined), false);
});

test("battement : tout de suite, à chaque tic, au retour au premier plan ; arrêt propre", () => {
  let tic = null;
  const minuterie = { setInterval: (f, ms) => { assert.equal(ms, G.BATTEMENT_MS); tic = f; return 3; }, clearInterval: (id) => { if (id === 3) tic = null; } };
  const doc = cible({ visibilityState: "visible" });
  const fen = cible();
  let n = 0;
  const arreter = G.demarrerBattement({ envoyer: () => (n += 1), minuterie, document: doc, fenetre: fen });
  assert.equal(n, 1);
  tic();
  doc.emettre("visibilitychange");
  fen.emettre("focus");
  assert.equal(n, 4);
  doc.visibilityState = "hidden";
  doc.emettre("visibilitychange");
  assert.equal(n, 4);
  arreter();
  assert.equal(tic, null);
  assert.equal(doc.nombre() + fen.nombre(), 0);
});

test("mesure de la mémoire de la page", () => {
  assert.deepEqual(G.mesurer({ memory: { usedJSHeapSize: 50 * 1048576 } }, { getElementsByTagName: () => ({ length: 1234 }) }), { tasMo: 50, noeuds: 1234 });
  assert.deepEqual(G.mesurer({}, undefined), { tasMo: null, noeuds: null });
});

test("erreurs JS journalisées, au plus MAX_ERREURS_JOURNAL", () => {
  const fen = cible();
  const lignes = [];
  const arreter = G.journaliserErreurs(fen, (t) => lignes.push(t));
  fen.emettre("error", { message: "x is undefined", filename: "app.js", lineno: 12 });
  fen.emettre("unhandledrejection", { reason: new Error("IPC perdu") });
  assert.match(lignes[0], /x is undefined \(app\.js:12\)/);
  assert.match(lignes[1], /IPC perdu/);
  for (let i = 0; i < 50; i += 1) fen.emettre("error", { message: "encore" });
  assert.equal(lignes.length, G.MAX_ERREURS_JOURNAL);
  arreter();
  assert.equal(fen.nombre(), 0);
});

test("l'interface branche la reprise, le battement et le journal", () => {
  const app = lire("../src/App.tsx");
  assert.match(app, /ecranARouvrir\(/);
  assert.match(app, /page_reprise_demandee/);
  assert.match(app, /demarrerBattement\(/);
  assert.match(app, /journaliserErreurs\(/);
  assert.match(app, /noterEcran\(/);
  assert.match(lire("../src/components/Workspace.tsx"), /noterConversation\(/);
});
