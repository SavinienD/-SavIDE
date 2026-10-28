const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
function charger(rel) {
  const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const m = { exports: {} };
  new Function("module", "exports", "require", ts.transpileModule(src, { compilerOptions: { module: 1, target: 99 } }).outputText)(m, m.exports, require);
  return m.exports;
}
test("micro local : PCM float32 LE en base64", () => {
  const { pcmEnBase64, MIME_PCM } = charger("src/axe/voix/pcm.ts");
  const b = Buffer.from(pcmEnBase64(new Float32Array([0, 0.5, -1])), "base64");
  assert.equal(b.length, 12);
  assert.equal(b.readFloatLE(4), 0.5);
  assert.equal(b.readFloatLE(8), -1);
  assert.equal(MIME_PCM, "audio/pcm-f32-16k");
});
test("micro local : dictee disponible sans aucun service, jamais la VM", () => {
  const { dicteeDisponible } = charger("src/axe/voix/disponibilite.ts");
  assert.equal(dicteeDisponible({ services: [], openai: false, local: { ok: true } }, { localSeulement: true }), true);
  const d = fs.readFileSync(path.join(__dirname, "../src/axe/voix/useDictee.ts"), "utf8");
  assert.ok(d.includes("local: true") && d.includes("modeleLocal: reglages.modeleLocal") && d.includes("mime: MIME_PCM"));
  const r = fs.readFileSync(path.join(__dirname, "../src-tauri/src/voix.rs"), "utf8");
  assert.ok(r.includes("if input.local { Vec::new() }") && r.includes("!input.local && input.repli_openai"));
  const l = fs.readFileSync(path.join(__dirname, "../src-tauri/src/voix_local.rs"), "utf8");
  for (const s of ["60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"]) assert.ok(l.includes(s));
});
test("micro local : reglage petit/moyen, nettoyage par le modele active par defaut", () => {
  const r = fs.readFileSync(path.join(__dirname, "../src/axe/voix/reglages.ts"), "utf8");
  assert.ok(r.includes('modeleLocal: "base"') && r.includes("nettoyer: true"));
  const v = fs.readFileSync(path.join(__dirname, "../src/axe/voix/VoixSection.tsx"), "utf8");
  assert.ok(v.includes("Petit (base)") && v.includes("Moyen (small)") && v.includes("voix_modele_local"));
});
