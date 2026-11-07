// API personnalisées de génération (images et vidéos) dans Réglages > REPL.
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
const A = charger("../src/lib/apisMedias.ts");

test("préréglages : vidéos OpenAI, fal (clé « Key »), Replicate (corps input), autre", () => {
  const sora = A.nouvelleApi("openai-videos", []);
  assert.equal(sora.kind, "video");
  assert.equal(sora.url, "https://api.openai.com/v1/videos");
  assert.ok(JSON.parse(sora.body).prompt === "{prompt}");
  const fal = A.nouvelleApi("fal", []);
  assert.equal(fal.authPrefix, "Key ");
  assert.match(fal.url, /\{model\}/);
  assert.deepEqual(JSON.parse(A.nouvelleApi("replicate", []).body), { input: { prompt: "{prompt}" } });
  const autre = A.nouvelleApi("inconnu", []);
  assert.equal(autre.url, "");
  for (const champ of ["authHeader", "apiKey", "pollUrl", "resultUrl", "resultPath"]) assert.equal(typeof autre[champ], "string");
});

test("noms uniques, tri par type, gabarit vérifié", () => {
  const un = A.nouvelleApi("fal", []);
  const deux = A.nouvelleApi("fal", [un]);
  assert.equal(deux.name, "fal-2");
  assert.equal(A.nomLibre("FAL", [un, deux]), "FAL-3");
  assert.deepEqual(A.apisDuType([un, A.nouvelleApi("openai-images", [])], "video").map((a) => a.name), ["fal"]);
  assert.equal(A.erreurGabarit(""), null);
  assert.equal(A.erreurGabarit('{"prompt": "{prompt}"}'), null);
  assert.equal(A.erreurGabarit("{prompt"), "JSON invalide.");
  assert.equal(A.erreurGabarit("[1]"), "Le corps doit être un objet JSON.");
});

test("l'écran propose l'API personnalisée pour les images et la vidéo par défaut", () => {
  const section = fs.readFileSync(path.resolve(__dirname, "../src/components/settings/ReplServicesSection.tsx"), "utf8");
  assert.ok(section.includes('data-fournisseur="custom"'), "bouton API personnalisée des images");
  assert.ok(section.includes("Vidéos (videos.generate)"), "choix de l'API vidéo");
  assert.ok(section.includes("PREREGLAGES_API.map"), "boutons d'ajout");
  assert.ok(section.includes("<ApiKeyField") && section.includes("Clé API (ou $VARIABLE)"), "clé masquée");
});
