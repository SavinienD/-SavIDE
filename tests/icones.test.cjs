"use strict";
// Toutes les icônes citées dans src/ sont embarquées (la CSP bloque l'API d'Iconify).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const racine = path.resolve(__dirname, "../src");
const cols = {
  solar: require("@iconify-json/solar/icons.json"),
  "simple-icons": require("@iconify-json/simple-icons/icons.json"),
  "vscode-icons": require("@iconify-json/vscode-icons/icons.json"),
  local: { icons: { kimi: {} } },
};
const existe = (p, n) => { const c = cols[p]; return !!c && !!((c.icons || {})[n] || (c.aliases || {})[n]); };
function fichiers(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? fichiers(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []); }
test("icônes solar / simple-icons / local citées : toutes embarquées", () => {
  const manque = [];
  for (const f of fichiers(racine)) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/["'`](solar|simple-icons|local):([a-z0-9-]+)["'`]/g)) if (!existe(m[1], m[2])) manque.push(`${m[1]}:${m[2]}`);
  }
  assert.deepEqual([...new Set(manque)], []);
});
test("explorateur : toutes les icônes de fileIcon.ts sont embarquées", () => {
  const src = fs.readFileSync(path.join(racine, "lib/fileIcon.ts"), "utf8");
  const noms = [...new Set([...src.matchAll(/"((?:file-type|folder-type|default)[a-z0-9_-]*)"/g)].map((m) => m[1]))];
  assert.ok(noms.length > 50);
  assert.deepEqual(noms.filter((n) => !existe("vscode-icons", n)), []);
});
test("aucune API d'icônes distante citée dans src/", () => {
  for (const f of fichiers(racine)) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /api\.(iconify\.design|simplesvg\.com|unisvg\.com)/, f);
});
