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

// Same block as the phone app (remote/public/app.js imports React from esm.sh).
function blocDuMobile() {
  const source = fs.readFileSync(path.resolve(__dirname, "../remote/public/app.js"), "utf8");
  const debut = source.indexOf("// axe:storage-migration-begin");
  const fin = source.indexOf("// axe:storage-migration-end");
  assert.ok(debut > 0 && fin > debut, "bloc de migration de remote/public/app.js");
  return new Function(
    `${source.slice(debut, fin)}\nreturn { legacyStorageKey, migrateLegacyStorage, STORAGE_MIGRATION_MARKER };`,
  )();
}

class FauxStockage {
  constructor(entrees) {
    this.map = new Map(Object.entries(entrees));
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

// Anciens noms construits par morceaux : le script de renommage ne doit pas les réécrire.
const OLD = "atelier";
const Old = OLD[0].toUpperCase() + OLD.slice(1);

for (const [nom, impl] of [
  ["src/lib/legacyStorage.ts", charger("../src/lib/legacyStorage.ts")],
  ["remote/public/app.js", blocDuMobile()],
]) {
  test(`${nom} : anciennes cles recopiees une fois, rien d'efface ni d'ecrase`, () => {
    const projet = `C:\\Users\\s\\Documents\\${Old}-dev`;
    const stockage = new FauxStockage({
      [`axe-${OLD}:zoom`]: "1.2",
      [`axe-${OLD}:ui-zoom`]: "0.9",
      [`${OLD}.recentWorkspaces`]: "[1]",
      [`${OLD}.lastWorkspace`]: projet,
      [`axe-${OLD}:terminals:${projet}`]: "onglets",
      [`${OLD}.remote.session.v1`]: "session",
      "axecode:ui-zoom": "1.1",
      [`axecode:terminals:${projet}2`]: "nouveau",
      autre: "x",
    });
    const avant = new Map(stockage.map);
    const copiees = impl.migrateLegacyStorage(() => stockage);
    assert.deepEqual(
      [...copiees].sort(),
      [
        "axecode.lastWorkspace",
        "axecode.recentWorkspaces",
        "axecode.remote.session.v1",
        "axecode:zoom",
        `axecode:terminals:${projet}`,
      ].sort(),
    );
    assert.equal(stockage.getItem("axecode:zoom"), "1.2");
    assert.equal(stockage.getItem("axecode.lastWorkspace"), projet);
    assert.equal(stockage.getItem("axecode:ui-zoom"), "1.1", "jamais ecrasee");
    assert.equal(stockage.getItem(`axecode:terminals:${projet}`), "onglets", "chemin garde tel quel");
    for (const [k, v] of avant) assert.equal(stockage.getItem(k), v, `${k} inchangee`);
    assert.ok(stockage.getItem(impl.STORAGE_MIGRATION_MARKER));
    // Une seule fois : une cle retiree par l'appli (deconnexion) ne revient jamais.
    stockage.removeItem("axecode.remote.session.v1");
    assert.deepEqual(impl.migrateLegacyStorage(() => stockage), []);
    assert.equal(stockage.getItem("axecode.remote.session.v1"), null);
  });

  test(`${nom} : seul le prefixe de l'appli change`, () => {
    assert.equal(impl.legacyStorageKey(`axe-${OLD}:zoom`), "axecode:zoom");
    assert.equal(impl.legacyStorageKey(`${OLD}.fastServiceTier`), "axecode.fastServiceTier");
    assert.equal(impl.legacyStorageKey(`AXE_${OLD.toUpperCase()}_X`), "AXECODE_X");
    assert.equal(impl.legacyStorageKey(`Axe ${Old}`), "Axecode");
    assert.equal(impl.legacyStorageKey(`${OLD}y.x`), null);
    assert.equal(impl.legacyStorageKey(`axecode:terminals:/home/${OLD}`), null);
    assert.equal(impl.legacyStorageKey("axecode:zoom"), null);
  });

  test(`${nom} : ne bloque jamais le demarrage`, () => {
    assert.deepEqual(impl.migrateLegacyStorage(() => { throw new Error("SecurityError"); }), []);
    assert.deepEqual(impl.migrateLegacyStorage(() => undefined), []);
    const plein = new FauxStockage({ [`${OLD}.a`]: "1" });
    plein.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    assert.deepEqual(impl.migrateLegacyStorage(() => plein), []);
    assert.equal(plein.getItem(impl.STORAGE_MIGRATION_MARKER), null, "nouvel essai au demarrage suivant");
  });
}

test("main.tsx : la migration est le premier import", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../src/main.tsx"), "utf8");
  const premier = main.split(/\r?\n/).find((ligne) => ligne.startsWith("import "));
  assert.match(premier, /^import "\.\/migrateStorage";/);
});
