"use strict";
// onglet Agents : compteurs justes (même source que le rond d'activité : sessions.list du
// service + événements, plus les tours envoyés par la fenêtre) et sous-agents terminés archivés.
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
const A = require(path.resolve(__dirname, "../src/components/agents/agentsStatut.ts"));
const ws = "\\\\?\\C:\\Users\\marc\\Documents\\projet";
const s = (id, status, parentId, extra = {}) => ({ id, status, parentId, workspaceId: ws, archived: false, ...extra });

test("même dossier malgré le préfixe \\\\?\\ et la casse", () => {
  assert.equal(A.dansLeDossier(s("a", "idle"), "c:/users/marc/documents/projet"), true);
  assert.equal(A.dansLeDossier(s("a", "idle", undefined, { workspaceId: "C:\\autre" }), "C:\\Users\\marc\\Documents\\projet"), false);
  assert.equal(A.dansLeDossier(s("a", "idle", undefined, { scratch: true, workspaceId: "x" }), "y"), true);
});

test("capture 0 · 0 · 13 : la conversation (tour de la fenêtre) et 2 sous-agents tournent → 3 en cours", () => {
  const sessions = [s("parent", "inactive"), s("sa1", "running", "parent"), s("sa2", "running", "parent"),
    ...Array.from({ length: 10 }, (_, i) => s(`fini${i}`, "inactive", "parent"))];
  const statut = A.statutsEffectifs(sessions, new Set(["parent"]), new Map());
  const c = A.compter(sessions.filter((x) => !A.archive(x, statut)), statut);
  assert.deepEqual(c, { running: 3, idle: 0, inactive: 0 });
});

test("un événement « status » du service compte avant la relecture de la liste", () => {
  const sessions = [s("parent", "idle")];
  const statut = A.statutsEffectifs(sessions, new Set(), new Map([["parent", ws]]));
  assert.equal(statut.get("parent"), "running");
});

test("sous-agents terminés archivés automatiquement (pas les conversations, pas ceux qui tournent)", () => {
  const statut = new Map([["sa", "idle"], ["sb", "running"], ["c", "inactive"]]);
  assert.equal(A.archive(s("sa", "idle", "p"), statut), true);
  assert.equal(A.archive(s("sb", "running", "p"), statut), false);
  assert.equal(A.archive(s("c", "inactive"), statut), false);
  assert.equal(A.archive(s("c", "inactive", undefined, { archived: true }), statut), true);
});
