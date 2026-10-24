"use strict";
// Mise à jour automatique : installation seulement quand rien ne tourne.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
Module._extensions[".ts"] = (module, filename) => {
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(js, filename);
};
const m = require(path.resolve(__dirname, "../src/lib/majBadge.ts"));
const lire = (f) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

test("mise à jour disponible : badge, pas d'installation automatique", () => {
  const info = { available: true, currentVersion: "0.1.65", version: "0.1.66", notes: "x", date: null };
  assert.deepEqual(m.statutApresVerification({ kind: "idle" }, info), { kind: "available", info });
  assert.equal(m.libelleMaj("0.1.66"), "Mise à jour 0.1.66 disponible");
  const badge = lire("src/components/UpdateBadge.tsx");
  assert.doesNotMatch(badge, /doitInstallerMaintenant|activiteEnCours|axecode:install-update/);
  assert.match(badge, /Installer maintenant/);
  assert.match(badge, /Plus tard/);
  // installUpdate n'est appelé que dans onInstall (clic).
  assert.equal(badge.match(/api\.installUpdate\(/g).length, 1);
  const app = lire("src/App.tsx");
  assert.doesNotMatch(app, /UpdaterLockScreen|update_required|checkForUpdate/);
});

test("version déjà installée : aucun badge, aucune relance", () => {
  const deja = { available: false, currentVersion: "0.1.66", version: null, notes: null, date: null };
  assert.deepEqual(m.statutApresVerification({ kind: "idle" }, deja), { kind: "idle" });
  const memeVersion = { available: true, currentVersion: "0.1.66", version: "0.1.66", notes: null, date: null };
  assert.deepEqual(m.statutApresVerification({ kind: "idle" }, memeVersion), { kind: "idle" });
  // Un téléchargement en cours n'est pas écrasé par une nouvelle vérification.
  const enCours = { kind: "downloading", info: memeVersion, downloaded: 1, total: 2 };
  assert.equal(m.statutApresVerification(enCours, { ...memeVersion, version: "0.1.67" }), enCours);
});

test("installeur : hook NSIS qui ferme les processus du dossier de l'appli", () => {
  const conf = JSON.parse(lire("src-tauri/tauri.conf.json"));
  assert.equal(conf.bundle.windows.nsis.installerHooks, "windows/hooks.nsh");
  const hook = lire("src-tauri/windows/hooks.nsh");
  assert.match(hook, /!macro NSIS_HOOK_PREINSTALL/);
  assert.match(hook, /\$INSTDIR/);
  assert.match(hook, /Stop-Process -Force/);
});

test("configuration : mise à jour depuis le dépôt GitHub public de SavIDE", () => {
  const conf = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(conf.plugins.updater.active, true);
  assert.deepEqual(conf.plugins.updater.endpoints, ["https://github.com/SavinienD/-SavIDE/releases/latest/download/latest.json"]);
  const badge = fs.readFileSync(path.resolve(__dirname, "../src/components/UpdateBadge.tsx"), "utf8");
  assert.match(badge, /60 \* 60 \* 1000/);
});
