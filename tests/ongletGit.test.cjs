// axe:0.1.75 — onglet Git du volet bas (capture de Savinien : liste des modifications invisible, onglets tronqués).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const lire = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("le panneau Git du terminal local est une colonne flex (sinon son corps tombe à 0 px)", () => {
  const css = lire("src/styles.css");
  assert.match(css, /\.terminal-viewport--git\[data-active="true"\]\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/);
  assert.match(css, /\.git-panel__row--file\s*\{\s*grid-template-columns:\s*14px minmax\(0, 1fr\)/);
});

test("la branche est sur l'onglet Git, pas sur chaque terminal", () => {
  const tsx = lire("src/components/TerminalPanel.tsx");
  const git = tsx.indexOf('data-tab="git"');
  const premiereSession = tsx.indexOf("{sessions.map((session) => (");
  const puce = tsx.indexOf("terminal-tab__git");
  assert.ok(git > 0 && puce > git && puce < premiereSession, "puce de branche dans l'onglet Git");
  assert.strictEqual(tsx.split("terminal-tab__git").length - 1, 1);
});

test("un relevé périodique n'annule pas un relevé Git encore en cours", () => {
  const tsx = lire("src/components/GitPanel.tsx");
  assert.match(tsx, /if \(!showSpinner && enCoursRef\.current === ws\) return;/);
});
