const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:reprise — après une coupure du flux, le démon renvoie la requête et émet
// « stream_retry » : la réponse en cours repart de zéro à l'écran
// (src/components/chat/stream.ts, applyEvent).
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const s = require(path.resolve(__dirname, "../src/components/chat/stream.ts"));

function streaming(blocks) {
  return { blocks, status: "streaming", streamPhase: "responding", lastError: null, turnStartedAtMs: 1 };
}

test("stream_retry retire le texte et la réflexion affichés par la réponse coupée", () => {
  const avant = streaming([
    { kind: "assistant-text", id: "h-a-0", text: "réponse d'un tour précédent" },
    { kind: "tool", id: "call-1", name: "python", status: "done" },
    { kind: "thinking", id: "s-t-10", text: "je réfléchis", streaming: true, startedAtMs: 10 },
    { kind: "assistant-text", id: "s-a-11", text: "début de réponse coupée" },
  ]);
  const apres = s.applyEvent(avant, { type: "stream_retry" });
  assert.deepEqual(
    apres.blocks.map((b) => b.id),
    ["h-a-0", "call-1"],
    "seuls les blocs en direct de la réponse coupée partent",
  );
  assert.equal(apres.streamPhase, "waiting");
  assert.equal(apres.status, "streaming", "le tour continue");

  let suite = s.applyEvent(apres, { type: "text_started" });
  suite = s.applyEvent(suite, { type: "text_chunk", delta: "réponse complète" });
  const dernier = suite.blocks[suite.blocks.length - 1];
  assert.equal(dernier.kind, "assistant-text");
  assert.equal(dernier.text, "réponse complète", "la 2e réponse s'affiche seule");
  assert.equal(suite.blocks.length, 3);
});

test("stream_retry sans rien d'affiché ne change pas les blocs", () => {
  const blocs = [{ kind: "tool", id: "call-1", name: "python", status: "done" }];
  const etat = streaming(blocs);
  assert.equal(s.applyEvent(etat, { type: "stream_retry" }).blocks, blocs);
});
