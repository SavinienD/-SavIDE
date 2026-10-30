// axe:0.1.75 — dictée en direct (morceaux de ≈ 3 s) et choix du modèle Whisper (gratuit, local).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const D = charger("../src/axe/voix/direct.ts");
const R = charger("../src/axe/voix/reglages.ts");

test("coupe d'un morceau : sur un silence après 2,5 s, d'office à 4,5 s", () => {
  assert.equal(D.doitCouper(1000, 900), false);
  assert.equal(D.doitCouper(2600, 100), false);
  assert.equal(D.doitCouper(2600, 300), true);
  assert.equal(D.doitCouper(4600, 0), true);
});

test("WAV 16 kHz mono 16 bits, rééchantillonnage 48 kHz -> 16 kHz", () => {
  const e = new Float32Array(48000).map((_, i) => Math.sin(i / 10));
  const r = D.reechantillonner(e, 48000);
  assert.equal(r.length, 16000);
  const wav = D.pcmVersWav(r);
  assert.equal(wav.length, 44 + 32000);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  const v = new DataView(wav.buffer);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(D.octetsEnBase64(new Uint8Array([77, 97, 110])), "TWFu");
});

test("auto : moyen par défaut, petit si le moyen dépasse 2× le temps réel", () => {
  const t0 = 1_000_000;
  assert.equal(D.choisirTaille("auto", null, t0), "moyen");
  assert.equal(D.choisirTaille("grand", null, t0), "grand");
  let m = D.noterMesure(null, "moyen", 3000, 4500, t0); // 1,5×
  assert.equal(m.taille, "moyen");
  m = D.noterMesure(m, "moyen", 3000, 9000, t0); // moyenne 2,25×
  assert.equal(m.taille, "petit");
  assert.equal(D.choisirTaille("auto", m, t0 + 1000), "petit");
  // mesure d'un autre modèle : sans effet ; mesure périmée : on refait l'essai en moyen.
  assert.equal(D.noterMesure(m, "petit", 3000, 9000, t0), m);
  assert.equal(D.choisirTaille("auto", m, t0 + D.VALIDITE_MESURE_MS + 1), "moyen");
  // d’emblée à plus de 3× : petit tout de suite (mesuré sur la VM : small 10 s pour 3 s).
  assert.equal(D.noterMesure(null, "moyen", 3000, 10160, t0).taille, "petit");
});

test("texte provisoire et aperçu trop lent", () => {
  assert.equal(D.assemblerProvisoire([" Bonjour,", "", "fais un  commit. "]), "Bonjour, fais un commit.");
  assert.equal(D.apercuTropLent([1, 4]), false);
  assert.equal(D.apercuTropLent([3.5, 4]), true);
});

test("réglages : gratuits par défaut (pas de repli OpenAI), direct et taille auto", () => {
  assert.equal(R.REGLAGES_VOIX_DEFAUT.repliOpenai, false);
  assert.equal(R.REGLAGES_VOIX_DEFAUT.direct, true);
  assert.equal(R.REGLAGES_VOIX_DEFAUT.modeleLocal, "auto"); // SavIDE : whisper.cpp du poste
});

// axe:0.1.77 — direct sans WebAudio : segments MediaRecorder relancés toutes les 3 s ;
// erreurs des morceaux montrées (avant : avalées, aperçu vide sans explication).
test("secours du direct : segments MediaRecorder complets, relancés, arrêtés avec l'enregistrement", async () => {
  const minuteries = [];
  global.window = { setTimeout: (fn, ms) => { minuteries.push(fn); return minuteries.length; }, clearTimeout: () => undefined };
  const crees = [];
  class FauxRecorder {
    constructor(flux, opts) { this.flux = flux; this.mimeType = (opts && opts.mimeType) || "audio/webm;codecs=opus"; this.state = "inactive"; crees.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable({ data: { size: 10 } }); this.onstop(); }
  }
  global.MediaRecorder = FauxRecorder;
  global.Blob = class { constructor(parts, o) { this.parts = parts; this.type = o.type; } };
  global.performance = { now: () => 0 };
  const E = charger("../src/axe/voix/enregistreur.ts");
  const enr = new E.EnregistreurVoix();
  enr.flux = { getTracks: () => [] };
  enr.type = "audio/webm;codecs=opus";
  enr.recorder = new FauxRecorder(enr.flux, {});
  assert.equal(enr.directPossible(), true, "direct possible sans WebAudio");
  assert.equal(enr.pcmLivre(), false);
  const segments = [];
  assert.equal(enr.demarrerSegments(3000, (b) => segments.push(b)), true);
  minuteries[0]();
  minuteries[1]();
  assert.equal(segments.length, 2);
  assert.equal(segments[0].type, "audio/webm;codecs=opus");
  enr.annuler();
  assert.equal(enr.segmentsActifs(), false);
  assert.equal(segments.length, 2, "pas de segment après l'arrêt");
});

test("useDictee : bascule sur les segments sans PCM, erreur d'un morceau affichée, contexte relancé", () => {
  const u = fs.readFileSync(path.resolve(__dirname, "../src/axe/voix/useDictee.ts"), "utf8");
  const e = fs.readFileSync(path.resolve(__dirname, "../src/axe/voix/enregistreur.ts"), "utf8");
  const b = fs.readFileSync(path.resolve(__dirname, "../src/axe/voix/DicteeBouton.tsx"), "utf8");
  assert.match(u, /if \(!enr\.pcmLivre\(\)\)[\s\S]*demarrerSegments\(SEGMENT_MS/);
  assert.match(u, /catch \(err\)[\s\S]*setDirect\(\{ actif: true, erreur: texteErreur\(err\)/);
  assert.match(e, /contexte\.state === "suspended"\) void this\.contexte\.resume\(\)/);
  assert.match(b, /Aperçu en direct indisponible/);
});
