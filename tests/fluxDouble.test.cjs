const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:flux-unique — scène : le même flux relayé par deux clients démon (démon local +
// connexion distante, ou deux connexions vers la même VM) donnait le texte en double,
// entremêlé. Le filtre est côté Rust (daemon_client::accept_stream_source) ; cette scène
// montre le motif produit par applyEvent et le rendu attendu avec une seule source.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const s = require(path.resolve(__dirname, "../src/components/chat/stream.ts"));

function rejouer(deltas) {
  let st = { blocks: [], status: "streaming", streamPhase: "waiting", lastError: null, turnStartedAtMs: 1 };
  st = s.applyEvent(st, { type: "text_started" });
  for (const d of deltas) st = s.applyEvent(st, { type: "text_chunk", delta: d });
  st = s.applyEvent(st, { type: "text_finished" });
  return st.blocks.filter((b) => b.kind === "assistant-text").map((b) => b.text).join("");
}

test("flux doublé et décalé : motif de la capture (« Ça corÇa corrige »)", () => {
  const d = ["Ça cor", "rige", " les fautes."];
  assert.match(rejouer([d[0], d[0], d[1], d[2], d[1], d[2]]), /^Ça corÇa corrige/);
});

test("une seule source : texte exact", () => {
  assert.equal(rejouer(["Ça cor", "rige", " les fautes."]), "Ça corrige les fautes.");
});
