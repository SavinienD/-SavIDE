"use strict";
// État d'un agent de terminal (src/components/agents-cli/etatAgent.ts) : travaille (sortie
// active), attend (invite reconnue, BEL, OSC 9 / OSC 777, long silence), fini (code de sortie).
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
const E = charger("../src/components/agents-cli/etatAgent.ts");

test("la sortie fait travailler l'agent, sauf l'écho d'une frappe", () => {
  let s = E.suiviInitial(0);
  assert.equal(s.etat, "demarre");
  s = E.surSortie(s, 1000);
  assert.equal(s.etat, "travaille");
  let t = E.surHorloge(s, 1000 + E.SILENCE_MS + 1, "", []);
  assert.equal(t.suivi.etat, "attend");
  assert.equal(t.notifier, false, "travail trop court pour prévenir");
  s = E.surSaisie(t.suivi, 20_000);
  s = E.surSortie(s, 20_000 + E.ECHO_MS - 50);
  assert.equal(s.etat, "attend", "l'écho de la frappe ne compte pas comme du travail");
  s = E.surSortie(s, 21_000);
  assert.equal(s.etat, "travaille");
});

test("silence + invite reconnue : attend plus tôt ; long travail : on prévient", () => {
  let s = E.surSortie(E.suiviInitial(0), 1000);
  for (let t = 1000; t <= 9000; t += 200) s = E.surSortie(s, t);
  const invites = [/\? for shortcuts/];
  let t = E.surHorloge(s, 9000 + E.SILENCE_INVITE_MS - 10, "> \n? for shortcuts", invites);
  assert.equal(t.suivi.etat, "travaille", "trop tôt");
  t = E.surHorloge(s, 9000 + E.SILENCE_INVITE_MS + 10, "texte sans invite", invites);
  assert.equal(t.suivi.etat, "travaille", "pas d'invite à l'écran");
  t = E.surHorloge(s, 9000 + E.SILENCE_INVITE_MS + 10, "> \n? for shortcuts", invites);
  assert.equal(t.suivi.etat, "attend");
  assert.equal(t.notifier, true);
  const encore = E.surHorloge(t.suivi, 9000 + E.SILENCE_MS * 3, "", invites);
  assert.equal(encore.notifier, false, "une seule notification par attente");
});

test("BEL, OSC 9 et OSC 777 : attente immédiate ; la progression OSC 9;4 est ignorée", () => {
  let s = E.surSortie(E.suiviInitial(0), 1000);
  let t = E.surSignal(s, 1200, null);
  assert.equal(t.suivi.etat, "attend");
  assert.equal(t.notifier, true);
  assert.equal(E.messageOsc9("4;1;50"), null);
  assert.equal(E.messageOsc9("Claude attend votre permission"), "Claude attend votre permission");
  assert.equal(E.messageOsc777("notify;Codex;Tâche finie"), "Codex : Tâche finie");
  assert.equal(E.messageOsc777("notify;;Prêt"), "Prêt");
  assert.equal(E.messageOsc777("preexec"), null);
  t = E.surSignal(t.suivi, 1300, "deuxième");
  assert.equal(t.notifier, false, "déjà en attente : pas de seconde notification");
});

test("fin du processus : fini (code 0) ou échec, et plus rien ne change ensuite", () => {
  const s = E.surSortie(E.suiviInitial(0), 1000);
  let t = E.surFin(s, 0);
  assert.equal(t.suivi.etat, "fini");
  assert.equal(t.notifier, true);
  assert.equal(E.surSortie(t.suivi, 2000).etat, "fini");
  t = E.surFin(s, 2);
  assert.equal(t.suivi.etat, "echec");
  assert.equal(t.suivi.codeSortie, 2);
  assert.equal(E.libelleEtat(t.suivi), "Arrêté (code 2)");
  assert.equal(E.libelleEtat(E.surSortie(E.suiviInitial(0), 5)), "Travaille");
});

test("notification de l'IDE (contrat « ide-notification »)", () => {
  const s = E.surSortie(E.suiviInitial(0), 1000);
  const attente = E.notificationAgent("Codex", "/depot", E.surSignal(s, 2000, "Approuver la commande ?").suivi, "Approuver la commande ?");
  assert.deepEqual(attente, { genre: "attente", titre: "Codex attend", texte: "Approuver la commande ?", dossier: "/depot" });
  const fini = E.notificationAgent("Codex", "/depot", E.surFin(s, 0).suivi);
  assert.equal(fini.genre, "fini");
  const echec = E.notificationAgent("Codex", "/depot", E.surFin(s, 1).suivi);
  assert.equal(echec.genre, "echec");
  assert.match(echec.texte, /code 1/);
});
