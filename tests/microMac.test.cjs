// Micro sur macOS : déclaration d'usage du micro et message de refus adapté.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const racine = path.resolve(__dirname, "..");
const lire = (rel) => fs.readFileSync(path.join(racine, rel), "utf8");

test("Info.plist macOS : NSMicrophoneUsageDescription présent (sinon macOS refuse le micro)", () => {
  const plist = lire("src-tauri/Info.plist");
  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{10,}<\/string>/);
});

test("entitlements macOS : entrée audio (runtime renforcé) déclarée et branchée", () => {
  const ent = lire("src-tauri/Entitlements.plist");
  assert.match(ent, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
  const conf = JSON.parse(lire("src-tauri/tauri.conf.json"));
  assert.equal(conf.bundle.macOS.entitlements, "Entitlements.plist");
});

test("refus du micro : message propre à chaque système", () => {
  const E = charger("../src/axe/voix/enregistreur.ts");
  const mac = E.messageErreurMicro("refuse", "mac");
  assert.match(mac, /Réglages Système/);
  assert.match(mac, /Micro/);
  assert.doesNotMatch(mac, /Windows/);
  assert.match(E.messageErreurMicro("refuse", "windows"), /Paramètres Windows/);
  assert.doesNotMatch(E.messageErreurMicro("refuse", "linux"), /Windows|Réglages Système/);
  assert.equal(E.classerErreurMicro({ name: "NotAllowedError" }), "refuse");
});

test("bouton « Ouvrir les Réglages » : commande Rust enregistrée, Win+H réservé à Windows", () => {
  assert.match(lire("src-tauri/src/voix.rs"), /fn voix_ouvrir_reglages_micro[\s\S]*Privacy_Microphone/);
  assert.match(lire("src-tauri/src/lib.rs"), /voix::voix_ouvrir_reglages_micro/);
  const u = lire("src/axe/voix/useDictee.ts");
  assert.match(u, /winH && plateforme === "windows"/);
  assert.match(lire("src/axe/voix/DicteeBouton.tsx"), /d\.erreur\.reglagesMac/);
});
