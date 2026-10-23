// Génère src-tauri/icons/savide-icon-1024.png (logo SavIDE complet, noir, sur tuile blanche,
// comme l'icône d'Axecode) et src-tauri/icons/nsis-sidebar.bmp (164 × 314, barre de l'installeur).
// Usage : node scripts/generate-savide-icon.mjs && npx tauri icon src-tauri/icons/savide-icon-1024.png
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const icons = resolve(here, "../src-tauri/icons");
const LOGO_W = 3780;
const LOGO_H = 762;
const GLYPHES = `
    <rect x="0" y="0" width="700" height="190" fill="#000000"/>
    <rect x="0" y="286" width="700" height="190" fill="#000000"/>
    <rect x="0" y="572" width="700" height="190" fill="#000000"/>
    <rect x="0" y="0" width="190" height="476" fill="#000000"/>
    <rect x="510" y="286" width="190" height="476" fill="#000000"/>
    <path d="M1050 310 L1173 512 L927 512 Z" fill="#000000"/>
    <path d="M884 582 L1216 582 L1328 762 L772 762 Z" fill="#000000"/>
    <path d="M1400 306 L1960 306 L1680 762 Z" fill="#000000"/>
    <rect x="2030" y="0" width="190" height="762" fill="#000000"/>
    <path d="M2290 0 L2770 0 L3010 381 L2770 762 L2290 762 Z M2480 190 L2670 190 L2790 381 L2670 572 L2480 572 Z" fill-rule="evenodd" fill="#000000"/>
    <rect x="3080" y="0" width="700" height="190" fill="#000000"/>
    <rect x="3080" y="286" width="700" height="190" fill="#000000"/>
    <rect x="3080" y="572" width="700" height="190" fill="#000000"/>`;

function tuile(taille, largeur, rx) {
  const s = largeur / LOGO_W;
  const tx = (taille - largeur) / 2;
  const ty = (taille - LOGO_H * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${taille} ${taille}" width="${taille}" height="${taille}">
  <rect x="0" y="0" width="${taille}" height="${taille}" rx="${rx}" fill="#ffffff"/>
  <g transform="translate(${tx} ${ty}) scale(${s})">${GLYPHES}</g>
</svg>`;
}

const png = new Resvg(tuile(1024, 900, 180), { fitTo: { mode: "width", value: 1024 } }).render().asPng();
writeFileSync(resolve(icons, "savide-icon-1024.png"), png);

// Barre latérale NSIS : 164 × 314, fond blanc, logo centré en haut.
const W = 164, H = 314, L = 132;
const s = L / LOGO_W;
const barre = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <g transform="translate(${(W - L) / 2} 60) scale(${s})">${GLYPHES}</g>
</svg>`;
const img = new Resvg(barre, { fitTo: { mode: "width", value: W } }).render();
const rgba = img.pixels;
const ligne = Math.ceil((W * 3) / 4) * 4;
const bmp = Buffer.alloc(54 + ligne * H);
bmp.write("BM", 0);
bmp.writeUInt32LE(bmp.length, 2);
bmp.writeUInt32LE(54, 10);
bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(W, 18);
bmp.writeInt32LE(H, 22);
bmp.writeUInt16LE(1, 26);
bmp.writeUInt16LE(24, 28);
bmp.writeUInt32LE(ligne * H, 34);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = ((H - 1 - y) * W + x) * 4;
    const a = rgba[i + 3] / 255;
    const o = 54 + y * ligne + x * 3;
    bmp[o] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
    bmp[o + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    bmp[o + 2] = Math.round(rgba[i] * a + 255 * (1 - a));
  }
}
writeFileSync(resolve(icons, "nsis-sidebar.bmp"), bmp);
console.log("icônes SavIDE écrites");
