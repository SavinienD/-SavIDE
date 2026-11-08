"use strict";
// Réglages > Notifications (événements, notification du système, son court,
// ne pas déranger, essai) et son joué par la seule fenêtre à qui le centre le demande.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><body></body>");
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Element = dom.window.Element;
global.IS_REACT_ACT_ENVIRONMENT = true;

const racine = path.resolve(__dirname, "..");
for (const ext of [".ts", ".tsx"]) {
  Module._extensions[ext] = (module, filename) => {
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    module._compile(js, filename);
  };
}
Module._extensions[".css"] = () => {};
const appels = [];
let reponses = {};
const remplacants = {
  "@tauri-apps/api/core": {
    invoke: async (cmd, args) => {
      appels.push([cmd, args]);
      const r = reponses[cmd];
      return typeof r === "function" ? r(args) : r ?? null;
    },
  },
  "@tauri-apps/api/event": { listen: async () => () => {} },
  "@iconify/react": { Icon: () => null },
};
const charger = Module.prototype.require;
Module.prototype.require = function (id) {
  if (remplacants[id] && this.filename?.startsWith(path.join(racine, "src"))) return remplacants[id];
  return charger.call(this, id);
};
const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = require("react");
const api = require(path.join(racine, "src/components/notifications/notificationsApi.ts"));
const son = require(path.join(racine, "src/components/notifications/son.ts"));
const service = require(path.join(racine, "src/components/notifications/useServiceNotifications.ts"));
const { NotificationsSection } = require(path.join(racine, "src/components/notifications/NotificationsSection.tsx"));

const attendre = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("état du centre complété (banc, ancien service) ; réglages par défaut", () => {
  const vide = api.normaliserEtat(null);
  assert.deepEqual(vide.reglages, api.REGLAGES_DEFAUT);
  assert.equal(vide.nonLus, 0);
  const e = api.normaliserEtat({ evenements: [{ cle: "a", lu: false }, { cle: "b", lu: true }], reglages: { son: false } });
  assert.equal(e.nonLus, 1);
  assert.equal(e.reglages.son, false);
  assert.equal(e.reglages.systeme, true);
  assert.equal(api.REGLAGES_DEFAUT.sousAgents, false);
  assert.equal(api.REGLAGES_DEFAUT.nePasDeranger, false);
});

test("son : trois mélodies distinctes ; préparé au premier geste puis plus écouté", () => {
  assert.deepEqual(son.notesDe("fini"), [784, 1175]);
  assert.equal(son.notesDe("attente").length, 3);
  assert.notDeepEqual(son.notesDe("echec"), son.notesDe("fini"));
  const ecoutes = new Map();
  const cible = {
    addEventListener: (t, f) => ecoutes.set(t, f),
    removeEventListener: (t) => ecoutes.delete(t),
  };
  const retirer = son.armerSon(cible);
  assert.deepEqual([...ecoutes.keys()], ["pointerdown", "keydown"]);
  ecoutes.get("pointerdown")();
  assert.equal(ecoutes.size, 0, "un seul armement");
  retirer();
  son.jouerSon("fini"); // sans WebAudio (jsdom) : ne lève rien
});

test("seule la fenêtre à qui le centre répond « son » le joue ; effacer passe au centre", async () => {
  const joues = [];
  const effaces = [];
  const sig = (genre) => ({ type: "signaler", signalement: { cle: genre, genre, titre: "t", texte: "", sessionId: "s" } });
  await service.executerActions([sig("fini"), sig("attente"), { type: "effacer", sessionId: "s2" }], {
    signaler: async (s) => ({ nouveau: true, systeme: true, son: s.genre === "attente" }),
    effacer: async (id) => effaces.push(id),
    jouer: (g) => joues.push(g),
  });
  assert.deepEqual(joues, ["attente"]);
  assert.deepEqual(effaces, ["s2"]);
  await service.executerActions([sig("echec")], { signaler: async () => { throw new Error("hors Tauri"); }, effacer: async () => {}, jouer: () => joues.push("x") });
  assert.deepEqual(joues, ["attente"], "centre indisponible : rien, sans erreur");
});

test("Réglages > Notifications : cases, enregistrement, essai", async () => {
  appels.length = 0;
  reponses = {
    notifications_lister: { evenements: [], etats: {}, reglages: { ...api.REGLAGES_DEFAUT }, nonLus: 0 },
    notifications_reglages: (a) => a.reglages,
    notifications_essayer: { nouveau: true, systeme: true, son: false },
  };
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const root = createRoot(hote);
  await act(async () => root.render(React.createElement(NotificationsSection)));
  await attendre();
  const caseDe = (cle) => hote.querySelector(`[data-reglage='${cle}'] input`);
  for (const cle of ["fini", "attente", "echec", "systeme", "son"]) assert.equal(caseDe(cle).checked, true, cle);
  for (const cle of ["sousAgents", "nePasDeranger"]) assert.equal(caseDe(cle).checked, false, cle);
  await act(async () => caseDe("nePasDeranger").click());
  const enregistre = appels.filter(([c]) => c === "notifications_reglages").pop();
  assert.equal(enregistre[1].reglages.nePasDeranger, true);
  assert.equal(enregistre[1].reglages.fini, true, "les autres réglages sont gardés");
  assert.equal(caseDe("nePasDeranger").checked, true);
  await act(async () => hote.querySelector("[data-action='essayer']").click());
  await attendre();
  assert.ok(appels.some(([c]) => c === "notifications_essayer"));
  assert.equal(hote.querySelector("[role='status']").textContent, "Notification envoyée.");
  await act(async () => root.unmount());
});
