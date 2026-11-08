// Revue des changements : texte choisi dans l'aperçu Markdown -> lignes de la source
// (src/components/revue/apercuNotes.ts), et crochet minimal dans l'aperçu (EditorPane).
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
const A = require(path.resolve(__dirname, "../src/components/revue/apercuNotes.ts"));

const SOURCE = [
  "# Guide de la **revue**",
  "",
  "Choisir des lignes dans le *diff*, puis « Noter ».",
  "",
  "- [ ] Installer `git`",
  "- Lancer la [vue des changements](docs/revue.md)",
  "",
  "> Les notes partent en un seul message.",
].join("\n");

test("syntaxe Markdown retirée d'une ligne", () => {
  assert.equal(A.texteSansMarkdown("# Guide de la **revue**"), "Guide de la revue");
  assert.equal(A.texteSansMarkdown("- [ ] Installer `git`"), "Installer git");
  assert.equal(A.texteSansMarkdown("- Lancer la [vue des changements](docs/revue.md)"), "Lancer la vue des changements");
});

test("une ligne choisie dans le rendu retrouve sa ligne de source", () => {
  assert.deepEqual(A.lignesDansSource(SOURCE, "Guide de la revue"), { debut: 1, fin: 1 });
  assert.deepEqual(A.lignesDansSource(SOURCE, "dans le diff, puis"), { debut: 3, fin: 3 });
  assert.deepEqual(A.lignesDansSource(SOURCE, "Les notes partent"), { debut: 8, fin: 8 });
});

test("plusieurs lignes : début et fin ; texte introuvable : null", () => {
  assert.deepEqual(A.lignesDansSource(SOURCE, "Installer git\nLancer la vue des changements"), { debut: 5, fin: 6 });
  assert.equal(A.lignesDansSource(SOURCE, "texte absent de la source"), null);
  assert.equal(A.lignesDansSource(SOURCE, "   \n "), null);
});

test("crochet minimal : l'aperçu Markdown monte NoteApercu (fichiers du dossier seulement)", () => {
  const tsx = fs.readFileSync(path.resolve(__dirname, "../src/components/EditorPane.tsx"), "utf8");
  const apercu = tsx.indexOf('className="editor-md-preview"');
  const crochet = tsx.indexOf("<NoteApercu fichier={activeTab.relativePath} source={activeTab.buffer} />");
  assert.ok(apercu > 0 && crochet > apercu && crochet - apercu < 400, "NoteApercu dans le conteneur de l'aperçu");
  assert.match(tsx, /activeTab\.external \? null : <NoteApercu/);
});
