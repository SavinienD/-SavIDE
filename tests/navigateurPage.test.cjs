const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

// scripts évalués dans la page du navigateur intégré (src-tauri/src/navigateur/page) :
// lecture compacte, clic, saisie, touches, attente, Design Mode. jsdom n'a pas de mise en page :
// chaque élément reçoit une taille sauf ceux marqués data-sans-taille.
const racine = path.resolve(__dirname, "..");
const AGENT = fs.readFileSync(path.join(racine, "src-tauri/src/navigateur/page/agent.js"), "utf8");
const DESIGN = fs.readFileSync(path.join(racine, "src-tauri/src/navigateur/page/design.js"), "utf8");

function page(html) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Démo</title></head><body>${html}</body></html>`, {
    url: "http://localhost:5173/connexion",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = function () {
    const vide = this.hasAttribute("data-sans-taille");
    return { left: 10, top: 20, right: 110, bottom: 50, x: 10, y: 20, width: vide ? 0 : 100, height: vide ? 0 : 30 };
  };
  w.Element.prototype.getClientRects = function () {
    return this.hasAttribute("data-sans-taille") ? [] : [this.getBoundingClientRect()];
  };
  // Comme l'appli : la bibliothèque, puis l'appel ; la valeur rendue est une chaîne JSON.
  const appel = (fonction, ...args) => {
    const brut = w.eval(`${AGENT}\n;JSON.stringify((function(){try{return window.__axecodeNavigateur.${fonction}(${args.map((a) => JSON.stringify(a)).join(",")});}catch(e){return {erreur:String(e&&e.message||e)};}})())`);
    return JSON.parse(brut);
  };
  return { dom, w, appel };
}

const FORMULAIRE = `
  <nav><a href="/">Accueil</a><a href="https://docs.exemple.fr/guide?x=1">Guide</a></nav>
  <main>
    <h1>Connexion</h1>
    <p>Entrez vos <b>identifiants</b>.</p>
    <form id="f">
      <label for="mail">Adresse e-mail</label><input id="mail" type="email" placeholder="vous@exemple.fr">
      <input id="mdp" type="password" aria-label="Mot de passe" value="secret">
      <select id="pays"><option value="fr">France</option><option value="be">Belgique</option></select>
      <label><input id="cgu" type="checkbox"> J'accepte</label>
      <button type="submit">Se connecter</button>
    </form>
    <div style="display:none"><button>Caché</button></div>
    <button data-sans-taille>Sans taille</button>
    <div role="button" tabindex="0">Menu</div>
  </main>`;

test("lire : texte compact et éléments numérotés, rien de caché, mot de passe jamais lu", () => {
  const { appel } = page(FORMULAIRE);
  const r = appel("lire", {});
  assert.equal(r.titre, "Démo");
  assert.equal(r.url, "http://localhost:5173/connexion");
  const lignes = r.lignes;
  assert.deepEqual(lignes.slice(0, 2), ["[e1] lien « Accueil » → /", "[e2] lien « Guide » → https://docs.exemple.fr/guide?x=1"]);
  assert.ok(lignes.includes("# Connexion"));
  assert.ok(lignes.includes("Entrez vos identifiants ."), lignes.join("\n"));
  assert.ok(lignes.includes("[e3] champ e-mail « Adresse e-mail » (vide)"), lignes.join("\n"));
  assert.ok(lignes.includes("[e4] champ mot de passe « Mot de passe » (rempli)"));
  assert.ok(lignes.includes("[e5] liste déroulante « pays » = « France »") || lignes.some((l) => l.startsWith("[e5] liste déroulante")), lignes.join("\n"));
  assert.ok(lignes.some((l) => /^\[e6\] case à cocher .*\(non cochée\)$/.test(l)), lignes.join("\n"));
  assert.ok(lignes.includes("[e7] bouton « Se connecter »"));
  assert.ok(lignes.includes("[e8] bouton « Menu »"));
  const tout = lignes.join("\n");
  assert.ok(!tout.includes("Caché") && !tout.includes("Sans taille"), "éléments cachés ou sans taille omis");
  assert.ok(!tout.includes("secret"), "valeur du mot de passe jamais rendue");
  assert.equal(r.elements, 8);
});

test("références stables d'une lecture à l'autre, partie de page, troncature", () => {
  const { appel, w } = page(FORMULAIRE);
  appel("lire", {});
  const nouveau = w.document.createElement("button");
  nouveau.textContent = "Nouveau";
  w.document.querySelector("main").prepend(nouveau);
  const r = appel("lire", {});
  assert.ok(r.lignes.includes("[e7] bouton « Se connecter »"), "même élément, même référence");
  assert.ok(r.lignes.includes("[e9] bouton « Nouveau »"));
  const partie = appel("lire", { selecteur: "nav" });
  assert.equal(partie.elements, 2);
  assert.match(appel("lire", { selecteur: "#absent" }).erreur, /aucun élément pour le sélecteur/);
  const court = appel("lire", { max_elements: 2 });
  assert.equal(court.elements, 2);
  assert.equal(court.tronque, true);
});

test("cliquer, remplir, touche, trouver", () => {
  const { appel, w } = page(FORMULAIRE);
  appel("lire", {});
  const vus = [];
  w.document.querySelector("[role=button]").addEventListener("click", () => vus.push("menu"));
  w.document.querySelector("[role=button]").addEventListener("mousedown", () => vus.push("appui"));
  assert.deepEqual(appel("cliquer", "e8"), { ok: true, element: "bouton « Menu »" });
  assert.deepEqual(vus, ["appui", "menu"]);
  assert.match(appel("cliquer", "e99").erreur, /élément e99 introuvable : relisez la page/);

  const saisies = [];
  const mail = w.document.getElementById("mail");
  mail.addEventListener("input", () => saisies.push(mail.value));
  assert.equal(appel("remplir", "e3", "a@b.fr").ok, true);
  assert.equal(mail.value, "a@b.fr");
  assert.deepEqual(saisies, ["a@b.fr"]);
  appel("remplir", "e5", "Belgique");
  assert.equal(w.document.getElementById("pays").value, "be");
  assert.match(appel("remplir", "e5", "Suisse").erreur, /aucune option « Suisse »/);
  appel("remplir", "e6", "oui");
  assert.equal(w.document.getElementById("cgu").checked, true);
  assert.match(appel("remplir", "e1", "x").erreur, /ne se remplit pas \(lien\)/);

  // Entrée dans un champ : le formulaire est envoyé (évènement submit).
  let envoye = 0;
  w.document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); envoye += 1; });
  mail.focus();
  assert.equal(appel("touche", "Entrée").ok, true);
  assert.equal(envoye, 1);
  // Tab : focus suivant ; caractère : tapé dans le champ.
  mail.focus();
  assert.match(appel("touche", "Tab").focus, /champ mot de passe/);
  mail.focus();
  appel("touche", "!");
  assert.equal(mail.value, "a@b.fr!");
  appel("touche", "Retour arrière");
  assert.equal(mail.value, "a@b.fr");
  assert.match(appel("touche", "F13").erreur, /touche inconnue/);

  assert.deepEqual(appel("trouver", "Connexion"), { trouve: true, par: "texte" });
  assert.deepEqual(appel("trouver", "#mail"), { trouve: true, par: "sélecteur" });
  assert.deepEqual(appel("trouver", "Introuvable"), { trouve: false });
});

test("la bibliothèque ne s'installe qu'une fois et la page ne peut pas la remplacer", () => {
  const { w, appel } = page("<button>A</button>");
  appel("resume");
  const api = w.__axecodeNavigateur;
  w.eval(`${AGENT}`);
  assert.equal(w.__axecodeNavigateur, api);
  w.eval("try { window.__axecodeNavigateur = { lire: () => 'faux' }; } catch (e) {}");
  assert.equal(w.__axecodeNavigateur, api);
});

test("Design Mode : survol, clic choisi (HTML sans valeurs), Échap annule", () => {
  const { w } = page(`<main><button id="envoi" class="primaire grand" style="color: rgb(255, 0, 0)">Envoyer <input value="secret"></button><p>Texte</p></main>`);
  const releve = () => JSON.parse(w.eval("JSON.stringify(window.__axecodeDesign.prendre())"));
  w.eval(DESIGN);
  assert.equal(w.document.documentElement.style.cursor, "crosshair");
  const bouton = w.document.getElementById("envoi");
  let clicsPage = 0;
  bouton.addEventListener("click", () => (clicsPage += 1));
  bouton.dispatchEvent(new w.MouseEvent("mousemove", { bubbles: true }));
  assert.equal(w.document.querySelectorAll("[data-axecode-design]").length, 2, "cadre et étiquette affichés");
  bouton.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(clicsPage, 0, "le clic ne va pas à la page");
  const r = releve();
  assert.equal(r.actif, false);
  assert.equal(r.choix.balise, "button");
  assert.equal(r.choix.selecteur, "#envoi");
  assert.equal(r.choix.styles.color, "rgb(255, 0, 0)");
  assert.equal(r.choix.attributs.class, "primaire grand");
  assert.ok(r.choix.html.startsWith('<button id="envoi"'));
  assert.ok(!r.choix.html.includes("secret"), "valeurs des champs retirées");
  assert.equal(r.choix.url, "http://localhost:5173/connexion");
  assert.equal(w.document.querySelectorAll("[data-axecode-design]").length, 0, "plus rien d'ajouté à la page");
  assert.equal(releve().choix, null, "choix relevé une seule fois");

  w.eval(DESIGN);
  w.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const annule = releve();
  assert.equal(annule.actif, false);
  assert.equal(annule.annule, true);
  assert.equal(annule.choix, null);
});

test("Design Mode : sélecteur par chemin quand l'élément n'a pas d'identifiant", () => {
  const { w } = page(`<main><ul class="liste"><li>A</li><li>B</li></ul></main>`);
  w.eval(DESIGN);
  const second = w.document.querySelectorAll("li")[1];
  second.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const r = JSON.parse(w.eval("JSON.stringify(window.__axecodeDesign.prendre())"));
  assert.equal(r.choix.selecteur, "main > ul.liste > li:nth-of-type(2)");
  assert.equal(w.document.querySelector(r.choix.selecteur), second);
});
