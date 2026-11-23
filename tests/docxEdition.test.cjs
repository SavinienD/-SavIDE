"use strict";
// aller-retour Word : .docx → HTML de l'éditeur (vrai schéma TipTap) → .docx → relecture.
// Surlignage, couleur, taille, police, titres, listes, alignement, image et tableau conservés ;
// pertes annoncées (signets) ; reste du paquet (média, styles) gardé ; document neuf (.pages → .docx).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const JSZip = require("jszip");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const cle of ["window", "document", "DOMParser", "XMLSerializer", "Node", "HTMLElement", "Element", "navigator", "getComputedStyle", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"]) {
  if (!(cle in globalThis) || cle === "window" || cle === "document") {
    Object.defineProperty(globalThis, cle, { value: cle === "window" ? dom.window : dom.window[cle], configurable: true, writable: true });
  }
}
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const D = require(path.join(racine, "src/components/viewers/docxPaquet.ts"));
const { extensionsTexte } = require(path.join(racine, "src/components/viewers/editeurExtensions.ts"));
const { Editor } = require("@tiptap/core");

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc00000030101009a1c2b8a0000000049454e44ae426082", "hex");
const IMAGE = '<w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><wp:docPr id="1" name="Image 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';

async function docxExemple() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>');
  zip.file("word/styles.xml", `<?xml version="1.0"?><w:styles ${NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  zip.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file("word/media/image1.png", PNG);
  const corps =
    '<w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:t>Titre principal</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:t xml:space="preserve">Texte </w:t></w:r>' +
    '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>surligné jaune</w:t></w:r>' +
    '<w:r><w:t xml:space="preserve"> puis </w:t></w:r>' +
    '<w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:sz w:val="28"/><w:lang w:val="fr-FR"/></w:rPr><w:t>rouge gras 14</w:t></w:r>' +
    '<w:bookmarkStart w:id="0" w:name="repere"/><w:bookmarkEnd w:id="0"/>' +
    '<w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr><w:t>ombré Georgia</w:t></w:r>' +
    `<w:r>${IMAGE}</w:r></w:p>` +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Puce un</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Puce deux</w:t></w:r></w:p>' +
    '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
    '<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:t>Fin</w:t></w:r></w:p>' +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${corps}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

/** Passe le HTML par le vrai schéma de l'éditeur, comme à l'ouverture puis à l'enregistrement. */
function parEditeur(html, modifier) {
  const editeur = new Editor({ element: document.createElement("div"), extensions: extensionsTexte(), content: html });
  if (modifier) modifier(editeur);
  const sortie = editeur.getHTML();
  editeur.destroy();
  return sortie;
}

function positionDe(editeur, texte) {
  let pos = null;
  editeur.state.doc.descendants((n, p) => {
    if (pos === null && n.isText && n.text.includes(texte)) pos = p + n.text.indexOf(texte);
  });
  assert.notEqual(pos, null, `texte « ${texte} » introuvable`);
  return { from: pos, to: pos + texte.length };
}

test("import : mise en forme Word lue par l'éditeur, pertes annoncées", async () => {
  const p = await D.ouvrirDocx(await docxExemple());
  const { html, pertes } = await D.docxPourEditeur(p);
  assert.match(html, /<h1>Titre principal<\/h1>/);
  assert.match(html, /<mark data-color="#ffff00"[^>]*>surligné jaune<\/mark>/);
  assert.match(html, /style="color: #ff0000; font-size: 14pt"/);
  assert.match(html, /<mark data-color="#fff2cc"/);
  assert.match(html, /font-family: Georgia/);
  assert.match(html, /<img data-docx-brut="[^"]*a:blip[^"]*" data-libelle="Image" src="data:image\/png;base64,/);
  assert.match(html, /<ul data-docx-num="1"><li><p>Puce un<\/p><\/li><li><p>Puce deux<\/p><\/li><\/ul>/);
  assert.match(html, /<table data-docx-tblpr=/);
  assert.match(html, /text-align: center/);
  assert.deepEqual(pertes, ["signets"]);
  const passe = parEditeur(html);
  assert.match(passe, /<mark data-color="#ffff00"/, "le surlignage survit au schéma de l'éditeur");
  assert.match(passe, /data-docx-ppr=/, "propriétés de paragraphe gardées par l'éditeur");
  assert.match(passe, /data-docx-rpr=/, "propriétés de texte gardées par l'éditeur");
  assert.match(passe, /<img[^>]*data-docx-brut=/, "image gardée par l'éditeur");
  assert.match(passe, /data-docx-tblpr=/, "propriétés du tableau gardées par l'éditeur");
});

test("aller-retour : surlignage et couleur conservés après enregistrement puis relecture", async () => {
  const p = await D.ouvrirDocx(await docxExemple());
  const { html } = await D.docxPourEditeur(p);
  const modifie = parEditeur(html, (e) => {
    e.chain().setTextSelection(positionDe(e, "Fin")).setHighlight({ color: "#00ff00" }).setColor("#0070c0").run();
    e.chain().setTextSelection(positionDe(e, "Puce deux")).toggleBold().run();
    e.chain().setTextSelection(positionDe(e, "Texte")).setHighlight({ color: "#ffd8a8" }).setFontSize("18pt").setFontFamily("Arial").run();
  });
  assert.deepEqual(D.pertesExport(p, modifie), []);
  const octets = await D.enregistrerDocx(p, modifie);
  const zip = await JSZip.loadAsync(octets);
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /<w:highlight w:val="yellow"\/><\/w:rPr><w:t xml:space="preserve">surligné jaune</);
  assert.match(xml, /<w:rPr><w:b\/><w:color w:val="FF0000"\/><w:sz w:val="28"\/><w:szCs w:val="28"\/><w:lang w:val="fr-FR"\/><\/w:rPr><w:t xml:space="preserve">rouge gras 14/);
  assert.match(xml, /<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"\/><w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"\/>/);
  assert.match(xml, /<w:color w:val="0070C0"\/><w:highlight w:val="green"\/><\/w:rPr><w:t xml:space="preserve">Fin</);
  assert.match(xml, /<w:rFonts w:ascii="Arial"[^>]*\/><w:sz w:val="36"\/><w:szCs w:val="36"\/><w:shd [^>]*w:fill="FFD8A8"\/><\/w:rPr><w:t xml:space="preserve">Texte/);
  assert.match(xml, /<w:pPr><w:pStyle w:val="Titre1"\/><\/w:pPr>/);
  assert.match(xml, /<w:pPr><w:spacing w:after="240"\/><w:jc w:val="center"\/><\/w:pPr>/);
  assert.match(xml, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr><\/w:pPr><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Puce deux/);
  assert.match(xml, /<a:blip r:embed="rId9"\/>/);
  assert.match(xml, /<w:tblW w:w="5000" w:type="pct"\/>/);
  assert.match(xml, /<w:gridCol w:w="4000"\/><w:gridCol w:w="4000"\/>/);
  assert.match(xml, /<w:sectPr><w:pgSz w:w="11906" w:h="16838"\/><\/w:sectPr><\/w:body>/);
  assert.doesNotMatch(xml, /bookmarkStart/);
  assert.doesNotMatch(xml, /<w:rPr xmlns/, "pas de déclaration d'espace de noms redondante");
  assert.ok(zip.file("word/media/image1.png"), "image gardée dans le paquet");
  assert.equal(Buffer.compare(Buffer.from(await zip.file("word/media/image1.png").async("uint8array")), PNG), 0);
  // Relecture : l'éditeur retrouve surlignages et couleurs.
  const relu = await D.docxPourEditeur(await D.ouvrirDocx(octets));
  assert.match(relu.html, /<mark data-color="#00ff00"[^>]*>Fin<\/mark>/);
  assert.match(relu.html, /<span style="color: #0070c0">/);
  assert.match(relu.html, /<mark data-color="#ffff00"[^>]*>surligné jaune<\/mark>/);
  assert.match(relu.html, /<mark data-color="#ffd8a8"/);
  assert.match(relu.html, /font-size: 18pt; font-family: Arial/);
  assert.deepEqual(relu.pertes, []);
});

test("document neuf (texte d'un .pages) : titres, listes numérotées et liens ajoutés au paquet", async () => {
  const p = await D.nouveauDocx();
  const html = parEditeur("<h2>Section</h2><ol><li><p>un</p><ol><li><p>sous</p></li></ol></li><li><p>deux</p></li></ol><p><a href=\"https://exemple.fr\">lien</a> et <mark data-color=\"#ff00ff\">rose</mark></p>");
  const octets = await D.enregistrerDocx(p, html);
  const zip = await JSZip.loadAsync(octets);
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(xml, /<w:ilvl w:val="1"\/><w:numId w:val="1"\/>/);
  assert.match(xml, /<w:hyperlink r:id="rIdAxe1"><w:r><w:t xml:space="preserve">lien/);
  assert.match(xml, /<w:highlight w:val="magenta"\/>/);
  const num = await zip.file("word/numbering.xml").async("string");
  assert.match(num, /<w:numFmt w:val="decimal"\/>/);
  const rels = await zip.file("word/_rels/document.xml.rels").async("string");
  assert.match(rels, /Target="numbering.xml"/);
  assert.match(rels, /Target="https:\/\/exemple.fr" TargetMode="External"/);
  assert.match(await zip.file("[Content_Types].xml").async("string"), /PartName="\/word\/numbering.xml"/);
  const relu = await D.docxPourEditeur(await D.ouvrirDocx(octets));
  assert.match(relu.html, /<h2>Section<\/h2><ol data-docx-num="1"><li><p>un<\/p><ol data-docx-num="1"><li><p>sous<\/p><\/li><\/ol><\/li><li><p>deux<\/p><\/li><\/ol>/);
  assert.match(relu.html, /<a href="https:\/\/exemple.fr">lien<\/a>/);
});

test("image collée dans l'éditeur : signalée comme non conservée", async () => {
  const p = await D.nouveauDocx();
  assert.deepEqual(D.pertesExport(p, '<p>a<img src="data:image/png;base64,AAAA"></p>'), ["images ajoutées dans l'éditeur"]);
});
