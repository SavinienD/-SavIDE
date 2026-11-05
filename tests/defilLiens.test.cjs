const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

// defil178 — cliquer sur un lien du chat (fichier, URL, lien Markdown) ne fait plus bouger la
// conversation : les messages ne sont plus recréés (Markdown) et changer de colonne ne recrée
// plus les fils (Workspace). Scènes du banc : defil-liens et defil-liens-c2.
const dom = new JSDOM("<!doctype html><body></body>");
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.IS_REACT_ACT_ENVIRONMENT = true;

const racine = path.resolve(__dirname, "..");
const lire = (rel) => fs.readFileSync(path.join(racine, rel), "utf8");
for (const ext of [".ts", ".tsx"]) {
  Module._extensions[ext] = (module, filename) => {
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    module._compile(js, filename);
  };
}
// Ni Tauri ni mermaid ici : le pont IPC et les diagrammes sont remplacés.
const ouvertes = [];
const remplacants = {
  "../../lib/ipc": { api: { openExternalUrl: async (url) => { ouvertes.push(url); } } },
  "./MermaidDiagram": { MermaidDiagram: () => null },
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

const TEXTE = "Détail dans `src/banc/etape-1.ts`, la [notice du banc](https://docs.exemple.fr/banc) et https://github.com/axe/axecode/actions/runs/42.";
function monter() {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const root = createRoot(hote);
  return { hote, rendre: (props) => act(() => root.render(React.createElement(Markdown, props))), fin: () => act(() => root.unmount()) };
}
const liens = (hote) => [...hote.querySelectorAll(".chat-file-link, .chat-link")];

test("Markdown : un morceau de texte de plus ne recrée pas les liens déjà affichés", () => {
  const m = monter();
  const ouvrir = () => {};
  m.rendre({ text: TEXTE, onOpenFile: ouvrir });
  const avant = liens(m.hote);
  assert.equal(avant.length, 3);
  m.rendre({ text: TEXTE + "\n\nSuite du tour : je relance le banc.", onOpenFile: ouvrir });
  const apres = liens(m.hote);
  assert.equal(apres.length, 3);
  avant.forEach((el, i) => assert.equal(apres[i], el, `lien ${i} recréé`));
  m.fin();
});

test("Markdown : un nouveau rappel onOpenFile (onglet ouvert) ne recrée rien et c'est lui qui sert", () => {
  const m = monter();
  const appels = [];
  m.rendre({ text: TEXTE, onOpenFile: (p) => appels.push(["ancien", p]) });
  const avant = liens(m.hote);
  m.rendre({ text: TEXTE, onOpenFile: (p) => appels.push(["nouveau", p]) });
  const apres = liens(m.hote);
  avant.forEach((el, i) => assert.equal(apres[i], el, `lien ${i} recréé`));
  act(() => apres[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(appels, [["nouveau", "src/banc/etape-1.ts"]]);
  act(() => apres[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
  assert.deepEqual(ouvertes, ["https://docs.exemple.fr/banc"]);
  m.fin();
});

test("ChatPane : rappel d'ouverture stable pour les messages et la liste des tâches", () => {
  const pane = lire("src/components/chat/ChatPane.tsx");
  assert.match(pane, /const ouvrirFichier = useCallback\(\(path: string\) => onOpenFileRef\.current\(path\), \[\]\);/);
  assert.equal((pane.match(/onOpenFile=\{ouvrirFichier\}/g) ?? []).length, 4); // messages, liste des tâches, barre des liens, message de la file en cours d'envoi
});

test("Workspace : changer de colonne ne recrée pas les fils, chaque colonne garde sa conversation", () => {
  const ws = lire("src/components/Workspace.tsx");
  // une seule clé pour le ChatPane d'une colonne (avant : « chat-focus » / « chat-<id> »)
  assert.match(ws, /<ChatPane\s*\n(?:\s*\/\/[^\n]*\n)*\s*key="chat"\n/);
  assert.doesNotMatch(ws, /"chat-focus"/);
  // la colonne qui prend le focus montre la sienne tant que la conversation active n'a pas suivi
  assert.match(ws, /const visible = visibleDeColonne\(colonne\);\n\s*const actifIci = visible !== null && visible === activeConv\.id;/);
  assert.match(ws, /\) : actifIci \? \(\s*chatDetache === activeConv\.id \?/);
  assert.match(ws, /if \(id && id !== activeConv\.id\) aCharger\.add\(id\);/);
});
