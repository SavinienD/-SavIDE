"use strict";
// automatisations — fin d'une exécution -> notification `ide-notification` (réussie, échouée,
// arrêtée ; rien pour une exécution sautée ou manquée), et au démarrage de l'appli un seul mot pour
// les exécutions faites pendant qu'elle était fermée.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(js, filename);
};
const N = require(path.resolve(__dirname, "../src/components/automatisations/notifications.ts"));
const src = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

const fin = (statut, resume) => ({
  type: "fin",
  automatisation: { id: "a1", nom: "Rapport du matin", dossier: "C:\\projet" },
  execution: { id: "x1", statut, resume, sessionId: "s1", debutMs: 1, declencheur: "horaire" },
});

test("fin d'exécution : réussie, échouée, arrêtée -> notification ; sautée, manquée -> rien", () => {
  assert.deepEqual(N.notificationDeFin(fin("reussie", "12 tickets ouverts, 3 urgents.")), {
    genre: "fini",
    titre: "Rapport du matin\u00a0: réussie",
    texte: "12 tickets ouverts, 3 urgents.",
    dossier: "C:\\projet",
    sessionId: "s1",
  });
  assert.equal(N.notificationDeFin(fin("echouee", "HTTP 529 Overloaded")).genre, "echec");
  assert.equal(N.notificationDeFin(fin("echouee", "x")).titre, "Rapport du matin\u00a0: échouée");
  assert.equal(N.notificationDeFin(fin("arretee", undefined)).genre, "info");
  assert.equal(N.notificationDeFin(fin("arretee", undefined)).texte, "");
  assert.equal(N.notificationDeFin(fin("sautee", "Vérification en échec (code 1)")), null);
  assert.equal(N.notificationDeFin(fin("manquee", "")), null);
  assert.equal(N.notificationDeFin({ type: "maj" }), null);
  assert.equal(N.notificationDeFin(null), null);
  const long = N.notificationDeFin(fin("reussie", "mot ".repeat(100)));
  assert.equal(long.texte.length, 140);
  assert.ok(long.texte.endsWith("…"));
});

test("appli fermée : un seul mot pour les exécutions finies depuis la dernière visite", () => {
  const x = (statut, finMs) => ({ id: `${statut}-${finMs}`, statut, finMs, debutMs: 0, declencheur: "horaire" });
  const liste = [
    { historique: [x("reussie", 50), x("reussie", 150), x("echouee", 160)] },
    { historique: [x("sautee", 170), x("reussie", 180), x("en_cours", undefined)] },
  ];
  assert.deepEqual(N.resumeAbsence(liste, 100), {
    genre: "echec",
    titre: "Automatisations",
    texte: "3 exécutions pendant que l'appli était fermée\u00a0: 2 réussies, 1 échouée.",
  });
  assert.equal(N.resumeAbsence(liste, 200), null);
  const une = N.resumeAbsence([{ historique: [x("reussie", 150)] }], 100);
  assert.equal(une.genre, "fini");
  assert.equal(une.texte, "1 exécution pendant que l'appli était fermée\u00a0: 1 réussie.");
});

test("emettre : événement `ide-notification` sur window (contrat commun)", () => {
  const recus = [];
  const avant = { window: global.window, CustomEvent: global.CustomEvent };
  global.window = { dispatchEvent: (e) => recus.push(e) };
  global.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
  try {
    N.emettre({ genre: "fini", titre: "t", texte: "x" });
  } finally {
    global.window = avant.window;
    global.CustomEvent = avant.CustomEvent;
  }
  assert.equal(recus.length, 1);
  assert.equal(recus[0].type, "ide-notification");
  assert.deepEqual(recus[0].detail, { genre: "fini", titre: "t", texte: "x" });
});

test("l'écoute des fins d'exécution est montée avec l'écran (accueil et dossier)", () => {
  const global_ = src("../src/components/automatisations/Automatisations.tsx");
  assert.match(global_, /useNotificationsAutomatisations\(\);/);
  const ecoute = src("../src/components/automatisations/useNotificationsAutomatisations.ts");
  assert.match(ecoute, /\(ev\.event as string\) !== "automatisations"/);
  assert.match(ecoute, /notificationDeFin\(ev\.data\)/);
});

