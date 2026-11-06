"use strict";
// barre-dossiers — boutons 1 2 3… des dossiers numérotés dans la barre du haut, juste avant
// l'indicateur de quota : clic = bascule, dossier courant marqué, nom au survol, même ordre
// que Ctrl+1…9 et les cartes de l'accueil.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("composant : ordre des numéros, courant marqué, info-bulle « nom · Ctrl+n »", () => {
  const s = lire("../src/components/BarreDossiers.tsx");
  assert.match(s, /dossiersNumerotes\(\)/);
  assert.match(s, /ecouterOrdre/);
  assert.match(s, /aria-current/);
  assert.match(s, /infoBulleNumero\(/);
  assert.match(s, /NB_NUMEROTES/);
});

test("branché avant l'indicateur de quota (IDE et conversation sans dossier)", () => {
  const w = lire("../src/components/Workspace.tsx");
  assert.match(w, /<BarreDossiers[\s\S]{0,120}?\/>\s*<QuotaIndicator \/>/);
  const f = lire("../src/components/freechat/FreechatView.tsx");
  assert.match(f, /<BarreDossiers[\s\S]{0,120}?\/>\s*<QuotaIndicator \/>/);
});
