// Rond de l'accueil d'après le service local (formes réelles du service).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = new Module(p, module); m.filename = p; m.paths = Module._nodeModulePaths(path.dirname(p)); m._compile(js, p); return m.exports;
}
const { sessionsEnCours, majSessionsEnCours, dossierAuTravail } = charger("../src/lib/toursActifs.ts");
const WS_SERVICE = "\\\\?\\C:\\Users\\utilisateur\\Documents\\mon-projet";
const RECENT = "C:\\Users\\utilisateur\\Documents\\mon-projet";
const PARENT = "45127dc0-5b2f-4f50-a166-5a7523cc769e";
const liste = [
  { id: PARENT, status: "idle", workspaceId: WS_SERVICE },
  { id: "ec1006d0", status: "running", workspaceId: WS_SERVICE, parentId: PARENT },
  { id: "9222a2f8", status: "running", workspaceId: "\\\\?\\C:\\Users\\utilisateur\\Documents\\site-web" },
  { id: "550dc56f", status: "inactive", workspaceId: "\\\\?\\C:\\Users\\utilisateur\\Documents\\compta" },
];
test("parent idle, sous-agent running : le dossier local est au travail", () => {
  const s = sessionsEnCours(liste);
  assert.equal(s.size, 2);
  assert.equal(dossierAuTravail(RECENT, [], s), true);
  assert.equal(dossierAuTravail("C:\\Users\\utilisateur\\Documents\\compta", [], s), false);
});
test("événement status : running ajoute, idle retire, distant ignoré, rien de neuf = null", () => {
  let s = sessionsEnCours([]);
  const run = majSessionsEnCours(s, { event: "status", sessionId: PARENT, data: { id: PARENT, status: "running", workspaceId: WS_SERVICE } });
  assert.ok(run); s = run;
  assert.equal(dossierAuTravail(RECENT, [], s), true);
  assert.equal(majSessionsEnCours(s, { event: "status", sessionId: PARENT, data: { id: PARENT, status: "running", workspaceId: WS_SERVICE } }), null);
  assert.equal(majSessionsEnCours(s, { event: "status", sessionId: "x", connectionId: "axe-cloud", data: { status: "running", workspaceId: RECENT } }), null);
  assert.equal(majSessionsEnCours(s, { event: "entry", sessionId: PARENT, data: {} }), null);
  s = majSessionsEnCours(s, { event: "status", sessionId: PARENT, data: { id: PARENT, status: "idle", workspaceId: WS_SERVICE } });
  assert.equal(s.size, 0);
  assert.equal(dossierAuTravail(RECENT, [], s), false);
});
test("tours de la fenêtre toujours pris en compte (forme \\\\?\\ et casse)", () => {
  assert.equal(dossierAuTravail(RECENT, ["\\\\?\\c:\\users\\utilisateur\\documents\\mon-projet\\"], new Map()), true);
});
test("accueil branché sur le service (sessions.list + événements)", () => {
  const w = fs.readFileSync(path.resolve(__dirname, "../src/components/Welcome.tsx"), "utf8");
  assert.match(w, /agentsApi\s*\.list\("local"\)/);
  assert.match(w, /majSessionsEnCours\(/);
  assert.match(w, /dossierAuTravail\(recent\.path, active\.workspaces, service\)/);
});
