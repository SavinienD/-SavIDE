"use strict";
// lecture des .pages : snappy « à la Apple », protobuf, texte du corps dans l'ordre,
// aperçu PDF préféré, vignette, ancien format (index.xml.gz). Exemple fait à la main :
// tests/pages-exemple/exemple.pages (fabriqué par tests/pages-exemple/fabriquer.cjs).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const ts = require("typescript");
const JSZip = require("jszip");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const P = require(path.join(racine, "src/components/viewers/pages.ts"));
const F = require(path.join(racine, "tests/pages-exemple/fabriquer.cjs"));

async function entrees(octets) {
  const zip = await JSZip.loadAsync(octets);
  const noms = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  return { noms, lire: async (n) => zip.file(n).async("uint8array") };
}

test("snappy : littéraux et copies qui se chevauchent", () => {
  const clair = Buffer.from("abcabcabcabcabcabc-Bonjour Bonjour Bonjour !".repeat(3), "utf8");
  const c = F.snappy(clair);
  assert.ok(c.length < clair.length, "le bloc d'essai contient bien des copies");
  assert.equal(Buffer.from(P.snappyBrut(new Uint8Array(c))).toString("utf8"), clair.toString("utf8"));
  // Copie à 1 octet de décalage (tag type 1) écrite à la main : « aaaaaaaa ».
  const manuel = new Uint8Array([8, 0 << 2, 0x61, ((7 - 4) << 2) | 1, 1]);
  assert.equal(Buffer.from(P.snappyBrut(manuel)).toString(), "aaaaaaaa");
  assert.throws(() => P.snappyBrut(new Uint8Array([5, 1, 9])), /snappy/);
});

test("exemple.pages : paragraphes du corps dans l'ordre, en-tête exclu, autres textes à part", async () => {
  const octets = fs.readFileSync(path.join(__dirname, "pages-exemple/exemple.pages"));
  assert.ok(octets.length < 4096, "exemple petit");
  const res = await P.lirePages(await entrees(octets));
  assert.equal(res.format, "iwa");
  assert.equal(res.apercuPdf, null);
  assert.equal(res.vignette.nom, "preview.jpg");
  assert.equal(res.approximatif, false);
  assert.deepEqual(res.paragraphes, [
    "Compte rendu de réunion",
    "Le projet avance bien. Le projet avance bien et vite.",
    "",
    "Points à suivre : accents éàüç, guillemets « ok ».",
    "Fin du document.",
  ]);
  assert.deepEqual(res.autres, ["Zone de texte annexe"]);
  assert.ok(!P.texteDePages(res).includes("En-tête"));
});

test("le fichier d'exemple est bien celui que fabrique le script", async () => {
  const res1 = await P.lirePages(await entrees(fs.readFileSync(path.join(__dirname, "pages-exemple/exemple.pages"))));
  const res2 = await P.lirePages(await entrees(await F.fabriquer()));
  assert.deepEqual(res1.paragraphes, res2.paragraphes);
});

test("aperçu PDF préféré quand QuickLook/Preview.pdf existe", async () => {
  const zip = new JSZip();
  zip.file("QuickLook/Preview.pdf", "%PDF-1.4 faux");
  zip.file("Index/Document.iwa", F.iwa([{ id: 1, messages: [{ type: 2001, donnees: F.stockage(0, "Texte") }] }]));
  const e = await entrees(await zip.generateAsync({ type: "nodebuffer" }));
  const sansTexte = await P.lirePages(e, false);
  assert.equal(Buffer.from(sansTexte.apercuPdf).toString(), "%PDF-1.4 faux");
  assert.deepEqual(sansTexte.paragraphes, []);
  const avec = await P.lirePages(e, true);
  assert.deepEqual(avec.paragraphes, ["Texte"]);
});

test("structure inconnue : chaînes lisibles récupérées (lecture approximative)", async () => {
  const zip = new JSZip();
  const msg = F.champOctets(5, F.champOctets(2, "Texte caché dans un message inconnu"));
  zip.file("Index/Document.iwa", F.iwa([{ id: 1, messages: [{ type: 9999, donnees: msg }] }]));
  const res = await P.lirePages(await entrees(await zip.generateAsync({ type: "nodebuffer" })));
  assert.equal(res.approximatif, true);
  assert.deepEqual(res.paragraphes, ["Texte caché dans un message inconnu"]);
});

test("ancien format (Pages '09) : index.xml.gz, texte des <sf:p>", async () => {
  const xml =
    '<?xml version="1.0"?><sl:document xmlns:sf="x" xmlns:sl="y"><sf:text-storage sf:kind="body"><sf:text-body>' +
    '<sf:section><sf:layout><sf:p sf:style="t">Titre &amp; sous-titre</sf:p>' +
    '<sf:p sf:style="b">Un<sf:tab/>deux <sf:span sf:style="g">gras</sf:span><sf:br/>ligne</sf:p><sf:p/>' +
    "<sf:p>Dernier &#233;l&#xE9;ment</sf:p></sf:layout></sf:section></sf:text-body></sf:text-storage></sl:document>";
  const zip = new JSZip();
  zip.file("index.xml.gz", zlib.gzipSync(Buffer.from(xml)));
  zip.file("QuickLook/Thumbnail.jpg", Buffer.from([1, 2]));
  const res = await P.lirePages(await entrees(await zip.generateAsync({ type: "nodebuffer" })));
  assert.equal(res.format, "xml-ancien");
  assert.equal(res.vignette.nom, "QuickLook/Thumbnail.jpg");
  assert.deepEqual(res.paragraphes, ["Titre & sous-titre", "Un\tdeux gras\nligne", "", "Dernier élément"]);
});

test("visionneuse : .pages enregistré, icône dédiée", () => {
  const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
  assert.match(lire("src/components/viewers/registry.ts"), /register\(\["pages"\], binary\("pages"\)\)/);
  assert.match(lire("src/lib/fileIcon.ts"), /pages/);
});
