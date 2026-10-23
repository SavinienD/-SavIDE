// axe:parcours-collegue (D5) — à l'ouverture d'un espace Axe Cloud, la liste est celle de l'espace.
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
const { ouvertureEspace } = charger("../src/lib/ouvertureEspace.ts");

// Ce que renvoie open_cloud_workspace chez un collègue : le magasin du PC ne connaît que le
// brouillon créé à sa première ouverture (modèle par défaut du PC).
const MODELE_PC = { provider: "google", name: "gemini-3.8-flash" };
const brouillon = {
  id: "brouillon-pc", workspaceId: "axe-cloud://axe-cloud/home/collegue/work", title: "Nouvelle conversation",
  model: MODELE_PC, modeModelSettings: { act: MODELE_PC, plan: MODELE_PC, goal: MODELE_PC }, systemPrompt: "",
  planWorkflow: { status: "idle" }, goalWorkflow: { status: "idle" }, history: [],
};
const bootstrap = () => ({
  workspace: { path: brouillon.workspaceId, name: "work" },
  conversations: [{ id: "brouillon-pc", title: "Nouvelle conversation", updatedAtMs: 5 }],
  activeConversation: brouillon,
  modeModelSettings: brouillon.modeModelSettings,
});
const TEST = { id: "8b198dda-26f1-4b30-8062-0e4beb705686", title: "test", updatedAtMs: 9 };

test("réouverture de l'espace d'un collègue : « test » (créée sur la VM) est listée, le brouillon du PC reste en tête", async () => {
  const b = await ouvertureEspace(bootstrap(), async () => [TEST]);
  assert.deepEqual(b.conversations.map((c) => c.title), ["Nouvelle conversation", "test"]);
  assert.equal(b.activeConversation.id, "brouillon-pc");
});

test("brouillon déjà envoyé (même identifiant sur l'espace) : pas de doublon, ordre de l'espace", async () => {
  const envoye = { id: "brouillon-pc", title: "Bonjour", updatedAtMs: 12 };
  const b = await ouvertureEspace(bootstrap(), async () => [envoye, TEST]);
  assert.deepEqual(b.conversations, [envoye, TEST]);
});

test("espace vide : seul le brouillon ; service injoignable : liste du PC inchangée", async () => {
  assert.deepEqual((await ouvertureEspace(bootstrap(), async () => [])).conversations.map((c) => c.id), ["brouillon-pc"]);
  const hors = bootstrap();
  assert.equal(await ouvertureEspace(hors, async () => { throw new Error("transport closed"); }), hors);
});
