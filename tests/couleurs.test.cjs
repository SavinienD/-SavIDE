const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:couleurs — découpe des messages : commande slash en tête (accent), skills (violet).
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const { decouperJetons, classeJeton } = require(path.join(racine, "src/components/chat/jetonsMessage.ts"));
const CMD = ["goal", "heartbeat", "autonomous", "compact"];

const resume = (segs) => segs.map((s) => `${s.genre}:${s.texte}`);
const recolle = (segs) => segs.map((s) => s.texte).join("");

test("commande en tête et skill dans la suite", () => {
  const t = "/heartbeat 5s coucou puis /revue-code";
  const s = decouperJetons(t, CMD, ["revue-code"]);
  assert.deepEqual(resume(s), ["commande:/heartbeat", "texte: 5s coucou puis ", "skill:/revue-code"]);
  assert.equal(recolle(s), t);
});

test("commande seule, en majuscules, ou précédée d'espaces", () => {
  assert.deepEqual(resume(decouperJetons("/goal", CMD)), ["commande:/goal"]);
  assert.deepEqual(resume(decouperJetons("  /Goal finir", CMD)), ["texte:  ", "commande:/Goal", "texte: finir"]);
});

test("pas de commande ailleurs qu'en tête, ni pour un nom inconnu ou collé", () => {
  assert.deepEqual(resume(decouperJetons("voir /goal", CMD)), ["texte:voir /goal"]);
  assert.deepEqual(resume(decouperJetons("/inconnu x", CMD)), ["texte:/inconnu x"]);
  assert.deepEqual(resume(decouperJetons("/goals x", CMD)), ["texte:/goals x"]);
  assert.deepEqual(resume(decouperJetons("/goal/x", CMD)), ["texte:/goal/x"]);
});

test("skills : début de mot et fin de jeton, pas dans un chemin", () => {
  const s = decouperJetons("lance /revue-code, puis src/revue-code et /revue-codex", CMD, ["revue-code"]);
  assert.deepEqual(resume(s), ["texte:lance ", "skill:/revue-code", "texte:, puis src/revue-code et /revue-codex"]);
});

test("skill en tête : couleur de skill ; commande homonyme : la commande l'emporte", () => {
  assert.deepEqual(resume(decouperJetons("/revue-code ici", CMD, ["revue-code"])), ["skill:/revue-code", "texte: ici"]);
  assert.deepEqual(resume(decouperJetons("/goal x", CMD, ["goal"])), ["commande:/goal", "texte: x"]);
});

test("fichiers mentionnés et texte vide", () => {
  const s = decouperJetons("lis @src/a.ts.", CMD, [], ["src/a.ts"]);
  assert.deepEqual(resume(s), ["texte:lis ", "fichier:@src/a.ts", "texte:."]);
  assert.deepEqual(decouperJetons("", CMD), []);
  assert.equal(classeJeton("commande"), "jeton-commande");
  assert.equal(classeJeton("skill"), "jeton-skill");
  assert.equal(classeJeton("texte"), null);
});

test("couleurs : accent pour les commandes, violet pour les skills (styles.css)", () => {
  const css = fs.readFileSync(path.join(racine, "src/styles.css"), "utf8");
  assert.match(css, /\.jeton-commande \{ color: var\(--accent\); \}/);
  assert.match(css, /\.jeton-skill \{ color: var\(--skill, #a78bfa\); \}/);
  const pane = fs.readFileSync(path.join(racine, "src/components/chat/ChatPane.tsx"), "utf8");
  assert.ok(pane.includes("<TexteUtilisateur text={block.text}"), "bulle utilisateur colorée");
  assert.ok(pane.includes("<SkillsActifsContext.Provider value={enabledSkillNames}>"), "skills fournis aux bulles");
});
