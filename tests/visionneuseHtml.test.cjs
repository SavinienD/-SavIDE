"use strict";
// Visionneuse HTML : rendu isolé (CSP : aucun réseau, seulement les fichiers locaux du dossier,
// scripts coupés par défaut) et choix Rendu / Code mémorisé par fichier.
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
const { documentApercuHtml, politiqueApercu } = require(path.join(racine, "src/lib/apercuHtml.ts"));
const vue = require(path.join(racine, "src/lib/vueFichier.ts"));

const BASES = {
  windows: "http://asset.localhost/C%3A/Users/utilisateur/site/",
  macos_linux: "asset://localhost/%2Fhome%2Fsav%2Fsite/",
};

const csp = (doc) => (doc.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1];

for (const [os, base] of Object.entries(BASES)) {
  test(`aperçu HTML (${os}) : base du dossier + CSP sans réseau, scripts coupés`, () => {
    const doc = documentApercuHtml("<html><head><title>t</title></head><body><img src='logo.png'></body></html>", base, false);
    assert.ok(doc.indexOf("<base href=") < doc.indexOf("<title>"));
    const p = csp(doc);
    assert.ok(p, "CSP absente");
    const origine = os === "windows" ? "http://asset.localhost" : "asset://localhost";
    assert.match(p, /default-src 'none'/);
    assert.match(p, /script-src 'none'/);
    assert.match(p, /connect-src 'none'/);
    assert.ok(p.includes(`img-src ${origine} data: blob:`), p);
    assert.ok(!/https?:\/\/\*|\shttps:\s|\*/.test(p.replace(origine, "")), "réseau autorisé : " + p);
    // CSP avant toute ressource de la page.
    assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<title>"));
  });
}

test("scripts autorisés : seulement inline et fichiers du dossier, toujours sans réseau", () => {
  const p = politiqueApercu(BASES.windows, true);
  assert.match(p, /script-src http:\/\/asset\.localhost 'unsafe-inline'/);
  assert.match(p, /connect-src 'none'/);
});

test("fragment sans <head> ni <html> : base et CSP ajoutées quand même", () => {
  const doc = documentApercuHtml("<p>bonjour</p>", BASES.windows, false);
  assert.ok(csp(doc));
  assert.ok(doc.endsWith("<p>bonjour</p>"));
});

test("choix Rendu / Code mémorisé par fichier (localStorage)", () => {
  const donnees = new Map();
  global.localStorage = { getItem: (k) => donnees.get(k) ?? null, setItem: (k, v) => donnees.set(k, String(v)), removeItem: (k) => donnees.delete(k) };
  assert.equal(vue.vueMemorisee("C:\\a\\index.html"), null);
  vue.memoriserVue("C:\\a\\index.html", false);
  vue.memoriserVue("/home/b/page.htm", true);
  assert.equal(vue.vueMemorisee("C:\\a\\index.html"), false);
  assert.equal(vue.vueMemorisee("/home/b/page.htm"), true);
  for (let i = 0; i < 600; i += 1) vue.memoriserVue(`/x/${i}.html`, true);
  assert.ok(Object.keys(JSON.parse(donnees.get(vue.CLE_VUES))).length <= vue.MAX_VUES);
  assert.equal(vue.vueMemorisee("/x/599.html"), true);
  donnees.set(vue.CLE_VUES, "{abîmé");
  assert.equal(vue.vueMemorisee("/x/599.html"), null);
});

test("EditorPane et HtmlPreview utilisent ces fonctions", () => {
  const pane = fs.readFileSync(path.join(racine, "src/components/EditorPane.tsx"), "utf8");
  const apercu = fs.readFileSync(path.join(racine, "src/components/viewers/HtmlPreview.tsx"), "utf8");
  assert.match(pane, /vueMemorisee\(/);
  assert.match(pane, /memoriserVue\(/);
  assert.match(apercu, /documentApercuHtml\(/);
});
