// axe:0.1.71 — sessions « … — arrière-plan » hors de la liste Conversations.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = new Module(p, module); m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p)); m._compile(js, p); return m.exports;
}
const A = charger("../src/components/chat/arrierePlan.ts");
test("clone d'arrière-plan et sous-agent : pas dans la liste, clone rattaché à la conversation d'origine", () => {
  const l = A.resumesConversations([
    { id: "c1", name: "Saas Sav", updatedAtMs: 10 },
    { id: "bg", name: "Saas Sav — arrière-plan", parentId: "c1", status: "running", updatedAtMs: 20 },
    { id: "sa", name: "t-171", parentId: "c1", status: "idle", updatedAtMs: 30 },
    { id: "c2", name: "Autre", updatedAtMs: 5 },
    { id: "old", name: "X — arrière-plan", parentId: "c2", archived: true },
  ]);
  assert.deepEqual(l.map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(l[0].arrierePlan, [{ id: "bg", title: "Saas Sav — arrière-plan", enCours: true }]);
  assert.equal(l[1].arrierePlan, undefined);
});
test("la liste de l'espace passe par resumesConversations ; indicateur cliquable", () => {
  const ipc = fs.readFileSync(path.resolve(__dirname, "../src/lib/ipc.ts"), "utf8");
  assert.match(ipc, /return resumesConversations\(sessions\);/);
  const liste = fs.readFileSync(path.resolve(__dirname, "../src/components/ConversationList.tsx"), "utf8");
  assert.match(liste, /className="conv-row__bg"/);
});
