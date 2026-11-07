"use strict";
// Dossiers locaux renommés ou déplacés : retrouvés et rouverts, chemin mis à jour partout.
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
  clear: () => memoire.clear(),
  key: (i) => [...memoire.keys()][i] ?? null,
  get length() { return memoire.size; },
};
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const Rec = require(path.resolve(__dirname, "../src/lib/recents.ts"));
const D = require(path.resolve(__dirname, "../src/lib/dossierDeplace.ts"));
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

const ANCIEN = "C:\\Users\\S\\Documents\\projet";
const NOUVEAU = "C:\\Users\\S\\Documents\\projet-2026";

test("récents : le chemin est remplacé sur place, sans doublon, Ctrl+n garde son numéro", () => {
  memoire.clear();
  Rec.recordRecent("/autre", "autre");
  Rec.recordRecent(ANCIEN, "projet");
  Rec.recordRecent("/dernier", "dernier");
  // L'utilisateur avait déjà ouvert le nouvel emplacement à la main : doublon à éviter.
  Rec.recordRecent(NOUVEAU, "projet-2026");
  Rec.recordRecent("/tout-dernier", "tout-dernier");
  const avant = Rec.loadRecents().findIndex((r) => r.path === ANCIEN);
  D.remplacerCheminRecent(ANCIEN, NOUVEAU, "projet-2026");
  const apres = Rec.loadRecents();
  assert.equal(apres.filter((r) => r.path === NOUVEAU).length, 1, "une seule entrée");
  assert.ok(!apres.some((r) => r.path === ANCIEN), "l'ancien chemin a disparu");
  assert.equal(apres.length, 4);
  assert.equal(Rec.dossierRecentNumero(avant).path, NOUVEAU, "même numéro Ctrl+n qu'avant");
  assert.equal(apres.find((r) => r.path === NOUVEAU).name, "projet-2026");
});

test("dernier dossier ouvert et réglages du dossier (onglets, colonnes, terminal) suivent le nouveau chemin", () => {
  memoire.clear();
  Rec.recordRecent(ANCIEN, "projet");
  localStorage.setItem(`axe:v2:onglets-chat:${ANCIEN}`, JSON.stringify({ ids: ["c1", "c2"] }));
  localStorage.setItem(`axe:v2:colonnes-chat:${ANCIEN}`, JSON.stringify({ ids: ["c1"] }));
  localStorage.setItem(`axe:v2:colonnes-chat-largeurs:${ANCIEN}`, "[1,2]");
  localStorage.setItem(`axecode:terminals:${ANCIEN}`, JSON.stringify([{ cwd: ANCIEN + "\\src" }]));
  localStorage.setItem(`axecode:terminal-buffer:${ANCIEN}:t1`, "dir");
  localStorage.setItem(`axe:v2:colonnes-chat:${ANCIEN}-bis`, "autre dossier");
  D.migrerStockageDossier(ANCIEN, NOUVEAU);
  assert.equal(localStorage.getItem("axecode.lastWorkspace"), NOUVEAU);
  assert.deepEqual(JSON.parse(localStorage.getItem(`axe:v2:onglets-chat:${NOUVEAU}`)), { ids: ["c1", "c2"] });
  assert.deepEqual(JSON.parse(localStorage.getItem(`axe:v2:colonnes-chat:${NOUVEAU}`)), { ids: ["c1"] });
  assert.equal(localStorage.getItem(`axe:v2:colonnes-chat-largeurs:${NOUVEAU}`), "[1,2]");
  assert.deepEqual(JSON.parse(localStorage.getItem(`axecode:terminals:${NOUVEAU}`)), [{ cwd: NOUVEAU + "\\src" }]);
  assert.equal(localStorage.getItem(`axecode:terminal-buffer:${NOUVEAU}:t1`), "dir");
  assert.equal(localStorage.getItem(`axe:v2:onglets-chat:${ANCIEN}`), null, "ancienne clé retirée");
  assert.equal(localStorage.getItem(`axe:v2:colonnes-chat:${ANCIEN}-bis`), "autre dossier", "un autre dossier n'est pas touché");
});

function deps(over) {
  const appels = [];
  const d = {
    appels,
    ouvrir: async (p) => { appels.push(["ouvrir", p]); if (p === ANCIEN) throw new Error(`unable to open workspace ${p}`); return { workspace: { path: p, name: "projet-2026" } }; },
    retrouver: async (p, racines) => { appels.push(["retrouver", p, racines]); return { statut: "retrouve", chemin: NOUVEAU }; },
    deplacer: async (a, n) => { appels.push(["deplacer", a, n]); return { path: n, name: "projet-2026" }; },
    ...over,
  };
  return d;
}

test("ouvrir un dossier renommé : retrouvé, chemin mis à jour partout, puis rouvert", async () => {
  memoire.clear();
  Rec.recordRecent("C:\\Users\\S\\Bureau\\x", "x");
  Rec.recordRecent(ANCIEN, "projet");
  const d = deps();
  const r = await D.ouvrirDossier(ANCIEN, d);
  assert.equal(r.kind, "ouvert");
  assert.equal(r.bootstrap.workspace.path, NOUVEAU);
  assert.equal(r.deplaceDe, ANCIEN);
  assert.deepEqual(d.appels.map((a) => a[0]), ["ouvrir", "retrouver", "deplacer", "ouvrir"]);
  assert.ok(d.appels[1][2].includes("C:\\Users\\S\\Bureau"), "racines des autres dossiers récents transmises");
  assert.ok(Rec.loadRecents().some((r) => r.path === NOUVEAU));
  assert.ok(!Rec.loadRecents().some((r) => r.path === ANCIEN));
});

test("dossier introuvable : pas d'exception, résultat « introuvable »", async () => {
  memoire.clear();
  Rec.recordRecent(ANCIEN, "projet");
  const r = await D.ouvrirDossier(ANCIEN, deps({ retrouver: async () => ({ statut: "introuvable" }) }));
  assert.equal(r.kind, "introuvable");
  assert.equal(r.chemin, ANCIEN);
  const r2 = await D.ouvrirDossier(ANCIEN, deps({ retrouver: async () => { throw new Error("boom"); } }));
  assert.equal(r2.kind, "introuvable", "une recherche en échec = carte, pas de plantage");
  assert.ok(Rec.loadRecents().some((r) => r.path === ANCIEN), "l'entrée reste tant que l'utilisateur ne la retire pas");
});

test("dossier présent mais illisible : l'erreur d'origine est rendue (pas de carte)", async () => {
  memoire.clear();
  const r = await D.ouvrirDossier(ANCIEN, deps({ retrouver: async () => ({ statut: "existe" }) }));
  assert.equal(r.kind, "erreur");
  assert.match(r.message, /unable to open workspace/);
});

test("nouvel emplacement choisi à la main : même mise à jour partout, puis ouverture", async () => {
  memoire.clear();
  Rec.recordRecent(ANCIEN, "projet");
  localStorage.setItem(`axe:v2:colonnes-chat:${ANCIEN}`, "x");
  const d = deps();
  const r = await D.deplacerEtOuvrir(ANCIEN, NOUVEAU, d);
  assert.equal(r.kind, "ouvert");
  assert.deepEqual(d.appels.map((a) => a[0]), ["deplacer", "ouvrir"]);
  assert.equal(localStorage.getItem(`axe:v2:colonnes-chat:${NOUVEAU}`), "x");
  assert.ok(!Rec.loadRecents().some((r) => r.path === ANCIEN));
});

test("App : ouverture par l'accueil, Ctrl+1…9 et la liste des conversations passe par ouvrirDossier ; carte « Dossier introuvable »", () => {
  const app = lire("../src/App.tsx");
  assert.match(app, /ouvrirDossier\(/);
  const carte = lire("../src/components/DossierIntrouvable.tsx");
  for (const t of ["Dossier introuvable", "Rechercher à nouveau", "Choisir le nouvel emplacement", "Retirer de la liste"]) {
    assert.ok(carte.includes(t), t);
  }
});
