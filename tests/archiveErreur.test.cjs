const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const src = fs.readFileSync(path.join(__dirname, "../src/components/chat/archiveErreur.ts"), "utf8");
const m = { exports: {} };
new Function("module", "exports", ts.transpileModule(src, { compilerOptions: { module: 1 } }).outputText)(m, m.exports);
const { messageArchiveEchec } = m.exports;
test("archivage : message en francais, jamais vide", () => {
  assert.match(messageArchiveEchec(new Error("session not found: abc")), /ne trouve pas/);
  assert.match(messageArchiveEchec(new Error("network error")), /ne répond pas/);
  assert.match(messageArchiveEchec(null), /^Archivage impossible/);
});
test("Workspace n'avale plus l'echec ni le cas conversation en cours", () => {
  const w = fs.readFileSync(path.join(__dirname, "../src/components/Workspace.tsx"), "utf8");
  assert.ok(w.includes("avisArchiveRef.current(messageArchiveEchec(err))"));
  assert.ok(w.includes("la conversation travaille encore"));
});
