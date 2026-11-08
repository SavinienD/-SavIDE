"use strict";
// Cloche de la barre du haut : nombre de non-lus, liste des événements
// récents, « Tout marquer lu », clic = ouvrir la conversation, clavier (flèches, Échap).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
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
const T = 1_793_890_099_980;
const ETAT = {
  evenements: [
    { cle: "c1:attente:1", genre: "attente", titre: "Publier la 0.1.86", texte: "Attend votre réponse\u00a0: on publie\u00a0?", sessionId: "c1", dossier: "\\\\?\\C:\\Users\\S\\projet", ts: T, lu: false },
    { cle: "c2:fini:1", genre: "fini", titre: "Facture OVH", texte: "Fini\u00a0: 42 lignes rapprochées.", sessionId: "c2", ts: T - 60_000, lu: false },
    { cle: "info:1", genre: "info", titre: "Worktree prêt", texte: "lot-agents", ts: T - 120_000, lu: true },
  ],
  etats: {},
  reglages: {},
  nonLus: 2,
};
const remplacants = {
  "@tauri-apps/api/core": { invoke: async (cmd, args) => { appels.push([cmd, args]); return cmd === "notifications_lister" ? ETAT : null; } },
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
const { Cloche } = require(path.join(racine, "src/components/notifications/Cloche.tsx"));
const ouvrir = require(path.join(racine, "src/components/notifications/ouvrir.ts"));

const attendre = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const touche = (el, key) => act(() => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })));

test("cloche : non-lus, liste, Tout marquer lu, ouverture, clavier", async () => {
  const ouverts = [];
  const retirer = ouvrir.fournirOuvreur((c) => (ouverts.push(c), true), 10);
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const root = createRoot(hote);
  await act(async () => root.render(React.createElement(Cloche)));
  await attendre();
  const bouton = hote.querySelector(".axe-cloche__bouton");
  assert.equal(bouton.querySelector(".axe-cloche__compte").textContent, "2");
  assert.equal(bouton.getAttribute("aria-label"), "Notifications\u00a0: 2 non lues");
  assert.equal(bouton.getAttribute("aria-expanded"), "false");

  await act(async () => bouton.click());
  await attendre();
  const panneau = document.querySelector(".axe-cloche__panneau");
  assert.ok(panneau, "panneau ouvert (portail dans le body)");
  const items = [...panneau.querySelectorAll(".axe-cloche__item")];
  assert.deepEqual(items.map((i) => i.dataset.genre), ["attente", "fini", "info"]);
  assert.deepEqual(items.map((i) => i.dataset.lu), ["false", "false", "true"]);
  assert.equal(items[0].querySelector(".axe-cloche__texte").textContent, "on publie\u00a0?", "le genre n'est pas répété");
  assert.match(items[0].querySelector(".axe-cloche__details").textContent, /^Attend votre réponse · projet · /);

  // flèches : parcours des boutons du panneau
  items[0].focus();
  await touche(items[0], "ArrowDown");
  assert.equal(document.activeElement, items[1]);
  await touche(items[1], "ArrowUp");
  assert.equal(document.activeElement, items[0]);
  await touche(items[0], "ArrowUp");
  assert.ok(document.activeElement.classList.contains("axe-cloche__tout"), "« Tout marquer lu » avant la liste");
  await touche(document.activeElement, "ArrowUp");
  assert.equal(document.activeElement, items[2], "retour en bas");

  await act(async () => panneau.querySelector(".axe-cloche__tout").click());
  assert.deepEqual(appels.filter(([c]) => c === "notifications_marquer_lu").pop()[1], { cle: null, sessionId: null });

  await act(async () => items[1].click());
  assert.deepEqual(appels.filter(([c]) => c === "notifications_marquer_lu").pop()[1], { cle: "c2:fini:1", sessionId: null });
  assert.equal(ouverts.length, 1);
  assert.equal(ouverts[0].sessionId, "c2");
  assert.equal(document.querySelector(".axe-cloche__panneau"), null, "fermé après l'ouverture");

  // Échap ferme et rend le focus au bouton
  await act(async () => bouton.click());
  await attendre();
  assert.ok(document.querySelector(".axe-cloche__panneau"));
  await touche(document.body, "Escape");
  assert.equal(document.querySelector(".axe-cloche__panneau"), null);
  assert.equal(document.activeElement, bouton);
  retirer();
  await act(async () => root.unmount());
});
