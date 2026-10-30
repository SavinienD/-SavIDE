// axe:0.1.75 — aucun lancement de processus n'ouvre de fenêtre console sous Windows.
const test = require("node:test"); const assert = require("node:assert");
const fs = require("node:fs"); const path = require("node:path");
const racine = path.join(__dirname, "..");
function fichiers(d, ext, out = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) { if (!["target", "node_modules", "tests", "binaries"].includes(e.name)) fichiers(p, ext, out); } else if (p.endsWith(ext)) out.push(p); } return out; }
test("Rust : chaque Command::new hors tests passe par CREATE_NO_WINDOW", () => {
  const fautifs = [];
  for (const f of [...fichiers(path.join(racine, "src-tauri/src"), ".rs"), ...fichiers(path.join(racine, "crates"), ".rs")]) {
    let s = fs.readFileSync(f, "utf8"); const i = s.indexOf("#[cfg(test)]"); if (i >= 0) s = s.slice(0, i);
    const n = (s.match(/Command::new\(/g) ?? []).length - (s.match(/fn __nw_(std|tokio)/g) ?? []).length;
    if (n > 0 && !/creation_flags\((CREATE_NO_WINDOW|0x0*8000000|0x0800_0000|DETACHED)/.test(s)) fautifs.push(path.relative(racine, f));
  }
  assert.deepStrictEqual(fautifs, []);
});
test("Python du noyau : subprocess avec creationflags", () => {
  for (const f of fichiers(path.join(racine, "python/axecode_kernel"), ".py")) {
    const s = fs.readFileSync(f, "utf8");
    const appels = s.match(/subprocess\.(run|Popen|call|check_output|check_call)\(/g) ?? [];
    for (const a of appels) assert.ok(/creationflags/.test(s), `${path.basename(f)} : ${a}`);
    assert.ok(!/os\.system\(/.test(s), path.basename(f));
  }
});
