"use strict";
// Terminaux par dossier : au changement de dossier (Ctrl+1…9), le panneau du dossier quitté
// reste monté et caché (terminaux vivants) ; chaque dossier a ses identifiants auprès du service.
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
const T = charger("../src/lib/terminalDossier.ts");

test("même onglet, deux dossiers : deux identifiants distincts et stables", () => {
  const a = T.identifiantPty("/p/a", "terminal-1");
  const b = T.identifiantPty("/p/b", "terminal-1");
  assert.notEqual(a, b);
  assert.equal(a, T.identifiantPty("/p/a", "terminal-1"));
  assert.ok(a.startsWith("terminal-1@"));
  assert.ok(T.identifiantPty("C:\\\\" + "x".repeat(300), "terminal-12").length <= 256, "accepté par le service (256 car. au plus)");
});

test("le dossier quitté garde son panneau s'il avait des terminaux, le dossier ouvert est retiré de la liste", () => {
  let q = [];
  q = T.quitterDossier(q, "/a", true, "/b");
  assert.deepEqual(q, ["/a"]);
  assert.deepEqual(T.dossiersAvecTerminal(q, "/b", false), ["/a"]);
  assert.deepEqual(T.dossiersAvecTerminal(q, "/b", true), ["/a", "/b"]);
  q = T.quitterDossier(q, "/b", true, "/c");
  assert.deepEqual(q, ["/a", "/b"]);
  q = T.quitterDossier(q, "/c", false, "/a");
  assert.deepEqual(q, ["/b"], "retour sur /a : son panneau redevient celui du dossier ouvert");
  assert.deepEqual(T.dossiersAvecTerminal(q, "/a", true), ["/b", "/a"]);
  q = T.quitterDossier(q, "/a", false, "/b");
  assert.deepEqual(q, [], "terminaux de /a fermés : rien à garder");
});

test("l'espace monte un panneau par dossier ; le panneau parle au service avec l'identifiant du dossier", () => {
  const w = fs.readFileSync(path.resolve(__dirname, "../src/components/Workspace.tsx"), "utf8");
  assert.match(w, /dossiersAvecTerminal\(terminauxQuittes, workspacePath, terminalAvailable\)/);
  assert.match(w, /key=\{`\$\{cle\}:\$\{dossier\}`\}/);
  assert.match(w, /masque=\{!courant\}/);
  assert.match(w, /active=\{courant && terminalVisible\}/);
  assert.match(w, /setTerminauxQuittes\(quitterDossier\(terminauxQuittes, cheminDisposition, terminalAvailable, workspacePath\)\)/);
  const t = fs.readFileSync(path.resolve(__dirname, "../src/components/TerminalPanel.tsx"), "utf8");
  const surface = t.slice(t.indexOf("function TerminalSurface("));
  assert.match(surface, /const idPty = identifiantPty\(workspacePath, session\.id\)/);
  assert.doesNotMatch(surface, /api\.(spawnTerminal|writeTerminal|killTerminal|resizeTerminal)\([^)]*?\bsession\.id\b/s);
  assert.doesNotMatch(surface, /payload\.sessionId !== session\.id/);
  assert.match(surface, /sessionId: idPty,/);
});
