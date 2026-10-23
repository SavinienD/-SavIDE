// axe:agents-ordre - ordre de la liste des agents : ceux qui travaillent en tête.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}

const { comparerAgents } = charger("../src/components/agents/agentOrder.ts");
const n = (id, status, t, children = []) => ({ id, meta: { status, updatedAtMs: t }, children });
const ordre = (liste) => liste.sort(comparerAgents).map((x) => x.id);

test("ceux qui travaillent passent en tête, même moins récents", () => {
  assert.deepEqual(ordre([n("fini", "inactive", 30), n("attend", "idle", 20), n("travaille", "running", 10)]), ["travaille", "attend", "fini"]);
});
test("un parent dont un sous-agent travaille remonte en tête", () => {
  assert.deepEqual(ordre([n("seul", "idle", 50), n("parent", "inactive", 1, [n("enfant", "running", 1)])]), ["parent", "seul"]);
});
test("à rang égal, le plus récent d'abord", () => {
  assert.deepEqual(ordre([n("a", "running", 1), n("b", "running", 9)]), ["b", "a"]);
});
test("les archivés passent après les terminés", () => {
  const archive = { id: "archive", meta: { status: "inactive", updatedAtMs: 99, archived: true }, children: [] };
  assert.deepEqual(ordre([archive, n("fini", "inactive", 1)]), ["fini", "archive"]);
});
