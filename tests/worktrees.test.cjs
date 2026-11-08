// Worktrees — logique des worktrees (noms, réglages, terminaux de départ, étapes) et accroches.
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
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const L = charger("../src/components/worktrees/logique.ts");
const T = charger("../src/components/worktrees/terminauxDepart.ts");

function stockage(initial = {}) {
  const d = new Map(Object.entries(initial));
  return { getItem: (k) => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), removeItem: (k) => d.delete(k), d };
}

test("branche proposée depuis le titre (même règle que le Rust)", () => {
  assert.equal(L.slug("Corriger le bug du panier !"), "corriger-le-bug-du-panier");
  assert.equal(L.slug("Été 2026 : Œuvre à l'œil"), "ete-2026-oeuvre-a-l-oeil");
  assert.equal(L.slug("feature/Login"), "feature-login");
  assert.equal(L.slug("***"), "tache");
  assert.ok(L.slug("mot ".repeat(40)).length <= 48);
  assert.ok(!L.slug("mot ".repeat(40)).endsWith("-"));
});

test("chemins : même dossier quelle que soit l'écriture", () => {
  assert.ok(L.memeChemin("\\\\?\\C:\\Users\\S\\depot", "c:/users/s/depot/"));
  assert.ok(!L.memeChemin("C:\\a", "C:\\b"));
  assert.equal(L.nomDe("\\\\?\\C:\\Users\\S\\depot-worktrees\\ma-tache"), "ma-tache");
  assert.equal(L.cheminAffiche("\\\\?\\C:\\x"), "C:\\x");
});

test("réglages par dépôt : base, accord sur les commandes, liens", () => {
  const s = stockage();
  let r = L.lireReglages(s);
  assert.deepEqual(r, L.reglagesVides());
  r = L.avecReglagesDepot(r, "\\\\?\\C:\\depot", { base: "develop", approuve: "abc" });
  L.ecrireReglages(s, r);
  r = L.lireReglages(s);
  assert.equal(L.reglagesDepot(r, "C:/depot").base, "develop");
  assert.ok(L.commandesApprouvees(r, "c:\\depot", "abc"));
  assert.ok(!L.commandesApprouvees(r, "c:\\depot", "autre"));
  assert.ok(L.commandesApprouvees(r, "ailleurs", null), "rien à approuver");
  assert.equal(L.baseParDefaut(r, "C:\\depot", "main", "main", ["main", "develop"]), "develop");
  assert.equal(L.baseParDefaut(L.reglagesVides(), "C:\\depot", null, "main", ["main", "x"]), "main");
  assert.equal(L.baseParDefaut(L.reglagesVides(), "C:\\depot", "x", "main", ["main", "x"]), "x");
  assert.equal(L.baseParDefaut(L.reglagesVides(), "C:\\depot", "absente", null, ["trunk"]), "trunk");
  r = L.avecLien(r, "C:\\wt", "https://github.com/o/d/pull/12");
  assert.equal(L.lienDe(r, "c:/wt"), "https://github.com/o/d/pull/12");
  r = L.avecLien(r, "c:/WT", "");
  assert.equal(L.lienDe(r, "C:\\wt"), undefined);
  assert.deepEqual(L.basculer(["C:\\a"], "c:/a"), []);
  assert.deepEqual(L.basculer([], "C:\\a"), ["C:\\a"]);
  assert.deepEqual(L.lireReglages(stockage({ [L.CLE_REGLAGES]: "{pas du json" })), L.reglagesVides());
});

test("liens PR / issue", () => {
  assert.ok(L.urlValide("https://github.com/o/d/issues/3"));
  assert.ok(!L.urlValide("javascript:alert(1)"));
  assert.ok(!L.urlValide("pas une adresse"));
  assert.equal(L.libelleLien("https://github.com/o/d/pull/12"), "PR #12");
  assert.equal(L.libelleLien("https://gitlab.com/o/d/-/merge_requests/7"), "PR #7");
  assert.equal(L.libelleLien("https://github.com/o/d/issues/34"), "Issue #34");
  assert.equal(L.libelleLien("https://linear.app/equipe/issue/PRJ-42/titre"), "PRJ-42");
  assert.equal(L.libelleLien("https://www.example.com/x"), "example.com");
});

test("formats : taille et ancienneté", () => {
  assert.equal(L.tailleLisible(512), "512 o");
  assert.equal(L.tailleLisible(1536), "1,5 Ko");
  assert.equal(L.tailleLisible(250 * 1024 * 1024), "250 Mo");
  const t = 1_800_000_000_000;
  assert.equal(L.ilYa(t - 30_000, t), "à l'instant");
  assert.equal(L.ilYa(t - 5 * 60_000, t), "il y a 5 min");
  assert.equal(L.ilYa(t - 3 * 86_400_000, t), "il y a 3 jours");
  assert.equal(L.joursDepuis(t - 3 * 86_400_000 - 1000, t), 3);
  assert.equal(L.joursDepuis(null, t), Infinity);
});

test("terminaux de départ : onglets nommés, commande lancée une seule fois", () => {
  const s = stockage({ "axecode:terminal-buffer:/d:terminal-1": "[\"ancien\"]" });
  T.preparerTerminaux("/d", [{ nom: "Serveur", commande: "npm run dev" }, { nom: "Terminal 2", commande: null }], s);
  const onglets = JSON.parse(s.getItem(T.cleOnglets("/d")));
  assert.deepEqual(onglets.map((o) => [o.index, o.title, o.customTitle, o.shell]), [[1, "Terminal 1", "Serveur", "powershell"], [2, "Terminal 2", undefined, "powershell"]]);
  assert.equal(s.getItem("axecode:terminal-buffer:/d:terminal-1"), null, "pas d'ancien historique");
  assert.equal(T.prendreCommandeDepart("/d", "terminal-2", s), null);
  assert.equal(T.prendreCommandeDepart("/d", "terminal-1", s), "npm run dev");
  assert.equal(T.prendreCommandeDepart("/d", "terminal-1", s), null, "une seule fois");
  T.preparerTerminaux("/e", [], s);
  assert.equal(JSON.parse(s.getItem(T.cleOnglets("/e"))).length, 1);
});

test("étapes affichées d'une tâche", () => {
  const base = { genre: "creation", etapes: ["git", "partage", "script", "fin"], etape: "partage", etat: "en_cours" };
  assert.deepEqual(L.etapesAffichees(base).map((e) => `${e.libelle}:${e.etat}`), ["Branche et dossier:fait", "Partage:cours", "Préparation:avenir"]);
  assert.deepEqual(L.etapesAffichees({ ...base, etape: "script", etat: "echec" }).map((e) => e.etat), ["fait", "fait", "echec"]);
  assert.deepEqual(L.etapesAffichees({ ...base, etape: "fin", etat: "reussi" }).map((e) => e.etat), ["fait", "fait", "fait"]);
  const sup = { genre: "archivage", etapes: ["script", "git", "fin"], etape: "git", etat: "en_cours" };
  assert.deepEqual(L.etapesAffichees(sup).map((e) => e.libelle), ["Script de suppression", "Retrait du dossier"]);
});

test("accroches : Workspace, panneau Git, terminaux, raccourci, commandes Tauri", () => {
  assert.match(lire("src/components/Workspace.tsx"), /<WorktreesRacine dossier=\{workspacePath\}/);
  assert.match(lire("src/components/GitPanel.tsx"), /ouvrirWorktrees\("nouveau", workspacePath\)/);
  const terminaux = lire("src/components/TerminalPanel.tsx");
  assert.match(terminaux, /prendreCommandeDepart\(workspacePath, session\.id\)/);
  assert.ok(terminaux.includes(`localStorage.getItem(terminalStorageKey(workspacePath))`) && terminaux.includes("axecode:terminals:${workspacePath}"), "format des onglets inchangé");
  assert.match(lire("src/axe/raccourcis.ts"), /id: "nouveauWorktree"/);
  const lib = lire("src-tauri/src/lib.rs");
  for (const c of ["worktrees_config", "worktree_creer", "worktree_tache_reprendre", "worktree_tache_sortie"]) assert.ok(lib.includes(`worktrees::${c}`), c);
});
