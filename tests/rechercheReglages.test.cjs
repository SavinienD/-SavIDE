"use strict";
// Recherche dans les Réglages : champ en haut, sections et réglages filtrés par
// mot, sans tenir compte des accents ni de la casse ; chaque titre de l'index existe dans le volet.
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
const racine = path.resolve(__dirname, "..");
const RR = require(path.join(racine, "src/components/palette/rechercheReglages.ts"));
const lire = (p) => fs.readFileSync(path.join(racine, p), "utf8");
const ids = (r) => r.map((s) => `${s.section.id}:${s.reglages.map((x) => x.reglage.titre).join("|")}`);

test("un mot, sans accents ni casse : la section et ses réglages", () => {
  const r = RR.chercherReglages("ZOOM");
  assert.deepEqual(r.map((s) => s.section.id), ["appearance", "shortcuts"]);
  assert.equal(r[0].reglages[0].reglage.titre, "Zoom de l'interface");
  assert.deepEqual(r[0].reglages[0].marques, [0, 1, 2, 3]);
  assert.deepEqual(RR.chercherReglages("dictee").map((s) => s.section.id), RR.chercherReglages("DICTÉE").map((s) => s.section.id));
  assert.ok(RR.chercherReglages("dictée").some((s) => s.section.id === "voice"));
});

test("le nom d'une section la propose seule ; les mots-clés trouvent un réglage", () => {
  const r = RR.chercherReglages("apparence");
  assert.equal(r.length, 1);
  assert.equal(r[0].section.id, "appearance");
  assert.equal(r[0].reglages.length, 0, "pas toute la section listée pour son seul nom");
  assert.ok(ids(RR.chercherReglages("whisper")).some((x) => x.startsWith("voice:Modèle")));
  assert.ok(ids(RR.chercherReglages("ollama")).includes("providers:Fournisseurs configurables"));
  assert.deepEqual(RR.chercherReglages("mot-qui-n-existe-pas"), []);
  assert.deepEqual(RR.chercherReglages("   "), []);
});

test("plusieurs mots : tous requis (réglage + section)", () => {
  const r = RR.chercherReglages("repl compactage");
  assert.deepEqual(ids(r), ["repl:Compactage automatique"]);
  assert.deepEqual(RR.chercherReglages("voix compactage"), []);
});

test("les raccourcis du registre sont cherchables (section Raccourcis)", () => {
  const r = RR.chercherReglages("ouvrir un fichier");
  const s = r.find((x) => x.section.id === "shortcuts");
  assert.ok(s && s.reglages.some((x) => x.reglage.titre === "Ouvrir un fichier par son nom"));
});

test("index honnête : chaque titre est affiché par le code de sa section", () => {
  const fichiers = {
    about: ["src/components/SettingsPane.tsx"],
    appearance: ["src/axe/AppearanceSection.tsx"],
    providers: ["src/components/SettingsPane.tsx", "src/axe/CustomProvidersPanel.tsx"],
    mcp: ["src/components/SettingsPane.tsx"],
    skills: ["src/components/SettingsPane.tsx"],
    harness: ["src/components/settings/HarnessPane.tsx", "src/axe/HarnessBackupSection.tsx"],
    repl: ["src/components/settings/ReplToolsPane.tsx", "src/components/settings/ReplServicesSection.tsx"],
    voice: ["src/axe/voix/VoixSection.tsx"],
  };
  for (const r of RR.REGLAGES) {
    const code = (fichiers[r.section] ?? []).map(lire).join("\n");
    assert.ok(code.includes(r.titre) || code.includes(`"${r.titre}"`), `« ${r.titre} » introuvable dans la section ${r.section}`);
  }
});

test("signalement : l'élément qui affiche exactement le titre est retrouvé", () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(`<div class="settings-pane__main"><h3>Zoom de l'interface</h3><p>Zoom de l'interface entière, texte long</p><span>Préréglages</span></div>`);
  const r = dom.window.document.querySelector(".settings-pane__main");
  assert.equal(RR.elementDuReglage(r, "zoom de l'INTERFACE").tagName, "H3");
  assert.equal(RR.elementDuReglage(r, "Préréglages").tagName, "SPAN");
  assert.equal(RR.elementDuReglage(r, "Absent"), null);
});

test("branché : champ en haut du volet des Réglages (une ligne) ; Ctrl+K trouve aussi les réglages", () => {
  const volet = lire("src/components/SettingsPane.tsx");
  assert.match(volet, /<RechercheReglages section=\{section\}/);
  const aller = lire("src/components/palette/PaletteAller.tsx");
  assert.match(aller, /tousLesReglages\(\)/);
  assert.match(lire("src/components/palette/palette.css"), /\.settings-pane__nav:has\(\.recherche-reglages\[data-active="true"\]\)/);
});
