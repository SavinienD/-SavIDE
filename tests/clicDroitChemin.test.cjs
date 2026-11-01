const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

// Clic droit sur un chemin de fichier du chat : menu « Afficher dans
// l'explorateur », « Copier le chemin », « Copier le chemin relatif ». Scènes du banc : chemin-chat-*.
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
const remplacants = {
  "../../lib/ipc": { api: { openExternalUrl: async () => {} } },
  "./MermaidDiagram": { MermaidDiagram: () => null },
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
const { Markdown } = require(path.join(racine, "src/components/chat/Markdown.tsx"));
const { ActionsCheminChatContext } = require(path.join(racine, "src/components/chat/MenuCheminChat.tsx"));
const { cheminsACopier } = require(path.join(racine, "src/lib/cheminsChat.ts"));

function monter(actions, ouvrir = () => {}) {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const root = createRoot(hote);
  const md = React.createElement(Markdown, { text: "Voir `src/banc/etape-3.ts` puis la suite.", onOpenFile: ouvrir });
  act(() => root.render(actions ? React.createElement(ActionsCheminChatContext.Provider, { value: actions }, md) : md));
  return { hote, fin: () => act(() => root.unmount()) };
}
const clicDroit = (el) => {
  const ev = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 30 });
  act(() => el.dispatchEvent(ev));
  return ev;
};
const entrees = () => [...document.querySelectorAll(".chat-path-menu .tree-menu__item")];

test("clic droit sur un chemin : menu à trois entrées, actions avec le chemin cité", () => {
  const appels = [];
  const m = monter({ afficher: (c) => appels.push(["afficher", c]), copier: (c, g) => appels.push([g, c]) });
  const lien = m.hote.querySelector(".chat-file-link");
  const ev = clicDroit(lien);
  assert.equal(ev.defaultPrevented, true, "menu natif évité");
  assert.deepEqual(entrees().map((b) => b.textContent), ["Afficher dans l'explorateur", "Copier le chemin", "Copier le chemin relatif"]);
  assert.equal(m.hote.querySelector(".chat-path-menu"), null, "menu hors du fil (portail dans <body>)");
  for (const i of [0, 1, 2]) {
    if (!entrees().length) clicDroit(m.hote.querySelector(".chat-file-link"));
    act(() => entrees()[i].click());
    assert.equal(document.querySelector(".chat-path-menu"), null, "menu refermé après le choix");
  }
  assert.deepEqual(appels, [["afficher", "src/banc/etape-3.ts"], ["complet", "src/banc/etape-3.ts"], ["relatif", "src/banc/etape-3.ts"]]);
  m.fin();
});

test("clic droit : Échap et clic ailleurs referment le menu ; le clic gauche ouvre toujours", () => {
  const ouverts = [];
  const m = monter({ copier: () => {} }, (p) => ouverts.push(p));
  const lien = m.hote.querySelector(".chat-file-link");
  clicDroit(lien);
  assert.deepEqual(entrees().map((b) => b.textContent), ["Copier le chemin", "Copier le chemin relatif"], "sans explorateur : pas d'« Afficher »");
  act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(entrees().length, 0);
  clicDroit(lien);
  act(() => document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })));
  assert.equal(entrees().length, 0);
  act(() => lien.click());
  assert.deepEqual(ouverts, ["src/banc/etape-3.ts"]);
  m.fin();
});

test("sans actions (hors du chat) : pas de menu, le menu natif reste", () => {
  const m = monter(null);
  const ev = clicDroit(m.hote.querySelector(".chat-file-link"));
  assert.equal(ev.defaultPrevented, false);
  assert.equal(entrees().length, 0);
  m.fin();
});

test("cheminsACopier : complet et relatif, Windows et Linux, hors de l'espace", () => {
  assert.deepEqual(cheminsACopier("src/banc/etape-3.ts:12", "\\\\?\\C:\\Projets\\atelier", true), { complet: "C:\\Projets\\atelier\\src\\banc\\etape-3.ts", relatif: "src\\banc\\etape-3.ts" });
  assert.deepEqual(cheminsACopier("`./mcp/flux.json`", "/home/u/projet/", false), { complet: "/home/u/projet/mcp/flux.json", relatif: "mcp/flux.json" });
  assert.deepEqual(cheminsACopier("/home/u/projet/mcp/flux.json", "/home/u/projet", false), { complet: "/home/u/projet/mcp/flux.json", relatif: "mcp/flux.json" });
  assert.deepEqual(cheminsACopier("/etc/hosts", "/home/u/projet", false), { complet: "/etc/hosts", relatif: null });
});
