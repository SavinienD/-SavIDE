"use strict";
// Contrat commun « ide-notification » : les autres écrans émettent
// window.dispatchEvent(new CustomEvent("ide-notification", { detail: { genre, titre, texte, dossier?, sessionId? } })) ;
// le centre des notifications l'écoute et le traite comme une fin de tour (cloche, badge, notification, son, tableau).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><body></body>");
global.window = dom.window;
global.CustomEvent = dom.window.CustomEvent;
Module._extensions[".ts"] = (module, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(js, filename);
};
const racine = path.resolve(__dirname, "..");
const C = require(path.join(racine, "src/components/notifications/contrat.ts"));

test("un ide-notification émis sur la fenêtre arrive au centre comme un signalement", () => {
  const recus = [];
  const arreter = C.ecouterIdeNotifications(window, (s) => recus.push(s), () => 1234);
  window.dispatchEvent(new CustomEvent("ide-notification", {
    detail: { genre: "attente", titre: "Worktree correctif-panier", texte: "Valider la suppression de 3 fichiers\u00a0?", dossier: "C:\\depot", sessionId: "s-42" },
  }));
  C.notifier({ genre: "fini", titre: "Commit rédigé" }, window);
  assert.equal(recus.length, 2);
  assert.deepEqual({ ...recus[0], cle: undefined }, {
    cle: undefined, genre: "attente", titre: "Worktree correctif-panier", texte: "Valider la suppression de 3 fichiers\u00a0?",
    dossier: "C:\\depot", sessionId: "s-42", ts: 1234, alerter: true,
  });
  assert.match(recus[0].cle, /^ide:1234:\d+$/);
  assert.notEqual(recus[0].cle, recus[1].cle, "chaque événement a sa clé (jamais fusionné avec un autre)");
  assert.equal(recus[1].genre, "fini");
  assert.equal(recus[1].texte, "");
  arreter();
  C.notifier({ genre: "info", titre: "après" }, window);
  assert.equal(recus.length, 2, "plus écouté après l'arrêt");
});

test("détails incomplets : genre inconnu = info, texte seul = titre, vide = ignoré", () => {
  assert.equal(C.signalementDe({ genre: "bizarre", titre: "x" }, 1).genre, "info");
  const seul = C.signalementDe({ texte: "  Mise à jour prête  " }, 1);
  assert.equal(seul.titre, "Mise à jour prête");
  assert.equal(seul.texte, "");
  assert.equal(C.signalementDe({ genre: "fini" }, 1), null);
  assert.equal(C.signalementDe(null, 1), null);
  assert.equal(C.signalementDe("texte", 1), null);
  assert.equal(C.signalementDe({ titre: "t", sessionId: 42 }, 1).sessionId, undefined);
});

test("l'appli écoute le contrat (useServiceNotifications, monté par App.tsx) et le documente", () => {
  const service = fs.readFileSync(path.join(racine, "src/components/notifications/useServiceNotifications.ts"), "utf8");
  assert.match(service, /ecouterIdeNotifications\(window,/);
  const app = fs.readFileSync(path.join(racine, "src/App.tsx"), "utf8");
  assert.match(app, /useServiceNotifications\(/);
  const contrat = fs.readFileSync(path.join(racine, "src/components/notifications/contrat.ts"), "utf8");
  assert.match(contrat, /CustomEvent\("ide-notification"/);
  assert.equal(C.EVENEMENT_IDE_NOTIFICATION, "ide-notification");
});
