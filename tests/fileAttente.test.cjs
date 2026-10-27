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
const F = charger("../src/components/chat/fileAttente.ts");

// Faux localStorage (mêmes méthodes que celui du navigateur).
function stockage({ plein = false } = {}) {
  const donnees = new Map();
  return {
    donnees,
    plein,
    get length() {
      return donnees.size;
    },
    key: (i) => Array.from(donnees.keys())[i] ?? null,
    getItem: (cle) => (donnees.has(cle) ? donnees.get(cle) : null),
    setItem(cle, valeur) {
      if (this.plein) throw new Error("QuotaExceededError");
      donnees.set(cle, String(valeur));
    },
    removeItem: (cle) => void donnees.delete(cle),
  };
}

const msg = (id, text = `texte ${id}`) => ({
  id,
  text,
  attachments: [{ path: `C:/tmp/${id}.png`, name: `${id}.png` }],
  model: { provider: "anthropic", name: "claude" },
  thinking: "Medium",
  mode: "act",
  serviceTier: null,
  createdAtMs: 1,
});
const libre = { occupe: false, sousAgent: false, edition: false };

test("la file est gardée par conversation et relue au redémarrage", () => {
  const s = stockage();
  const avant = new F.MagasinFiles(s);
  avant.modifierFile("conv-a", (file) => [...file, msg("q1"), msg("q2")]);
  avant.modifierFile("conv-b", (file) => [...file, msg("q3")]);
  assert.ok(s.getItem(F.cleFile("conv-a")));
  // Redémarrage de l'appli (ou nouveau volet) : nouveau magasin, même stockage.
  const apres = new F.MagasinFiles(s);
  assert.deepEqual(apres.file("conv-a").map((m) => m.id), ["q1", "q2"]);
  assert.deepEqual(apres.file("conv-b"), [msg("q3")]);
  // File vidée : la clé disparaît du stockage.
  apres.modifierFile("conv-b", () => []);
  assert.equal(s.getItem(F.cleFile("conv-b")), null);
  assert.equal(new F.MagasinFiles(s).file("conv-b").length, 0);
});

test("même contrat que l'ancien setState sur Map (modifierFiles)", () => {
  const m = new F.MagasinFiles(stockage());
  m.modifierFiles((actuel) => new Map(actuel).set("c", [msg("x")]));
  assert.deepEqual(m.instantane().files.get("c").map((e) => e.id), ["x"]);
  const instantane = m.instantane();
  m.modifierFiles((actuel) => actuel); // rien ne change : même instantané
  assert.equal(m.instantane(), instantane);
});

test("relecture : données abîmées ignorées, doublons retirés", () => {
  assert.deepEqual(F.relireFile(null), []);
  assert.deepEqual(F.relireFile("pas du json"), []);
  assert.deepEqual(F.relireFile('{"id":"x"}'), []);
  const brut = JSON.stringify([msg("a"), { id: "", text: "x", attachments: [] }, { text: "sans id" }, msg("a"), msg("b")]);
  assert.deepEqual(F.relireFile(brut).map((e) => e.id), ["a", "b"]);
  const s = stockage();
  s.setItem(F.cleFile("c"), "{abîmé");
  s.setItem("autre-cle", JSON.stringify([msg("z")]));
  const m = new F.MagasinFiles(s);
  assert.equal(m.file("c").length, 0);
  assert.equal(m.instantane().files.size, 0);
});

test("stockage plein : la file reste en mémoire, rien ne plante, pas de copie périmée", () => {
  const s = stockage();
  const m = new F.MagasinFiles(s);
  m.modifierFile("c", (file) => [...file, msg("q1")]);
  s.plein = true;
  assert.doesNotThrow(() => m.modifierFile("c", (file) => [...file, msg("q2")]));
  assert.deepEqual(m.file("c").map((e) => e.id), ["q1", "q2"]);
  assert.ok(m.instantane().nonSauvees.has("c"));
  // L'ancienne copie [q1] est effacée : relue au redémarrage elle renverrait q1.
  assert.equal(s.getItem(F.cleFile("c")), null);
  s.plein = false;
  m.modifierFile("c", (file) => [...file, msg("q3")]);
  assert.ok(!m.instantane().nonSauvees.has("c"));
  assert.deepEqual(new F.MagasinFiles(s).file("c").map((e) => e.id), ["q1", "q2", "q3"]);
  // Stockage absent (ou illisible) : tout en mémoire.
  const sansStockage = new F.MagasinFiles(null);
  sansStockage.modifierFile("c", () => [msg("m")]);
  assert.equal(sansStockage.file("c").length, 1);
});

test("deux volets sur la même conversation : un seul envoi", () => {
  const m = new F.MagasinFiles(stockage());
  m.modifierFile("c", () => [msg("q1"), msg("q2")]);
  // Les deux volets voient le même premier message dans le même passage…
  const vuParA = m.prochain("c", libre);
  const vuParB = m.prochain("c", libre);
  assert.equal(vuParA.id, "q1");
  assert.equal(vuParB.id, "q1");
  // … mais un seul le prend.
  assert.equal(m.prendreEnvoi("c", vuParA.id), true);
  assert.equal(m.prendreEnvoi("c", vuParB.id), false);
  assert.deepEqual(m.file("c").map((e) => e.id), ["q2"]);
  // Tant que l'envoi n'est pas fini, rien d'autre ne part pour « c ».
  assert.equal(m.prochain("c", libre), null);
  assert.equal(m.prendreEnvoi("c", "q2"), false);
  m.libererEnvoi("c", "q2"); // pas le sien : sans effet
  assert.equal(m.envoiEnCours("c"), true);
  m.libererEnvoi("c", "q1");
  assert.equal(m.prochain("c", libre).id, "q2");
  // Une autre conversation n'est pas bloquée par « c ».
  m.modifierFile("d", () => [msg("d1")]);
  assert.equal(m.prendreEnvoi("c", "q2"), true);
  assert.equal(m.prendreEnvoi("d", "d1"), true);
  // Un élément qui n'est plus dans la file ne repart jamais.
  m.libererEnvoi("c", "q2");
  assert.equal(m.prendreEnvoi("c", "q2"), false);
});

test("l'envoi retiré de la file est aussi retiré du stockage (pas de renvoi au redémarrage)", () => {
  const s = stockage();
  const m = new F.MagasinFiles(s);
  m.modifierFile("c", () => [msg("q1"), msg("q2")]);
  assert.equal(m.prendreEnvoi("c", "q1"), true);
  assert.deepEqual(new F.MagasinFiles(s).file("c").map((e) => e.id), ["q2"]);
});

test("compaction (ou arrière-plan) : rien ne part tant que l'opération n'est pas finie", () => {
  const m = new F.MagasinFiles(stockage());
  m.modifierFile("c", () => [msg("q1")]);
  m.occuper("c");
  // Le « turn_finished » de la compaction rend la conversation libre…
  assert.equal(m.prochain("c", libre), null);
  m.occuper("c"); // deux opérations (deux volets) : un compteur
  m.liberer("c");
  assert.equal(m.prochain("c", libre), null);
  m.liberer("c");
  assert.equal(m.occupee("c"), false);
  // … et pendant le tour de relance, la conversation est occupée.
  assert.equal(m.prochain("c", { ...libre, occupe: true }), null);
  assert.equal(m.prochain("c", libre).id, "q1");
  m.liberer("c"); // jamais négatif
  assert.equal(m.occupee("c"), false);
});

test("bloqué, sous-agent affiché, édition : pas d'envoi automatique", () => {
  const m = new F.MagasinFiles(stockage());
  m.modifierFile("c", () => [msg("q1"), msg("q2")]);
  m.bloquer("q1");
  assert.equal(m.prochain("c", libre), null);
  m.debloquer("q1");
  assert.equal(m.prochain("c", { ...libre, sousAgent: true }), null);
  assert.equal(m.prochain("c", { ...libre, edition: true }), null);
  assert.equal(m.prochain("c", libre).id, "q1");
  assert.equal(m.noterEchec("q1"), 1);
  assert.equal(m.noterEchec("q1"), 2);
});

test("les volets sont prévenus de chaque changement (useSyncExternalStore)", () => {
  const m = new F.MagasinFiles(stockage());
  let appels = 0;
  const arreter = m.abonner(() => (appels += 1));
  m.modifierFile("c", () => [msg("q1")]);
  m.occuper("c");
  m.liberer("c");
  m.bloquer("q1");
  m.debloquer("q1");
  assert.equal(m.prendreEnvoi("c", "q1"), true);
  m.libererEnvoi("c", "q1");
  assert.equal(appels, 7);
  arreter();
  m.modifierFile("c", () => [msg("q2")]);
  assert.equal(appels, 7);
});

test("un seul magasin pour toute l'appli (survit au remontage d'un volet)", () => {
  assert.equal(F.filesPartagees(), F.filesPartagees());
});

// axe:file-hors-vue — A tourne avec 2 messages en file, l'utilisateur passe sur B.
test("file hors vue : A démontée envoie ses 2 messages dans l'ordre", () => {
  const m = new F.MagasinFiles(null);
  const el = (id) => ({ id, text: id, attachments: [] });
  m.modifierFile("A", () => [el("a1"), el("a2")]);
  const demonterA = m.monter("A");
  m.monter("B");
  const enCours = new Set(["A"]);
  assert.deepEqual(m.prochainsHorsVue(enCours), []); // A affichée : c'est son volet
  demonterA(); // passage sur B
  assert.deepEqual(m.prochainsHorsVue(enCours), []); // tour en cours
  enCours.delete("A"); // turn_finished
  let p = m.prochainsHorsVue(enCours);
  assert.deepEqual(p.map(([c, e]) => [c, e.id]), [["A", "a1"]]);
  assert.ok(m.prendreEnvoi("A", "a1"));
  assert.deepEqual(m.prochainsHorsVue(enCours), []); // un seul en vol
  enCours.add("A");
  m.libererEnvoi("A", "a1");
  assert.deepEqual(m.prochainsHorsVue(enCours), []);
  enCours.delete("A");
  p = m.prochainsHorsVue(enCours);
  assert.deepEqual(p.map(([c, e]) => [c, e.id]), [["A", "a2"]]);
  assert.ok(m.prendreEnvoi("A", "a2"));
  m.libererEnvoi("A", "a2");
  assert.deepEqual(m.file("A"), []);
});

test("file hors vue : B affichée et vide n'est jamais touchée", () => {
  const m = new F.MagasinFiles(null);
  m.monter("B");
  m.modifierFile("B", () => [{ id: "b1", text: "x", attachments: [] }]);
  assert.deepEqual(m.prochainsHorsVue(new Set()), []);
});
