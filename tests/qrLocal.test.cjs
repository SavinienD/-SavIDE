const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Le QR d'appairage est fabriqué dans l'appli, sans réseau.
// Avant, l'image venait d'un site tiers qui recevait l'adresse du relais et le code.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");

// Services connus de fabrication de QR en ligne, et toute URL dont l'adresse parle de QR.
const SERVICES_QR =
  /api\.qrserver\.com|create-qr-code|chart\.googleapis\.com\/chart|quickchart\.io\/(?:chart|qr)|goqr\.me|qrcode\.tec-it\.com|image-charts\.com|qr-code-generator\.com|qrickit\.com|zxing\.org\/w\/chart/i;
const URL_QR = /https?:\/\/[^\s"'`<>)]*qr/i;
const DOSSIERS = ["src", "web/src", "remote/public", "remote/server.mjs", "src-tauri/src", "crates", "python/axecode_kernel"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".html", ".css", ".rs", ".py", ".json"]);

function fichiers(chemin) {
  const complet = path.join(racine, chemin);
  if (!fs.existsSync(complet)) return [];
  if (fs.statSync(complet).isFile()) return [complet];
  const sortie = [];
  for (const entree of fs.readdirSync(complet, { withFileTypes: true })) {
    if (entree.name === "node_modules" || entree.name === "target" || entree.name === "dist") continue;
    const enfant = path.join(chemin, entree.name);
    if (entree.isDirectory()) sortie.push(...fichiers(enfant));
    else if (EXTENSIONS.has(path.extname(entree.name))) sortie.push(path.join(racine, enfant));
  }
  return sortie;
}

test("ROUGE avant : aucune adresse de QR en ligne dans le code (le code d'appairage ne sort pas du PC)", () => {
  const fautes = [];
  for (const dossier of DOSSIERS) {
    for (const fichier of fichiers(dossier)) {
      const lignes = fs.readFileSync(fichier, "utf8").split("\n");
      lignes.forEach((ligne, i) => {
        if (SERVICES_QR.test(ligne) || URL_QR.test(ligne)) fautes.push(`${path.relative(racine, fichier)}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(fautes, [], "QR fabriqué par un service externe");
});

test("ROUGE avant : le panneau Accès à distance dessine le QR lui-même", () => {
  const panneau = fs.readFileSync(path.join(racine, "src/components/RemotePanel.tsx"), "utf8");
  assert.match(panneau, /from "\.\.\/lib\/qrcode"/);
  assert.doesNotMatch(panneau, /<img[^>]*src=\{?`?https?:/);
});

const Q = require(path.join(racine, "src/lib/qrcode.ts"));
const LETTRES = "abcdefghijklmnopqrstuvwxyz0123456789";
const texteDe = (n) => Array.from({ length: n }, (_, i) => LETTRES[(i * 7 + 3) % 36]).join("");
const empreinte = (qr) => crypto.createHash("sha256").update(qr.modules.map((l) => l.map((b) => (b ? "1" : "0")).join("")).join("\n")).digest("hex");

// Références bit à bit tirées de python-qrcode 8.2 (même version, niveau et masque) ;
// pendant le lot, 176 codes (versions 1 à 40 × L/M/Q/H) ont aussi été relus par libzbar.
const REFERENCES = [
  { cle: "url-M-2", texte: "https://relay.exemple.fr/?code=482913", niveau: "M", masque: 2, version: 3, sha256: "51a77e28694a66da3b7cf9ff0e1480367c6038ade5cab57702f7eee3a0c21203" },
  { cle: "v7-Q-5", texte: texteDe(86), niveau: "Q", masque: 5, version: 7, sha256: "611a7d0f8423812e1970feb953bc24291e5e92fefb0560a330c0af9dfe82d327" },
  { cle: "v10-L-1", texte: texteDe(271), niveau: "L", masque: 1, version: 10, sha256: "c73d7edeb7eb5236f24bc36482acdd44c662b4a4e8763cf4a8d57c02b95e6372" },
  { cle: "v32-H-6", texte: texteDe(842), niveau: "H", masque: 6, version: 32, sha256: "cfdda01d7bd6eb4cd2b681ee2ea81110f39a2972b169b6f6d1bd9dcd07809c73" },
  { cle: "v40-M-3", texte: texteDe(2331), niveau: "M", masque: 3, version: 40, sha256: "0c58a537eebb02175fa2a57840399c697893dcb2adda5218fa336f6357908c48" },
  { cle: "utf8-H-4", texte: "Café « été » ✓", niveau: "H", masque: 4, version: 3, sha256: "029dde087ef67af010beb7eb3b6505ed626b24a3572e8dd5d2bdb2f9d513a289" },
];

for (const ref of REFERENCES) {
  test(`QR identique à la référence : ${ref.cle}`, () => {
    const qr = Q.fabriquerQr(ref.texte, ref.niveau, ref.masque);
    assert.equal(qr.version, ref.version);
    assert.equal(qr.taille, ref.version * 4 + 17);
    assert.equal(empreinte(qr), ref.sha256);
  });
}

test("masque choisi automatiquement, chemin SVG avec marge claire", () => {
  const qr = Q.fabriquerQr("https://relay.exemple.fr/?code=482913");
  assert.ok(qr.masque >= 0 && qr.masque <= 7);
  const { cote, chemin } = Q.cheminSvg(qr, 2);
  assert.equal(cote, qr.taille + 4);
  assert.match(chemin, /^M2 2h7v1h-7z/, "repère du coin haut gauche à la marge 2");
  assert.doesNotMatch(chemin, /NaN|undefined/);
  assert.throws(() => Q.fabriquerQr("x".repeat(3000), "H"), /trop long/);
});
