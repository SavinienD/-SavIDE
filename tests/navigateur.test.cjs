const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// navigateur intégré : modules sans React (liens, tailles, recouvrement,
// texte de l'élément choisi, envoi au chat) et accroches (raccourci, réglage, éditeur).
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const dossier = path.join(racine, "src/components/navigateur");
const liens = require(path.join(dossier, "liens.ts"));
const appareils = require(path.join(dossier, "appareils.ts"));
const recouvrement = require(path.join(dossier, "recouvrement.ts"));
const design = require(path.join(dossier, "design.ts"));
const versChat = require(path.join(dossier, "versChat.ts"));

test("liens : adresses locales et choix du navigateur", () => {
  for (const u of ["http://localhost:5173/", "http://127.0.0.1:8000/a", "http://[::1]:3000/", "http://app.localhost/", "http://192.168.1.5/", "http://10.0.0.2:8080", "http://172.20.0.1/", "http://imprimante.local/"]) {
    assert.ok(liens.estAdresseLocale(u), u);
  }
  for (const u of ["https://exemple.fr/", "http://172.32.0.1/", "pas une url"]) assert.ok(!liens.estAdresseLocale(u), u);
  assert.equal(liens.versNavigateurIntegre("http://localhost:3000/", "local"), true);
  assert.equal(liens.versNavigateurIntegre("https://docs.rs/", "local"), false);
  assert.equal(liens.versNavigateurIntegre("https://docs.rs/", "integre"), true);
  assert.equal(liens.versNavigateurIntegre("http://localhost:3000/", "systeme"), false);
  assert.equal(liens.versNavigateurIntegre("https://docs.rs/", "local", true), true, "Maj inverse");
  assert.equal(liens.versNavigateurIntegre("mailto:a@b.fr", "integre"), false, "seulement http(s)");
  assert.equal(liens.lireModeLiens({ getItem: () => null }), "local", "réglage par défaut");
  assert.equal(liens.lireModeLiens({ getItem: () => "systeme" }), "systeme");
  assert.equal(liens.lireModeLiens({ getItem: () => "n'importe quoi" }), "local");
});

test("liens : sans onglet Navigateur affiché, le navigateur du système", () => {
  liens.reinitialiserOuvreurs();
  const systeme = [];
  const integre = [];
  liens.ouvrirLien("http://localhost:5173/", (u) => systeme.push(u));
  assert.deepEqual(systeme, ["http://localhost:5173/"]);
  const retirer = liens.enregistrerOuvreur((u) => integre.push(u));
  liens.ouvrirLien("http://localhost:5173/", (u) => systeme.push(u));
  liens.ouvrirLien("https://exemple.fr/", (u) => systeme.push(u));
  liens.ouvrirLien("https://exemple.fr/doc", (u) => systeme.push(u), true);
  assert.deepEqual(integre, ["http://localhost:5173/", "https://exemple.fr/doc"]);
  assert.deepEqual(systeme, ["http://localhost:5173/", "https://exemple.fr/"]);
  retirer();
  liens.ouvrirLien("http://localhost:1/", (u) => systeme.push(u));
  assert.equal(systeme.at(-1), "http://localhost:1/");
});

test("tailles d'écran : zone centrée, bornée, zoom de l'interface", () => {
  const place = { left: 100, top: 50, width: 800, height: 600 };
  assert.deepEqual(appareils.zonePage(place, "bureau", 1), place);
  assert.deepEqual(appareils.zonePage(place, "telephone", 1), { left: 305, top: 50, width: 390, height: 600 });
  assert.deepEqual(appareils.zonePage(place, "tablette", 1), { left: 100, top: 50, width: 800, height: 600 }, "bornée à la place");
  assert.deepEqual(appareils.zonePage(place, "telephone", 0.5), { left: 402.5, top: 50, width: 195, height: 422 });
  assert.deepEqual(appareils.versLogique({ left: 10, top: 20.333, width: 100, height: 50 }, 1.25), { x: 12.5, y: 25.42, largeur: 125, hauteur: 62.5 });
  assert.equal(appareils.zoomVoisin(1, 1), 1.1);
  assert.equal(appareils.zoomVoisin(1, -1), 0.9);
  assert.equal(appareils.zoomVoisin(2, 1), 2);
  assert.equal(appareils.zoomVoisin(0.5, -1), 0.5);
});

test("recouvrement : un menu sur la page cache la vue native", () => {
  const zone = { left: 0, top: 0, width: 100, height: 100 };
  assert.ok(recouvrement.zoneRecouverte(zone, [{ left: 90, top: 90, width: 50, height: 50 }]));
  assert.ok(!recouvrement.zoneRecouverte(zone, [{ left: 100, top: 0, width: 50, height: 50 }]), "bord contre bord");
  assert.ok(!recouvrement.zoneRecouverte(zone, [{ left: 10, top: 10, width: 0, height: 50 }]), "élément vide");
  assert.ok(recouvrement.SELECTEUR_FLOTTANTS.includes("[role='menu']"));
});

const element = {
  url: "http://localhost:5173/", titre: "Démo", balise: "button", selecteur: "main > button.primaire",
  html: '<button class="primaire">Envoyer ```</button>', texte: "Envoyer", largeur: 120.4, hauteur: 32, x: 10, y: 20,
  styles: { display: "inline-flex", position: "static", color: "rgb(255, 255, 255)", "background-color": "rgb(37, 99, 235)", "border-radius": "8px", margin: "0px", opacity: "1" },
  attributs: { class: "primaire grand", id: "envoi" },
};

test("Design Mode : texte pour la conversation", () => {
  // Espaces insécables de la typographie française (« : », « » ») lues comme des espaces.
  const t = design.texteElement(element).replace(/[\u00a0\u202f]/g, " ");
  assert.ok(t.startsWith("Élément choisi dans le navigateur (http://localhost:5173/) :\n"));
  assert.ok(t.includes("- Sélecteur : `main > button.primaire`"));
  assert.ok(t.includes("- Taille : 120 × 32 px"));
  assert.ok(t.includes("- Texte : « Envoyer »"));
  assert.ok(t.includes("display: inline-flex ; color: rgb(255, 255, 255) ; background-color: rgb(37, 99, 235) ; border-radius: 8px"));
  assert.ok(!t.includes("position: static") && !t.includes("margin: 0px") && !t.includes("opacity: 1"), "valeurs par défaut omises");
  assert.ok(t.includes("````html\n<button"), "clôture plus longue que les ``` du HTML");
  assert.ok(t.endsWith("````\n\n"));
  assert.equal(design.resumeElement(element), "button#envoi.primaire.grand");
});

test("envoi au chat : saisie de la conversation, sinon refus", () => {
  versChat.reinitialiserCibles();
  const recu = [];
  assert.equal(versChat.envoyerAuChat("c-1", "x"), false);
  const retirer = versChat.enregistrerCibleChat("c-1", (t) => recu.push(t));
  assert.equal(versChat.envoyerAuChat("c-1", "bonjour"), true);
  assert.equal(versChat.envoyerAuChat("c-2", "x"), false);
  retirer();
  assert.equal(versChat.envoyerAuChat("c-1", "x"), false);
  assert.deepEqual(recu, ["bonjour"]);
  assert.equal(versChat.ajouterAuTexte("", "A"), "A");
  assert.equal(versChat.ajouterAuTexte("Corrige ce bouton  \n", "A"), "Corrige ce bouton\n\nA");
});

test("accroches : raccourci, réglage, onglet spécial de l'éditeur, liens du chat et du terminal", () => {
  const lire = (p) => fs.readFileSync(path.join(racine, p), "utf8");
  const raccourcis = lire("src/axe/raccourcis.ts");
  assert.match(raccourcis, /id: "navigateur", categorie: "Panneaux", libelle: "Ouvrir le navigateur intégré", combinaison: "Ctrl \+ Maj \+ B"/);
  assert.match(lire("src/components/SettingsPane.tsx"), /section === "navigateur" \?/);
  const editeur = lire("src/components/EditorPane.tsx");
  assert.match(editeur, /export type OngletSpecial/);
  assert.match(editeur, /settingsActive \|\| remoteActive \|\| specialActif \? undefined/);
  assert.match(lire("src/components/Workspace.tsx"), /ongletsSpeciaux=\{premiere \? navigateur\.onglets : undefined\}/);
  assert.match(lire("src/components/chat/Markdown.tsx"), /ouvrirLien\(href, /);
  assert.match(lire("src/components/TerminalPanel.tsx"), /ouvrirLien\(uri, /);
  assert.match(lire("src/components/chat/ChatPane.tsx"), /enregistrerCibleChat\(conversationId/);
});
