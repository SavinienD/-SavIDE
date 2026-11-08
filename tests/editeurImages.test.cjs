"use strict";
// Image collée ou déposée dans un .md -> fichier dans images/ à côté
// du .md (Rust editeur_image_markdown, tests cargo editeur::) et lien inséré ; images relatives
// affichées dans l'aperçu.
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
const I = require(path.join(racine, "src/components/editeur/imagesMarkdown.ts"));

test("nom d'une image collée : son vrai nom, sinon image-<date> (heure locale)", () => {
  const d = new Date(2026, 10, 8, 14, 30, 12);
  assert.equal(I.horodatage(d), "20261108-143012");
  assert.equal(I.nomImageCollee("image.png", d), "image-20261108-143012");
  assert.equal(I.nomImageCollee(undefined, d), "image-20261108-143012");
  assert.equal(I.nomImageCollee("blob", d), "image-20261108-143012");
  assert.equal(I.nomImageCollee("schéma réseau.png", d), "schéma réseau");
});

test("lien Markdown inséré", () => {
  assert.equal(I.lienImage("images/capture-ecran.png"), "![capture ecran](images/capture-ecran.png)");
  assert.equal(I.lienImage("images/a b.png", "a"), "![a](<images/a b.png>)");
  assert.equal(I.lienImage("images/x.png", "[x]"), "![x](images/x.png)");
  assert.equal(I.texteAlternatif("images/image-20261108-143012.png"), "image 20261108 143012");
});

test("types et extensions d'images", () => {
  assert.equal(I.extensionDuType("image/png"), "png");
  assert.equal(I.extensionDuType("image/jpeg"), "jpg");
  assert.equal(I.extensionDuType("image/svg+xml"), "svg");
  assert.equal(I.extensionDuType("text/plain"), null);
  assert.ok(I.estCheminImage("C:\\Users\\sav\\Capture.PNG"));
  assert.ok(!I.estCheminImage("/home/x/rapport.pdf"));
  assert.equal(I.dossierDe("C:\\docs\\notes.md"), "C:\\docs");
  assert.equal(I.dossierDe("docs/notes.md"), "docs");
});

test("aperçu : image relative résolue depuis le dossier du .md (protocole des fichiers locaux)", () => {
  const conv = (c) => `asset://${c}`;
  assert.equal(I.sourceImage("images/a.png", "C:\\docs", conv), "asset://C:\\docs\\images\\a.png");
  assert.equal(I.sourceImage("./images/mon%20image.png", "/home/s/docs", conv), "asset:///home/s/docs/images/mon image.png");
  assert.equal(I.sourceImage("https://exemple.fr/a.png", "C:\\docs", conv), "https://exemple.fr/a.png");
  assert.equal(I.sourceImage("data:image/png;base64,AAAA", "C:\\docs", conv), "data:image/png;base64,AAAA");
  assert.equal(I.sourceImage("C:\\img\\b.png", "C:\\docs", conv), "asset://C:\\img\\b.png");
  assert.equal(I.sourceImage("a.png?v=2", "/d", conv), "asset:///d/a.png");
  assert.equal(I.sourceImage(undefined, "/d", conv), undefined);
});

test("branchements : commande Rust, dépôt relayé par Workspace, collage et dépôt dans l'éditeur, aperçu", () => {
  assert.match(lire("src-tauri/src/lib.rs"), /editeur::editeur_image_markdown/);
  const ws = lire("src/components/Workspace.tsx");
  assert.match(ws, /\[data-depot-markdown\]/);
  assert.match(ws, /DEPOT_MARKDOWN_EVENT/);
  const ed = lire("src/components/EditorPane.tsx");
  assert.match(ed, /useImagesMarkdown\(/);
  assert.match(ed, /data-depot-markdown=/);
  assert.match(ed, /dossierImages=/);
  const md = lire("src/components/chat/Markdown.tsx");
  assert.match(md, /dossierImages\?: string/);
  assert.match(md, /sourceImage\(/);
  const hook = lire("src/components/editeur/useImagesMarkdown.ts");
  assert.match(hook, /addEventListener\("paste", coller, true\)/, "collage intercepté avant Monaco");
  assert.match(hook, /getData\("text\/plain"\)\.trim\(\)/, "un collage de texte reste du texte");
});
