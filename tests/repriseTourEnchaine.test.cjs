const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:reprise-tour — un tour de continuation enchaîné juste après un autre (rien
// entre les deux : pas de message, pas d'outil), puis coupé (« stream_retry ») :
// le texte final du tour précédent ne doit pas disparaître de l'écran
// (src/components/chat/stream.ts, applyEvent / dropLiveResponse).
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const s = require(path.resolve(__dirname, "../src/components/chat/stream.ts"));

function apres(etat, ...evenements) {
  return evenements.reduce((e, ev) => s.applyEvent(e, ev), etat);
}

function premierTour() {
  const depart = s.initialStateFromHistory([
    { role: "user", parts: [{ type: "text", text: "Corrige la barre de titre" }] },
  ]);
  return apres(
    depart,
    { type: "turn_started" },
    { type: "thinking_started" },
    { type: "thinking_chunk", delta: "je regarde" },
    { type: "thinking_finished" },
    { type: "text_started" },
    { type: "text_chunk", delta: "Texte final du tour 1" },
    { type: "text_finished" },
    { type: "turn_finished", duration_ms: 10 },
  );
}

const textes = (etat) => etat.blocks.filter((b) => b.kind === "assistant-text").map((b) => b.text);

test("tour enchaîné puis coupé avant toute sortie : le texte du tour précédent reste", () => {
  const fin1 = premierTour();
  assert.deepEqual(textes(fin1), ["Texte final du tour 1"]);
  const coupe = apres(fin1, { type: "turn_started" }, { type: "stream_retry" });
  assert.deepEqual(textes(coupe), ["Texte final du tour 1"], "le texte du tour 1 est encore à l'écran");
  assert.equal(coupe.status, "streaming");
  assert.equal(coupe.streamPhase, "waiting");
});

test("tour enchaîné, début de réponse puis coupure : seule la réponse coupée part", () => {
  const coupe = apres(
    premierTour(),
    { type: "turn_started" },
    { type: "thinking_chunk", delta: "suite" },
    { type: "text_started" },
    { type: "text_chunk", delta: "début coupé du tour 2" },
    { type: "stream_retry" },
  );
  assert.deepEqual(textes(coupe), ["Texte final du tour 1"]);
  assert.equal(coupe.blocks.filter((b) => b.kind === "thinking").length, 1, "la réflexion du tour 1 reste, celle du tour 2 part");
  const reprise = apres(coupe, { type: "text_started" }, { type: "text_chunk", delta: "réponse complète du tour 2" });
  assert.deepEqual(textes(reprise), ["Texte final du tour 1", "réponse complète du tour 2"]);
});

test("nouveau tour sans « turn_finished » du précédent : le texte précédent reste aussi", () => {
  const sansFin = apres(
    s.initialStateFromHistory([]),
    { type: "turn_started" },
    { type: "text_started" },
    { type: "text_chunk", delta: "Texte final du tour 1" },
  );
  const coupe = apres(sansFin, { type: "turn_started" }, { type: "stream_retry" });
  assert.deepEqual(textes(coupe), ["Texte final du tour 1"]);
});

test("envoi depuis l'interface (beginTurn) puis coupure : le texte précédent reste", () => {
  const fin1 = premierTour();
  const envoi = s.beginTurn(s.appendUserMessage(fin1, "ok continue", 2));
  const coupe = apres(envoi, { type: "turn_started" }, { type: "text_started" }, { type: "text_chunk", delta: "x" }, { type: "stream_retry" });
  assert.deepEqual(textes(coupe), ["Texte final du tour 1"]);
});
