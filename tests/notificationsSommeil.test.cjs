"use strict";
// Conversations endormies : Réglages > Service (délai, « Jamais »), bouton
// « Endormir » de l'onglet Agents (sessions.unload). La reprise des variables par un nouveau
// noyau est vérifiée par python/tests/test_sommeil.py ; le délai du service par
// crates/axecode-daemon/tests/sommeil.rs.
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
let etatService = { conversationsMinutes: null, defautMinutes: 30 };
const remplacants = {
  "@tauri-apps/api/core": {
    invoke: async (cmd, args) => {
      appels.push([cmd, args]);
      const m = args?.input?.method;
      if (m === "sommeil.get") return etatService;
      if (m === "sommeil.set") return (etatService = { ...etatService, conversationsMinutes: args.input.params.conversationsMinutes });
      if (m === "sessions.unload") return { ok: true };
      return null;
    },
  },
  "@tauri-apps/api/event": { listen: async () => () => {} },
  "../../lib/ipc": { cloudRpc: async () => null },
  "../settings/connectionsApi": { connectionArg: (c) => c, getActiveConnection: () => "local", LOCAL_CONNECTION: "local" },
};
const charger = Module.prototype.require;
Module.prototype.require = function (id) {
  if (remplacants[id] && this.filename?.startsWith(path.join(racine, "src"))) return remplacants[id];
  return charger.call(this, id);
};
const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = require("react");
const { SommeilSection, libelleDelai } = require(path.join(racine, "src/components/notifications/SommeilSection.tsx"));
const { agentsApi, STATUS_LABEL } = require(path.join(racine, "src/components/agents/agentsApi.ts"));

const attendre = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("libellés des délais ; une session déchargée s'appelle « endormie »", () => {
  assert.equal(libelleDelai(0), "Jamais");
  assert.equal(libelleDelai(15), "15 min");
  assert.equal(libelleDelai(120), "2 h");
  assert.equal(STATUS_LABEL.inactive, "endormi");
});

test("Endormir = sessions.unload sur la connexion de la session", async () => {
  appels.length = 0;
  await agentsApi.unload("s-1", "local");
  assert.deepEqual(appels[0], ["daemon_call", { input: { method: "sessions.unload", params: { sessionId: "s-1" }, connection: "local" } }]);
});

test("Réglages > Service : délai par défaut affiché, « Jamais » enregistré dans le service du poste", async () => {
  appels.length = 0;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const root = createRoot(hote);
  await act(async () => root.render(React.createElement(SommeilSection)));
  await attendre();
  const choix = hote.querySelector("select.axe-sommeil__delai");
  assert.equal(choix.disabled, false);
  assert.equal(choix.value, "defaut");
  assert.equal(choix.options[0].textContent, "30 min (par défaut)");
  assert.deepEqual([...choix.options].map((o) => o.value), ["defaut", "5", "15", "60", "120", "240", "0"]);
  assert.equal(choix.getAttribute("aria-labelledby"), "axe-sommeil-libelle");
  await act(async () => {
    choix.value = "0";
    choix.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await attendre();
  const set = appels.find(([, a]) => a?.input?.method === "sommeil.set");
  assert.deepEqual(set[1].input, { method: "sommeil.set", params: { conversationsMinutes: 0 }, connection: "local" });
  assert.equal(hote.querySelector("select.axe-sommeil__delai").value, "0");
  await act(async () => root.unmount());
});
