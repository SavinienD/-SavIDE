const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

// copie-selection — sélection qui traverse un bloc de code : lignes entières copiées. Scène du banc : copie-selection-code.
const racine = path.resolve(__dirname, "..");
for (const ext of [".ts", ".tsx"]) {
  Module._extensions[ext] = (module, filename) => {
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    module._compile(js, filename);
  };
}
const { texteCopie, installerCopieSelection } = require(path.join(racine, "src/components/chat/copieSelection.ts"));

const LONGUE = "/* " + "x".repeat(300) + " FIN */";
function page() {
  const dom = new JSDOM(`<!doctype html><body><div class="md"><p>Texte  au-dessus</p>` +
    `<div class="bloc-copie"><pre><code><span>a { b: 1; }</span>\n<span>${LONGUE}</span>\nc { d: 2; }\n</code></pre><button>Copier</button></div>` +
    `<p>Après</p></div></body>`);
  return dom.window.document;
}
const texteDe = (n) => n.childNodes[0];

test("début dans le texte, fin au milieu de la ligne longue : ligne entière", () => {
  const doc = page();
  const r = doc.createRange();
  r.setStart(texteDe(doc.querySelector("p")), 0);
  const span = doc.querySelectorAll("pre span")[1];
  r.setEnd(texteDe(span), 40);
  assert.equal(texteCopie(r).texte, "Texte au-dessus\na { b: 1; }\n" + LONGUE);
});

test("sélection qui couvre tout le bloc : texte normal autour + lignes complètes", () => {
  const doc = page();
  const r = doc.createRange();
  const ps = doc.querySelectorAll("p");
  r.setStart(texteDe(ps[0]), 6);
  r.setEnd(texteDe(ps[1]), 5);
  const res = texteCopie(r);
  assert.equal(res.texte, "au-dessus\na { b: 1; }\n" + LONGUE + "\nc { d: 2; }\nAprès");
  assert.ok(!res.html.includes("Copier"));
});

test("début au milieu d'une ligne du bloc, fin après : la ligne part du début", () => {
  const doc = page();
  const r = doc.createRange();
  r.setStart(texteDe(doc.querySelectorAll("pre span")[1]), 50);
  r.setEnd(texteDe(doc.querySelectorAll("p")[1]), 5);
  assert.equal(texteCopie(r).texte, LONGUE + "\nc { d: 2; }\nAprès");
});

test("sélection hors bloc ou dans un seul bloc : le navigateur garde la main", () => {
  const doc = page();
  const r = doc.createRange();
  r.setStart(texteDe(doc.querySelector("p")), 0);
  r.setEnd(texteDe(doc.querySelector("p")), 5);
  assert.equal(texteCopie(r), null);
  const s = doc.querySelectorAll("pre span")[1];
  r.setStart(texteDe(s), 1);
  r.setEnd(texteDe(s), 9);
  assert.equal(texteCopie(r), null);
});

test("évènement copy : presse-papiers rempli, défaut empêché", () => {
  const doc = page();
  installerCopieSelection(doc);
  const r = doc.createRange();
  r.setStart(texteDe(doc.querySelector("p")), 0);
  r.setEnd(texteDe(doc.querySelectorAll("p")[1]), 5);
  const sel = doc.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  const donnees = {};
  const ev = new doc.defaultView.Event("copy", { bubbles: true, cancelable: true });
  ev.clipboardData = { setData: (t, v) => { donnees[t] = v; } };
  doc.body.dispatchEvent(ev);
  assert.ok(ev.defaultPrevented);
  assert.ok(donnees["text/plain"].includes(LONGUE));
});
