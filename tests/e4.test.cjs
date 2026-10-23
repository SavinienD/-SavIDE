const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { execFile } = require("node:child_process");
const ts = require("typescript");
const { WebSocketServer, WebSocket } = require("ws");

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
const R = charger("../src/axe/ScriptRegistry.ts");
const B = charger("../src/axe/ScriptBridge.ts");
const S = charger("../src/axe/ScriptSandbox.ts");
const K = charger("../src/axe/SkillSync.ts");

function memoire() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test("ScriptRegistry : enregistrer, lister, persister, recharger", async () => {
  const st = memoire();
  const r = new R.ScriptRegistry(st);
  r.register("quarante", async () => 40 + 2);
  r.register("bonjour", async () => "salut");
  assert.deepEqual(r.list().map((s) => s.name), ["bonjour", "quarante"]);
  assert.equal(await r.run("quarante"), 42);
  assert.ok(JSON.parse(st.getItem(R.CLE_REGISTRE)).length === 2);
  const r2 = new R.ScriptRegistry(st);
  assert.deepEqual(r2.list().map((s) => s.name), ["bonjour", "quarante"]);
  assert.match(r2.get("quarante").source, /40 \+ 2/);
  assert.equal(r2.unregister("bonjour"), true);
  assert.deepEqual(new R.ScriptRegistry(st).list().map((s) => s.name), ["quarante"]);
  st.setItem(R.CLE_REGISTRE, "{corrompu");
  assert.deepEqual(new R.ScriptRegistry(st).list(), []);
});

test("importFromPrime : GET /prime/api/scripts/:id puis registre", async () => {
  const r = new R.ScriptRegistry(memoire());
  let url;
  const fetcher = async (u) => ((url = u), { ok: true, json: async () => ({ name: "p1", source: "async () => 1" }) });
  const info = await R.importFromPrime("abc 1", r, fetcher);
  assert.equal(url, "/prime/api/registre/v1/scripts/abc%201");
  assert.equal(info.origine, "prime");
  assert.equal(r.get("p1").primeId, "abc 1");
  const appels = [];
  const f2 = async (u) => (appels.push(u), u.endsWith("/code")
    ? { ok: true, text: async () => "print(42)" }
    : { ok: true, json: async () => ({ script: {}, manifeste: { nom: "v1" } }) });
  assert.equal((await R.importFromPrime("q", r, f2)).source, "print(42)");
  assert.equal(appels.length, 2);
  await assert.rejects(R.importFromPrime("x", r, async () => ({ ok: false, status: 404 })), /404/);
});

test("ScriptBridge : run -> result via un vrai serveur WS", async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((ok) => wss.on("listening", ok));
  const url = `ws://127.0.0.1:${wss.address().port}/prime`;
  const reponses = [];
  const fini = new Promise((ok) =>
    wss.on("connection", (sock) => {
      sock.on("message", (d) => {
        reponses.push(JSON.parse(String(d)));
        if (reponses.length === 2) ok();
      });
      sock.send(JSON.stringify({ type: "run", script: "quarante", args: { x: 2 } }));
      sock.send("pas du json");
      sock.send(JSON.stringify({ type: "run", script: "absent" }));
    }),
  );
  const r = new R.ScriptRegistry(memoire());
  r.register("quarante", async () => 42);
  const pont = new B.ScriptBridge((s) => r.run(s), url, (u) => new WebSocket(u));
  pont.connecter();
  await fini;
  pont.fermer();
  wss.close();
  reponses.sort((a, b) => b.script.localeCompare(a.script));
  assert.deepEqual(reponses[0], { type: "result", script: "quarante", outcome: 42 });
  assert.equal(reponses[1].script, "absent");
  assert.match(reponses[1].error, /sans fonction vivante/);
});

function lanceurReel(cmd, args, { cwd, timeoutMs }) {
  return new Promise((ok) =>
    execFile(cmd, args, { cwd, timeout: timeoutMs }, (err, stdout, stderr) =>
      ok({ code: err ? err.code ?? 1 : 0, stdout, stderr }),
    ),
  );
}

test("ScriptSandbox : ticket, résultat 42, pas d'accès au FS du projet", async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "axe-sandbox-"));
  const sb = new S.ScriptSandbox(lanceurReel, "dev", dossier, 20000);
  const vus = [];
  sb.surChangement((t) => vus.push(t.etat));
  const { ticket, termine } = sb.lancer("quarante", "async () => 42");
  assert.match(ticket, /^t-/);
  assert.equal(sb.tickets.get(ticket).etat, "en_cours");
  const t = await termine;
  assert.equal(t.etat, "fini");
  assert.equal(t.resultat, 42);
  assert.deepEqual(vus, ["en_cours", "fini"]);
  const projet = JSON.stringify(path.resolve(__dirname, "../package.json"));
  const fuite = await sb.lancer("fuite", `async () => require("fs").readFileSync(${projet}, "utf8")`).termine;
  assert.equal(fuite.etat, "erreur");
  assert.match(fuite.erreur, /ERR_ACCESS_DENIED|permission|denied|restricted/i);
  assert.deepEqual(S.commandePour("systemd", "1").slice(0, 1), ["systemd-run"]);
  assert.ok(S.commandePour("systemd", "1")[1].includes("--uid=savide-bac"));
});

test("SkillSync : un skill modifié déclenche le badge au tick du timer", async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "axe-skills-"));
  fs.mkdirSync(path.join(dossier, "alpha"));
  const fichier = path.join(dossier, "alpha", "SKILL.md");
  fs.writeFileSync(fichier, "v1");
  const lire = async (d) =>
    Object.fromEntries(
      fs.readdirSync(d).map((n) => [n, fs.readFileSync(path.join(d, n, "SKILL.md"), "utf8")]),
    );
  const st = memoire();
  const sync = new K.SkillSync(lire, st, dossier, 30);
  let badge = null;
  sync.surMiseAJour((d) => (badge = d));
  sync.demarrer();
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(badge.ajoutees, ["alpha"]);
  badge = null;
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(badge, null, "rien n'a changé : pas de badge");
  fs.writeFileSync(fichier, "v2");
  await new Promise((ok) => setTimeout(ok, 80));
  sync.arreter();
  assert.deepEqual(badge.modifiees, ["alpha"]);
});
