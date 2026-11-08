// Quotas des abonnements (Claude, ChatGPT) : affichage (% utilisé ou restant), compte, heure de
// réinitialisation, alerte au seuil (une fois par fenêtre et par période). Module pur src/axe/quotas.ts.
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
const Q = charger("../src/axe/quotas.ts");
const sansNb = (t) => t.replace(/\u00a0/g, " ");

// Heure locale fixe : 8 novembre 2026, 13:00.
const MAINTENANT = new Date(2026, 10, 8, 13, 0, 0).getTime();
const H = 3_600_000;
const fenetre = (id, label, utilization, resetsAtMs, extra = {}) => ({
  id, label, utilization, resetsAt: null, resetsAtMs, windowMinutes: null, projectedExhaustionMs: null, exhaustsBeforeReset: false, ...extra,
});
const RAPPORT = {
  fetchedAtMs: MAINTENANT,
  providers: [
    { provider: "anthropic", label: "Claude", account: "a@exemple.fr", plan: "max", supported: true, error: null,
      windows: [fenetre("five_hour", "5 h", 42.4, MAINTENANT + 2 * H + 5 * 60_000), fenetre("seven_day", "7 j", 12, MAINTENANT + 3 * 24 * H)] },
    { provider: "openai", label: "ChatGPT", account: "c@d.fr", plan: "plus", supported: true, error: null,
      windows: [fenetre("five_hour", "5 h", 85, MAINTENANT + 30 * 60_000), fenetre("seven_day", "7 j", 50, null)] },
    { provider: "openai~2", label: "ChatGPT", account: null, plan: null, supported: true, error: "connexion à renouveler", windows: [] },
    { provider: "ollama", label: "ollama", account: null, plan: null, supported: false, error: null, windows: [] },
  ],
};

test("% utilisé ou % restant", () => {
  assert.equal(Q.valeurAffichee(42.4, "utilise"), 42);
  assert.equal(Q.valeurAffichee(42.4, "restant"), 58);
  assert.equal(Q.valeurAffichee(130, "restant"), 0);
  assert.equal(sansNb(Q.textePourcent(42.4, "utilise")), "42 % utilisés");
  assert.equal(sansNb(Q.textePourcent(99.6, "restant")), "0 % restant");
  assert.equal(sansNb(Q.textePourcent(42.4, "restant")), "58 % restants");
});

test("réglages : lus, bornés, valeurs par défaut", () => {
  const stock = new Map();
  const s = { getItem: (k) => stock.get(k) ?? null, setItem: (k, v) => stock.set(k, v) };
  assert.deepEqual(Q.lireReglagesQuota(s), { mode: "utilise", seuil: 80 });
  Q.ecrireReglagesQuota(s, { mode: "restant", seuil: 250 });
  assert.deepEqual(Q.lireReglagesQuota(s), { mode: "restant", seuil: 100 });
  stock.set(Q.CLE_REGLAGES_QUOTA, "{illisible");
  assert.deepEqual(Q.lireReglagesQuota(s), { mode: "utilise", seuil: 80 });
  assert.deepEqual(Q.lireReglagesQuota(null), { mode: "utilise", seuil: 80 });
});

test("nom des comptes : fournisseur, rang des comptes ajoutés", () => {
  assert.equal(Q.nomCompte(RAPPORT.providers[0]), "Claude");
  assert.equal(Q.nomCompte(RAPPORT.providers[2]), "ChatGPT 2");
});

test("heure de réinitialisation : aujourd'hui, cette semaine, plus tard ; délai restant", () => {
  assert.equal(Q.heureReinitialisation(MAINTENANT + 2 * H + 5 * 60_000, MAINTENANT), "15:05");
  assert.equal(sansNb(Q.heureReinitialisation(MAINTENANT + 3 * 24 * H, MAINTENANT)), "mer. 13:00");
  assert.equal(Q.heureReinitialisation(MAINTENANT + 20 * 24 * H, MAINTENANT), "28/11 13:00");
  assert.equal(sansNb(Q.delaiAvant(MAINTENANT + 2 * H + 5 * 60_000, MAINTENANT)), "dans 2 h 05");
  assert.equal(sansNb(Q.delaiAvant(MAINTENANT + 30 * 60_000, MAINTENANT)), "dans 30 min");
  assert.equal(Q.delaiAvant(MAINTENANT - 1, MAINTENANT), "maintenant");
});

test("vue compacte : la fenêtre la plus pleine, avec le compte s'il y en a plusieurs", () => {
  const pire = Q.pireFenetre(RAPPORT);
  assert.equal(pire.fournisseur.provider, "openai");
  assert.equal(pire.fenetre.id, "five_hour");
  const reglages = { mode: "utilise", seuil: 80 };
  // Au-dessus du seuil : l'heure de réinitialisation est ajoutée.
  assert.equal(sansNb(Q.texteCompact(RAPPORT, reglages, MAINTENANT)), "ChatGPT 5 h 85 % · 13:30");
  assert.equal(sansNb(Q.texteCompact(RAPPORT, { mode: "restant", seuil: 90 }, MAINTENANT)), "ChatGPT 5 h reste 15 %");
  const seul = { ...RAPPORT, providers: [RAPPORT.providers[0]] };
  assert.equal(sansNb(Q.texteCompact(seul, reglages, MAINTENANT)), "5 h 42 %");
  assert.equal(Q.texteCompact({ fetchedAtMs: 0, providers: [] }, reglages, MAINTENANT), null);
});

test("ton : seuil réglable, rouge au-delà de 90 % ou si l'épuisement précède la réinitialisation", () => {
  assert.equal(Q.ton(fenetre("x", "x", 50, null), 80), "ok");
  assert.equal(Q.ton(fenetre("x", "x", 80, null), 80), "warn");
  assert.equal(Q.ton(fenetre("x", "x", 60, null), 50), "warn");
  assert.equal(Q.ton(fenetre("x", "x", 91, null), 80), "error");
  assert.equal(Q.ton(fenetre("x", "x", 40, null, { exhaustsBeforeReset: true }), 80), "error");
});

test("alertes : au seuil, une fois par fenêtre et par période", () => {
  const vues = [];
  const a = Q.alertesQuota(RAPPORT, 80, vues, MAINTENANT);
  assert.equal(a.length, 1);
  assert.equal(sansNb(a[0].titre), "Quota ChatGPT à 85 %");
  assert.equal(sansNb(a[0].texte), "Fenêtre 5 h : 85 % utilisés, réinitialisation à 13:30 (c@d.fr).");
  // Déjà signalée : plus rien ; après la réinitialisation (autre période) : de nouveau.
  assert.equal(Q.alertesQuota(RAPPORT, 80, a.map((x) => x.cle), MAINTENANT).length, 0);
  const apres = JSON.parse(JSON.stringify(RAPPORT));
  apres.providers[1].windows[0].resetsAtMs = MAINTENANT + 5 * H;
  assert.equal(Q.alertesQuota(apres, 80, a.map((x) => x.cle), MAINTENANT).length, 1);
  // Seuil plus bas : deux fenêtres.
  assert.equal(Q.alertesQuota(RAPPORT, 40, [], MAINTENANT).length, 3);
});

test("alertes déjà vues : gardées dans le stockage, 50 au plus", () => {
  const stock = new Map();
  const s = { getItem: (k) => stock.get(k) ?? null, setItem: (k, v) => stock.set(k, v) };
  assert.deepEqual(Q.alertesVues(s), []);
  Q.noterAlertesVues(s, Array.from({ length: 60 }, (_, i) => `k${i}`));
  const vues = Q.alertesVues(s);
  assert.equal(vues.length, 50);
  assert.equal(vues[49], "k59");
});
