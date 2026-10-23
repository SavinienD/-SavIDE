// axe:parcours-collegue (D11) — /tree d'une conversation d'espace : le journal est lu sur l'espace.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("les deux volets /tree de Workspace lisent l'arbre sur la connexion de l'espace", () => {
  const ws = lire("../src/components/Workspace.tsx");
  const usages = ws.split("\n").filter((l) => l.includes("<SessionTree sessionId={treeSessionId}"));
  assert.equal(usages.length, 2);
  for (const u of usages) assert.match(u, /connectionId=\{cloudConnection \?\? undefined/);
  assert.match(ws, /const cloudConnection = cloudConnectionFromPath\(workspacePath\);/);
});

test("hors espace (connectionId absent) : l'arbre reste lu sur le démon du PC", () => {
  assert.match(lire("../src/components/agents/SessionTree.tsx"), /connectionId = "local"/);
  assert.match(
    lire("../src/components/agents/agentsApi.ts"),
    /tree: \(sessionId: string, connection\?: string\) => call<JournalTree>\("sessions\.tree", \{ sessionId \}, connection\)/,
  );
});
