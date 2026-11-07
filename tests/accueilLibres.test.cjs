"use strict";
// accueil : toutes les conversations sans dossier (liste qui défile), croix « Supprimer »
// avec confirmation (2e clic), même action que dans l'appli (archiver).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const s = fs.readFileSync(path.resolve(__dirname, "../src/components/Welcome.tsx"), "utf8");

test("toutes les conversations sans dossier, dans une liste qui défile", () => {
  assert.doesNotMatch(s, /MAX_VISIBLE_RECENTS/);
  assert.match(s, /data-liste="conversations"/);
  const css = fs.readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");
  assert.match(css, /\.welcome__recents\[data-liste="conversations"\]\s*\{[^}]*overflow-y: auto/);
});

test("Supprimer = archiver (comme l'appli), après un 2e clic, refusé pendant une réponse", () => {
  assert.match(s, /api\.archiveConversation\(scratchRoot, id\)/);
  assert.match(s, /data-confirm=\{confirmer \? "true" : "false"\}/);
  assert.match(s, /if \(enCours\)/);
});
