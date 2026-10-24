const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:commandes — chaque commande slash proposée dans l'autocomplétion doit être
// servie : côté IDE (runClientSlashCommand) ou par le service (session_commands.rs,
// run_slash). Plus les indicateurs /heartbeat et /goal et la bulle « réveil : … ».
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const lire = (rel) => fs.readFileSync(path.join(racine, rel), "utf8");

function commandesProposees() {
  const src = lire("src/components/chat/SlashCommands.tsx");
  const bloc = src.slice(src.indexOf("export const SLASH_COMMANDS"), src.indexOf("];", src.indexOf("export const SLASH_COMMANDS")));
  return [...bloc.matchAll(/\{\s*name:\s*"([a-z_-]+)"([^\n]*)\}/g)].map((m) => ({
    name: m[1],
    client: /client:\s*true/.test(m[2]),
  }));
}

test("toutes les commandes slash proposées sont servies (IDE ou service)", () => {
  const proposees = commandesProposees();
  assert.ok(proposees.length >= 8, `liste lue : ${proposees.map((c) => c.name)}`);
  const ide = lire("src/components/chat/SlashCommands.tsx");
  const clientSwitch = ide.slice(ide.indexOf("export async function runClientSlashCommand"));
  const rust = lire("crates/axecode-app/src/session_commands.rs");
  const runSlash = rust.slice(rust.indexOf("pub async fn run_slash"), rust.indexOf("async fn start_refine"));
  const constRust = /pub const SLASH_COMMANDS: &\[&str\] = &\[([^\]]*)\]/.exec(rust);
  assert.ok(constRust, "SLASH_COMMANDS du service introuvable");
  const servies = [...constRust[1].matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]);
  for (const c of proposees) {
    if (c.client) {
      assert.ok(clientSwitch.includes(`case "${c.name}":`), `/${c.name} : marquée IDE mais non traitée par runClientSlashCommand`);
    } else {
      assert.ok(servies.includes(c.name), `/${c.name} : envoyée au service mais absente de SLASH_COMMANDS (session_commands.rs)`);
      assert.ok(runSlash.includes(`"${c.name}" =>`), `/${c.name} : pas de branche dans run_slash`);
    }
  }
  for (const s of servies) {
    assert.ok(runSlash.includes(`"${s}" =>`), `/${s} déclarée par le service sans branche run_slash`);
  }
});

test("/goal et /heartbeat acceptent les formes annoncées (service)", () => {
  const rust = lire("crates/axecode-app/src/session_commands.rs");
  for (const forme of ['"pause"', '"resume"', '"done"', '"clear"', '"off"']) {
    assert.ok(rust.includes(forme), `forme ${forme} absente de run_slash`);
  }
  const usage = lire("src/components/chat/SlashCommands.tsx");
  assert.match(usage, /\/goal <texte>[^"]*pause \| resume \| done \| clear/);
  assert.match(usage, /\/heartbeat <intervalle> <message> \| off/);
});

const ind = require(path.join(racine, "src/components/chat/logiqueIndicateurs.ts"));

test("indicateurs : intervalle, statut, déclenchement, état normalisé", () => {
  assert.equal(ind.formatIntervalle(60_000), "1 min");
  assert.equal(ind.formatIntervalle(30_000), "30 s");
  assert.equal(ind.formatIntervalle(90_000), "1 min 30 s");
  assert.equal(ind.formatIntervalle(5_400_000), "1 h 30");
  assert.equal(ind.libelleStatutGoal("active"), "en cours");
  assert.equal(ind.libelleStatutGoal("paused"), "en pause");
  const a = ind.normaliserEtat({ heartbeat: { interval_ms: 60000, message: "coucou", next_at_ms: 1000 }, goal: { text: "lot 3", status: "paused" } });
  assert.deepEqual(a.heartbeat, { interval_ms: 60000, message: "coucou", next_at_ms: 1000, last_at_ms: null });
  assert.equal(a.goal.status, "paused");
  const b = ind.normaliserEtat({ heartbeat: { interval_ms: 60000, message: "coucou", next_at_ms: 61000 }, goal: null });
  assert.equal(ind.vientDeSeDeclencher(a, b), true, "le prochain réveil a avancé : il s'est déclenché");
  assert.equal(ind.vientDeSeDeclencher(b, b), false);
  const c1 = ind.normaliserEtat({ heartbeat: { interval_ms: 300000, message: "x", next_at_ms: 600000, last_at_ms: 290000 } });
  const c2 = ind.normaliserEtat({ heartbeat: { interval_ms: 300000, message: "x", next_at_ms: 600000, last_at_ms: 301000 } });
  assert.equal(c2.heartbeat.last_at_ms, 301000, "heure du dernier réveil lue");
  assert.equal(ind.vientDeSeDeclencher(c1, c2), true, "réveil livré (dernier réveil a changé)");
  assert.equal(ind.vientDeSeDeclencher(c2, c2), false);
  assert.deepEqual(ind.normaliserEtat(null), { goal: null, heartbeat: null });
  assert.deepEqual(ind.normaliserEtat({ heartbeat: null, goal: null, autonomous: null }), { goal: null, heartbeat: null });
});

test("réveil : lecture du message injecté et texte de la bulle avec l'heure", () => {
  const at = new Date(2026, 9, 23, 14, 32, 5).getTime();
  assert.deepEqual(ind.lireReveil(`<heartbeat at_ms="${at}">\ncoucou\n</heartbeat>`), { message: "coucou", atMs: at });
  assert.deepEqual(ind.lireReveil("<heartbeat>\ncoucou\n</heartbeat>"), { message: "coucou", atMs: null });
  assert.equal(ind.lireReveil("bonjour"), null);
  assert.equal(ind.texteReveil("coucou", at), "réveil\u00a0: coucou · 14:32");
  assert.equal(ind.texteReveil("coucou", null), "réveil\u00a0: coucou");
});

const s = require(path.join(racine, "src/components/chat/stream.ts"));

test("le message du heartbeat est affiché : en direct et depuis l'historique", () => {
  const at = new Date(2026, 9, 23, 14, 32).getTime();
  let etat = s.initialStateFromHistory([{ role: "user", parts: [{ type: "text", text: "/heartbeat 1m coucou" }] }]);
  etat = [
    { type: "turn_started" },
    { type: "heartbeat_received", message: "coucou", at_ms: at },
    { type: "heartbeat_received", message: "coucou", at_ms: at },
  ].reduce((e, ev) => s.applyEvent(e, ev), etat);
  const reveils = etat.blocks.filter((b) => b.kind === "wake");
  assert.equal(reveils.length, 1, "un seul réveil (pas de doublon)");
  assert.deepEqual([reveils[0].message, reveils[0].atMs], ["coucou", at]);

  const hist = s.initialStateFromHistory([
    { role: "user", parts: [{ type: "text", text: `<heartbeat at_ms="${at}">\ncoucou\n</heartbeat>` }] },
    { role: "assistant", parts: [{ type: "text", text: "ok" }] },
  ]);
  assert.deepEqual(hist.blocks.map((b) => b.kind), ["wake", "assistant-text"]);
  assert.equal(hist.blocks.filter((b) => b.kind === "user-text").length, 0, "pas affiché comme un message de l'utilisateur");
});
