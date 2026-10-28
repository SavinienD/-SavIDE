const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const w = fs.readFileSync(path.join(__dirname, "../src/components/Workspace.tsx"), "utf8");
test("reveil / reconnexion : liste et conversation ouverte relues", () => {
  const i = w.indexOf("axe:reprise-reveil");
  assert.ok(i > 0);
  const bloc = w.slice(i, i + 2000);
  for (const r of ["visibilitychange", "online", "axe://daemon", "api.listConversations(workspacePath)", "api.loadConversation(workspacePath, id)"]) assert.ok(bloc.includes(r), r);
});
