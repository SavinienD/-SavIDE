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
const J = charger("../src/components/agents/journalAgent.ts");
const src = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

// axe:journal-espace — capture 0.1.71 : journal ouvert sur le PC (« local ») alors que l'agent
// vit dans l'espace -> « session not found: b845… », 0 entrées.
const ID = "b845673c-2661-4761-94fb-63966992dc9b";
const lire = (machines) => async (id, conn) => {
  if (machines[conn]?.includes(id)) return { sessionId: id, conn };
  throw `session not found: ${id}`;
};

test("journal demandé au PC mais vivant dans l'espace : relu dans l'espace", async () => {
  const t = await J.chargerJournal(lire({ local: [], espace: [ID] }), ID, "local", "espace");
  assert.equal(t.conn, "espace");
});

test("journal trouvé sur la machine demandée : pas de second appel", async () => {
  const appels = [];
  const t = await J.chargerJournal(async (id, c) => (appels.push(c), { conn: c }), ID, "espace", "espace");
  assert.deepEqual(appels, ["espace"]);
  assert.equal(t.conn, "espace");
});

test("introuvable partout : message clair en français, jamais « session not found »", async () => {
  await assert.rejects(J.chargerJournal(lire({}), ID, "local", "espace"), (e) => {
    const m = J.messageJournal(e);
    assert.match(m, /^Journal introuvable/);
    assert.doesNotMatch(m, /session not found/i);
    return true;
  });
});

test("autres erreurs : traduites, pas de bascule", async () => {
  let n = 0;
  await assert.rejects(J.chargerJournal(async () => { n++; throw "io error: x"; }, ID, "local", "espace"));
  assert.equal(n, 1);
  assert.equal(J.messageJournal("io error: x", (t) => "T:" + t), "T:io error: x");
});

test("bandeau des agents : la machine de l'agent est transmise au journal", () => {
  assert.match(src("../src/components/chat/ChatPane.tsx"), /axe:open-agent-journal", \{ detail: \{[^}]*conn: a\.conn/);
  assert.match(src("../src/components/Workspace.tsx"), /conn: d\.conn \?\? getActiveConnection\(\)/);
});
