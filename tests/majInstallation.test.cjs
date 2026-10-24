// Mises à jour : un seul chemin d'installation (clic), pas de démon relancé
// pendant l'installation, hook NSIS qui attend que tout soit fermé (bug du 24/10).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const R = path.join(__dirname, "..");
const lire = (f) => fs.readFileSync(path.join(R, f), "utf8");
function tous(dir, out = []) {
  for (const e of fs.readdirSync(path.join(R, dir), { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) tous(f, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(f);
  }
  return out;
}

test("une seule installation : api.installUpdate() appelé une fois, dans onInstall (clic)", () => {
  const appels = [];
  for (const f of tous("src")) {
    const s = lire(f);
    assert.ok(!/@tauri-apps\/plugin-(updater|process)/.test(s), `${f} importe le plugin JS updater/process`);
    for (const m of s.matchAll(/installUpdate\(\)/g)) if (!f.endsWith("ipc.ts")) appels.push([f, m.index, s]);
  }
  assert.strictEqual(appels.length, 1, JSON.stringify(appels.map((a) => a[0])));
  const [f, i, s] = appels[0];
  assert.match(f, /UpdateBadge\.tsx$/);
  const avant = s.slice(0, i);
  assert.ok(avant.lastIndexOf("const onInstall") > avant.lastIndexOf("useEffect("), "installUpdate hors onInstall");
  // onInstall n'est déclenché que par un clic (onClick / prop onInstall), jamais par un effet.
  assert.ok(!/useEffect\([^]*?onInstall\(\)/.test(s.replace(/const onInstall[^]*?\}, \[\]\);/, "")), "onInstall appelé par un effet");
  assert.ok(!/autoInstall|doitInstallerMaintenant/.test(tous("src").map(lire).join("\n")), "reste d'installation automatique");
});

test("Rust : un seul appel à install(), démon interdit pendant l'installation", () => {
  const u = lire("src-tauri/src/updater.rs");
  assert.strictEqual((u.match(/\bupdate\s*\.install\(|\.download_and_install\(/g) || []).length, 1);
  assert.ok(u.indexOf("INSTALLATION_LANCEE.store(true") < u.indexOf("arreter_noyaux(&app).await"), "drapeau posé avant l'arrêt");
  const d = lire("src-tauri/src/daemon_client.rs");
  const c = d.slice(d.indexOf("async fn connect("));
  assert.ok(c.indexOf("demon_autorise()?") >= 0 && c.indexOf("demon_autorise()?") < c.indexOf("ensure_daemon"), "connect relance le démon pendant l'installation");
  assert.ok(lire("src-tauri/src/lib.rs").includes("updater::nettoyer_au_demarrage"));
  const conf = JSON.parse(lire("src-tauri/tauri.conf.json"));
  assert.strictEqual(conf.plugins.updater.windows.installMode, "passive");
});

test("hook NSIS : boucle jusqu'à ce que plus rien ne tourne, démons avant python", () => {
  const h = lire("src-tauri/windows/hooks.nsh");
  assert.match(h, /!macro NSIS_HOOK_PREINSTALL/);
  assert.match(h, /for \(\$\$i=0/, "pas de boucle : un python.exe relancé survit");
  assert.match(h, /Count -eq 0\) \{ break \}/);
  assert.match(h, /Sort-Object \{ \$\$_\.ProcessName -like 'python\*' \}/, "python avant le démon");
  assert.ok(!/\$_\./.test(h.replace(/\$\$_\./g, "")), "$ non échappé pour NSIS");
});
