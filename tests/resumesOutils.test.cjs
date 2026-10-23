"use strict";
// Résumés d'outils envoyés par le moteur (anglais, y compris depuis un espace en 0.1.56) :
// traduits à la réception (src/components/chat/resumesOutils.ts, appelé par stream.ts sur « tool_ready »).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const { resumeOutilEnFrancais: fr } = require(path.resolve(__dirname, "../src/components/chat/resumesOutils.ts"));
const s = require(path.resolve(__dirname, "../src/components/chat/stream.ts"));
const NB = "\u00a0";

test("les résumés connus du moteur passent en français", () => {
  assert.equal(fr("grep", "Grep in workspace"), "Grep dans l'espace de travail");
  assert.equal(fr("glob", "Glob **/*.ts in src"), "Glob **/*.ts dans src");
  assert.equal(fr("edit_file", "Edit src/a.ts · 3 replacements"), "Modifier src/a.ts · 3 remplacements");
  assert.equal(fr("edit_file", "Edit files · 2 files · 5 replacements"), "Modifier des fichiers · 2 fichiers · 5 remplacements");
  assert.equal(fr("subagent_general", "Sub-agent · Corriger le banc"), "Sous-agent · Corriger le banc");
  assert.equal(fr("skill", "Load skill · pdf"), "Skill · pdf");
  assert.equal(fr("WebSearch", "Search web: météo Paris"), `Recherche web${NB}: météo Paris`);
  assert.equal(fr("task_update", "Task · #4 · completed"), "Tâche · #4 · terminée");
  assert.equal(fr("task_list", "Task · update · #4"), "Tâche · mise à jour · #4");
  assert.equal(fr("bash_input", "Poll PowerShell session 2"), "Lire la session PowerShell 2");
  assert.equal(fr("context_compaction", "Compact context"), "Compacter le contexte");
});

test("le texte libre et les outils inconnus ne sont pas touchés", () => {
  assert.equal(fr("bash", "npm test"), "npm test", "description bash écrite par le modèle");
  assert.equal(fr("mcp__github__search", "GitHub · search"), "GitHub · search");
  assert.equal(fr("read", ""), "");
  assert.equal(fr("grep", "Grep dans src"), "Grep dans src", "déjà en français");
});

test("tool_ready : résumé traduit, nom du sous-agent reconnu (Sub-agent ou Sous-agent)", () => {
  let etat = { blocks: [], status: "streaming", streamPhase: "tooling", lastError: null, turnStartedAtMs: 1 };
  etat = s.applyEvent(etat, { type: "tool_started", id: "t1", name: "subagent_general" });
  etat = s.applyEvent(etat, { type: "tool_ready", id: "t1", summary: "Sub-agent · Audit", args_pretty: "{}" });
  const bloc = etat.blocks.find((b) => b.id === "t1");
  assert.equal(bloc.summary, "Sous-agent · Audit");
  assert.equal(bloc.subAgent.name, "Audit");
});
