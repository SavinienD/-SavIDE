"use strict";
// Lot palette (P2) — Ctrl+K « Aller à » : dossiers récents, conversations de tous les dossiers,
// sous-agents, onglets, terminaux, sections des Réglages, et recherche dans le contenu des
// conversations (extrait autour du mot).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const memoire = new Map();
global.localStorage = {
  getItem: (k) => (memoire.has(k) ? memoire.get(k) : null),
  setItem: (k, v) => memoire.set(k, String(v)),
  removeItem: (k) => memoire.delete(k),
};
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const S = require(path.join(racine, "src/components/palette/sourcesAller.ts"));
const IR = require(path.join(racine, "src/components/palette/indexReglages.ts"));
const R = require(path.join(racine, "src/axe/raccourcis.ts"));
const lire = (p) => fs.readFileSync(path.join(racine, p), "utf8");

const sources = () => [
  { genre: "dossier", id: "C:\\Clients\\cabinet-martin", titre: "cabinet-martin", detail: "C:\\Clients\\cabinet-martin", icone: "x", ordre: 0 },
  { genre: "dossier", id: "C:\\Clients\\atelier-durand", titre: "atelier-durand", detail: "C:\\Clients\\atelier-durand", icone: "x", ordre: 1 },
  { genre: "conversation", id: "c-1", titre: "Facture OVH d'octobre", detail: "cabinet-martin", icone: "x", ordre: 0 },
  { genre: "conversation", id: "c-2", titre: "Tri des tickets Zendesk", detail: "atelier-durand", icone: "x", ordre: 1 },
  { genre: "sousAgent", id: "sa-1", titre: "t-lotA", detail: "Tri des tickets Zendesk", icone: "x", ordre: 0 },
  { genre: "terminal", id: "terminal-1", titre: "Terminal 1", icone: "x", ordre: 0 },
  { genre: "reglage", id: "shortcuts", titre: "Raccourcis", icone: "x", ordre: 0 },
  { genre: "onglet", id: "c-2", titre: "Tri des tickets Zendesk", icone: "x", ordre: 0 },
];

test("requête vide : tout, par groupes dans un ordre fixe (onglets d'abord)", () => {
  const r = S.elementsAller("", sources());
  assert.equal(r[0].groupe, "Onglets ouverts");
  const groupes = [...new Set(r.map((e) => e.groupe))];
  assert.deepEqual(groupes, ["Onglets ouverts", "Conversations", "Dossiers récents", "Sous-agents", "Terminaux", "Réglages"]);
  assert.equal(new Set(r.map((e) => e.id)).size, r.length, "identifiants uniques");
});

test("requête : lettres dans l'ordre sans casse ni accents ; groupe le mieux trouvé d'abord", () => {
  const r = S.elementsAller("zendesk", sources());
  const ids = r.map((e) => e.id);
  assert.deepEqual([...ids].sort(), ["conversation:c-2", "onglet:c-2", "sousAgent:sa-1"]);
  assert.ok(ids.indexOf("sousAgent:sa-1") > ids.indexOf("conversation:c-2"), "trouvé dans le titre avant trouvé dans le détail");
  assert.ok(r.every((e) => e.id !== "dossier:C:\\Clients\\cabinet-martin"));
  const m = S.elementsAller("MARTIN", sources());
  assert.equal(m[0].id, "dossier:C:\\Clients\\cabinet-martin");
  assert.ok(m[0].marquesTitre.length > 0);
  // une conversation se trouve aussi par son dossier (moins bien que par son titre)
  assert.ok(m.some((e) => e.id === "conversation:c-1"));
  assert.equal(S.elementsAller("reglages raccourcis", [{ genre: "reglage", id: "shortcuts", titre: "Raccourcis", detail: "Réglages", icone: "x", ordre: 0 }]).length, 1);
});

test("extrait d'une conversation : mots surlignés sans casse ni accents (positions dans l'extrait)", () => {
  assert.deepEqual(S.marquesExtrait("… la facture de l'Été …", "ete"), [18, 19, 20]);
  assert.deepEqual(S.marquesExtrait("l’ordre", "l'ordre"), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(S.marquesExtrait("Zendesk puis zendesk", "ZENDESK"), [0, 1, 2, 3, 4, 5, 6, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(S.marquesExtrait("rien", "x"), []);
});

test("terminaux du dossier lus comme le panneau Terminal (titre perso, sinon « Terminal N »)", () => {
  const ws = "C:\\projet";
  memoire.set(`axecode:terminals:${ws}`, JSON.stringify([
    { index: 1, title: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", shell: "powershell" },
    { index: 2, title: "npm run dev", customTitle: "Serveur", shell: "bash" },
    { pas: "valide" },
  ]));
  assert.deepEqual(S.terminauxDuDossier(ws), [{ id: "terminal-1", titre: "Terminal 1" }, { id: "terminal-2", titre: "Serveur" }]);
  assert.deepEqual(S.terminauxDuDossier("C:\\vide"), []);
});

test("conversation à ouvrir : ici, sans dossier, ou dans son dossier", () => {
  assert.equal(S.ouOuvrir("C:\\projet", "c:/projet/", "C:\\data\\scratch"), "ici");
  assert.equal(S.ouOuvrir("C:\\data\\scratch", "C:\\projet", "C:\\data\\scratch"), "libre");
  assert.equal(S.ouOuvrir("\\\\?\\C:\\autre", "C:\\projet", "C:\\data\\scratch"), "dossier");
  assert.equal(S.ouOuvrir("C:\\autre", undefined, "C:\\data\\scratch"), "dossier");
});

test("sections des Réglages : toutes celles du volet, mêmes identifiants (data-section)", () => {
  const volet = lire("src/components/SettingsPane.tsx");
  const ids = [...volet.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10);
  // Édition locale : Service et Appareils sont masqués dans le volet, donc pas proposés.
  assert.deepEqual(IR.SECTIONS_MASQUEES.sort(), ["connections", "service"]);
  assert.deepEqual(IR.SECTIONS_REGLAGES.map((s) => s.id).sort(), [...new Set(ids)].filter((id) => !IR.SECTIONS_MASQUEES.includes(id)).sort());
  for (const s of IR.SECTIONS_REGLAGES) assert.ok(volet.includes(`>${s.titre}<`), `libellé « ${s.titre} » absent du volet`);
});

test("Ctrl+K déclaré (une seule action), laissé à l'éditeur et au terminal", () => {
  const r = R.RACCOURCIS.find((x) => x.id === "allerA");
  assert.ok(r, "raccourci allerA absent");
  assert.equal(R.combinaisonCourte("allerA", false), "Ctrl+K");
  assert.ok(r.horsEditeur, "Ctrl+K reste aux accords de l'éditeur (Ctrl+K Ctrl+C…)");
  const e = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: "k", code: "KeyK" };
  assert.deepEqual(R.RACCOURCIS.filter((x) => R.correspond(x, e, false)).map((x) => x.id), ["allerA"]);
});

test("branché : Ctrl+K dans l'espace (IDE et sans dossier) et sur l'accueil ; commandes Tauri", () => {
  const ws = lire("src/components/Workspace.tsx");
  assert.ok((ws.match(/<PaletteEspace\b/g) ?? []).length >= 2, "palette dans les deux dispositions");
  assert.match(lire("src/App.tsx"), /<PaletteAccueil\b/);
  const pa = lire("src/components/palette/PaletteAller.tsx");
  assert.match(pa, /palette_recherche_conversations|rechercherConversations/);
  const lib = lire("src-tauri/src/lib.rs");
  assert.match(lib, /recherche_conversations::palette_conversations/);
  assert.match(lib, /recherche_conversations::palette_recherche_conversations/);
});
