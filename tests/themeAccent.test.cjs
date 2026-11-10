const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Theme: accent-derived variables and CSS colours that must follow the theme.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const theme = require(path.join(racine, "src/axe/theme.ts"));
const { deriveThemeVars, contrastRatio, AXE_ACCENT } = theme;

const FONDS = { sombre: "#0b0b0d", clair: "#f6f6f4", blanc: "#ffffff", marine: "#0f1724" };
const ACCENTS = ["#2563eb", "#9333ea", "#0d9488", "#eab308", "#ec4899", AXE_ACCENT];

test("default orange keeps its exact tones", () => {
  const sombre = deriveThemeVars(FONDS.sombre);
  assert.equal(sombre["--accent"], "#fc610b");
  assert.equal(sombre["--accent-hi"], "#ff7a2e");
  assert.equal(sombre["--accent-soft"], "rgba(252, 97, 11, 0.12)");
  assert.equal(sombre["--accent-text"], "#ff7a2e");
  assert.equal(sombre["--accent-ink"], "#ffffff");
  assert.equal(deriveThemeVars(FONDS.clair)["--accent-text"], "#c24b07");
});

test("every accent tone follows the chosen accent", () => {
  const v = deriveThemeVars(FONDS.sombre, "#2563eb");
  assert.equal(v["--accent"], "#2563eb");
  for (const cle of ["--accent-soft", "--accent-glow", "--accent-strong", "--selection-bg", "--highlight-bg", "--highlight-bg-strong", "--focus-ring"]) {
    assert.match(v[cle], /^rgba\(37, 99, 235, /, cle);
  }
  assert.notEqual(v["--editor-selection"], deriveThemeVars(FONDS.sombre)["--editor-selection"]);
});

test("accent used as text stays readable on light and dark grounds", () => {
  for (const fond of Object.values(FONDS)) {
    for (const accent of ACCENTS) {
      const v = deriveThemeVars(fond, accent);
      assert.ok(contrastRatio(v["--accent-text"], fond) >= 4.4, `${accent} sur ${fond} : ${v["--accent-text"]}`);
    }
  }
});

test("text drawn on an accent fill is readable", () => {
  for (const accent of ACCENTS) {
    const v = deriveThemeVars(FONDS.sombre, accent);
    assert.ok(contrastRatio(v["--accent-ink"], accent) >= 3, `${accent} : ${v["--accent-ink"]}`);
  }
  assert.equal(deriveThemeVars(FONDS.sombre, "#eab308")["--accent-ink"], "#1a1a1d");
});

test("invalid accent falls back to the default orange", () => {
  assert.equal(theme.normalizeAccent("pas une couleur"), AXE_ACCENT);
  assert.equal(theme.normalizeAccent(null), AXE_ACCENT);
  assert.equal(theme.normalizeAccent("#ABC"), "#aabbcc");
});

// Colours hard-coded for a dark ground only: invisible or black blocks on a light theme.
const lire = (f) => fs.readFileSync(path.join(racine, f), "utf8");
const regle = (css, selecteur) => {
  const i = css.indexOf(`\n${selecteur} {`);
  assert.ok(i >= 0, selecteur);
  return css.slice(i, css.indexOf("}", i));
};

test("queue, task list and context popover use theme surfaces", () => {
  const css = lire("src/styles.css");
  for (const sel of [".todo-strip__queue", ".todo-strip__list", ".context-meter__rows"]) {
    assert.match(regle(css, sel), /background: var\(--bg-/, sel);
  }
  assert.doesNotMatch(css, /#0d0e11/);
});

test("selection and search highlights derive from the accent", () => {
  const css = lire("src/styles.css");
  assert.match(regle(css, "::selection"), /var\(--selection-bg/);
  assert.match(regle(css, ".composer__input::selection"), /var\(--selection-bg/);
  assert.match(regle(css, ".editor-search-hit"), /var\(--highlight-bg/);
  assert.match(regle(css, ".search-result__text mark"), /var\(--highlight-bg/);
});

test("no light-on-dark only tints left in the main stylesheet", () => {
  // Custom-property defaults (overridden by theme.ts at startup) are allowed.
  const css = lire("src/styles.css").split("\n").filter((l) => !/^\s*--[\w-]+\s*:/.test(l)).join("\n");
  // Cream (232, 233, 236) is the dark-theme text colour: as a tint it vanishes on light themes.
  assert.doesNotMatch(css, /rgba\(\s*232,\s*233,\s*236/);
  // The default orange written out instead of var(--accent).
  assert.doesNotMatch(css, /rgba\(\s*252,\s*97,\s*11/);
});

test("accent swatches: default first, distinct, readable on light and dark grounds", () => {
  const presets = theme.AXE_ACCENT_PRESETS;
  assert.equal(presets[0].accent, AXE_ACCENT);
  assert.ok(presets.length >= 6);
  assert.equal(new Set(presets.map((p) => p.accent)).size, presets.length);
  for (const p of presets) {
    assert.equal(theme.normalizeAccent(p.accent), p.accent, p.id);
    for (const fond of Object.values(FONDS)) {
      const v = deriveThemeVars(fond, p.accent);
      assert.ok(contrastRatio(v["--accent-text"], fond) >= 4.4, `${p.id} sur ${fond}`);
      assert.ok(contrastRatio(v["--accent-ink"], p.accent) >= 3, `${p.id} : encre`);
    }
  }
});

test("chosen accent is persisted, applied live and restored at startup", () => {
  const stockage = new Map();
  const proprietes = new Map();
  const ecouteurs = {};
  const evenements = [];
  global.localStorage = {
    getItem: (k) => (stockage.has(k) ? stockage.get(k) : null),
    setItem: (k, v) => stockage.set(k, String(v)),
    removeItem: (k) => stockage.delete(k),
  };
  global.document = { documentElement: { style: { setProperty: (k, v) => proprietes.set(k, v) }, dataset: {} } };
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  global.window = {
    addEventListener: (type, cb) => { (ecouteurs[type] ||= []).push(cb); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { evenements.push(e.type); (ecouteurs[e.type] || []).forEach((cb) => cb(e)); },
  };
  try {
    theme.setThemeAccent("#2563EB");
    assert.equal(stockage.get("axe.theme.accent"), "#2563eb");
    assert.equal(proprietes.get("--accent"), "#2563eb");
    assert.ok(evenements.includes("axe-theme-change"));
    proprietes.clear();
    theme.initTheme();
    assert.equal(proprietes.get("--accent"), "#2563eb");
    // Another window picks green: this one follows.
    stockage.set("axe.theme.accent", "#16a34a");
    ecouteurs.storage.forEach((cb) => cb({ key: "axe.theme.accent" }));
    assert.equal(proprietes.get("--accent"), "#16a34a");
    theme.setThemeAccent(null);
    assert.equal(stockage.has("axe.theme.accent"), false);
    assert.equal(proprietes.get("--accent"), AXE_ACCENT);
  } finally {
    delete global.localStorage;
    delete global.document;
    delete global.window;
    delete global.CustomEvent;
  }
});
