"use strict";
// Erreurs du moteur affichées en français (src/lib/erreursMoteur.ts) ; le texte brut, comparé
// ailleurs (Workspace.tsx, cloudOnline.ts, agentsApi.ts, remoteItems.ts), n'est pas modifié.
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
const { erreurMoteurEnFrancais: fr } = require(path.resolve(__dirname, "../src/lib/erreursMoteur.ts"));
const NB = "\u00a0";

test("préfixes du moteur traduits, détail technique gardé", () => {
  assert.equal(fr("stream error: error decoding response body"), `Réponse interrompue${NB}: error decoding response body`);
  assert.equal(fr("retryable stream error: reset"), `Réponse interrompue (nouvel essai possible)${NB}: reset`);
  assert.equal(fr("rate limited: 429"), `Limite de débit atteinte${NB}: 429`);
  assert.equal(fr("Error: network error: dns"), `Erreur réseau${NB}: dns`);
});

test("messages gardés en anglais par le Rust (reconnus par le front) affichés en français", () => {
  assert.equal(fr("a turn is already running for this conversation"), "Un tour est déjà en cours pour cette conversation.");
  assert.equal(fr("Error: a turn is already running for this conversation"), "Un tour est déjà en cours pour cette conversation.");
  assert.equal(
    fr("runtime error: provider `kimi` is not configured or missing credentials"),
    `Erreur du moteur${NB}: Fournisseur «${NB}kimi${NB}» non configuré ou identifiants manquants.`,
  );
  assert.equal(fr("turn cancelled"), "Tour annulé.");
});

test("texte inconnu ou déjà en français : inchangé", () => {
  assert.equal(fr("le tour ne s'est pas arrêté à temps"), "le tour ne s'est pas arrêté à temps");
  assert.equal(fr("Error: boom"), "Error: boom");
  assert.equal(fr(""), "");
});
