"use strict";
// mémoire : les vues des conversations quittées ne s'empilent plus sans limite.
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
const V = require(path.resolve(__dirname, "../src/components/chat/vuesConversations.ts"));
const enCours = (v) => v.status === "streaming";

test("au plus VUES_GARDEES vues en plus de la conversation affichée, les plus anciennes partent", () => {
  const vues = new Map();
  for (let i = 1; i <= 10; i += 1) vues.set(`c-${i}`, { status: "idle" });
  V.toucherVue(vues, "c-2"); // c-2 revisitée : devenue récente
  const retirees = V.bornerVues(vues, "c-10", enCours);
  assert.equal(vues.size, V.VUES_GARDEES + 1);
  assert.ok(vues.has("c-10") && vues.has("c-2"));
  assert.deepEqual(retirees, ["c-1", "c-3", "c-4", "c-5", "c-6"]);
});

test("une conversation dont le tour tourne garde toujours sa vue", () => {
  const vues = new Map();
  vues.set("c-1", { status: "streaming" });
  for (let i = 2; i <= 9; i += 1) vues.set(`c-${i}`, { status: "idle" });
  V.bornerVues(vues, "c-9", enCours, 2);
  assert.deepEqual([...vues.keys()], ["c-1", "c-8", "c-9"]);
});

test("la colonne de conversation borne ses vues à chaque changement de conversation", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/components/chat/ChatPane.tsx"), "utf8");
  assert.match(src, /toucherVue\(conversationViewsRef\.current, conversationId\)/);
  assert.match(src, /bornerVues\(\s*conversationViewsRef\.current/);
});

test("fils chargés pour les colonnes : seuls ceux encore affichés restent en mémoire", () => {
  const m = { a: { id: "a" }, b: { id: "b" }, c: { id: "c" } };
  assert.equal(V.garderSeulement(m, ["a", "b", "c", "z"]), m, "rien à retirer : même objet (pas de rendu de plus)");
  assert.deepEqual(V.garderSeulement(m, ["b"]), { b: { id: "b" } });
});

test("l'espace ne garde plus le fil de chaque conversation ouverte dans la journée", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/components/Workspace.tsx"), "utf8");
  assert.match(src, /setConversationsColonnes\(\(m\) => garderSeulement\(m, garder\)\)/);
});
