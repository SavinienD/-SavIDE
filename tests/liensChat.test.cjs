const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// axe:liens — URL, chemins (Linux/macOS/Windows) et texte bien séparés.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const { decouperLiens, estFichier, raccourcirUrl, nettoyerUrl } = require(path.join(racine, "src/components/chat/liensChat.ts"));
const resume = (t) => decouperLiens(t).map((s) => `${s.genre}:${s.texte}`);

test("URL nue : un seul lien, pas de chemin à l'intérieur", () => {
  assert.deepEqual(resume("voir https://exemple.fr/docs/page.html."), ["texte:voir ", "url:https://exemple.fr/docs/page.html", "texte:."]);
});
test("ponctuation et parenthèses autour d'une URL", () => {
  assert.equal(nettoyerUrl("https://fr.wikipedia.org/wiki/A_(b))"), "https://fr.wikipedia.org/wiki/A_(b)");
  assert.deepEqual(resume("(https://a.fr/x)"), ["texte:(", "url:https://a.fr/x", "texte:)"]);
});
test("chemins Linux et macOS : relatifs, absolus, ~ et numéro de ligne", () => {
  assert.deepEqual(resume("src/main.rs:12 et /home/agent/a/b.txt"), ["fichier:src/main.rs:12", "texte: et ", "fichier:/home/agent/a/b.txt"]);
  assert.deepEqual(resume("~/Documents/note.md"), ["fichier:~/Documents/note.md"]);
});
test("chemins Windows : absolu et relatif à barres inverses", () => {
  assert.deepEqual(resume("ouvre C:\\Users\\sav\\a.txt puis src\\lib\\ipc.ts"), ["texte:ouvre ", "fichier:C:\\Users\\sav\\a.txt", "texte: puis ", "fichier:src\\lib\\ipc.ts"]);
});
test("pas de faux liens : version, adresse e-mail, phrase", () => {
  assert.deepEqual(resume("version 0.1.67 pour a@b.md, fin."), ["texte:version 0.1.67 pour a@b.md, fin."]);
  assert.ok(estFichier("package.json"));
  assert.ok(!estFichier("https://a.fr/b.json"));
});
test("libellé raccourci des URL longues", () => {
  assert.equal(raccourcirUrl("https://www.exemple.fr/"), "exemple.fr");
  const r = raccourcirUrl("https://github.com/exemple/projet/actions/runs/123456789/job/987654321?check_suite_focus=true");
  assert.equal(r.length, 60);
  assert.ok(r.includes("…"));
});
