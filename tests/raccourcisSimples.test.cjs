"use strict";
// raccourcis-simples — combinaisons courtes et standard (navigateur, VS Code) à la place
// des combinaisons à trois touches : Ctrl+T, Ctrl+N, Ctrl+Tab, Échap, Ctrl+D.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const memoire = new Map();
global.localStorage = {
  getItem: (k) => (memoire.has(k) ? memoire.get(k) : null),
  setItem: (k, v) => memoire.set(k, String(v)),
  removeItem: (k) => memoire.delete(k),
};
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const R = require(path.resolve(__dirname, "../src/axe/raccourcis.ts"));
const ev = (o) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, key: "", code: "", ...o });
const reg = (id) => R.RACCOURCIS.find((x) => x.id === id);
const court = (id, mac = false) => R.combinaisonCourte(id, mac);

test("nouveaux raccourcis : Ctrl+T, Ctrl+Tab, Ctrl+Maj+Tab, Échap, Ctrl+D", () => {
  assert.equal(court("nouvelleConversation"), "Ctrl+T");
  assert.equal(court("conversationSuivante"), "Ctrl+Tab");
  assert.equal(court("conversationPrecedente"), "Ctrl+Maj+Tab");
  assert.equal(court("stop"), "Échap");
  assert.equal(court("dictee"), "Ctrl+D");
  // inchangés (demande : Ctrl+1…9, Ctrl+Maj+E, Ctrl+Maj+T)
  assert.equal(court("focusExplorateur"), "Ctrl+Maj+E");
  assert.equal(court("focusChat"), "Ctrl+Maj+T");
  assert.equal(R.combinaisonNumero("dossierRecent", 2), "Ctrl+2");
});

test("lecture au clavier (Windows)", () => {
  assert.ok(R.correspond(reg("nouvelleConversation"), ev({ ctrlKey: true, key: "t", code: "KeyT" }), false));
  assert.ok(!R.correspond(reg("nouvelleConversation"), ev({ ctrlKey: true, shiftKey: true, key: "T", code: "KeyT" }), false));
  assert.ok(R.correspond(reg("conversationSuivante"), ev({ ctrlKey: true, key: "Tab", code: "Tab" }), false));
  assert.ok(!R.correspond(reg("conversationSuivante"), ev({ ctrlKey: true, shiftKey: true, key: "Tab", code: "Tab" }), false));
  assert.ok(R.correspond(reg("conversationPrecedente"), ev({ ctrlKey: true, shiftKey: true, key: "Tab", code: "Tab" }), false));
  assert.ok(R.correspond(reg("stop"), ev({ key: "Escape", code: "Escape" }), false));
  assert.ok(!R.correspond(reg("stop"), ev({ ctrlKey: true, key: "Escape", code: "Escape" }), false));
  assert.ok(R.correspond(reg("dictee"), ev({ ctrlKey: true, key: "d", code: "KeyD" }), false));
});

test("macOS : ⌘T, ⌘N, ⌘D ; ⌃Tab (⌘Tab appartient au système)", () => {
  assert.equal(court("nouvelleConversation", true), "⌘T");
  assert.equal(court("conversationSuivante", true), "⌃ Tab");
  assert.equal(court("conversationPrecedente", true), "⌃⇧ Tab");
  assert.ok(R.correspond(reg("conversationSuivante"), ev({ ctrlKey: true, key: "Tab", code: "Tab" }), true));
  assert.ok(!R.correspond(reg("conversationSuivante"), ev({ metaKey: true, key: "Tab", code: "Tab" }), true));
  assert.ok(R.correspond(reg("nouvelleConversation"), ev({ metaKey: true, key: "t", code: "KeyT" }), true));
});

test("plus aucune combinaison lourde (Maj + Page, Retour arrière, Ctrl+Alt+Maj)", () => {
  for (const r of R.RACCOURCIS) {
    const t = r.touche;
    if (!t.touches.length) continue;
    assert.ok(!(t.shift && t.touches.some((k) => /^page/.test(k))), `${r.id} : ${r.combinaison}`);
    assert.ok(!t.touches.includes("backspace"), `${r.id} : ${r.combinaison}`);
    assert.ok(!(t.ctrl && t.alt && t.shift), `${r.id} : ${r.combinaison}`);
  }
});

test("pas de Ctrl+Alt sur une touche qui donne un caractère avec AltGr (clavier français)", () => {
  const altgr = ["2", "3", "4", "5", "6", "7", "8", "9", "0", "e", ")", "=", "code:Digit2", "code:Digit3", "code:Digit4", "code:Digit5", "code:Digit6", "code:Digit7", "code:Digit8", "code:Digit9", "code:Digit0", "code:KeyE", "code:Minus", "code:Equal"];
  for (const r of R.RACCOURCIS) {
    if (!(r.touche.ctrl && r.touche.alt)) continue;
    for (const k of r.touche.touches) assert.ok(!altgr.includes(k), `${r.id} : Ctrl+Alt+${k} = AltGr`);
  }
});

test("menu natif (Linux / macOS) : Ctrl+Maj+N et Ctrl+W restent au menu, la page ne les prend pas en double", () => {
  const rs = fs.readFileSync(path.resolve(__dirname, "../src-tauri/src/platform.rs"), "utf8");
  assert.match(rs, /accelerator\("CmdOrCtrl\+Shift\+N"\)/);
  for (const r of R.RACCOURCIS) {
    if (r.touche.ctrl && r.touche.shift && !r.touche.alt) assert.ok(!r.touche.touches.includes("n"), `${r.id} prend Ctrl+Maj+N`);
  }
});

test("Ctrl+T, Ctrl+D laissés au terminal (shell : transposer, fin de saisie)", () => {
  for (const id of ["nouvelleConversation", "dictee"]) {
    const r = reg(id);
    assert.ok(r.horsTerminal || r.horsEditeur, `${id} pris au terminal`);
  }
  assert.ok(reg("dictee").horsEditeur, "Ctrl+D laissé à l'éditeur (occurrence suivante)");
  const terminal = { closest: (s) => (s.includes(".xterm") ? {} : null) };
  assert.equal(R.dansTerminal(terminal), true);
  assert.equal(R.dansTerminal({ closest: () => null }), false);
});

test("une action peut refuser la touche (renvoie false) : pas de preventDefault, la touche continue", () => {
  let appelee = 0;
  let empeche = 0;
  const retirer = R.fournirActions({ stop: () => { appelee++; return false; } });
  const e = { ...ev({ key: "Escape", code: "Escape" }), target: null, preventDefault: () => empeche++, stopPropagation: () => empeche++ };
  R.traiterTouche(e);
  assert.equal(appelee, 1);
  assert.equal(empeche, 0);
  retirer();
  const retirer2 = R.fournirActions({ stop: () => { appelee++; } });
  R.traiterTouche(e);
  assert.equal(appelee, 2);
  assert.equal(empeche, 2);
  retirer2();
});

test("Ctrl+\\ affiché selon le clavier (AZERTY : la touche * à côté d'Entrée)", () => {
  assert.equal(court("colonneChat"), "Ctrl+\\");
  R.definirDispositionClavier(new Map([["Backslash", "*"], ["KeyA", "q"]]));
  assert.equal(court("colonneChat"), "Ctrl+*");
  R.definirDispositionClavier(null);
  assert.equal(court("colonneChat"), "Ctrl+\\");
});
