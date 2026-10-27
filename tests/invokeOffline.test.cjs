// Chaque invoke("offline_*") du front doit correspondre a la signature Rust.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const rs = fs.readFileSync(path.join(root, "src-tauri/src/offline.rs"), "utf8");
const ts = fs.readFileSync(path.join(root, "src/lib/cloudOffline.ts"), "utf8");
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function structFields(name) {
  const m = rs.match(new RegExp("struct " + name + "\\s*\\{([\\s\\S]*?)\\}"));
  assert.ok(m, "struct " + name);
  const out = [];
  for (const l of m[1].split("\n")) {
    const f = l.match(/pub (\w+):\s*([^,]+)/);
    if (f) out.push({ name: camel(f[1]), optional: /Option</.test(f[2]) });
  }
  return out;
}
function commands() {
  const map = {};
  const re = /#\[tauri::command\][\s\S]*?fn (offline_\w+)\s*\(([\s\S]*?)\)\s*->/g;
  let m;
  while ((m = re.exec(rs))) {
    const params = m[2].split(",").map((p) => p.trim()).filter(Boolean)
      .map((p) => p.split(":").map((x) => x.trim()))
      .filter(([, t]) => !/AppHandle|State<|Window/.test(t));
    map[m[1]] = params;
  }
  return map;
}
function keysOf(obj) {
  // cles de premier niveau d'un litteral objet (raccourcis ou cle: valeur)
  const inner = obj.trim().slice(1, -1);
  const keys = []; let d = 0, cur = "";
  for (const c of inner) {
    if ("{[(".includes(c)) d++; else if ("}])".includes(c)) d--;
    if (c === "," && d === 0) { keys.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) keys.push(cur);
  return keys.map((k) => k.trim().split(":")[0].trim()).filter(Boolean)
    .map((k) => [k, obj]);
}
function invokes() {
  const res = []; const re = /invoke(?:<[^(]*?>)?\(\s*"(offline_\w+)"\s*(,\s*)?/g; let m;
  while ((m = re.exec(ts))) {
    let i = m.index + m[0].length, arg = null;
    if (m[2] && ts[i] === "{") {
      let d = 0, j = i;
      for (; j < ts.length; j++) { if (ts[j] === "{") d++; else if (ts[j] === "}" && --d === 0) break; }
      arg = ts.slice(i, j + 1);
    }
    res.push({ name: m[1], arg });
  }
  return res;
}
test("invoke offline_* alignes sur les commandes Rust", () => {
  const cmds = commands();
  const calls = invokes();
  assert.ok(calls.length >= 10);
  for (const { name, arg } of calls) {
    const params = cmds[name];
    assert.ok(params, name + " absente cote Rust");
    const top = arg ? keysOf(arg).map(([k]) => k) : [];
    assert.deepStrictEqual(top.sort(), params.map(([p]) => camel(p)).sort(), name + " : cles de premier niveau");
    for (const [p, type] of params) {
      const inner = arg.match(new RegExp(camel(p) + "\\s*:\\s*(\\{[\\s\\S]*\\})\\s*\\}$"));
      if (!/^[A-Z]\w*$/.test(type) || !inner) continue;
      const fields = structFields(type);
      const given = keysOf(inner[1]).map(([k]) => k);
      for (const f of fields) if (!f.optional) assert.ok(given.includes(f.name), name + " : manque " + f.name);
      for (const g of given) assert.ok(fields.some((f) => f.name === g), name + " : cle inconnue " + g);
    }
  }
});
