// paquet .docx (zip) : lecture pour l'éditeur riche, réécriture à l'enregistrement,
// et document neuf (texte d'un .pages enregistré en .docx). Seules les parties modifiées sont
// réécrites (document, et au besoin styles, numérotation, relations, types de contenu).

import JSZip from "jszip";
import { docxVersHtml, type ResultatImport } from "./docxVersHtml";
import { htmlVersDocx } from "./htmlVersDocx";

const MIME_IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
};
const TYPE_NUMEROTATION = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering";
const CT_NUMEROTATION = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";

export type PaquetDocx = {
  zip: JSZip;
  /** Chemin de la partie principale (word/document.xml en général). */
  cheminDocument: string;
  documentXml: string;
  stylesXml: string | null;
  numberingXml: string | null;
  relsXml: string | null;
};

function dossierDe(chemin: string): string {
  const i = chemin.lastIndexOf("/");
  return i >= 0 ? chemin.slice(0, i + 1) : "";
}

function resoudre(base: string, cible: string): string {
  if (cible.startsWith("/")) return cible.slice(1);
  const parts = dossierDe(base).split("/").filter(Boolean);
  for (const s of cible.split("/")) {
    if (s === "..") parts.pop();
    else if (s && s !== ".") parts.push(s);
  }
  return parts.join("/");
}

function cheminRels(cheminDocument: string): string {
  return `${dossierDe(cheminDocument)}_rels/${cheminDocument.split("/").pop()}.rels`;
}

async function texte(zip: JSZip, chemin: string): Promise<string | null> {
  const f = zip.file(chemin);
  return f ? f.async("string") : null;
}

/** Partie liée au document par un type de relation (styles, numbering…). */
function partieLiee(relsXml: string | null, cheminDocument: string, typeFin: string): string | null {
  if (!relsXml) return null;
  const re = /<Relationship\b[^>]*>/g;
  for (let m = re.exec(relsXml); m; m = re.exec(relsXml)) {
    const type = /Type="([^"]*)"/.exec(m[0])?.[1] ?? "";
    const cible = /Target="([^"]*)"/.exec(m[0])?.[1];
    if (cible && type.endsWith(`/${typeFin}`) && !/TargetMode="External"/.test(m[0])) return resoudre(cheminDocument, cible);
  }
  return null;
}

export async function ouvrirDocx(octets: Uint8Array): Promise<PaquetDocx> {
  const zip = await JSZip.loadAsync(octets);
  const racine = (await texte(zip, "_rels/.rels")) ?? "";
  const m = /<Relationship\b[^>]*Type="[^"]*\/officeDocument"[^>]*>/.exec(racine);
  const cible = m ? /Target="([^"]*)"/.exec(m[0])?.[1] : null;
  const cheminDocument = cible ? resoudre("", cible) : "word/document.xml";
  const documentXml = await texte(zip, cheminDocument);
  if (!documentXml) throw new Error("ce fichier n'est pas un document Word (.docx) valide");
  const relsXml = await texte(zip, cheminRels(cheminDocument));
  const styles = partieLiee(relsXml, cheminDocument, "styles");
  const numbering = partieLiee(relsXml, cheminDocument, "numbering");
  return {
    zip,
    cheminDocument,
    documentXml,
    stylesXml: styles ? await texte(zip, styles) : null,
    numberingXml: numbering ? await texte(zip, numbering) : null,
    relsXml,
  };
}

function base64(octets: Uint8Array): string {
  let b = "";
  for (let i = 0; i < octets.length; i += 0x8000) b += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(b);
}

/** HTML de l'éditeur (images incluses en data URL) et pertes prévues. */
export async function docxPourEditeur(p: PaquetDocx): Promise<ResultatImport> {
  const images = new Map<string, string>();
  const re = /<Relationship\b[^>]*>/g;
  for (let m = re.exec(p.relsXml ?? ""); m; m = re.exec(p.relsXml ?? "")) {
    const id = /Id="([^"]*)"/.exec(m[0])?.[1];
    const cible = /Target="([^"]*)"/.exec(m[0])?.[1];
    if (!id || !cible || /TargetMode="External"/.test(m[0]) || !/\/image"/.test(m[0])) continue;
    const chemin = resoudre(p.cheminDocument, cible);
    const mime = MIME_IMAGES[chemin.split(".").pop()?.toLowerCase() ?? ""];
    const f = p.zip.file(chemin);
    if (!mime || !f) continue;
    images.set(id, `data:${mime};base64,${base64(await f.async("uint8array"))}`);
  }
  return docxVersHtml({
    documentXml: p.documentXml,
    stylesXml: p.stylesXml,
    numberingXml: p.numberingXml,
    relsXml: p.relsXml,
    imageDe: (rid) => images.get(rid) ?? null,
  });
}

/** Pertes que l'enregistrement du HTML causerait (sans rien écrire). */
export function pertesExport(p: PaquetDocx, html: string): string[] {
  return htmlVersDocx({ html, documentXml: p.documentXml, stylesXml: p.stylesXml, numberingXml: p.numberingXml, relsXml: p.relsXml }).pertes;
}

/** Nouveau contenu du .docx avec le HTML de l'éditeur ; le paquet est mis à jour. */
export async function enregistrerDocx(p: PaquetDocx, html: string): Promise<Uint8Array> {
  const r = htmlVersDocx({ html, documentXml: p.documentXml, stylesXml: p.stylesXml, numberingXml: p.numberingXml, relsXml: p.relsXml });
  const rels = cheminRels(p.cheminDocument);
  p.zip.file(p.cheminDocument, r.documentXml);
  p.documentXml = r.documentXml;
  if (r.stylesXml) {
    const chemin = partieLiee(p.relsXml, p.cheminDocument, "styles");
    if (chemin) p.zip.file(chemin, r.stylesXml);
    p.stylesXml = r.stylesXml;
  }
  let relsXml = r.relsXml ?? p.relsXml;
  if (r.numberingXml) {
    let chemin = partieLiee(relsXml, p.cheminDocument, "numbering");
    if (!chemin) {
      chemin = `${dossierDe(p.cheminDocument)}numbering.xml`;
      relsXml = ajouterRelation(relsXml, TYPE_NUMEROTATION, "numbering.xml");
      const types = (await texte(p.zip, "[Content_Types].xml")) ?? "";
      if (!types.includes(`PartName="/${chemin}"`)) {
        p.zip.file(
          "[Content_Types].xml",
          types.replace("</Types>", `<Override PartName="/${chemin}" ContentType="${CT_NUMEROTATION}"/></Types>`),
        );
      }
    }
    p.zip.file(chemin, r.numberingXml);
    p.numberingXml = r.numberingXml;
  }
  if (relsXml && relsXml !== p.relsXml) {
    p.zip.file(rels, relsXml);
    p.relsXml = relsXml;
  }
  return p.zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function ajouterRelation(relsXml: string | null, type: string, cible: string): string {
  const base = relsXml ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let i = 1;
  while (base.includes(`Id="rIdAxe${i}"`)) i += 1;
  const ligne = `<Relationship Id="rIdAxe${i}" Type="${type}" Target="${cible}"/>`;
  return /<\/Relationships>/.test(base) ? base.replace("</Relationships>", `${ligne}</Relationships>`) : base.replace(/<Relationships([^>]*)\/>/, `<Relationships$1>${ligne}</Relationships>`);
}

const ENTETE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Paquet .docx vide (A4, Calibri 11, styles Normal et Titre 1 à 3). */
export async function nouveauDocx(): Promise<PaquetDocx> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${ENTETE}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${ENTETE}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const relsXml = `${ENTETE}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  zip.file("word/_rels/document.xml.rels", relsXml);
  const titre = (n: number, taille: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${taille}"/></w:rPr></w:style>`;
  const stylesXml = `${ENTETE}<w:styles ${NS_W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${titre(1, 32)}${titre(2, 28)}${titre(3, 24)}</w:styles>`;
  zip.file("word/styles.xml", stylesXml);
  const documentXml = `${ENTETE}<w:document ${NS_W}><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  zip.file("word/document.xml", documentXml);
  return { zip, cheminDocument: "word/document.xml", documentXml, stylesXml, numberingXml: null, relsXml };
}
