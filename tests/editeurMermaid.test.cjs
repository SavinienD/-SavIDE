"use strict";
// ED3a : visionneuse des fichiers Mermaid (.mmd, .mermaid) : diagramme
// au-dessus du code (bascule Diagramme / Code), agrandi au clic (molette = zoom).
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
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
const R = require(path.join(racine, "src/components/viewers/registry.ts"));

test(".mmd et .mermaid : visionneuse Mermaid par-dessus le code, diagramme affiché à l'ouverture", () => {
  for (const f of ["flux.mmd", "docs/archi.MERMAID"]) {
    const spec = R.viewerForPath(f);
    assert.equal(spec?.kind, "mermaid", f);
    assert.equal(spec.fromFile, false, "le texte vient de l'éditeur (modifications en direct)");
    assert.equal(spec.overlay.previewByDefault, true);
    assert.equal(spec.overlay.previewLabel, "Diagramme");
    assert.equal(spec.overlay.sourceLabel, "Code");
  }
  assert.notEqual(R.viewerForPath("notes.md")?.kind, "mermaid");
});

test("branchements : ViewerHost charge MermaidViewer à la demande, qui réutilise le diagramme du chat", () => {
  const host = lire("src/components/viewers/ViewerHost.tsx");
  assert.match(host, /lazy\(\(\) => import\("\.\/MermaidViewer"\)\)/);
  assert.match(host, /case "mermaid":/);
  const v = lire("src/components/viewers/MermaidViewer.tsx");
  assert.match(v, /MermaidDiagram/);
});
