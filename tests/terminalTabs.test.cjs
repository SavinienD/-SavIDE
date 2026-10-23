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
const T = charger("../src/components/terminalTabs.ts");

test("titre = chemin de l'executable ignore", () => {
  assert.equal(T.isExecutablePathTitle("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), true);
  assert.equal(T.isExecutablePathTitle("C:/Windows/System32/cmd.exe"), true);
  assert.equal(T.isExecutablePathTitle("pwsh.exe"), true);
  assert.equal(T.isExecutablePathTitle("/usr/bin/bash"), true);
  assert.equal(T.isExecutablePathTitle("vim README.md"), false);
  assert.equal(T.isExecutablePathTitle("agent@vm: ~/projets"), false);
});

test("l'onglet actif n'est jamais orphelin, Git reste a part", () => {
  assert.equal(T.resolveActiveTab("terminal-1", ["terminal-1"]), "terminal-1");
  assert.equal(T.resolveActiveTab("terminal-9", ["terminal-1", "terminal-2"]), "terminal-1");
  assert.equal(T.resolveActiveTab(T.GIT_TAB_ID, ["terminal-1"]), T.GIT_TAB_ID);
  assert.equal(T.resolveActiveTab("x", []), T.GIT_TAB_ID);
});

test("Ctrl+Tab passe par Git et les terminaux", () => {
  const ids = ["terminal-1", "terminal-2"];
  assert.equal(T.cycleTab("terminal-1", ids, 1), "terminal-2");
  assert.equal(T.cycleTab("terminal-2", ids, 1), T.GIT_TAB_ID);
  assert.equal(T.cycleTab(T.GIT_TAB_ID, ids, 1), "terminal-1");
  assert.equal(T.cycleTab(T.GIT_TAB_ID, ids, -1), "terminal-2");
});
