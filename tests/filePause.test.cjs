const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
test("file en pause apres Stop : bouton Reprendre la file, queue.resume, etat du service", () => {
  const f = fs.readFileSync(path.join(__dirname, "../src/components/chat/fileDemon.ts"), "utf8");
  const c = fs.readFileSync(path.join(__dirname, "../src/components/chat/ChatPane.tsx"), "utf8");
  const r = fs.readFileSync(path.join(__dirname, "../crates/axecode-daemon/src/server.rs"), "utf8");
  assert.ok(f.includes('"queue.resume"') && f.includes('"queue.state"') && f.includes("p.data?.paused"));
  assert.ok(c.includes("Reprendre la file") && c.includes("fileEnPause(conversationId)"));
  assert.ok(r.includes("queue_rpc::pause_after_stop(self, &id)"));
});
