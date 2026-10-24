// Génère src-tauri/icons/savide-icon-1024.png (logo SavIDE complet, noir, sur tuile blanche,
// pastille blanche) ; images de l'installeur : scripts/generate-nsis-images.mjs.
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

console.log("icône SavIDE écrite (images de l'installeur : node scripts/generate-nsis-images.mjs)");
