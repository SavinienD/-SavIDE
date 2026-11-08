"use strict";
// Fins de tour repérées dans les événements du service : « fini »,
// « attente » (question.ask), « echec » (turn_error) ; clé identique dans chaque fenêtre ;
// réveils sans alerte ; parent dont un sous-agent travaille encore : pas d'alerte « fini ».
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
const S = require(path.resolve(__dirname, "../src/components/notifications/suivi.ts"));
const O = require(path.resolve(__dirname, "../src/components/notifications/ouvrir.ts"));

const ws = "\\\\?\\C:\\Users\\alice\\Documents\\projet";
const meta = (id, status, extra = {}) => ({ id, name: `conv ${id}`, workspaceId: ws, status, updatedAtMs: 1000, ...extra });
const statut = (id, status, extra = {}) => ({ event: "status", sessionId: id, data: meta(id, status, extra) });
const user = (id, text) => ({ event: "entry", sessionId: id, data: { kind: "message", message: { role: "user", parts: [{ type: "text", text }] } } });
const agent = (id, text) => ({ event: "entry", sessionId: id, data: { kind: "message", message: { role: "assistant", parts: [{ type: "text", text }] } } });
const ext = (id, name, payload) => ({ event: "entry", sessionId: id, data: { kind: "extension", name, payload } });
function jouer(suivi, evs) {
  return evs.flatMap((ev, i) => S.appliquer(suivi, ev, 5000 + i));
}
const signalements = (actions) => actions.filter((a) => a.type === "signaler").map((a) => a.signalement);

test("message de l'utilisateur puis fin du tour : « fini », alerte, dernier message de l'agent", () => {
  const actions = jouer(S.nouveauSuivi(), [user("a", "Range la facture"), statut("a", "running"), agent("a", "## Fait\nLes 42 lignes sont rapprochées."), statut("a", "idle", { updatedAtMs: 7777 })]);
  assert.deepEqual(actions.filter((x) => x.type === "effacer").map((x) => x.sessionId), ["a", "a"]);
  const [s] = signalements(actions);
  assert.equal(s.genre, "fini");
  assert.equal(s.cle, "a:fini:7777", "même clé dans chaque fenêtre (updatedAtMs du statut)");
  assert.equal(s.alerter, true);
  assert.equal(s.texte, "Fini\u00a0: Fait");
  assert.equal(s.titre, "conv a");
  assert.equal(s.dossier, ws);
  assert.equal(s.sousAgent, false);
});

test("question.ask : « attend votre réponse » avec la question ; la réponse efface l'état", () => {
  const suivi = S.nouveauSuivi();
  const fin = jouer(suivi, [user("q", "Publie"), statut("q", "running"), ext("q", "question", { question: "Publier la 0.1.86 maintenant ?", options: ["oui", "non"] }), agent("q", "Publier la 0.1.86 maintenant ?"), statut("q", "idle")]);
  const [s] = signalements(fin);
  assert.equal(s.genre, "attente");
  assert.equal(s.texte, "Attend votre réponse\u00a0: Publier la 0.1.86 maintenant ?");
  assert.equal(s.alerter, true);
  const reponse = S.appliquer(suivi, user("q", "oui"), 9000);
  assert.deepEqual(reponse, [{ type: "effacer", sessionId: "q" }]);
});

test("turn_error : « échec » avec le message", () => {
  const [s] = signalements(jouer(S.nouveauSuivi(), [user("e", "go"), statut("e", "running"), ext("e", "turn_error", { error: "HTTP 529 overloaded" }), statut("e", "idle")]));
  assert.equal(s.genre, "echec");
  assert.equal(s.texte, "Échec\u00a0: HTTP 529 overloaded");
});

test("tour lancé par un réveil (/heartbeat, guet, /goal) : listé sans alerte", () => {
  for (const reveil of ["<heartbeat at_ms=\"1\">\nvérifie\n</heartbeat>", "<guet id=\"g1\" statut=\"ok\">\nfin\n</guet>", "<system_reminder>continue</system_reminder>"]) {
    const [s] = signalements(jouer(S.nouveauSuivi(), [statut("h", "running"), user("h", reveil), agent("h", "Rien de neuf."), statut("h", "idle")]));
    assert.equal(s.genre, "fini");
    assert.equal(s.alerter, false, reveil);
  }
});

test("résultat d'un sous-agent (message entre sessions) : le parent alerte à sa fin", () => {
  const evs = [{ event: "entry", sessionId: "p", data: { kind: "peer_message", from_session: "sa", text: "fini" } }, statut("p", "running"), statut("p", "idle")];
  const [s] = signalements(jouer(S.nouveauSuivi(), evs));
  assert.equal(s.alerter, true);
});

test("parent dont un sous-agent travaille encore : fin sans alerte ; sous-agent marqué", () => {
  const suivi = S.nouveauSuivi();
  S.semer(suivi, [meta("p", "idle"), meta("sa", "running", { parentId: "p" })]);
  const [s] = signalements(jouer(suivi, [user("p", "Lance les lots"), statut("p", "running"), statut("p", "idle")]));
  assert.equal(s.alerter, false);
  const [fin] = signalements(jouer(suivi, [statut("sa", "idle", { parentId: "p" })]));
  assert.equal(fin.sousAgent, true, "le sous-agent semé au démarrage a un tour ouvert");
});

test("statut sans tour suivi (déchargement) : rien ; événements d'une connexion distante gardent la connexion", () => {
  assert.deepEqual(jouer(S.nouveauSuivi(), [statut("x", "idle"), statut("x", "inactive")]), []);
  const suivi = S.nouveauSuivi();
  const evs = [user("r", "go"), { ...statut("r", "running"), connectionId: "axe-cloud" }, { ...statut("r", "idle"), connectionId: "axe-cloud" }];
  const [s] = signalements(jouer(suivi, evs));
  assert.equal(s.connexion, "axe-cloud");
  assert.deepEqual(S.appliquer(suivi, null, 1), []);
  assert.deepEqual(S.appliquer(suivi, { event: "stream", sessionId: "r", data: {} }, 1), []);
});

test("extrait : première ligne utile, Markdown retiré, coupé", () => {
  assert.equal(S.extrait("\n\n**Bilan** du `lot`\nsuite"), "Bilan du lot");
  assert.equal(S.extrait("x".repeat(200), 10), "xxxxxxxxx…");
  assert.equal(S.estReveil("  <heartbeat>"), true);
  assert.equal(S.estReveil("bonjour"), false);
});

test("ouvreurs : priorité de l'espace, secours de l'appli, chemin du poste", () => {
  const vus = [];
  const retirerSecours = O.fournirOuvreur((c) => (vus.push(["secours", c.sessionId]), true), 0);
  const retirerEspace = O.fournirOuvreur((c) => (c.dossier ? (vus.push(["espace", c.sessionId]), true) : false), 10);
  assert.equal(O.ouvrirCible(O.cibleDe({ sessionId: "a", dossier: ws })), true);
  assert.equal(O.ouvrirCible(O.cibleDe({ sessionId: "b" })), true);
  retirerEspace();
  O.ouvrirCible({ sessionId: "c", dossier: ws });
  retirerSecours();
  assert.equal(O.ouvrirCible({ sessionId: "d" }), false);
  assert.deepEqual(vus, [["espace", "a"], ["secours", "b"], ["secours", "c"]]);
  assert.equal(O.cibleDe({}), null);
  assert.equal(O.cheminPoste(ws), "C:\\Users\\alice\\Documents\\projet");
});
