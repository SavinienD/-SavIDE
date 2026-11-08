"use strict";
// Lot palette (P5) — « Ouvrir dans… » VS Code, Cursor, Zed et autres éditeurs trouvés (dossier ;
// fichier à la ligne), « Ouvrir le dossier des journaux » (Aide), « Relancer en administrateur »
// (Windows). Vérifie le branchement (le comportement est testé côté Rust : ouvrir_avec::tests).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const racine = path.resolve(__dirname, "..");
const lire = (p) => fs.readFileSync(path.join(racine, p), "utf8");

test("explorateur : « Ouvrir dans <éditeur> » au clic droit, à la ligne du curseur si le fichier est ouvert", () => {
  const arbre = lire("src/components/FileTree.tsx");
  assert.match(arbre, /editeursDetectes\(\)/);
  assert.match(arbre, /`Ouvrir dans \$\{/);
  assert.match(arbre, /positionCurseur\(/);
  assert.match(arbre, /ouvrirDansEditeur\(/);
});

test("Ctrl+K : ouvrir le dossier ou le fichier actif dans un éditeur, journaux, relance administrateur (Windows)", () => {
  const actions = lire("src/components/palette/actionsAide.ts");
  assert.match(actions, /Ouvrir le dossier dans \$\{/);
  assert.match(actions, /Ouvrir le dossier des journaux/);
  assert.match(actions, /Relancer en administrateur/);
  assert.match(actions, /estWindows\(\)/);
  assert.match(actions, /"ide-notification"/, "échec signalé par le contrat commun de notification");
  const pe = lire("src/components/palette/PaletteEspace.tsx");
  assert.match(pe, /actionsEditeurs\(/);
  assert.match(pe, /actionsAide\(\)/);
  assert.match(lire("src/components/palette/PaletteAccueil.tsx"), /actionsAide\(\)/);
});

test("Aide : Réglages > À propos (Windows sans menu natif) et menu natif Aide (macOS, Linux)", () => {
  const volet = lire("src/components/SettingsPane.tsx");
  assert.match(volet, /<AideAppli \/>/);
  const aide = lire("src/components/palette/AideAppli.tsx");
  assert.match(aide, /Ouvrir le dossier des journaux/);
  assert.match(aide, /estWindows\(\)/);
  const plateforme = lire("src-tauri/src/platform.rs");
  assert.match(plateforme, /ouvrir_avec::menu_aide\(app\)/);
  const lib = lire("src-tauri/src/lib.rs");
  for (const c of ["editeurs_detectes", "ouvrir_dans_editeur", "ouvrir_dossier_journaux", "relancer_administrateur"]) {
    assert.match(lib, new RegExp(`ouvrir_avec::${c}`));
  }
  assert.match(lib, /ouvrir_avec::evenement_menu\(/);
});
