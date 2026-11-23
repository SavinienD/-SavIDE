"use strict";
// fabrique tests/pages-exemple/exemple.pages, petit document Pages fait à la main :
// zip avec Index/Document.iwa (flux snappy « à la Apple » + archives protobuf TSWP.StorageArchive),
// Index/Metadata.iwa et preview.jpg. Relancer : node tests/pages-exemple/fabriquer.cjs
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}
const champVarint = (num, v) => Buffer.concat([varint(num * 8), varint(v)]);
const champOctets = (num, b) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "utf8");
  return Buffer.concat([varint(num * 8 + 2), varint(buf.length), buf]);
};

/** Snappy brut : littéraux et copies (décalage sur 2 octets), recherche naïve. */
function snappy(src) {
  const out = [varint(src.length)];
  let lit = [];
  const viderLit = () => {
    if (!lit.length) return;
    const b = Buffer.from(lit);
    if (b.length <= 60) out.push(Buffer.from([(b.length - 1) << 2]));
    else out.push(Buffer.from([60 << 2, b.length - 1]));
    out.push(b);
    lit = [];
  };
  let i = 0;
  while (i < src.length) {
    let meilleur = 0;
    let dec = 0;
    for (let j = Math.max(0, i - 65535); j < i; j += 1) {
      let k = 0;
      while (i + k < src.length && src[j + k] === src[i + k] && k < 64) k += 1;
      if (k > meilleur) {
        meilleur = k;
        dec = i - j;
      }
    }
    if (meilleur >= 4) {
      viderLit();
      out.push(Buffer.from([((meilleur - 1) << 2) | 2, dec & 0xff, dec >> 8]));
      i += meilleur;
    } else {
      lit.push(src[i]);
      if (lit.length === 61) viderLit();
      i += 1;
    }
  }
  viderLit();
  return Buffer.concat(out);
}

/** Fichier .iwa : un morceau [0][taille 3 octets][snappy]. */
function iwa(archives) {
  const flux = Buffer.concat(
    archives.map(({ id, messages }) => {
      const info = Buffer.concat([
        champVarint(1, id),
        ...messages.map((m) => champOctets(2, Buffer.concat([champVarint(1, m.type), champVarint(3, m.donnees.length)]))),
      ]);
      return Buffer.concat([varint(info.length), info, ...messages.map((m) => m.donnees)]);
    }),
  );
  const c = snappy(flux);
  return Buffer.concat([Buffer.from([0, c.length & 0xff, (c.length >> 8) & 0xff, c.length >> 16]), c]);
}

const stockage = (genre, texte) => Buffer.concat([champVarint(1, genre), champOctets(3, texte)]);

async function fabriquer() {
  const corps =
    "Compte rendu de réunion\u2029" +
    "Le projet avance bien. Le projet avance bien et vite.\u2029" +
    "\u2029" +
    "Points à suivre : accents éàüç, guillemets « ok ».\ufffc\u2029" +
    "Fin du document.";
  const document = iwa([
    { id: 1, messages: [{ type: 10000, donnees: Buffer.concat([champVarint(1, 7), champOctets(2, "x")]) }] },
    { id: 2, messages: [{ type: 2001, donnees: stockage(0, corps) }] },
    { id: 3, messages: [{ type: 2001, donnees: stockage(1, "En-tête à ignorer") }] },
    { id: 4, messages: [{ type: 2001, donnees: stockage(3, "Zone de texte annexe") }] },
  ]);
  const metadata = iwa([{ id: 9, messages: [{ type: 11006, donnees: champOctets(1, "metadonnee") }] }]);
  const zip = new JSZip();
  const date = new Date("2026-11-23T00:00:00Z");
  zip.file("Index/Document.iwa", document, { date });
  zip.file("Index/Metadata.iwa", metadata, { date });
  zip.file("preview.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { date });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { fabriquer, iwa, snappy, stockage, champOctets, champVarint };

if (require.main === module) {
  fabriquer().then((b) => {
    const cible = path.join(__dirname, "exemple.pages");
    fs.writeFileSync(cible, b);
    console.log(`${cible} : ${b.length} octets`);
  });
}
