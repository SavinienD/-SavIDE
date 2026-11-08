// « Demander avant d'agir » : demandes reçues du service, notifications « attente ».
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
const V = charger("../src/lib/validationActions.ts");
const demande = (id, extra = {}) => ({ id, sessionId: "c-1", racineId: "c-1", nomSession: "Conversation", dossier: "/p", outil: "python", callId: "t1", code: "# lister\nshell.run('ls -la')", creeLe: 1, ...extra });
const flux = (event, connectionId) => ({ event: "stream", sessionId: event.demande?.sessionId ?? "c-1", connectionId, data: { turnId: "t", event } });

test("une demande arrive, s'affiche dans sa conversation et dans celle du parent, puis disparaît", () => {
  V.viderPourTests();
  let appels = 0;
  const fin = V.abonner(() => (appels += 1));
  const d = V.appliquerEvenement(flux({ type: "approbation", demande: demande("a") }));
  assert.equal(d.id, "a");
  assert.equal(V.appliquerEvenement(flux({ type: "approbation", demande: demande("a") })), null, "pas deux fois");
  const sa = V.appliquerEvenement(flux({ type: "approbation", demande: demande("b", { sessionId: "sa-1", parentId: "c-1", racineId: "c-1", nomSession: "agent-a", creeLe: 2 }) }, "axe-cloud"));
  assert.deepEqual(V.pourConversation("c-1").map((e) => e.demande.id), ["a", "b"]);
  assert.deepEqual(V.pourConversation("sa-1").map((e) => e.demande.id), ["b"]);
  assert.equal(V.pourConversation("c-1")[1].connexion, "axe-cloud");
  V.appliquerEvenement(flux({ type: "approbation_fin", id: "a" }));
  assert.deepEqual(V.pourConversation("c-1").map((e) => e.demande.id), ["b"]);
  V.appliquerEvenement({ event: "status", sessionId: "sa-1", data: { status: "idle" } });
  assert.equal(V.pourConversation("c-1").length, 0, "tour fini : demande caduque");
  assert.ok(appels >= 4);
  fin();
  assert.equal(sa.parentId, "c-1");
});

test("la liste du service remplace celle d'une connexion", () => {
  V.viderPourTests();
  V.remplacer([demande("x"), demande("y")], null);
  V.appliquerEvenement(flux({ type: "approbation", demande: demande("z") }, "axe-cloud"));
  const nouvelles = V.remplacer([demande("y"), demande("w")], null);
  assert.deepEqual(nouvelles.map((d) => d.id), ["w"]);
  assert.deepEqual(V.toutesLesDemandes().map((e) => e.demande.id).sort(), ["w", "y", "z"]);
  V.retirer("y");
  assert.deepEqual(V.toutesLesDemandes().map((e) => e.demande.id).sort(), ["w", "z"]);
});

test("notification « attente » : sous-agent toujours, conversation seulement hors de vue", () => {
  V.viderPourTests();
  const fin = V.monterVue("c-1");
  const vues = V.vuesMontees();
  assert.equal(V.doitNotifier(demande("a"), vues, true), false, "sous les yeux");
  assert.equal(V.doitNotifier(demande("a"), vues, false), true, "fenêtre cachée");
  assert.equal(V.doitNotifier(demande("a", { racineId: "c-2", sessionId: "c-2" }), vues, true), true, "autre conversation");
  assert.equal(V.doitNotifier(demande("b", { parentId: "c-1" }), vues, true), true, "sous-agent");
  fin();
  assert.equal(V.vuesMontees().has("c-1"), false);
  const n = V.notification(demande("b", { sessionId: "sa-1", parentId: "c-1", nomSession: "agent-a" }));
  assert.deepEqual(n, { genre: "attente", titre: "Un sous-agent attend votre accord", texte: "agent-a\u00a0: shell.run('ls -la')", dossier: "/p", sessionId: "c-1" });
  assert.equal(V.premiereLigne("x".repeat(100), 10), "xxxxxxxxx…");
});

test("réponse, libellés et bascule du réglage", () => {
  assert.deepEqual(V.parametresReponse("a", "refuser", "  pas ça  "), { id: "a", decision: "refuser", motif: "pas ça" });
  assert.deepEqual(V.parametresReponse("a", "refuser", "   "), { id: "a", decision: "refuser" });
  assert.deepEqual(V.parametresReponse("a", "autoriser", "ignoré"), { id: "a", decision: "autoriser" });
  assert.equal(V.libelleMode({ mode: "demander", explicite: "demander", defaut: "autonome" }), "Demander avant d'agir\u00a0: oui");
  assert.equal(V.libelleMode({ mode: "autonome", defaut: "autonome" }), "Demander avant d'agir\u00a0: non (réglage par défaut)");
  assert.equal(V.libelleMode({ mode: "demander", heriteDe: "c-1", defaut: "autonome" }), "Demander avant d'agir\u00a0: oui (comme la conversation parente)");
  assert.equal(V.basculer({ mode: "autonome", defaut: "autonome" }), "demander");
  assert.equal(V.basculer({ mode: "demander", defaut: "autonome" }), "autonome");
  assert.equal(V.basculer(null), "demander");
});
