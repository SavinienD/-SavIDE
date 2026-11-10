const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Endless mode (/nonstop) on the phone: badge with a stop button, relaunch shown as a status line.
const racine = path.resolve(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");

function fonction(source, nom) {
  const debut = source.indexOf(`export function ${nom}(`);
  assert.ok(debut >= 0, nom);
  const fin = source.indexOf("\n}\n", debut);
  return new Function(`${source.slice(debut + "export ".length, fin + 2)}; return ${nom};`)();
}

test("phone: endless badge only while running, relaunch line from the history", () => {
  const app = lire("remote/public/app.js");
  const endlessLabel = fonction(app, "endlessLabel");
  const endlessRelaunch = fonction(app, "endlessRelaunch");
  assert.equal(endlessLabel({ status: "running", turns: 4 }), "Endless · 4");
  assert.equal(endlessLabel({ status: "running", turns: 0 }), "Endless");
  assert.equal(endlessLabel({ status: "stopped", turns: 4 }), null);
  assert.equal(endlessLabel(null), null);
  assert.equal(endlessRelaunch('<nonstop_continue at_ms="1" n="3">\nMode sans fin, continue : lot\n</nonstop_continue>'), "Endless mode: relaunch #3");
  assert.equal(endlessRelaunch("hello"), null);
  assert.match(app, /h\(EndlessBadge, \{ cmd, conversationId: conv\.id/);
  assert.match(app, /type: "endless_mode", conversation_id: conversationId, stop: true/);
});

test("phone: the PC serves endless_mode (state and stop)", () => {
  const pc = lire("src-tauri/src/remote.rs");
  assert.match(pc, /EndlessMode \{\s*conversation_id: String,/);
  assert.match(pc, /"op": "sans_fin_stop"/);
  assert.match(pc, /"sessions\.commands_state"/);
});
