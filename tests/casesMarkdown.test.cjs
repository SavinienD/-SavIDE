const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

// cases à cocher cliquables dans l'aperçu Markdown. Scènes du banc : cases-*.
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
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    module._compile(js, filename);
  };
}
const { basculerCase, caseDansLigne } = require(path.join(racine, "src/components/chat/casesMarkdown.ts"));

const QCM = [
  "# QCM", "", "<!-- id: q1 -->", "1. Choix ?", "", "- [ ] oui", "- [x] non", "",
  "```md", "- [ ] pas une case", "```", "", "<!-- id: q2 -->", "* [X] déjà", "  1. [ ] imbriquée", "> - [ ] citée", "",
].join("\n");

test("coche, décoche [x] et [X], sans toucher au reste", () => {
  const a = basculerCase(QCM, 6);
  assert.equal(a, QCM.replace("- [ ] oui", "- [x] oui"));
  assert.equal(basculerCase(QCM, 7), QCM.replace("- [x] non", "- [ ] non"));
  assert.equal(basculerCase(QCM, 14), QCM.replace("* [X] déjà", "* [ ] déjà"));
  assert.equal(basculerCase(QCM, 15), QCM.replace("1. [ ] imbriquée", "1. [x] imbriquée"));
  assert.equal(basculerCase(QCM, 16), QCM.replace("> - [ ] citée", "> - [x] citée"));
  assert.equal(basculerCase(a, 6), QCM, "aller-retour");
});

test("lignes sans case : rien (commentaires id, titres, hors limites)", () => {
  for (const n of [0, 1, 3, 4, 99, 1.5]) assert.equal(basculerCase(QCM, n), null);
  assert.equal(caseDansLigne("- [y] non"), null);
  assert.equal(caseDansLigne("texte - [ ] milieu"), null);
});

test("CRLF gardé", () => {
  const crlf = QCM.replace(/\n/g, "\r\n");
  const r = basculerCase(crlf, 6);
  assert.equal(r, crlf.replace("- [ ] oui", "- [x] oui"));
  assert.equal((r.match(/\r\n/g) || []).length, (crlf.match(/\r\n/g) || []).length);
});

test("aperçu : cases cliquables sur la bonne ligne, celles du code ignorées", async () => {
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const { act } = require("react");
  const remplacants = {
    "../../lib/ipc": { api: { openExternalUrl: async () => {} } },
    "./MermaidDiagram": { MermaidDiagram: () => null },
    "@iconify/react": { Icon: () => null },
  };
  const charger = Module._load;
  Module._load = function (demande, parent, ...reste) {
    if (remplacants[demande]) return remplacants[demande];
    return charger.call(this, demande, parent, ...reste);
  };
  let Markdown;
  try {
    ({ Markdown } = require(path.join(racine, "src/components/chat/Markdown.tsx")));
  } catch (e) {
    Module._load = charger;
    throw e;
  }
  Module._load = charger;
  const lignes = [];
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const racineR = createRoot(hote);
  await act(async () => {
    racineR.render(React.createElement(Markdown, { text: QCM.replace(/\n/g, "\r\n"), onOpenFile: () => {}, onToggleTask: (n) => lignes.push(n) }));
  });
  const cases = [...hote.querySelectorAll("input[type=checkbox]")];
  assert.equal(cases.length, 5, "la fausse case du code n'est pas une case");
  assert.deepEqual(cases.map((c) => c.checked), [false, true, true, false, false]);
  assert.ok(cases.every((c) => !c.disabled));
  for (const c of cases) await act(async () => c.click());
  assert.deepEqual(lignes, [6, 7, 14, 15, 16]);
  assert.equal(hote.querySelector("pre").textContent.includes("- [ ] pas une case"), true);
  // sans onToggleTask (chat) : cases figées comme avant
  await act(async () => racineR.render(React.createElement(Markdown, { text: QCM, onOpenFile: () => {} })));
  assert.ok([...hote.querySelectorAll("input[type=checkbox]")].every((c) => c.disabled));
  await act(async () => racineR.unmount());
});
