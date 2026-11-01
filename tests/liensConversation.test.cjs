const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Barre des liens de la conversation : extraction, types, doublons, ordre.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const { liensDeConversation, typeDeLien } = require(path.join(racine, "src/lib/liensConversation.ts"));
const valeurs = (b) => liensDeConversation(b).map((l) => `${l.type}:${l.valeur}`);

test("messages : chemins, URL nues et liens Markdown, plus récents d'abord", () => {
  const blocs = [
    { kind: "user-text", text: "regarde src/a.ts" },
    { kind: "assistant-text", text: "Vu `src/b.rs:12`, la [doc](https://docs.exemple.fr/x) et https://github.com/o/r." },
  ];
  assert.deepEqual(valeurs(blocs), ["url:https://github.com/o/r", "url:https://docs.exemple.fr/x", "code:src/b.rs", "code:src/a.ts"]);
});
test("sans doublons : même fichier à une autre ligne, ./, barres inverses", () => {
  const blocs = [
    { kind: "assistant-text", text: "src/a.ts:3 puis ./src/a.ts" },
    { kind: "assistant-text", text: "src\\a.ts:9 et src/a.ts" },
  ];
  assert.equal(liensDeConversation(blocs).length, 1);
});
test("fichiers cités par les outils : arguments et fichiers modifiés", () => {
  const blocs = [
    { kind: "tool", argsRaw: JSON.stringify({ path: "docs/guide.pdf", offset: 3 }) },
    { kind: "tool", argsRaw: "{pas du json", fileChanges: [{ relativePath: "media/demo.mp4" }] },
    { kind: "tool", argsRaw: JSON.stringify({ command: "ls src/x.ts" }) },
  ];
  assert.deepEqual(valeurs(blocs), ["video:media/demo.mp4", "pdf:docs/guide.pdf"]);
});
test("types : images, vidéos, pdf, code, URL (même une URL d'image)", () => {
  assert.equal(typeDeLien("captures/a.PNG", "fichier"), "image");
  assert.equal(typeDeLien("C:\\v\\film.mov:2", "fichier"), "video");
  assert.equal(typeDeLien("notes/compte-rendu.docx", "fichier"), "autre");
  assert.equal(typeDeLien("https://x.fr/a/plan.pdf?dl=1", "url"), "pdf");
  assert.equal(typeDeLien("https://x.fr/logo.jpg", "url"), "image");
  assert.equal(typeDeLien("https://x.fr/page", "url"), "url");
});
test("conversation sans lien : liste vide (barre masquée)", () => {
  assert.deepEqual(liensDeConversation([{ kind: "assistant-text", text: "Bonjour" }, { kind: "thinking", text: "src/a.ts" }]), []);
});
