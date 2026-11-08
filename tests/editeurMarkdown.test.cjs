"use strict";
// ED2a : Markdown édité et aperçu côte à côte, défilement synchronisé
// (ancres « data-ligne » posées par rehypeAncresLignes dans l'aperçu, interpolation ligne <-> hauteur).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const memoire = new Map();
global.localStorage = {
  getItem: (k) => (memoire.has(k) ? memoire.get(k) : null),
  setItem: (k, v) => memoire.set(k, String(v)),
  removeItem: (k) => memoire.delete(k),
};
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
const M = require(path.join(racine, "src/components/editeur/modeMarkdown.ts"));
const { rehypeAncresLignes } = require(path.join(racine, "src/components/editeur/rehypeAncresLignes.ts"));
const S = require(path.join(racine, "src/components/editeur/defilementSynchro.ts"));

test("mode d'un .md mémorisé par fichier (source, côte à côte, aperçu), ancien choix Rendu/Code relu", () => {
  memoire.clear();
  assert.equal(M.modeMarkdownMemorise("C:\\a.md"), null);
  M.memoriserModeMarkdown("C:\\a.md", "cote");
  assert.equal(M.modeMarkdownMemorise("C:\\a.md"), "cote");
  memoire.set("axecode.vueFichiers", JSON.stringify({ "C:\\b.md": true, "C:\\c.md": false }));
  assert.equal(M.modeMarkdownMemorise("C:\\b.md"), "apercu");
  assert.equal(M.modeMarkdownMemorise("C:\\c.md"), "source");
  M.memoriserModeMarkdown("C:\\b.md", "source");
  assert.equal(M.modeMarkdownMemorise("C:\\b.md"), "source");
  for (let i = 0; i < 450; i++) M.memoriserModeMarkdown(`C:\\f${i}.md`, "cote");
  assert.ok(Object.keys(JSON.parse(memoire.get(M.CLE_MODES_MARKDOWN))).length <= 400, "borné");
});

async function hast(md) {
  const { unified } = await import("unified");
  const remarkParse = (await import("remark-parse")).default;
  const remarkGfm = (await import("remark-gfm")).default;
  const remarkRehype = (await import("remark-rehype")).default;
  const rehypeHighlight = (await import("rehype-highlight")).default;
  const p = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeHighlight, { detect: true, ignoreMissing: true }).use(rehypeAncresLignes);
  return p.runSync(p.parse(md));
}
function ancres(noeud, parent = null, sortie = []) {
  for (const e of noeud.children ?? []) {
    if (e.type === "element" && e.properties?.dataLigne !== undefined) sortie.push({ dans: parent?.tagName, ligne: e.properties.dataLigne });
    ancres(e, e, sortie);
  }
  return sortie;
}

test("ancres de lignes : titres, paragraphes, éléments de liste, blocs de code, lignes de tableau", async () => {
  const md = ["# Titre", "", "Un paragraphe", "sur deux lignes.", "", "- un", "- [ ] deux", "", "```js", "const a = 1;", "```", "", "| A | B |", "|---|---|", "| 1 | 2 |", "", "Texte avec `code` en ligne."].join("\n");
  const a = ancres(await hast(md));
  assert.deepEqual(a, [
    { dans: "h1", ligne: 1 }, { dans: "p", ligne: 3 }, { dans: "li", ligne: 6 }, { dans: "li", ligne: 7 },
    { dans: "code", ligne: 9 }, { dans: "th", ligne: 13 }, { dans: "td", ligne: 15 }, { dans: "p", ligne: 17 },
  ]);
  // Le bloc de code reste un seul <code> sous <pre> (le Markdown du chat y cherche Mermaid).
  const arbre = await hast("```mermaid\ngraph LR\nA-->B\n```");
  const pre = arbre.children.find((n) => n.tagName === "pre");
  assert.equal(pre.children.filter((n) => n.type === "element").length, 1);
});

test("défilement : ligne -> hauteur et hauteur -> ligne, par interpolation entre ancres", () => {
  const a = S.nettoyerAncres([{ ligne: 1, y: 0 }, { ligne: 10, y: 400 }, { ligne: 5, y: 100 }, { ligne: 5, y: 150 }, { ligne: 8, y: 90 }, { ligne: 41, y: 1600 }]);
  assert.deepEqual(a, [{ ligne: 1, y: 0 }, { ligne: 5, y: 100 }, { ligne: 10, y: 400 }, { ligne: 41, y: 1600 }], "triées, sans doublon, hauteur croissante");
  assert.equal(S.yPourLigne(a, 1), 0);
  assert.equal(S.yPourLigne(a, 3), 50);
  assert.equal(S.yPourLigne(a, 7.5), 250);
  assert.equal(S.yPourLigne(a, 99), 1600);
  assert.equal(S.lignePourY(a, 50), 3);
  assert.equal(S.lignePourY(a, 250), 7.5);
  assert.equal(S.lignePourY(a, 5000), 41);
  for (const l of [1, 2.5, 6, 9.9, 20, 40]) assert.ok(Math.abs(S.lignePourY(a, S.yPourLigne(a, l)) - l) < 1e-9, `aller-retour ${l}`);
  assert.equal(S.yPourLigne([], 3), 0);
  assert.equal(S.positionDefilement(0, 1000, 400), "haut");
  assert.equal(S.positionDefilement(300, 1000, 400), "milieu");
  assert.equal(S.positionDefilement(599, 1000, 400), "bas");
});

test("branchements : bouton Côte à côte, aperçu avec ancres, défilement synchronisé", () => {
  const ed = lire("src/components/EditorPane.tsx");
  assert.match(ed, /data-mode-md="cote"/);
  assert.match(ed, /className="tab-action editor-preview-toggle"/, "le bouton Aperçu / Source garde sa classe (scènes, autres écrans)");
  assert.match(ed, /data-mode=\{/);
  assert.match(ed, /useDefilementSynchro\(/);
  assert.match(ed, /lignesSource/);
  const md = lire("src/components/chat/Markdown.tsx");
  assert.match(md, /lignesSource\?: boolean/);
  assert.match(md, /rehypeAncresLignes/);
});
