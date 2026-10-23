"use strict";
// Garde-fou de la francisation : échoue si un texte visible en anglais revient dans src/ ou web/src.
// Détecteur et liste blanche : scripts/francisation/ (voir docs/francisation.md).
// Un texte anglais voulu (nom propre, terme technique, texte envoyé au modèle, texte comparé par le
// code) va dans scripts/francisation/liste-blanche.json AVEC sa raison.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const d = require("../scripts/francisation/detecteur.cjs");

test("aucun texte visible en anglais dans src/ et web/src", () => {
  const restants = d.inventaire({ rust: false }).filter((x) => !x.blanche);
  const detail = restants
    .slice(0, 40)
    .map((x) => `  ${x.fichier}:${x.ligne} ${JSON.stringify(x.texte)} (mots : ${x.mots.join(", ")})`)
    .join("\n");
  assert.equal(
    restants.length,
    0,
    `Textes visibles en anglais : traduisez-les (lexique : docs/francisation.md) ou ajoutez-les à scripts/francisation/liste-blanche.json avec une raison.\n${detail}`,
  );
});

test("le détecteur voit l'anglais visible (texte JSX, title, placeholder, erreur affichée)", () => {
  const source = `
export function Exemple({ n }: { n: number }) {
  return (
    <div>
      <button type="button" title="Close tab">Send</button>
      <span>{n} files will roll back</span>
      <input placeholder="Message the agent…" />
    </div>
  );
}
export function lire() {
  throw new Error("Unable to read pasted image");
}`;
  const textes = d.analyserTs("src/exemple.tsx", source).map((x) => x.texte);
  for (const attendu of ["Close tab", "Send", "files will roll back", "Message the agent…", "Unable to read pasted image"]) {
    assert.ok(textes.includes(attendu), `non détecté : ${attendu} (trouvés : ${JSON.stringify(textes)})`);
  }
});

test("le détecteur laisse passer le français et le code", () => {
  const source = `
import { invoke } from "@tauri-apps/api/core";
export function Exemple({ etat }: { etat: string }) {
  console.log("Starting the worker now");
  if (etat === "Send now") void invoke("git_push_command", { mode: "fast" });
  return (
    <div className="flex items-center gap-2" data-state="running">
      <button type="button" title="Fermer l'onglet">Envoyer</button>
      <span>Réflexion : 12 s</span>
      <span>Le fichier compact reste dans la file d'attente.</span>
      <span>Ouvrir une pull request</span>
    </div>
  );
}`;
  assert.deepEqual(d.analyserTs("src/components/GitPanel.tsx", source).filter((x) => !x.blanche), []);
});

test("la liste blanche couvre les textes voulus, pas le reste de la phrase", () => {
  const consigne = d.analyserTs("src/components/chat/ChatPane.tsx", 'const P = "Please inspect the attached file.";');
  assert.equal(consigne.length, 1);
  assert.ok(consigne[0].blanche, "consigne envoyée au modèle : gardée en anglais");
  const melange = d.analyserTs("src/components/GitPanel.tsx", "export const X = () => <span>Open pull request</span>;");
  assert.equal(melange.filter((x) => !x.blanche).length, 1, "« Open » reste de l'anglais même à côté de « pull request »");
});

test("liste blanche : chaque entrée est justifiée et valide", () => {
  const blanche = JSON.parse(fs.readFileSync(path.join(__dirname, "../scripts/francisation/liste-blanche.json"), "utf8"));
  assert.ok(Array.isArray(blanche) && blanche.length > 0);
  for (const e of blanche) {
    const nom = JSON.stringify(e.texte ?? e.motif ?? e.terme);
    assert.ok(typeof e.raison === "string" && e.raison.trim().length >= 10, `raison manquante pour ${nom}`);
    assert.ok(e.texte !== undefined || e.motif !== undefined || e.terme !== undefined, "entrée sans texte, motif ni terme");
    if (e.motif !== undefined) new RegExp(e.motif);
    if (e.terme !== undefined) new RegExp(e.terme);
  }
});

test("typographie : espace insécable avant : ; ? ! %, guillemets « », « … »", () => {
  const { examiner, corriger } = require("../scripts/francisation/typographie.cjs");
  const NB = "\u00a0";
  assert.equal(corriger("Erreur : réseau ; réessayez ?", false), `Erreur${NB}: réseau${NB}; réessayez${NB}?`);
  assert.equal(corriger("« Envoyer » à 12 %", false), `«${NB}Envoyer${NB}» à 12${NB}%`);
  assert.equal(corriger("Chargement...", false), "Chargement…");
  assert.equal(corriger("https://exemple.fr:8080 a::b", false), "https://exemple.fr:8080 a::b", "le code n'est pas touché");
  const fautes = examiner();
  const detail = fautes
    .slice(0, 20)
    .map((f) => `  ${f.fichier}:${f.ligne} ${JSON.stringify(f.avant.trim().slice(0, 80))}`)
    .join("\n");
  assert.equal(fautes.length, 0, `Typographie à corriger : lancez « node scripts/francisation/typographie.cjs --corriger ».\n${detail}`);
});
