// axe:explorateur — chemins sans « \\?\ », raccourcis de copie, tri et navigation clavier.
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
const lire = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
const A = charger("../src/lib/arbreFichiers.ts");

test("le préfixe de chemin long Windows est retiré", () => {
  assert.equal(A.cheminAffiche("\\\\?\\C:\\Users\\x\\a.txt"), "C:\\Users\\x\\a.txt");
  assert.equal(A.cheminAffiche("\\\\?\\UNC\\srv\\part\\a"), "\\\\srv\\part\\a");
  assert.equal(A.cheminAffiche("/home/a/b"), "/home/a/b");
  assert.equal(A.cheminRelatifSysteme("src/lib/a.ts", true), "src\\lib\\a.ts");
  assert.equal(A.cheminRelatifSysteme("src/lib/a.ts", false), "src/lib/a.ts");
});

test("le backend rend des chemins absolus sans « \\\\?\\ » (os_path)", () => {
  const rs = lire("../crates/axecode-app/src/workspace.rs");
  assert.doesNotMatch(rs, /\n\s+absolute_path: path\.display\(\)\.to_string\(\)/);
  const plat = lire("../src-tauri/src/platform.rs");
  assert.match(plat, /fn reveal_path[\s\S]*os_path/);
});

test("FileTree copie et affiche les chemins nettoyés", () => {
  const ft = lire("../src/components/FileTree.tsx");
  assert.match(ft, /cheminAffiche\(item\.absolutePath\)/);
  assert.match(ft, /raccourciCopieChemin\(/);
  assert.match(ft, /Ouvrir avec…/);
  assert.match(ft, /Ouvrir dans l'explorateur|Afficher dans le Finder/);
});

test("Ctrl+C = absolu, Ctrl+Maj+C = relatif ; Cmd sur macOS", () => {
  const k = (o) => ({ key: "c", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
  assert.equal(A.raccourciCopieChemin(k({ ctrlKey: true }), false), "absolu");
  assert.equal(A.raccourciCopieChemin(k({ ctrlKey: true, shiftKey: true, key: "C" }), false), "relatif");
  assert.equal(A.raccourciCopieChemin(k({ metaKey: true }), true), "absolu");
  assert.equal(A.raccourciCopieChemin(k({ ctrlKey: true }), true), null);
  assert.equal(A.raccourciCopieChemin(k({ metaKey: true }), false), null);
  assert.equal(A.raccourciCopieChemin(k({ ctrlKey: true, key: "v" }), false), null);
});

test("tri par nom, date, taille, sens et dossiers d'abord", () => {
  const e = [
    { name: "b.txt", kind: "file", modifiedMs: 3, size: 10 },
    { name: "A10.md", kind: "file", modifiedMs: 1, size: 300 },
    { name: "a2.md", kind: "file", modifiedMs: 2, size: 20 },
    { name: "zdir", kind: "directory", modifiedMs: 9, size: 0 },
  ];
  const noms = (t) => A.trierEntrees(e, t).map((x) => x.name);
  assert.deepEqual(noms(A.TRI_PAR_DEFAUT), ["zdir", "a2.md", "A10.md", "b.txt"]);
  assert.deepEqual(noms({ cle: "nom", sens: "decroissant", dossiersDabord: true }), ["zdir", "b.txt", "A10.md", "a2.md"]);
  assert.deepEqual(noms({ cle: "date", sens: "decroissant", dossiersDabord: false }), ["zdir", "b.txt", "a2.md", "A10.md"]);
  assert.deepEqual(noms({ cle: "taille", sens: "croissant", dossiersDabord: true }), ["zdir", "b.txt", "a2.md", "A10.md"]);
  assert.deepEqual(A.lireTri('{"cle":"taille","sens":"decroissant","dossiersDabord":false}'), { cle: "taille", sens: "decroissant", dossiersDabord: false });
  assert.deepEqual(A.lireTri("n'importe quoi"), A.TRI_PAR_DEFAUT);
});

test("navigation clavier : haut/bas, Début/Fin, droite/gauche, Entrée", () => {
  const l = [
    { relativePath: "src", kind: "directory" },
    { relativePath: "src/a.ts", kind: "file" },
    { relativePath: "tests", kind: "directory" },
    { relativePath: "README.md", kind: "file" },
  ];
  const dep = (p) => p === "src";
  assert.deepEqual(A.actionClavier(l, "src", "ArrowDown", dep), { type: "selectionner", relativePath: "src/a.ts" });
  assert.deepEqual(A.actionClavier(l, "src", "ArrowUp", dep), { type: "selectionner", relativePath: "src" });
  assert.deepEqual(A.actionClavier(l, "README.md", "ArrowDown", dep), { type: "selectionner", relativePath: "README.md" });
  assert.deepEqual(A.actionClavier(l, null, "ArrowDown", dep), { type: "selectionner", relativePath: "src" });
  assert.deepEqual(A.actionClavier(l, "src/a.ts", "End", dep), { type: "selectionner", relativePath: "README.md" });
  assert.deepEqual(A.actionClavier(l, "README.md", "Home", dep), { type: "selectionner", relativePath: "src" });
  assert.deepEqual(A.actionClavier(l, "tests", "ArrowRight", dep), { type: "deplier", relativePath: "tests" });
  assert.deepEqual(A.actionClavier(l, "src", "ArrowRight", dep), { type: "selectionner", relativePath: "src/a.ts" });
  assert.deepEqual(A.actionClavier(l, "src", "ArrowLeft", dep), { type: "replier", relativePath: "src" });
  assert.deepEqual(A.actionClavier(l, "src/a.ts", "ArrowLeft", dep), { type: "selectionner", relativePath: "src" });
  assert.deepEqual(A.actionClavier(l, "src/a.ts", "Enter", dep), { type: "ouvrir", relativePath: "src/a.ts" });
});
