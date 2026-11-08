// Jauge du contexte et minuteur du cache de l'en-tête du chat (src/components/chat/jaugeContexteDonnees.ts) :
// jetons du dernier appel / fenêtre du modèle, repère du seuil de compaction, temps restant du cache.
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
const J = charger("../src/components/chat/jaugeContexteDonnees.ts");
const sansNb = (t) => t.replace(/\u00a0/g, " ");
const T0 = new Date(2026, 10, 8, 14, 27, 0).getTime();
// Forme réelle de `sessions.context` (crates/axecode-daemon/src/contexte_rpc.rs).
const REPONSE = { appel: {
  jetonsContexte: 84_000, jetonsSortie: 900, cacheLu: 80_000, cacheEcrit: 2_800, fenetre: 200_000, seuilCompaction: 160_000,
  debutMs: T0, finMs: T0 + 20_000, cacheTtlS: 300, cacheExpireMs: T0 + 300_000, modele: "claude-opus-5-5",
} };

test("réponse du service lue ; forme inattendue ou ancienne : rien", () => {
  assert.equal(J.lireAppel(REPONSE).jetonsContexte, 84_000);
  assert.equal(J.lireAppel(REPONSE.appel).fenetre, 200_000);
  assert.equal(J.lireAppel({ appel: null }), null);
  assert.equal(J.lireAppel("unknown method"), null);
  assert.equal(J.lireAppel({ appel: { jetonsContexte: "x" } }), null);
});

test("jetons lisibles", () => {
  assert.equal(J.formatJetons(950), "950");
  assert.equal(sansNb(J.formatJetons(8_400)), "8,4 k");
  assert.equal(sansNb(J.formatJetons(84_000)), "84 k");
  assert.equal(sansNb(J.formatJetons(1_250_000)), "1,3 M");
});

test("jauge : part de la fenêtre, repère de compaction, couleur", () => {
  const j = J.etatJauge(J.lireAppel(REPONSE), 0);
  assert.equal(j.pourcent, 42);
  assert.equal(j.seuilPourcent, 80);
  assert.equal(j.ton, "ok");
  assert.equal(sansNb(j.libelle), "42 %");
  assert.equal(sansNb(j.detail), "Contexte du dernier appel : 84 k jetons sur 200 k (42 %) · compactage automatique à 160 k");
  // Près du seuil : orange ; au-delà de 95 % de la fenêtre : rouge.
  assert.equal(J.etatJauge({ ...REPONSE.appel, jetonsContexte: 150_000 }, 0).ton, "warn");
  assert.equal(J.etatJauge({ ...REPONSE.appel, jetonsContexte: 195_000, seuilCompaction: null }, 0).ton, "danger");
  // Fenêtre inconnue du service (journal relu) : celle du modèle choisi, sinon pas de jauge.
  const journal = { ...REPONSE.appel, fenetre: 0, seuilCompaction: null };
  assert.equal(J.etatJauge(journal, 1_000_000).pourcent, 8);
  assert.equal(J.etatJauge(journal, 0), null);
});

test("cache : temps restant, puis expiré, puis plus rien", () => {
  const a = J.lireAppel(REPONSE);
  const c = J.etatCache(a, T0 + 47_500);
  assert.equal(c.texte, "4:12");
  assert.equal(c.expire, false);
  assert.equal(sansNb(c.detail), "Cache de prompt (5 min) : expire à 14:32. Un message envoyé avant relit le contexte en cache au lieu de tout renvoyer.");
  const une_heure = { ...a, cacheTtlS: 3_600, cacheExpireMs: T0 + 3_600_000 };
  assert.equal(sansNb(J.etatCache(une_heure, T0 + 60_000).texte), "59 min");
  const fini = J.etatCache(a, T0 + 301_000);
  assert.equal(fini.texte, "expiré");
  assert.equal(fini.expire, true);
  assert.equal(sansNb(fini.detail), "Cache de prompt expiré à 14:32 : le prochain message renverra tout le contexte.");
  assert.equal(J.etatCache(a, T0 + 300_000 + 11 * 60_000), null);
  assert.equal(J.etatCache({ ...a, cacheExpireMs: null, cacheTtlS: null }, T0), null);
});

test("rafraîchissement : chaque seconde pendant les dix dernières minutes du cache", () => {
  const a = J.lireAppel(REPONSE);
  assert.equal(J.delaiRafraichissement(a, T0), 1_000);
  assert.equal(J.delaiRafraichissement({ ...a, cacheExpireMs: T0 + 3_600_000 }, T0), 30_000);
  assert.equal(J.delaiRafraichissement(null, T0), null);
});
