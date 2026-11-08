"use strict";
// Vue « Tableau » de l'onglet Agents : colonnes Attend votre réponse /
// Travaille / Fini, non lu / Échec / Au repos ; le statut réel passe avant l'état noté.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const T = require(path.resolve(__dirname, "../src/components/agents/agentsTableau.ts"));
const s = (id, status, updatedAtMs = 1) => ({ id, status, updatedAtMs });

test("colonne : statut réel d'abord, puis l'état du centre (lu ou non)", () => {
  assert.equal(T.colonneDe("running", { genre: "attente", depuis: 1 }), "travaille");
  assert.equal(T.colonneDe("idle", { genre: "attente", depuis: 1, lu: true }), "attente", "une question lue attend toujours");
  assert.equal(T.colonneDe("idle", { genre: "fini", depuis: 1 }), "fini");
  assert.equal(T.colonneDe("idle", { genre: "fini", depuis: 1, lu: true }), "repos");
  assert.equal(T.colonneDe("inactive", { genre: "echec", depuis: 1 }), "echec");
  assert.equal(T.colonneDe("idle", { genre: "echec", depuis: 1, lu: true }), "repos");
  assert.equal(T.colonneDe("inactive", undefined), "repos");
});

test("répartition : la plus récente d'abord ; statut effectif (rond d'activité) pris en compte", () => {
  const sessions = [s("a", "idle", 10), s("b", "inactive", 50), s("c", "idle", 30), s("d", "idle", 5)];
  const statuts = new Map([["d", "running"]]);
  const etats = { a: { genre: "fini", depuis: 100 }, c: { genre: "fini", depuis: 20 }, b: { genre: "attente", depuis: 60 } };
  const r = T.repartir(sessions, statuts, etats);
  assert.deepEqual(r.fini.map((x) => x.id), ["a", "c"]);
  assert.deepEqual(r.attente.map((x) => x.id), ["b"]);
  assert.deepEqual(r.travaille.map((x) => x.id), ["d"]);
  assert.deepEqual(r.repos, []);
  assert.deepEqual(T.COLONNES_TABLEAU.map((c) => c.titre), ["Attend votre réponse", "Travaille", "Fini, non lu", "Échec", "Au repos"]);
});

test("attention, durées, dossier, vue mémorisée", () => {
  assert.equal(T.demandeAttention({ genre: "attente", depuis: 1, lu: true }), true);
  assert.equal(T.demandeAttention({ genre: "echec", depuis: 1 }), true);
  assert.equal(T.demandeAttention({ genre: "fini", depuis: 1 }), false);
  const m = 10_000_000;
  assert.equal(T.depuisQuand(m - 20_000, m), "à l'instant");
  assert.equal(T.depuisQuand(m - 5 * 60_000, m), "il y a 5 min");
  assert.equal(T.depuisQuand(m - 3 * 3_600_000, m), "il y a 3 h");
  assert.equal(T.depuisQuand(m - 26 * 3_600_000, m), "hier");
  assert.equal(T.nomDossier("\\\\?\\C:\\Users\\Savinien\\Documents\\prime agent\\"), "prime agent");
  assert.equal(T.lireVue({ getItem: () => "tableau" }), "tableau");
  assert.equal(T.lireVue({ getItem: () => null }), "arbre");
  assert.equal(T.lireVue({ getItem: () => { throw new Error("x"); } }), "arbre");
});
