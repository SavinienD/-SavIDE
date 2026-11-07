"use strict";
// « Skills 3 » (onglet du harnais) et « Skills 10 » (barre des Réglages) : deux comptes différents,
// désormais nommés : « Skills du harnais » = skills Python du poste ; « Skills » = Markdown + harnais (détail au survol).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("onglet du harnais : « Skills du harnais », compte des skills Python du poste seulement", () => {
  const h = lire("../src/components/settings/HarnessPane.tsx");
  assert.match(h, /Skills du harnais →/);
  assert.match(h, /const skillsHarnais = entries\.filter\(\(entry\) => entry\.kind === "skill"\)\.length/);
  assert.doesNotMatch(h, /counts\.skill/);
});

test("barre des Réglages : total = Markdown + harnais, détail dans l'info-bulle", () => {
  const s = lire("../src/components/SettingsPane.tsx");
  assert.match(s, /skills\.length \+ pySkills\.length\} skills\u00a0: \$\{skills\.length\} Markdown \+ \$\{pySkills\.length\} du harnais \(Python\)/);
});
