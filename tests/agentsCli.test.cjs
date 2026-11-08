"use strict";
// Agents en ligne de commande : catalogue (fichier de données lu par le Rust) et
// fonctions pures de src/components/agents-cli/catalogueCli.ts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const chargementOrigine = Module._load;
Module._load = function (requete, parent, principal) {
  if (requete.startsWith("@tauri-apps/")) return { invoke: async () => null, listen: async () => () => undefined };
  return chargementOrigine.call(this, requete, parent, principal);
};
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
const C = charger("../src/components/agents-cli/catalogueCli.ts");
const CATALOGUE = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../crates/axecode-agents/catalogue-cli.json"), "utf8"));

test("catalogue : les agents demandés, une page d'installation, des invites lisibles par l'interface", () => {
  const ids = CATALOGUE.agents.map((a) => a.id);
  for (const id of ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "amp", "goose", "aider", "qwen", "kimi", "crush"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const a of CATALOGUE.agents) {
    assert.match(a.installation, /^https:\/\//, a.id);
    assert.ok(Array.isArray(a.nonInteractif), `${a.id} : commande non interactive`);
    for (const motif of a.invites ?? []) assert.doesNotThrow(() => new RegExp(motif), `${a.id} : ${motif}`);
    // Mode normal par défaut : aucun drapeau d'autonomie dans les arguments de lancement.
    for (const drapeau of a.autonomie ?? []) assert.ok(!(a.args ?? []).includes(drapeau), a.id);
  }
});

test("arguments : découpe comme le Rust (guillemets simples et doubles)", () => {
  assert.deepEqual(C.decouperArgs(""), []);
  assert.deepEqual(C.decouperArgs("  --model opus  "), ["--model", "opus"]);
  assert.deepEqual(C.decouperArgs(`--model "claude opus" -x 'a b' --vide ""`), ["--model", "claude opus", "-x", "a b", "--vide", ""]);
});

test("ligne de lancement : mode normal, autonomie complète, reprise", () => {
  const claude = { args: [], autonomie: ["--dangerously-skip-permissions"], reprise: ["--resume"] };
  assert.deepEqual(C.argsInteractifs(claude, { autonomie: false }), []);
  assert.deepEqual(C.argsInteractifs(claude, { autonomie: true }), ["--dangerously-skip-permissions"]);
  assert.deepEqual(C.argsInteractifs(claude, { autonomie: false, args: "--model opus" }, true), ["--resume", "--model", "opus"]);
  assert.equal(C.ligneAffichee("claude", ["--model", "claude opus"]), `claude --model "claude opus"`);
  assert.equal(C.ligneAffichee("aider", ["--message", 'dit "oui"']), `aider --message "dit \\"oui\\""`);
  assert.equal(C.autonomieDisponible({ autonomie: [], autonomieEnv: { GOOSE_MODE: "auto" } }), true);
  assert.equal(C.autonomieDisponible({ autonomie: [], autonomieEnv: {} }), false);
});

test("réglages enregistrés : seulement ce qui diffère du défaut", () => {
  const r = C.reglagesDepuis([
    { id: "claude", reglage: { autonomie: true } },
    { id: "codex", reglage: { autonomie: false } },
    { id: "gemini", reglage: { autonomie: false, args: "", chemin: "  " } },
    { id: "opencode", reglage: { autonomie: false, chemin: " /opt/bin/opencode " } },
  ]);
  assert.deepEqual(r, { agents: { claude: { autonomie: true }, gemini: { autonomie: false, args: "" }, opencode: { autonomie: false, chemin: "/opt/bin/opencode" } } });
});

test("titre d'un onglet d'agent : « agent · dossier »", () => {
  assert.equal(C.titreAgent("Claude Code", "C:\\Users\\moi\\projets\\site"), "Claude Code · site");
  assert.equal(C.titreAgent("Codex", "/home/moi/depot-wt/"), "Codex · depot-wt");
});

test("nouvel arbre de travail : branche « agent/<cli>-<horodatage> »", () => {
  assert.equal(C.brancheAgent("claude", new Date(2026, 10, 8, 14, 30, 5)), "agent/claude-20261108-143005");
  assert.equal(C.brancheAgent("cursor agent!", new Date(2026, 0, 2, 3, 4, 5)), "agent/cursoragent-20260102-030405");
});
