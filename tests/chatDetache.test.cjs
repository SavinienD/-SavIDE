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
global.IS_REACT_ACT_ENVIRONMENT = true;

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = require("react");
const { ChatCloseButton } = charger("../src/components/chat/ChatCloseButton.tsx");
const C = charger("../src/components/chat/colonnes.ts");

function monter(el) {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const root = createRoot(hote);
  act(() => root.render(el));
  return { hote, root };
}
const cliquer = (el) => act(() => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const bouton = (hote, texte) => [...hote.querySelectorAll("button")].find((b) => b.textContent.includes(texte));

test("✕ du chat détaché : Archiver (confirmé) retire l'id de colonnesChat", async () => {
  let etat = { colonnes: [["a"], ["b"]], focus: 1 };
  const { hote, root } = monter(
    React.createElement(ChatCloseButton, {
      conversationId: "b",
      peutArchiver: true,
      confirmer: () => true,
      onReancrer: () => assert.fail("ne doit pas ré-ancrer"),
      onArchiver: async (id) => {
        etat = C.retirer(etat, id);
      },
    }),
  );
  cliquer(hote.querySelector(".chat-close"));
  cliquer(bouton(hote, "Archiver"));
  await Promise.resolve();
  assert.deepEqual(etat.colonnes, [["a"]]);
  act(() => root.unmount());
});

test("✕ : refuser la confirmation ré-ancre sans archiver", () => {
  let reancre = 0;
  const { hote, root } = monter(
    React.createElement(ChatCloseButton, {
      conversationId: "b", peutArchiver: true, confirmer: () => false,
      onReancrer: () => (reancre += 1), onArchiver: () => assert.fail("pas d'archive"),
    }),
  );
  cliquer(hote.querySelector(".chat-close"));
  cliquer(bouton(hote, "Archiver"));
  assert.equal(reancre, 1);
  act(() => root.unmount());
});

test("✕ en local : seul « Ré-ancrer » est proposé", () => {
  const { hote, root } = monter(
    React.createElement(ChatCloseButton, {
      conversationId: "b", peutArchiver: false, onReancrer() {}, onArchiver() {},
    }),
  );
  cliquer(hote.querySelector(".chat-close"));
  assert.ok(bouton(hote, "Ré-ancrer"));
  assert.equal(bouton(hote, "Archiver"), undefined);
  act(() => root.unmount());
});

test("détacher le seul onglet : la colonne se replie en liseré de 34 px (règle Workspace)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/components/Workspace.tsx"), "utf8");
  assert.match(src, /chatDetacheSeul\s*=\s*\n?\s*chatDetache !== null && ongletsChat\.filter/);
  assert.match(src, /droiteRepliee\s*\n?\s*\? \{ width: 34, flex: "0 0 34px"/);
  // et la fenêtre détachée rend bien le fil (chatPane ou instantané de la colonne)
  assert.match(src, /chatDetache === activeConv\.id \? \(\s*chatPane/);
  assert.match(src, /renduChatPane\(conversationsColonnes\[chatDetache\], false\)/);
});
