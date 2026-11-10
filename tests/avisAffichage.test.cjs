"use strict";
// Avis « l'affichage a été relancé » et traces des pannes d'affichage.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const A = require(path.resolve(__dirname, "../src/lib/avisAffichage.ts"));
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("l'avis s'ouvre au signal, prévient les abonnés et se ferme", () => {
  let appels = 0;
  const arreter = A.abonnerAvis(() => (appels += 1));
  assert.equal(A.avisVisible(), false);
  A.signalerRelance();
  assert.equal(A.avisVisible(), true);
  A.fermerAvis();
  assert.equal(A.avisVisible(), false);
  A.fermerAvis(); // déjà fermé : personne n'est prévenu
  assert.equal(appels, 2);
  arreter();
  A.signalerRelance();
  assert.equal(appels, 2);
  A.fermerAvis();
});

test("l'avis n'est montré qu'après un rechargement demandé par le gardien", () => {
  const app = lire("../src/App.tsx");
  assert.match(app, /if \(repriseDemandee === true\) signalerRelance\(\)/);
  assert.match(lire("../src/main.tsx"), /<AvisAffichageRelance \/>/);
});

test("une erreur d'affichage rattrapée est notée dans le journal de la page", () => {
  const eb = lire("../src/components/ErrorBoundary.tsx");
  assert.match(eb, /componentDidCatch[\s\S]*invoke\("page_journal"/);
});

test("le gardien du rendu est branché sur macOS et Linux", () => {
  const rs = lire("../src-tauri/src/gardien_page.rs");
  assert.match(rs, /webViewWebContentProcessDidTerminate:/);
  assert.match(rs, /connect_web_process_terminated/);
  assert.match(rs, /#\[cfg\(target_os = "macos"\)\]\s*macos_wkwebview::brancher/);
});
