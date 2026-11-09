"use strict";
// Notifications en français : textes connus des producteurs (inventaire), erreurs brutes du
// moteur traduites à l'affichage, espaces insécables avant « : ; ? ! % ».
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
const T = require(path.resolve(__dirname, "../src/components/notifications/texteNotif.ts"));
const S = require(path.resolve(__dirname, "../src/components/notifications/suivi.ts"));
const NB = "\u00a0";

const ANGLAIS = /\b(the|is|has|was|failed|error|finished|done|completed|ready|waiting|update available|started|stopped|cannot|could not|please|your|you|turn|crashed|repeatedly|cancelled|new conversation|response ready|question pending|notifications work)\b/i;

// Fichiers qui produisent des notifications (inventaire) et textes qu'ils doivent contenir.
const ATTENDUS = {
  "src/components/notifications/suivi.ts": ["Attend votre réponse", "Échec du tour.", "Fini."],
  "src/lib/validationActions.ts": ["Un sous-agent attend votre accord", "Action à valider"],
  "src/components/agents-cli/etatAgent.ts": ["L'agent attend une réponse.", "Le processus s'est terminé.", "Le processus a été arrêté."],
  "src/components/automatisations/notifications.ts": ["Automatisations", "pendant que l'appli était fermée"],
  "src/components/editeur/useImagesMarkdown.ts": ["Image non ajoutée"],
  "src-tauri/src/notifications.rs": ["Les notifications fonctionnent.", "--action=default=Ouvrir"],
  "src-tauri/src/remote.rs": ["Réponse prête"],
  "remote/server.mjs": ["Réponse prête"],
  "remote/public/sw.js": ["Réponse prête"],
  "remote/public/app.js": ["Les notifications ne sont pas configurées sur le relais.", "Notifications actives", "Installez l'appli pour le plein écran et les notifications."],
};

test("textes connus des notifications : présents et sans anglais", () => {
  for (const [fichier, textes] of Object.entries(ATTENDUS)) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", fichier), "utf8");
    for (const t of textes) {
      assert.ok(source.includes(t), `${fichier} : « ${t} » absent`);
      assert.doesNotMatch(t, ANGLAIS, `${fichier} : « ${t} »`);
    }
  }
});

test("erreurs brutes du moteur traduites à l'affichage", () => {
  const cas = [
    "worker crashed repeatedly",
    "turn cancelled",
    "retryable stream error: HTTP 429",
    "Échec : runtime error: boom",
    "Lancement impossible : session busy: s1",
    "New conversation",
  ];
  for (const brut of cas) {
    const fr = T.texteNotification(brut);
    assert.doesNotMatch(fr.replace(/HTTP \d+|boom|s1/g, ""), ANGLAIS, `${brut} -> ${fr}`);
  }
  assert.equal(T.texteNotification("Échec : runtime error: boom"), `Échec${NB}: Erreur du moteur${NB}: boom`);
  assert.equal(T.texteNotification("New conversation"), "Nouvelle conversation");
});

test("espaces insécables avant : ; ? ! % et dans les guillemets", () => {
  assert.equal(T.typographie("Fini : oui ; non ? ah ! 80 % « x »"), `Fini${NB}: oui${NB}; non${NB}? ah${NB}! 80${NB}% «${NB}x${NB}»`);
  assert.equal(T.typographie("voir https://exemple.fr"), "voir https://exemple.fr");
  const s = T.franciser({ titre: "New conversation", texte: "Échec : turn cancelled" });
  assert.deepEqual(s, { titre: "Nouvelle conversation", texte: `Échec${NB}: Tour annulé.` });
});

test("fin de tour en échec : erreur du moteur en français", () => {
  const suivi = S.nouveauSuivi();
  S.appliquer(suivi, { event: "status", sessionId: "a", data: { id: "a", name: "c", status: "running", updatedAtMs: 1 } }, 1);
  S.appliquer(suivi, { event: "entry", sessionId: "a", data: { kind: "extension", name: "turn_error", payload: { error: "worker crashed repeatedly" } } }, 2);
  const [a] = S.appliquer(suivi, { event: "status", sessionId: "a", data: { id: "a", name: "c", status: "idle", updatedAtMs: 3 } }, 3);
  assert.equal(a.signalement.texte, `Échec${NB}: Le moteur de la conversation s'est arrêté plusieurs fois.`);
});
