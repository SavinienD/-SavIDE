// raccourcisMac — sur macOS, Cmd/Option affichés et lus à la place de Ctrl/Alt.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
const P = charger("../src/lib/plateforme.ts");

test("détection : userAgentData, navigator.platform, userAgent", () => {
  assert.equal(P.estMac({ userAgentData: { platform: "macOS" } }), true);
  assert.equal(P.estMac({ platform: "MacIntel" }), true);
  assert.equal(P.estMac({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }), true);
  assert.equal(P.estMac({ platform: "Win32" }), false);
  assert.equal(P.estWindows({ userAgentData: { platform: "Windows" } }), true);
  assert.equal(P.estMac({ platform: "Linux x86_64" }), false);
});

test("affichage macOS : ⌘ ⌥ ⇧", () => {
  const f = (s) => P.formaterRaccourci(s, true);
  assert.equal(f("Ctrl + Maj + D"), "⇧⌘D");
  assert.equal(f("Ctrl + ,"), "⌘,");
  assert.equal(f("Ctrl + +"), "⌘+");
  assert.equal(f("Ctrl + −"), "⌘−");
  assert.equal(f("Ctrl+Alt+B"), "⌥⌘B");
  assert.equal(f("Ctrl + Page suiv."), "⌘ Page suiv.");
  assert.equal(f("Contrôle + Tab"), "⌃ Tab");
  assert.equal(f("Maj + Entrée"), "⇧ Entrée");
  assert.equal(f("Entrée × 2 (rapide)"), "Entrée × 2 (rapide)");
  assert.equal(P.formaterTexte("Dicter (Ctrl+Maj+D) : texte", true), "Dicter (⇧⌘D) : texte");
  assert.equal(P.formaterTexte("Réglages (Ctrl+,)", true), "Réglages (⌘,)");
  assert.equal(P.formaterTexte("ou Ctrl +, Ctrl −, Ctrl 0.", true).includes("Ctrl"), true); // phrase libre : non touchée hors « + »
});

test("Windows/Linux : inchangé", () => {
  assert.equal(P.formaterRaccourci("Ctrl + Maj + D", false), "Ctrl + Maj + D");
  assert.equal(P.formaterTexte("Réglages (Ctrl+,)", false), "Réglages (Ctrl+,)");
  assert.equal(P.formaterRaccourci("Contrôle + Tab", false), "Ctrl + Tab");
});

test("lecture : Cmd sur macOS, Ctrl ailleurs", () => {
  assert.equal(P.modPrincipal({ ctrlKey: false, metaKey: true }, true), true);
  assert.equal(P.modPrincipal({ ctrlKey: true, metaKey: false }, true), false);
  assert.equal(P.modPrincipal({ ctrlKey: true, metaKey: false }, false), true);
  assert.equal(P.modPrincipal({ ctrlKey: false, metaKey: true }, false), false);
});

test("aucun « Ctrl » écrit en dur dans les infobulles et le pense-bête", () => {
  for (const f of ["src/components/Workspace.tsx", "src/components/freechat/FreechatView.tsx", "src/components/chat/ChatPane.tsx", "src/axe/voix/DicteeBouton.tsx", "src/components/viewers/ImageZoom.tsx"]) {
    const s = lire("../" + f);
    assert.doesNotMatch(s, /title=\{?"[^"]*Ctrl/, f);
  }
  const sec = lire("../src/axe/RaccourcisSection.tsx");
  assert.match(sec, /formaterRaccourci\(r\.combinaison\)/);
  assert.doesNotMatch(sec, /Sur macOS, Ctrl = Cmd/);
});

test("détection centralisée : plus de /mac/ sur navigator.platform ailleurs", () => {
  for (const f of ["src/axe/raccourcis.ts", "src/components/Workspace.tsx", "src/components/FileTree.tsx", "src/components/WindowControls.tsx"]) {
    assert.doesNotMatch(lire("../" + f), /\/(mac|win)\/i\.test\(/, f);
  }
});

test("le terminal garde Ctrl+C (sens terminal) : pas de copie interceptée", () => {
  const t = lire("../src/components/TerminalPanel.tsx");
  assert.doesNotMatch(t, /key(?:\.toLowerCase\(\))? === "c"/);
});
