// rond « agent en cours » sur la liste et les onglets, même source que l'accueil.
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
const { toursDeLEspace } = charger("../src/lib/toursActifs.ts");
const WS = "C:\\Users\\utilisateur\\Documents\\Projets\\savide";
test("chemin sous une autre forme (\\\\?\\, casse, barre finale) : le tour compte", () => {
  const t = [{ workspaceId: "\\\\?\\c:\\users\\utilisateur\\documents\\projets\\savide\\", conversationId: "c-9" }];
  assert.equal(toursDeLEspace(t, WS).length, 1);
});
test("conversation affichée : compte même si l'espace diffère ; autre espace sinon ignoré", () => {
  const t = [{ workspaceId: "/srv/cloud/saas", conversationId: "c-1" }, { workspaceId: "D:\\autre", conversationId: "x" }];
  assert.deepEqual(toursDeLEspace(t, WS, ["c-1"]).map((x) => x.conversationId), ["c-1"]);
  assert.equal(toursDeLEspace(t, "", []).length, 0);
});
test("branchements : Workspace filtre par toursDeLEspace, onglets reçoivent enCours", () => {
  const w = fs.readFileSync(path.resolve(__dirname, "../src/components/Workspace.tsx"), "utf8");
  assert.match(w, /toursDeLEspace\(\s*activeTurns/);
  assert.doesNotMatch(w, /turn\.workspaceId === workspacePathRef\.current/);
  assert.match(w, /enCours=\{streamingConversationIds\}/);
  const o = fs.readFileSync(path.resolve(__dirname, "../src/components/onglets/OngletsChat.tsx"), "utf8");
  assert.match(o, /onglets-chat__spinner/);
});
