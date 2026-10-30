const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const sourcePath = path.resolve(__dirname, "../src/components/chat/mentionsLibre.ts");
const js = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const m = new Module(sourcePath, module);
m._compile(js, sourcePath);
const { filtrerMentionsConversation } = m.exports;

test("sans dossier : @ ne propose que les fichiers de la conversation ouverte", () => {
  const files = [{ relativePath: "c1/a.txt" }, { relativePath: "c2/b.txt" }, { relativePath: "c1\\sous\\c.txt" }, { relativePath: "c10/d.txt" }];
  assert.deepEqual(filtrerMentionsConversation(files, "c1").map((f) => f.relativePath), ["c1/a.txt", "c1\\sous\\c.txt"]);
  assert.equal(filtrerMentionsConversation(files, null).length, 4);
});
