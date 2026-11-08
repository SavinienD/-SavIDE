"use strict";
// Sauvegarde automatique (désactivée / après 1 s / en quittant
// l'onglet), retour à la ligne et minimap réglables, enregistrement qui ne perd pas la frappe.
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
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
const R = require(path.join(racine, "src/components/editeur/reglagesEditeur.ts"));
const { PlanificateurSauvegarde } = require(path.join(racine, "src/components/editeur/sauvegardeAuto.ts"));
const O = require(path.join(racine, "src/components/editeur/onglets.ts"));

/** Minuterie manuelle : avancer(ms) déclenche ce qui arrive à échéance. */
function fausseMinuterie() {
  let maintenant = 0;
  let suivant = 1;
  const taches = new Map();
  return {
    poser: (f, ms) => { const id = suivant++; taches.set(id, { f, t: maintenant + ms }); return id; },
    annuler: (id) => taches.delete(id),
    avancer(ms) {
      maintenant += ms;
      for (const [id, t] of [...taches]) if (t.t <= maintenant) { taches.delete(id); t.f(); }
    },
    nombre: () => taches.size,
  };
}
const attendre = () => new Promise((r) => setImmediate(r));

test("réglages : défaut = comme avant (pas de sauvegarde auto, pas de retour à la ligne, pas de minimap)", () => {
  memoire.clear();
  R.rechargerReglagesEditeur();
  assert.deepEqual(R.lireReglagesEditeur(), { sauvegardeAuto: "desactivee", retourLigne: false, minimap: false });
  assert.deepEqual(R.optionsMonaco(R.lireReglagesEditeur()), { wordWrap: "off", minimap: { enabled: false } });
});

test("réglages : enregistrés sur le poste, valeurs inconnues ignorées, abonnés prévenus", () => {
  memoire.clear();
  R.rechargerReglagesEditeur();
  const vus = [];
  const retirer = R.ecouterReglagesEditeur((r) => vus.push(r.sauvegardeAuto));
  R.changerReglagesEditeur({ sauvegardeAuto: "delai", retourLigne: true });
  assert.deepEqual(JSON.parse(memoire.get(R.CLE_REGLAGES_EDITEUR)), { sauvegardeAuto: "delai", retourLigne: true, minimap: false });
  assert.deepEqual(R.optionsMonaco(R.lireReglagesEditeur()), { wordWrap: "on", minimap: { enabled: false } });
  assert.deepEqual(vus, ["delai"]);
  retirer();
  memoire.set(R.CLE_REGLAGES_EDITEUR, JSON.stringify({ sauvegardeAuto: "toujours", minimap: true, retourLigne: "oui" }));
  R.rechargerReglagesEditeur();
  assert.deepEqual(R.lireReglagesEditeur(), { sauvegardeAuto: "desactivee", retourLigne: false, minimap: true });
  memoire.set(R.CLE_REGLAGES_EDITEUR, "{abîmé");
  R.rechargerReglagesEditeur();
  assert.equal(R.lireReglagesEditeur().sauvegardeAuto, "desactivee");
  assert.deepEqual(vus, ["delai"], "abonnement retiré");
});

test("après 1 s : enregistré 1 s après la DERNIÈRE frappe, et tout de suite en quittant l'onglet", async () => {
  const m = fausseMinuterie();
  const sauves = [];
  const p = new PlanificateurSauvegarde(() => "delai", (c) => { sauves.push(c); }, m);
  p.modifie("a.md");
  m.avancer(600);
  p.modifie("a.md");
  m.avancer(600);
  assert.deepEqual(sauves, [], "la frappe repousse l'enregistrement");
  m.avancer(400);
  await attendre();
  assert.deepEqual(sauves, ["a.md"]);
  p.modifie("b.ts");
  p.quitte("b.ts");
  await attendre();
  assert.deepEqual(sauves, ["a.md", "b.ts"]);
  assert.equal(m.nombre(), 0, "plus rien en attente");
});

test("en quittant l'onglet : pas d'enregistrement pendant la frappe ; désactivée : jamais", async () => {
  const m = fausseMinuterie();
  const sauves = [];
  let mode = "quitter";
  const p = new PlanificateurSauvegarde(() => mode, (c) => { sauves.push(c); }, m);
  p.modifie("a.md");
  m.avancer(5000);
  await attendre();
  assert.deepEqual(sauves, []);
  p.quitte("a.md");
  await attendre();
  assert.deepEqual(sauves, ["a.md"]);
  mode = "desactivee";
  p.modifie("a.md");
  p.quitte("a.md");
  m.avancer(5000);
  await attendre();
  assert.deepEqual(sauves, ["a.md"]);
});

test("une écriture à la fois par fichier : une demande pendant l'écriture est rejouée une fois après", async () => {
  const sauves = [];
  let finir;
  const p = new PlanificateurSauvegarde(() => "quitter", (c) => {
    sauves.push(c);
    if (sauves.length === 1) return new Promise((r) => { finir = r; });
  }, fausseMinuterie());
  const premiere = p.maintenant("a.md");
  p.quitte("a.md");
  p.quitte("a.md");
  await attendre();
  assert.equal(sauves.length, 1, "pas deux écritures en même temps");
  finir();
  await premiere;
  await attendre();
  assert.deepEqual(sauves, ["a.md", "a.md"]);
});

test("vider : les enregistrements différés partent tout de suite (colonne fermée)", async () => {
  const m = fausseMinuterie();
  const sauves = [];
  const p = new PlanificateurSauvegarde(() => "delai", (c) => { sauves.push(c); }, m);
  p.modifie("a.md");
  p.modifie("b.md");
  assert.equal(p.enAttente(), 2);
  p.vider();
  await attendre();
  assert.deepEqual(sauves.sort(), ["a.md", "b.md"]);
  assert.equal(m.nombre(), 0);
});

test("enregistrement appliqué par chemin, la frappe pendant l'écriture est gardée", () => {
  const doc = (content) => ({ content, name: "x" });
  const onglets = [
    { relativePath: "a.md", buffer: "A2", dirty: true, doc: doc("A1") },
    { relativePath: "b.md", buffer: "B2", dirty: true, doc: doc("B1") },
  ];
  const fini = O.appliquerEnregistrement(onglets, "b.md", "B2", doc("B2"));
  assert.equal(fini[0], onglets[0], "l'autre onglet n'est pas touché");
  assert.deepEqual(fini[1], { relativePath: "b.md", buffer: "B2", dirty: false, doc: doc("B2") });
  const pendant = O.appliquerEnregistrement(onglets, "a.md", "A1bis", doc("A1bis"));
  assert.equal(pendant[0].buffer, "A2", "frappe gardée");
  assert.equal(pendant[0].dirty, true, "reste à enregistrer");
  assert.equal(pendant[0].doc.content, "A1bis");
  assert.equal(O.appliquerEnregistrement(onglets, "c.md", "", doc("")), onglets, "onglet fermé entre-temps");
});

test("fermeture d'un onglet modifié : enregistré d'abord si la sauvegarde automatique est active", () => {
  assert.equal(O.doitSauverAvantFermeture("delai", { dirty: true }), true);
  assert.equal(O.doitSauverAvantFermeture("quitter", { dirty: true }), true);
  assert.equal(O.doitSauverAvantFermeture("desactivee", { dirty: true }), false);
  assert.equal(O.doitSauverAvantFermeture("delai", { dirty: false }), false);
  assert.equal(O.doitSauverAvantFermeture("delai", { dirty: true, external: true }), false);
  assert.equal(O.doitSauverAvantFermeture("delai", undefined), false);
});

test("branchements : Workspace (enregistrement, fermeture), EditorPane (options, planificateur), Réglages > Éditeur", () => {
  const ws = lire("src/components/Workspace.tsx");
  assert.match(ws, /appliquerEnregistrement\(prev, tab\.relativePath, tab\.buffer, updated\)/);
  assert.match(ws, /sauverAvantFermeture\(workspacePathRef\.current, tabsRef\.current\[index\]\)/);
  const ed = lire("src/components/EditorPane.tsx");
  assert.match(ed, /\.\.\.optionsMonaco\(reglagesEditeur\)/);
  assert.doesNotMatch(ed, /minimap: \{ enabled: false \}/);
  assert.doesNotMatch(ed, /wordWrap: "off"/);
  assert.match(ed, /new PlanificateurSauvegarde\(/);
  assert.match(ed, /onDidBlurEditorWidget/);
  const reglages = lire("src/components/SettingsPane.tsx");
  assert.match(reglages, /data-section="editor"/);
  assert.match(reglages, /<ReglagesEditeurSection \/>/);
});
