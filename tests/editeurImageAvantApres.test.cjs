"use strict";
// ED3c : image modifiée depuis le dernier commit : avant / après (glissière ou
// côte à côte), bouton « Avant / après » dans la barre d'onglets ; version HEAD lue par
// editeur_fichier_head (src-tauri/src/editeur.rs).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
const A = require(path.join(racine, "src/components/editeur/imageAvantApres.ts"));
const octets = (...l) => l.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x]));

test("type de l'image d'après ses premiers octets, sinon d'après l'extension", () => {
  assert.equal(A.typeImage(octets(0x89, "PNG", 0x0d, 0x0a), "x.bin"), "image/png");
  assert.equal(A.typeImage(octets(0xff, 0xd8, 0xff, 0xe0), "x"), "image/jpeg");
  assert.equal(A.typeImage(octets("GIF89a"), "x"), "image/gif");
  assert.equal(A.typeImage(octets("RIFF", 1, 2, 3, 4, "WEBPVP8 "), "x"), "image/webp");
  assert.equal(A.typeImage(octets("BM", 0, 0), "x"), "image/bmp");
  assert.equal(A.typeImage(octets(0, 0, 0, 0x1c, "ftypavif"), "x"), "image/avif");
  assert.equal(A.typeImage(octets(0, 0, 1, 0, 1, 0), "x"), "image/x-icon");
  assert.equal(A.typeImage([], "photo.JPG"), "image/jpeg");
  assert.equal(A.typeImage([], "sans-extension"), "image/png");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString("base64");
  assert.equal(A.typeImageBase64(png, "logo.jpg"), "image/png", "le contenu prime sur le nom");
  assert.equal(A.typeImageBase64("%%%", "logo.gif"), "image/gif", "base64 illisible : extension");
});

test("cadre commun : la plus grande des deux versions, réduite pour tenir, jamais agrandie", () => {
  assert.deepEqual(A.cadreCommun({ l: 160, h: 100 }, { l: 200, h: 50 }, { l: 1000, h: 800 }), { l: 200, h: 100 });
  assert.deepEqual(A.cadreCommun({ l: 2000, h: 1000 }, null, { l: 548, h: 388 }), { l: 500, h: 250 });
  assert.deepEqual(A.cadreCommun(null, { l: 400, h: 400 }, { l: 248, h: 1000 }), { l: 200, h: 200 });
  assert.equal(A.cadreCommun(null, null, { l: 800, h: 600 }), null);
  assert.equal(A.cadreCommun({ l: 0, h: 0 }, null, { l: 800, h: 600 }), null);
});

test("glissière : position sous le pointeur, bornée de 0 à 100 %", () => {
  assert.equal(A.positionGlissiere(150, 100, 200), 25);
  assert.equal(A.positionGlissiere(50, 100, 200), 0);
  assert.equal(A.positionGlissiere(400, 100, 200), 100);
  assert.equal(A.positionGlissiere(10, 0, 0), 50);
});

test("branchements : bouton seulement pour une image modifiée d'un espace local, deux modes, clavier", () => {
  const ed = lire("src/components/EditorPane.tsx");
  assert.match(ed, /data-action="avant-apres"/);
  assert.match(ed, /headImage\.etat === "suivi" && headImage\.modifie && headImage\.base64/);
  assert.match(ed, /espaceLocal && imageActive/);
  assert.match(ed, /<ImageAvantApres/);
  const v = lire("src/components/viewers/ImageAvantApres.tsx");
  assert.match(v, /data-mode-avap="glissiere"/);
  assert.match(v, /data-mode-avap="cote"/);
  assert.match(v, /type="range"/, "glissière au clavier");
  assert.match(lire("src/components/editeur/useMargeGit.ts"), /export function useFichierHead/);
});
