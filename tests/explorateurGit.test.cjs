"use strict";
// Explorateur : couleurs git (modifié, nouveau, ignoré, en conflit) sur les
// fichiers et les dossiers ; clic droit « Rechercher dans ce dossier » (volet limité au dossier).
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
const racine = path.resolve(__dirname, "..");
const G = require(path.join(racine, "src/components/palette/etatGit.ts"));
const RD = require(path.join(racine, "src/components/palette/rechercheDossier.ts"));
const lire = (p) => fs.readFileSync(path.join(racine, p), "utf8");

const liste = [
  { chemin: "src/a.ts", etat: "modifie" },
  { chemin: "src/ui/b.tsx", etat: "nouveau" },
  { chemin: "src/ui/c.tsx", etat: "conflit" },
  { chemin: "docs/vieux.md", etat: "supprime" },
  { chemin: "tmp/", etat: "nouveau" },
  { chemin: "dist/", etat: "ignore" },
  { chemin: "trace.log", etat: "ignore" },
];

test("fichiers : leur propre état ; un fichier dans un dossier entier non suivi ou ignoré en hérite", () => {
  const c = G.carteGit(liste);
  assert.equal(G.etatDe(c, "src/a.ts", false), "modifie");
  assert.equal(G.etatDe(c, "src/ui/b.tsx", false), "nouveau");
  assert.equal(G.etatDe(c, "src/ui/c.tsx", false), "conflit");
  assert.equal(G.etatDe(c, "tmp/x/y.txt", false), "nouveau");
  assert.equal(G.etatDe(c, "dist/app.js", false), "ignore");
  assert.equal(G.etatDe(c, "trace.log", false), "ignore");
  assert.equal(G.etatDe(c, "src/propre.ts", false), null);
  assert.equal(G.etatDe(c, "docs/vieux.md", false), null, "un fichier supprimé n'est plus dans l'arbre");
  assert.equal(G.etatDe(null, "src/a.ts", false), null);
});

test("dossiers : le plus important de leur contenu (conflit > modifié > nouveau), ignoré seulement s'il l'est lui-même", () => {
  const c = G.carteGit(liste);
  assert.equal(G.etatDe(c, "src", true), "conflit");
  assert.equal(G.etatDe(c, "src/ui", true), "conflit");
  assert.equal(G.etatDe(c, "docs", true), "modifie", "contient un fichier supprimé");
  assert.equal(G.etatDe(c, "tmp", true), "nouveau");
  assert.equal(G.etatDe(c, "tmp/x", true), "nouveau");
  assert.equal(G.etatDe(c, "dist", true), "ignore");
  assert.equal(G.etatDe(c, "crates", true), null);
  const seul = G.carteGit([{ chemin: "web/neuf.ts", etat: "nouveau" }, { chemin: "web/a.ts", etat: "modifie" }]);
  assert.equal(G.etatDe(seul, "web", true), "modifie");
  assert.equal(G.LIBELLES_GIT.modifie.lettre, "M");
});

test("« Rechercher dans ce dossier » : dossier gardé, événement, filtre des résultats", () => {
  const recus = [];
  const cible = new EventTarget();
  cible.addEventListener(RD.EVENEMENT_RECHERCHE_DOSSIER, (e) => recus.push(e.detail.dossier));
  RD.demanderRechercheDossier("src\\components\\", cible);
  assert.equal(RD.dossierDeRecherche(), "src/components");
  assert.deepEqual(recus, ["src/components"]);
  assert.equal(RD.dansDossier("src/components/A.tsx", "src/components"), true);
  assert.equal(RD.dansDossier("src/componentsX/A.tsx", "src/components"), false);
  assert.equal(RD.dansDossier("autre.ts", null), true);
  RD.oublierRechercheDossier();
  assert.equal(RD.dossierDeRecherche(), null);
});

test("branché : couleurs et lettre dans l'arbre, entrée du clic droit, volet limité, commandes Tauri", () => {
  const arbre = lire("src/components/FileTree.tsx");
  assert.match(arbre, /useEtatGit\(workspacePath/);
  assert.match(arbre, /data-git=\{/);
  assert.match(arbre, /className="tree-row__git"/);
  assert.match(arbre, /Rechercher dans ce dossier/);
  assert.match(arbre, /demanderRechercheDossier\(/);
  const volet = lire("src/components/SearchPane.tsx");
  assert.match(volet, /dossierDeRecherche\(\)/);
  assert.match(volet, /palette_recherche_dossier/);
  assert.match(volet, /className="search-pane__dossier"/);
  const pe = lire("src/components/palette/PaletteEspace.tsx");
  assert.match(pe, /EVENEMENT_RECHERCHE_DOSSIER/);
  assert.match(lire("src/components/Workspace.tsx"), /ouvrirRecherche=\{/);
  const lib = lire("src-tauri/src/lib.rs");
  assert.match(lib, /explorateur_git::explorateur_git/);
  assert.match(lib, /explorateur_git::palette_recherche_dossier/);
  assert.match(lire("src/components/palette/explorateur.css"), /\.tree-row\[data-git="conflit"\]/);
});
