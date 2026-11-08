// Reprise automatique après une limite d'abonnement (src/axe/reprise/repriseAuto.ts) : erreur
// reconnue, heure de reprise tirée des quotas (avec marge), file des reprises, garde-fou.
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
const R = charger("../src/axe/reprise/repriseAuto.ts");
const sansNb = (t) => t.replace(/\u00a0/g, " ");
const T0 = new Date(2026, 10, 8, 13, 0, 0).getTime();
const MIN = 60_000;

// Textes réels du démon (turn_error) : 429 de l'abonnement Claude après les relances du flux,
// limite ChatGPT (usage_limit_reached), et des erreurs qui ne sont pas des limites.
const CLAUDE_429 = "retryable stream error: HTTP 429 Too Many Requests: rate_limit_error: This request would exceed your account's rate limit. Please try again later.";
const CHATGPT = "rate limited: usage_limit_reached: The usage limit has been reached";
test("limites d'abonnement reconnues, autres erreurs ignorées", () => {
  assert.equal(R.estLimite(CLAUDE_429), true);
  assert.equal(R.estLimite(CHATGPT), true);
  assert.equal(R.estLimite("Claude AI usage limit reached|1762610400"), true);
  assert.equal(R.estLimite("context window exceeded: prompt is too long"), false);
  assert.equal(R.estLimite("auth error: Anthropic rejected the API key"), false);
  assert.equal(R.estLimite("network error: connection refused"), false);
  assert.equal(R.estLimite(""), false);
});

const fenetre = (id, utilization, resetsAtMs) => ({ id, label: id, utilization, resetsAt: null, resetsAtMs, windowMinutes: null, projectedExhaustionMs: null, exhaustsBeforeReset: false });
const RAPPORT = { fetchedAtMs: T0, providers: [
  { provider: "anthropic", label: "Claude", account: null, plan: null, supported: true, error: null,
    windows: [fenetre("five_hour", 100, T0 + 125 * MIN), fenetre("seven_day", 40, T0 + 3 * 1440 * MIN)] },
  { provider: "openai~2", label: "ChatGPT", account: null, plan: null, supported: true, error: null,
    windows: [fenetre("five_hour", 100, T0 + 30 * MIN), fenetre("seven_day", 100, T0 + 2 * 1440 * MIN)] },
  { provider: "openai", label: "ChatGPT", account: null, plan: null, supported: true, error: null, windows: [fenetre("five_hour", 20, T0 + 60 * MIN)] },
  { provider: "mistral", label: "mistral", account: null, plan: null, supported: false, error: null, windows: [] },
] };

test("heure de reprise : réinitialisation de la fenêtre épuisée, plus une minute", () => {
  assert.deepEqual(R.heureReprise("anthropic", RAPPORT, T0), { aMs: T0 + 126 * MIN, source: "quota" });
  // Deux fenêtres épuisées : la reprise attend la plus tardive.
  assert.deepEqual(R.heureReprise("openai~2", RAPPORT, T0), { aMs: T0 + 2 * 1440 * MIN + MIN, source: "quota" });
  // Rien d'épuisé (quota pas encore à jour, limite courte) : nouvel essai dans 15 min.
  assert.deepEqual(R.heureReprise("openai", RAPPORT, T0), { aMs: T0 + 15 * MIN, source: "defaut" });
});

test("abonnement : seulement les comptes dont le quota est lu", () => {
  assert.equal(R.estAbonnement("anthropic", RAPPORT), true);
  assert.equal(R.estAbonnement("mistral", RAPPORT), false);
  assert.equal(R.estAbonnement("ollama", RAPPORT), false);
  assert.equal(R.estAbonnement("anthropic", null), false);
});

const reprise = (sessionId, aMs, extra = {}) => ({ sessionId, parentId: null, nom: sessionId, provider: "anthropic", aMs, source: "quota", essais: 0, creeMs: T0, ...extra });

test("file : une reprise par session, échues dans l'ordre (sous-agents d'abord), annulation", () => {
  let file = R.planifier([], reprise("conv", T0 + 10 * MIN));
  file = R.planifier(file, reprise("conv", T0 + 20 * MIN));
  assert.equal(file.length, 1);
  assert.equal(file[0].aMs, T0 + 20 * MIN);
  file = R.planifier(file, reprise("enfant", T0 + 20 * MIN, { parentId: "conv", nom: "t-lotA" }));
  file = R.planifier(file, reprise("autre", T0 + 60 * MIN));
  assert.deepEqual(R.echues(file, T0 + 21 * MIN).map((r) => r.sessionId), ["enfant", "conv"]);
  assert.deepEqual(R.reprisesDe(file, "conv").map((r) => r.sessionId), ["conv", "enfant"]);
  assert.deepEqual(R.annuler(file, "conv").map((r) => r.sessionId), ["enfant", "autre"]);
});

test("garde-fou : nouvelle limite juste après une reprise automatique = essai suivant", () => {
  const prec = { conv: { aMs: T0, essais: 1 } };
  assert.equal(R.essaiSuivant(prec, "conv", T0 + 10 * MIN), 2);
  assert.equal(R.essaiSuivant(prec, "conv", T0 + 3 * 60 * MIN), 0);
  assert.equal(R.essaiSuivant(prec, "autre", T0), 0);
  assert.equal(R.MAX_ESSAIS, 4);
});

test("textes du bandeau", () => {
  assert.equal(sansNb(R.texteBandeau(reprise("conv", T0 + 126 * MIN), "conv")), "Limite de l'abonnement atteinte : reprise automatique à 15:06.");
  assert.equal(sansNb(R.texteBandeau(reprise("conv", T0 + 15 * MIN, { source: "defaut" }), "conv")), "Limite atteinte : nouvel essai automatique à 13:15.");
  assert.equal(sansNb(R.texteBandeau(reprise("enfant", T0 + 126 * MIN, { parentId: "conv", nom: "t-lotA" }), "conv")), "Sous-agent « t-lotA » : reprise automatique à 15:06.");
});

test("file gardée dans le stockage local (entrées illisibles écartées)", () => {
  const stock = new Map();
  const s = { getItem: (k) => stock.get(k) ?? null, setItem: (k, v) => stock.set(k, v) };
  assert.deepEqual(R.lireFile(s), []);
  R.ecrireFile(s, [reprise("conv", T0)]);
  assert.equal(R.lireFile(s)[0].sessionId, "conv");
  stock.set(R.CLE_FILE, JSON.stringify([{ sessionId: 3 }, reprise("b", T0)]));
  assert.deepEqual(R.lireFile(s).map((r) => r.sessionId), ["b"]);
});
