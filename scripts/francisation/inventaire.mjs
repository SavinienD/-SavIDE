#!/usr/bin/env node
// Inventaire des textes visibles encore en anglais (src/, web/src, src-tauri/src).
// Usage : node scripts/francisation/inventaire.mjs [--detail] [--fichier <chemin>] [--blanche] [--json <sortie>] [--sans-rust]
//   (sans option) : total et nombre par fichier ; --detail : chaque texte (ligne, genre, texte) ;
//   --blanche : textes gardés en anglais exprès, avec la raison ; --md : tableau Markdown.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { inventaire } = require("./detecteur.cjs");

const args = process.argv.slice(2);
const opt = (n) => args.includes(n);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

let tout = inventaire({ rust: !opt("--sans-rust") });
const filtre = val("--fichier");
if (filtre) tout = tout.filter((x) => x.fichier.startsWith(filtre));
const restants = tout.filter((x) => !x.blanche);
const gardes = tout.filter((x) => x.blanche);

const compter = (liste) => {
  const m = new Map();
  for (const x of liste) m.set(x.fichier, (m.get(x.fichier) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
const zone = (f) => (f.startsWith("src-tauri/") ? "rust" : f.startsWith("web/") ? "web" : "src");
const parZone = { src: 0, web: 0, rust: 0 };
for (const x of restants) parZone[zone(x.fichier)]++;

if (val("--json")) fs.writeFileSync(val("--json"), JSON.stringify({ restants, gardes }, null, 1));

if (opt("--md")) {
  console.log(`| Fichier | Textes anglais |\n|---|---:|`);
  for (const [f, n] of compter(restants)) console.log(`| ${f} | ${n} |`);
  console.log(`| **Total** | **${restants.length}** |`);
} else {
  console.log(`Textes visibles en anglais : ${restants.length} (src : ${parZone.src}, web/src : ${parZone.web}, Rust : ${parZone.rust}) ; gardés exprès (liste blanche) : ${gardes.length}`);
  for (const [f, n] of compter(restants)) console.log(`${String(n).padStart(5)}  ${f}`);
}
if (opt("--detail")) {
  console.log("\n# Détail");
  for (const x of restants) console.log(`${x.fichier}:${x.ligne} [${x.genre}] ${x.texte}`);
}
if (opt("--blanche")) {
  console.log("\n# Gardés en anglais (liste blanche)");
  for (const x of gardes) console.log(`${x.fichier}:${x.ligne} ${JSON.stringify(x.texte)} — ${x.blanche.raison}`);
}
