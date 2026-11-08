"use strict";
// raccourcis-modifiables — chaque raccourci se change dans Réglages > Raccourcis : la combinaison
// tapée est vérifiée (conflit, touche réservée), enregistrée, et lue partout (registre central).
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

test("lecture d'une combinaison tapée : libellé, modificateurs seuls = on attend", () => {
  assert.equal(R.lireCombinaison(ev({ ctrlKey: true, key: "Control", code: "ControlLeft" }), false), null);
  const k = R.lireCombinaison(ev({ ctrlKey: true, key: "k", code: "KeyK" }), false);
  assert.equal(k.combinaison, "Ctrl + K");
  const p = R.lireCombinaison(ev({ ctrlKey: true, shiftKey: true, key: "PageDown", code: "PageDown" }), false);
  assert.equal(p.combinaison, "Ctrl + Maj + Page suiv.");
  assert.equal(R.lireCombinaison(ev({ key: "F2", code: "F2" }), false).combinaison, "F2");
  // AZERTY : Ctrl + touche « ! » (code Slash) : libellé = caractère tapé, lecture par la touche physique.
  const s = R.lireCombinaison(ev({ ctrlKey: true, key: "!", code: "Slash" }), false);
  assert.equal(s.combinaison, "Ctrl + !");
  assert.deepEqual(s.touche.touches, ["code:Slash"]);
  // macOS : ⌘ = Ctrl du registre.
  assert.equal(R.lireCombinaison(ev({ metaKey: true, key: "k", code: "KeyK" }), true).combinaison, "Ctrl + K");
});

test("vérification : lettre seule, touche réservée, AltGr, conflit", () => {
  const verif = (id, o, mac = false) => R.verifierCombinaison(id, R.lireCombinaison(ev(o), mac), mac);
  assert.match(verif("archiver", { key: "k", code: "KeyK" }), /Ctrl/);
  assert.match(verif("archiver", { shiftKey: true, key: "K", code: "KeyK" }), /Ctrl/);
  assert.match(verif("archiver", { ctrlKey: true, key: "c", code: "KeyC" }), /Copier/);
  assert.match(verif("archiver", { ctrlKey: true, key: "3", code: "Digit3" }), /dossier/i);
  assert.match(verif("archiver", { ctrlKey: true, altKey: true, key: "€", code: "KeyE" }), /AltGr/);
  assert.match(verif("archiver", { ctrlKey: true, key: "t", code: "KeyT" }), /Nouvelle conversation/);
  // Ctrl+K est pris par « Aller à » : une autre combinaison libre sert d'exemple.
  assert.match(verif("archiver", { ctrlKey: true, key: "k", code: "KeyK" }), /Aller à/);
  assert.equal(verif("archiver", { ctrlKey: true, altKey: true, key: "k", code: "KeyK" }), null);
  assert.equal(verif("nouvelleConversation", { ctrlKey: true, key: "t", code: "KeyT" }), null, "sa propre combinaison");
  assert.equal(verif("archiver", { key: "F2", code: "F2" }), null);
});

test("changement enregistré, persistant et lu partout ; « par défaut » le retire", () => {
  memoire.clear();
  const r = reg("nouvelleConversation");
  R.definirRaccourci("nouvelleConversation", R.lireCombinaison(ev({ ctrlKey: true, key: "k", code: "KeyK" }), false));
  assert.ok(memoire.get(R.CLE_RACCOURCIS).includes("nouvelleConversation"));
  assert.ok(R.correspond(r, ev({ ctrlKey: true, key: "k", code: "KeyK" }), false));
  assert.ok(!R.correspond(r, ev({ ctrlKey: true, key: "t", code: "KeyT" }), false));
  assert.equal(R.combinaisonCourte("nouvelleConversation", false), "Ctrl+K");
  assert.equal(R.combinaisonCourte("nouvelleConversation", true), "⌘K");
  assert.equal(R.infoBulle("Nouvelle conversation", "nouvelleConversation", false), "Nouvelle conversation · Ctrl+K");
  assert.equal(R.estModifie("nouvelleConversation"), true);
  // relu depuis le stockage (redémarrage)
  R.rechargerRaccourcis();
  assert.equal(R.combinaisonCourte("nouvelleConversation", false), "Ctrl+K");
  // l'ancienne combinaison est libre : un autre raccourci peut la prendre
  assert.equal(R.verifierCombinaison("archiver", R.lireCombinaison(ev({ ctrlKey: true, key: "t", code: "KeyT" }), false), false), null);
  R.definirRaccourci("nouvelleConversation", null);
  assert.equal(R.combinaisonCourte("nouvelleConversation", false), "Ctrl+T");
  assert.equal(R.estModifie("nouvelleConversation"), false);
});

test("tout remettre par défaut ; données abîmées ignorées", () => {
  memoire.clear();
  R.definirRaccourci("archiver", R.lireCombinaison(ev({ ctrlKey: true, key: "k", code: "KeyK" }), false));
  R.reinitialiserRaccourcis();
  assert.equal(R.combinaisonCourte("archiver", false), "Ctrl+Maj+A");
  memoire.set(R.CLE_RACCOURCIS, "{pas du json");
  R.rechargerRaccourcis();
  assert.equal(R.combinaisonCourte("archiver", false), "Ctrl+Maj+A");
  memoire.set(R.CLE_RACCOURCIS, JSON.stringify({ archiver: { touche: { touches: "x" } }, inconnu: {} }));
  R.rechargerRaccourcis();
  assert.equal(R.combinaisonCourte("archiver", false), "Ctrl+Maj+A");
});

test("modifiables : les vraies touches ; pas les gestes ni la famille Ctrl+1…9", () => {
  assert.equal(R.estModifiable(reg("nouvelleConversation")), true);
  assert.equal(R.estModifiable(reg("stop")), true);
  assert.equal(R.estModifiable(reg("dossierRecent")), false);
  assert.equal(R.estModifiable(reg("entreeEnvoyer")), false);
  assert.equal(R.estModifiable(reg("fermerMolette")), false);
});

test("pastilles : une par touche (Windows : Ctrl, Maj, N ; macOS : ⇧, ⌘, N)", () => {
  memoire.clear();
  R.rechargerRaccourcis();
  assert.deepEqual(R.partiesCombinaison(reg("archiver"), false), ["Ctrl", "Maj", "A"]);
  assert.deepEqual(R.partiesCombinaison(reg("archiver"), true), ["⇧", "⌘", "A"]);
  assert.deepEqual(R.partiesCombinaison(reg("zoomPlus"), false), ["Ctrl", "+"]);
  assert.deepEqual(R.partiesCombinaison(reg("ongletSuivant"), true), ["⌘", "Page suiv."]);
  assert.deepEqual(R.partiesCombinaison(reg("conversationPrecedente"), true), ["⌃", "⇧", "Tab"]);
  assert.deepEqual(R.partiesCombinaison(reg("stop"), false), ["Échap"]);
});

test("pendant l'enregistrement d'une combinaison, les raccourcis ne se déclenchent pas", () => {
  let n = 0;
  const retirer = R.fournirActions({ archiver: () => { n++; } });
  const e = { ...ev({ ctrlKey: true, shiftKey: true, key: "A", code: "KeyA" }), target: null, preventDefault() {}, stopPropagation() {} };
  R.suspendreRaccourcis(true);
  R.traiterTouche(e);
  assert.equal(n, 0);
  R.suspendreRaccourcis(false);
  R.traiterTouche(e);
  assert.equal(n, 1);
  retirer();
});

test("l'onglet Raccourcis : clic = enregistrement, « Par défaut », plus de tableau étroit", () => {
  const s = fs.readFileSync(path.resolve(__dirname, "../src/axe/RaccourcisSection.tsx"), "utf8");
  assert.match(s, /lireCombinaison\(/);
  assert.match(s, /verifierCombinaison\(/);
  assert.match(s, /definirRaccourci\(/);
  assert.match(s, /Par défaut/);
  assert.doesNotMatch(s, /overflowWrap: "anywhere"/);
  assert.doesNotMatch(s, /<table/);
});
