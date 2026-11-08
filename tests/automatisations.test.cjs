"use strict";
// automatisations — écran Automatisations : formulaire de l'horaire, dates, durées, tri,
// erreurs du service en clair, accroches (raccourci Ctrl+Maj+L, montage dans App.tsx).
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
const H = require(path.resolve(__dirname, "../src/components/automatisations/horaires.ts"));
const R = require(path.resolve(__dirname, "../src/axe/raccourcis.ts"));
const src = (rel) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

test("formulaire de l'horaire <-> horaire du service", () => {
  const hebdo = H.formeDepuisHoraire({ type: "hebdomadaire", jours: [5, 1], heure: "08:00" });
  assert.equal(hebdo.genre, "hebdomadaire");
  assert.deepEqual(H.horaireDepuisForme(hebdo), { type: "hebdomadaire", jours: [1, 5], heure: "08:00" });
  const defaut = H.formeDepuisHoraire();
  assert.deepEqual(H.horaireDepuisForme(defaut), { type: "quotidien", heure: "08:00" });
  assert.deepEqual(defaut.jours, [1, 2, 3, 4, 5]);
  assert.deepEqual(H.horaireDepuisForme({ ...defaut, genre: "intervalle", heures: 2 }), { type: "intervalle", heures: 2, minute: 0 });
  assert.deepEqual(H.horaireDepuisForme({ ...defaut, genre: "cron", expression: " 0 8 * * 1-5 " }), { type: "cron", expression: "0 8 * * 1-5" });
  assert.equal(H.formeDepuisHoraire({ type: "intervalle", heures: 6 }).heures, 6);
  assert.deepEqual(H.basculerJour([1, 5], 3), [1, 3, 5]);
  assert.deepEqual(H.basculerJour([1, 3, 5], 3), [1, 5]);
  assert.deepEqual(H.GENRES.map((g) => g.libelle), ["Tous les jours", "Certains jours", "Toutes les N heures", "Expression cron"]);
});

test("dates relatives et durées en français (heure locale)", () => {
  const maintenant = new Date(2026, 10, 9, 10, 0).getTime(); // lundi 9 novembre 2026
  assert.equal(H.dateCourte(new Date(2026, 10, 9, 8, 0).getTime(), maintenant), "aujourd'hui 08:00");
  assert.equal(H.dateCourte(new Date(2026, 10, 10, 8, 5).getTime(), maintenant), "demain 08:05");
  assert.equal(H.dateCourte(new Date(2026, 10, 8, 18, 30).getTime(), maintenant), "hier 18:30");
  assert.equal(H.dateCourte(new Date(2026, 10, 16, 8, 0).getTime(), maintenant), "lun. 16 nov. 08:00");
  assert.equal(H.dateCourte(new Date(2027, 0, 4, 8, 0).getTime(), maintenant), "lun. 4 janv. 2027 08:00");
  assert.equal(H.duree(0, 12_000), "12 s");
  assert.equal(H.duree(0, 185_000), "3 min 05 s");
  assert.equal(H.duree(0, 3_720_000), "1 h 02 min");
  assert.equal(H.duree(5, undefined), "");
  const a = { active: true, prochaineMs: new Date(2026, 10, 10, 8, 0).getTime(), enCours: false };
  assert.equal(H.prochaineTexte(a, maintenant), "Prochaine\u00a0: demain 08:00");
  assert.equal(H.prochaineTexte({ ...a, active: false }, maintenant), "En pause");
  assert.equal(H.prochaineTexte({ ...a, prochaineMs: undefined }, maintenant), "Pas de prochaine exécution");
});

test("dossier, brouillon, champs manquants", () => {
  assert.equal(H.nomDossier("\\\\?\\C:\\Users\\utilisateur\\client-01\\"), "client-01");
  assert.equal(H.nomDossier("/home/utilisateur/projet"), "projet");
  const b = H.brouillonVide("C:\\projet", "anthropic/claude-opus-5-5");
  assert.equal(H.champManquant(b), "Donnez un nom à l'automatisation.");
  assert.equal(H.champManquant({ ...b, nom: "Rapport" }), "Écrivez le prompt à envoyer.");
  assert.equal(H.champManquant({ ...b, nom: "Rapport", prompt: "Fais le point." }), null);
  assert.equal(H.champManquant({ ...b, nom: "R", prompt: "P", modele: "" }), "Choisissez un modèle.");
  assert.equal(H.champManquant({ ...b, nom: "R", prompt: "P", horaire: { type: "hebdomadaire", jours: [], heure: "08:00" } }), "Cochez au moins un jour.");
  const fiche = { nom: "R", dossier: "/p", prompt: "P", modele: { provider: "openai", name: "gpt" }, horaire: { type: "quotidien", heure: "07:00" }, memeConversation: true, active: false, rattrapage: false, historique: [] };
  assert.deepEqual(H.brouillonDepuis(fiche), { nom: "R", dossier: "/p", prompt: "P", modele: "openai/gpt", horaire: { type: "quotidien", heure: "07:00" }, memeConversation: true, active: false, rattrapage: false, verification: "" });
});

test("ordre de la liste : en cours, puis actives par prochaine exécution, puis en pause", () => {
  const a = (nom, extra) => ({ nom, active: true, enCours: false, prochaineMs: 10, historique: [], ...extra });
  const liste = [a("pause", { active: false, prochaineMs: undefined }), a("tard", { prochaineMs: 30 }), a("tôt", { prochaineMs: 20 }), a("tourne", { enCours: true })];
  assert.deepEqual(H.trier(liste).map((x) => x.nom), ["tourne", "tôt", "tard", "pause"]);
});

test("erreurs du service sans préfixe technique", () => {
  assert.equal(H.messageErreur("protocol error: Choisissez un dossier."), "Choisissez un dossier.");
  assert.equal(H.messageErreur(new Error("protocol error: Une exécution de « R » est déjà en cours.")), "Une exécution de « R » est déjà en cours.");
  assert.equal(H.messageErreur(""), "Erreur inconnue.");
  assert.equal(H.STATUTS.echouee, "Échouée");
  assert.equal(H.DECLENCHEURS.rattrapage, "Rattrapage");
});

test("raccourci Ctrl+Maj+L et accroches de l'écran", () => {
  const r = R.RACCOURCIS.find((x) => x.id === "automatisations");
  assert.ok(r, "raccourci déclaré dans le registre");
  assert.equal(r.combinaison, "Ctrl + Maj + L");
  assert.equal(R.combinaisonCourte("automatisations", false), "Ctrl+Maj+L");
  const app = src("../src/App.tsx");
  assert.equal((app.match(/<AutomatisationsGlobal\b/g) ?? []).length, 2, "monté sur l'accueil et dans un dossier");
  const ecran = src("../src/components/automatisations/EcranAutomatisations.tsx");
  assert.match(ecran, /fournirActions\(\{\s*stop:/, "Échap ferme l'écran au lieu d'arrêter l'agent");
  assert.match(ecran, /role="dialog"/);
  assert.match(src("../src/components/automatisations/Automatisations.tsx"), /fournirActions\(\{ automatisations:/);
});

