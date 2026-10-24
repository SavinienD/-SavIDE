// Génère les images de l'installeur Windows (NSIS) avec le logo SavIDE du dépôt
// (même tracé que src-tauri/icons/savide-logo.svg), noir sur fond blanc :
//   src-tauri/icons/nsis-sidebar.bmp  164 × 314 (pages Bienvenue / Fin)
//   src-tauri/icons/nsis-header.bmp   150 × 57  (bandeau des autres pages)
// BMP 24 bits non compressés, format attendu par NSIS (MUI2).
// Usage : node scripts/generate-nsis-images.mjs

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const icons = resolve(here, "../src-tauri/icons");

const LOGO_W = 3780;
const LOGO_H = 762;
// Glyphes repris du logo du dépôt (une seule source de vérité).
const source = readFileSync(resolve(icons, "savide-logo.svg"), "utf8");
const GLYPHES = source.slice(source.indexOf('<g fill="#000000">') + '<g fill="#000000">'.length, source.lastIndexOf("</g>"));
const logo = (x, y, largeur) =>
  `<g transform="translate(${x} ${y}) scale(${largeur / LOGO_W})" fill="#000000">${GLYPHES}</g>`;

function svg(w, h, corps) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>${corps}</svg>`;
}

// BMP 24 bits, lignes de bas en haut, chaque ligne alignée sur 4 octets.
function bmp(w, h, rgba) {
  const ligne = Math.ceil((w * 3) / 4) * 4;
  const taille = 54 + ligne * h;
  const b = Buffer.alloc(taille);
  b.write("BM", 0, "ascii");
  b.writeUInt32LE(taille, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(ligne * h, 34);
  b.writeInt32LE(2835, 38);
  b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const o = 54 + (h - 1 - y) * ligne;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255; // fond blanc sous l'alpha
      const c = (k) => Math.round(rgba[i + k] * a + 255 * (1 - a));
      b[o + x * 3] = c(2);
      b[o + x * 3 + 1] = c(1);
      b[o + x * 3 + 2] = c(0);
    }
  }
  return b;
}

function ecrire(nom, w, h, corps) {
  const r = new Resvg(svg(w, h, corps), { fitTo: { mode: "width", value: w } }).render();
  if (r.width !== w || r.height !== h) throw new Error(`${nom}: ${r.width}x${r.height}`);
  const out = resolve(icons, nom);
  writeFileSync(out, bmp(w, h, r.pixels));
  console.log(`wrote ${out} (${w}x${h})`);
}

// Sidebar : logo complet centré dans le tiers haut (le texte NSIS est à droite de l'image).
ecrire("nsis-sidebar.bmp", 164, 314, logo((164 - 132) / 2, 80, 132));
// Header : logo complet à droite (MUI2 l'affiche à droite du bandeau), marges 8 px.
const hl = 120;
ecrire("nsis-header.bmp", 150, 57, logo(150 - hl - 8, (57 - (LOGO_H * hl) / LOGO_W) / 2, hl));
