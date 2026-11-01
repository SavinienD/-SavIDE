// fournisseurs-178 — Réglages > Fournisseurs configurables : l'IDENTIFIANT (nom exact envoyé
// au fournisseur) est modifiable et validé ; le nom affiché est optionnel (vide = identifiant).
// Bug signalé : le nom d'un nouveau modèle Ollama tapé dans la ligne de qwen3:4b ne changeait
// que le libellé, l'appli appelait toujours qwen3:4b.
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
const M = charger("../src/axe/modelesFournisseur.ts");
const modele = (id, label = "") => ({ id, label, contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true, supportsReasoning: false, supportsVision: false });

test("renommer la ligne qwen3:4b change l'identifiant envoyé, pas seulement le libellé", () => {
  const avant = [modele("qwen3:4b"), modele("llama3.1:8b", "Llama")];
  const apres = M.renommerModele(avant, 0, "qwen3:8b");
  assert.equal(apres[0].id, "qwen3:8b");
  assert.equal(apres[0].label, "", "nom affiché vide = identifiant");
  assert.equal(apres[0].contextWindow, 32768, "les réglages de la ligne sont gardés");
  assert.deepEqual(apres[1], avant[1]);
  assert.equal(avant[0].id, "qwen3:4b", "pas de mutation");
});

test("un nom affiché égal à l'ancien identifiant suit le nouvel identifiant ; un vrai nom reste", () => {
  assert.equal(M.renommerModele([modele("qwen3:4b", "qwen3:4b")], 0, "qwen3:8b")[0].label, "");
  assert.equal(M.renommerModele([modele("qwen3:4b", "Mon Qwen")], 0, "qwen3:8b")[0].label, "Mon Qwen");
});

test("validation : identifiant vide ou en double signalé sur chaque ligne concernée", () => {
  assert.deepEqual(M.erreursIdentifiants([modele("a"), modele("b")]), {});
  const vide = M.erreursIdentifiants([modele("a"), modele("  ")]);
  assert.deepEqual(Object.keys(vide), ["1"]);
  assert.match(vide[1], /obligatoire/);
  const double = M.erreursIdentifiants([modele("qwen3:4b"), modele("x"), modele(" qwen3:4b ")]);
  assert.deepEqual(Object.keys(double).sort(), ["0", "2"]);
  assert.match(double[2], /double/);
  assert.equal(M.modelesInvalides([{ models: [modele("a")] }, { models: [modele("")] }]), true);
  assert.equal(M.modelesInvalides([{ models: [modele("a")] }, { models: [] }]), false);
});

test("« Saisir » demande l'identifiant exact : vide ou déjà présent refusé", () => {
  const liste = [modele("qwen3:4b")];
  assert.match(M.erreurNouvelIdentifiant(liste, "   "), /obligatoire/);
  assert.match(M.erreurNouvelIdentifiant(liste, " qwen3:4b"), /double/);
  assert.equal(M.erreurNouvelIdentifiant(liste, "qwen3:8b"), null);
});

test("« Découvrir » remplit les identifiants réels et garde les réglages des modèles connus", () => {
  const existants = [modele("qwen3:4b", "Petit Qwen"), modele("a-la-main")];
  existants[0].contextWindow = 16384;
  const trouves = [modele("llama3.1:8b"), modele("qwen3:4b")];
  const fusion = M.fusionnerDecouverte(existants, trouves);
  assert.deepEqual(fusion.map((m) => m.id), ["llama3.1:8b", "qwen3:4b", "a-la-main"]);
  assert.equal(fusion[1].label, "Petit Qwen");
  assert.equal(fusion[1].contextWindow, 16384);
});

test("la surcharge « Imposé » suit le modèle renommé, sans écraser une autre", () => {
  const s = { "ollama:qwen3:4b": { contextWindow: 8192 }, "ollama:x": { contextWindow: 4096 } };
  assert.deepEqual(M.deplacerSurcharge(s, "ollama", "qwen3:4b", "qwen3:8b"), { "ollama:qwen3:8b": { contextWindow: 8192 }, "ollama:x": { contextWindow: 4096 } });
  assert.equal(M.deplacerSurcharge(s, "ollama", "qwen3:4b", "x"), s);
  assert.equal(M.deplacerSurcharge(s, "", "qwen3:4b", "y"), s);
});

test("enregistrement : identifiants et noms sans espaces autour", () => {
  assert.deepEqual(M.identifiantsNettoyes([modele(" qwen3:8b ", " Q ")]).map((m) => [m.id, m.label]), [["qwen3:8b", "Q"]]);
});

test("le tableau du panneau : colonne Identifiant modifiable, plus de window.prompt", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/axe/CustomProvidersPanel.tsx"), "utf8");
  assert.match(src, />Identifiant</);
  assert.match(src, />Nom affiché</);
  assert.match(src, /data-champ="id"[\s\S]{0,900}onChange=\{\(e\) => renommer\(d, i, e\.target\.value\)\}/);
  assert.doesNotMatch(src, /window\.prompt/);
  assert.doesNotMatch(src, /<tr key=\{m\.id\}/, "clé de ligne stable pendant la frappe");
});
