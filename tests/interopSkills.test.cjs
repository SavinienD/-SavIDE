// skills de Claude Code / Codex et skills installés depuis une adresse.
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
const S = charger("../src/lib/skillsExternes.ts");
const sk = (nom, racine, etat, outil = "claude_code") => ({ chemin: `/h/${racine}/${nom}`, nom, nomSource: nom, description: "", outil, portee: "global", racine, fichiers: 1, octets: 10, empreinte: "x", etat });

test("seuls les nouveaux et les mises à jour se cochent, et sont cochés au départ", () => {
  const liste = [sk("a", "~/.claude/skills", "nouveau"), sk("b", "~/.claude/skills", "importe"), sk("c", "~/.codex/skills", "mise_a_jour", "codex"), sk("d", "~/.agents/skills", "conflit", "agents")];
  assert.deepEqual([...S.selectionInitiale(liste, (s) => s.chemin)], ["/h/~/.claude/skills/a", "/h/~/.codex/skills/c"]);
  assert.equal(S.cochable("conflit"), false);
  assert.equal(S.nombreMisesAJour(liste), 1);
  assert.deepEqual(S.grouperParRacine(liste).map((g) => [g.racine, g.skills.length]), [["~/.claude/skills", 2], ["~/.codex/skills", 1], ["~/.agents/skills", 1]]);
});

test("libellés en français", () => {
  assert.equal(S.libelleEtat("mise_a_jour"), "mise à jour disponible");
  assert.equal(S.libelleEtat("conflit"), "nom déjà pris");
  assert.equal(S.libelleOutil("codex"), "Codex");
  assert.equal(S.taille(2048), "2 Ko");
  assert.equal(S.taille(3 * 1024 * 1024 + 200000), "3,2 Mo");
  assert.equal(S.libelleVersion({ version: "1.2" }, { genre: "git", version: "abc123def456" }), "version 1.2 · révision abc123def456");
  assert.equal(S.libelleVersion({}, { genre: "zip", version: "0f0f" }), "archive 0f0f");
  assert.equal(S.resumeRapport({ faits: ["a", "b"], erreurs: ["c : nom pris"] }), "2 skills importés, 1 erreur\u00a0: c : nom pris");
  assert.equal(S.resumeRapport({ faits: ["a"], erreurs: [] }, "installé"), "1 skill installé");
});

test("adresse : https seulement, message clair sinon", () => {
  assert.equal(S.adresseValide("https://github.com/o/r"), null);
  assert.match(S.adresseValide(""), /Collez/);
  assert.match(S.adresseValide("git@github.com:o/r.git"), /https:\/\//);
});
