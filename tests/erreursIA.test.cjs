// axe:parcours-collegue — erreurs du compteur Axe Cloud (401, 429, 503…) en français lisible.
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
const E = charger("../src/lib/erreursIA.ts");
// Typographie française (espaces insécables, night-ui-fr) : vérifiée à part, à la fin ;
// ici, seul le contenu compte.
const expliquer = (brut, espace) => {
  const t = E.expliquerErreurIA(brut, espace);
  return t == null ? t : t.replace(/\u00a0/g, " ");
};

// Textes exacts reçus par l'appli (turn_error du démon), relevés le 22/10 avec un vrai démon
// Axecode et le faux compteur (scripts/faux-compteur, docs/parcours-collegue/faux-compteur).
const BRUT = {
  503: "retryable stream error: HTTP 503 Service Unavailable: api_error: Clé Anthropic du serveur indisponible. Préviens l'administrateur.",
  401: "auth error: Anthropic rejected the API key (authentication_error: Clé Axe invalide ou révoquée.). Check the key in Settings > Providers.",
  429: "retryable stream error: HTTP 429 Too Many Requests: rate_limit_error: Plafond mensuel IA atteint (20,00 €). Demande à l'administrateur de le relever.",
  403: "invalid request: permission_error: Compte désactivé : l'IA n'est pas accessible.",
};

test("503 du compteur : service indisponible, avec le message du serveur", () => {
  const t = expliquer(BRUT[503], true);
  assert.equal(t, "Le service IA d'Axe Cloud est indisponible pour le moment (erreur 503). Message du serveur : « Clé Anthropic du serveur indisponible. Préviens l'administrateur. »");
  assert.doesNotMatch(t, /stream error|retryable|HTTP/);
});

test("401 du compteur : clé de l'espace refusée, sans renvoyer vers les réglages du PC", () => {
  const t = expliquer(BRUT[401], true);
  assert.equal(t, "Axe Cloud a refusé la clé de votre espace (erreur 401). Prévenez l'administrateur. Message du serveur : « Clé Axe invalide ou révoquée. »");
  assert.doesNotMatch(t, /Settings|Providers/);
});

test("429 du compteur : limite atteinte, message du serveur gardé avec ses parenthèses", () => {
  assert.equal(
    expliquer(BRUT[429], true),
    "Limite d'utilisation de l'IA atteinte (erreur 429). Message du serveur : « Plafond mensuel IA atteint (20,00 €). Demande à l'administrateur de le relever. »",
  );
});

test("403 et préfixe « runtime error: » du démon", () => {
  assert.equal(
    expliquer("runtime error: " + BRUT[403], true),
    "Axe Cloud refuse l'accès à l'IA (erreur 403). Message du serveur : « Compte désactivé : l'IA n'est pas accessible. »",
  );
});

test("corps JSON brut du serveur : seul son message est repris", () => {
  const brut = 'provider error: HTTP 503 Service Unavailable: {"type":"error","error":{"type":"api_error","message":"Clé Anthropic du serveur indisponible. Préviens l\'administrateur."}}';
  assert.match(expliquer(brut, true), /\(erreur 503\)\. Message du serveur : « Clé Anthropic du serveur indisponible\. Préviens l'administrateur\. »$/);
});

test("fournisseur absent de l'espace, espace sans IA, compteur injoignable", () => {
  assert.match(expliquer("provider `anthropic` is not configured or missing credentials", true), /pas disponible dans votre espace Axe Cloud \(fournisseur « anthropic »\)/);
  assert.match(expliquer("runtime error: provider `axe-cloud` is not configured or missing credentials", true), /^L'IA n'est pas encore configurée dans votre espace Axe Cloud/);
  assert.match(expliquer("network error: error sending request for url (http://127.0.0.1:8096/v1/messages)", true), /^Le compteur Axe Cloud ne répond pas/);
});

test("hors espace Axe Cloud, erreur inconnue ou vide : null (le texte brut reste affiché)", () => {
  assert.equal(expliquer(BRUT[401], false), null);
  assert.equal(expliquer(BRUT[503], false), null);
  assert.equal(expliquer("conversation not found", true), null);
  assert.equal(expliquer("", true), null);
  assert.equal(expliquer(null, true), null);
});

test("erreurs seulement journalisées par le démon de l'espace (D9) : fournisseur non déclaré, moteur arrêté", () => {
  assert.equal(
    expliquer("runtime error: provider `axe-cloud` is not declared", true),
    "L'IA n'est pas encore configurée dans votre espace Axe Cloud (fournisseur « axe-cloud » absent). Prévenez l'administrateur.",
  );
  for (const brut of ["worker crashed repeatedly", "runtime error: python kernel exited during startup (is IPython installed?)"]) {
    assert.match(expliquer(brut, true), /^Le moteur de votre espace Axe Cloud s'est arrêté/);
  }
});


test("typographie française : espace insécable avant « : » et à l'intérieur des guillemets", () => {
  const t = E.expliquerErreurIA(BRUT[503], true);
  assert.match(t, /Message du serveur\u00a0: «\u00a0Clé Anthropic/);
  assert.match(t, /Préviens l'administrateur\.\u00a0»$/);
});

// Fusion de night-ui-fr (77f5a53) : l'explication d'un espace d'abord, sinon la traduction du moteur.
const M = charger("../src/lib/erreursMoteur.ts");
const afficher = (brut, espace) => E.expliquerErreurIA(brut, espace) ?? M.erreurMoteurEnFrancais(brut);

test("fusion night-ui-fr : dans un espace, l'explication d'Axe Cloud ; ailleurs, la traduction du moteur", () => {
  assert.match(afficher(BRUT[503], true), /^Le service IA d'Axe Cloud est indisponible/);
  assert.match(afficher(BRUT[503], false), /^Réponse interrompue/);
  assert.match(afficher("session not found: s-1", true), /^Session introuvable/);
  const pane = fs.readFileSync(path.resolve(__dirname, "../src/components/chat/ChatPane.tsx"), "utf8");
  assert.match(pane, /expliquerErreurIA\(displayView\.lastError, espaceCloud\) \?\? erreurMoteurEnFrancais\(displayView\.lastError\)/);
});
