// axe:parcours-collegue — modèles proposés dans une conversation d'un espace Axe Cloud.
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
const E = charger("../src/lib/modelesEspace.ts");

test("espace d'un collègue : les trois modèles Axe Cloud de son espace, même sans fournisseur sur le PC", () => {
  const liste = E.modelesEspace({ provider: "axe-cloud", name: "claude-opus-5-5" });
  assert.deepEqual(liste.map((m) => m.value), [
    "axe-cloud:claude-opus-5-5",
    "axe-cloud:claude-sonnet-5-5",
    "axe-cloud:claude-haiku-5-5",
  ]);
  assert.ok(liste.every((m) => m.provider === "axe-cloud" && m.providerLabel === "Axe Cloud"));
  // providers.json des espaces : Haiku sans raisonnement, Opus et Sonnet avec.
  assert.deepEqual(liste.map((m) => m.defaultThinking), ["medium", "medium", "off"]);
  assert.deepEqual([...liste[2].thinking], ["off"]);
});

test("le modèle par défaut du PC (ou un fournisseur du PC) n'est jamais proposé dans un espace", () => {
  for (const modele of [
    { provider: "google", name: "gemini-3.8-flash" }, // PC sans fournisseur (lib.rs)
    { provider: "anthropic", name: "claude-fable-5-1" }, // PC de l'utilisateur
    null,
    undefined,
  ]) {
    const valeurs = E.modelesEspace(modele).map((m) => m.value);
    assert.equal(valeurs.length, 3);
    assert.ok(valeurs.every((v) => v.startsWith("axe-cloud:")), JSON.stringify(modele));
  }
});

test("un autre modèle axe-cloud déjà porté par la conversation reste proposé (pas remplacé en silence)", () => {
  const valeurs = E.modelesEspace({ provider: "axe-cloud", name: "claude-opus-6" }).map((m) => m.value);
  assert.deepEqual(valeurs.slice(-1), ["axe-cloud:claude-opus-6"]);
  assert.equal(valeurs.length, 4);
});

test("choix du modèle dans une conversation créée par « + » : posé sur le service, pas d'erreur", async () => {
  const appels = [];
  const choisi = { provider: "axe-cloud", name: "claude-sonnet-5-5", effort: "medium" };
  const reglages = await E.preferenceModeleEspace(
    async () => {
      appels.push("pc");
      throw "conversation not found";
    },
    async () => appels.push("service"),
    choisi,
  );
  assert.deepEqual(appels, ["pc", "service"]);
  assert.deepEqual(reglages, { act: choisi, plan: choisi, goal: choisi });
});

test("conversation connue du PC : le service n'est pas appelé ; autre erreur : remontée telle quelle", async () => {
  const appels = [];
  const choisi = { provider: "axe-cloud", name: "claude-haiku-5-5" };
  const duPc = { act: choisi, plan: choisi, goal: choisi };
  assert.equal(await E.preferenceModeleEspace(async () => duPc, async () => appels.push("service"), choisi), duPc);
  assert.deepEqual(appels, []);
  await assert.rejects(
    E.preferenceModeleEspace(async () => { throw "a turn is already running for this conversation"; }, async () => appels.push("service"), choisi),
    /a turn is already running/,
  );
  assert.deepEqual(appels, []);
});


test("brouillon du PC (fournisseur de l'espace inconnu du PC) : choix gardé, posé sur le service s'il y existe (D8)", async () => {
  const choisi = { provider: "axe-cloud", name: "claude-sonnet-5-5", effort: "medium" };
  const refusPc = async () => { throw "provider `axe-cloud` is not configured or missing credentials"; };
  // Pas encore envoyé : la session n'existe pas sur l'espace, le modèle partira avec le premier message.
  const appels = [];
  const r1 = await E.preferenceModeleEspace(refusPc, async () => { appels.push("service"); throw "session not found: brouillon-pc"; }, choisi);
  assert.deepEqual(appels, ["service"]);
  assert.deepEqual(r1, { act: choisi, plan: choisi, goal: choisi });
  // Déjà envoyé : la session existe, son modèle est changé.
  const r2 = await E.preferenceModeleEspace(refusPc, async () => appels.push("service"), choisi);
  assert.deepEqual(r2.act, choisi);
  assert.equal(appels.length, 2);
  // Autre échec du service (transport) : remonté tel quel.
  await assert.rejects(E.preferenceModeleEspace(refusPc, async () => { throw "transport closed"; }, choisi), /transport closed/);
});


test("D10 : compaction et réécriture passent par le PC, désactivées dans un espace Axe Cloud", () => {
  assert.deepEqual(E.actionsDuPc(true), { compaction: false, reecriture: false });
  assert.deepEqual(E.actionsDuPc(false), { compaction: true, reecriture: true });
  assert.match(E.NOTE_COMPACTION_ESPACE, /résumé de la conversation est automatique/);
  const pane = fs.readFileSync(path.resolve(__dirname, "../src/components/chat/ChatPane.tsx"), "utf8");
  assert.match(pane, /const compactionAilleurs = !actionsDuPc\(espaceCloud\)\.compaction;/);
  // Compaction automatique du PC : jamais dans un espace (le démon de l'espace compacte lui-même).
  assert.match(pane, /useEffect\(\(\) => \{\s*\/\/ axe:parcours-collegue \(D10\)[^\n]*\n[^\n]*\n\s*if \(compactionAilleurs\) return;/);
  // Bouton « Compaction » et /compact : l'avis, jamais l'appel au PC.
  assert.equal((pane.match(/if \(compactionAilleurs\) \{\s*setSlashNotice\(NOTE_COMPACTION_ESPACE\)/g) ?? []).length, 2);
  assert.match(pane, /rewindDisabled=\{[^}]*!actionsDuPc\(espaceCloud\)\.reecriture/);
});


test("D7 : refus du magasin du PC reconnu en anglais ET en français (« conversation introuvable », Rust francisé)", async () => {
  const choisi = { provider: "axe-cloud", name: "claude-sonnet-5-5", effort: "medium" };
  for (const refus of ["conversation not found", "conversation introuvable"]) {
    const appels = [];
    const r = await E.preferenceModeleEspace(async () => { throw refus; }, async () => appels.push("service"), choisi);
    assert.deepEqual(appels, ["service"], refus);
    assert.deepEqual(r, { act: choisi, plan: choisi, goal: choisi }, refus);
  }
});
