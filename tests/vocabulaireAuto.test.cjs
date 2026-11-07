const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// voix-vocabulaire — vocabulaire de la dictée appris des messages tapés (local, sans secret).
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const V = require(path.join(racine, "src/axe/voix/vocabulaireAuto.ts"));

const apprendre = (messages, etat = V.etatVide()) => messages.reduce((e, m, i) => V.apprendre(e, m, 1000 + i), etat);
const formes = (etat) => V.motsAppris(etat).map((m) => m.forme);

test("noms propres et termes techniques répétés dans deux messages", () => {
  const e = apprendre([
    "Peux-tu regarder le tableau Grafana du client Dupont sur le pfSense ?",
    "Le pfSense de Dupont ne remonte plus dans Grafana.",
  ]);
  assert.deepEqual(formes(e).sort(), ["Dupont", "Grafana", "pfSense"]);
});

test("un mot vu une seule fois n'est pas encore retenu ; début de phrase ignoré", () => {
  const e = apprendre(["Kubernetes est en panne. Regarde GitLab.", "Regarde encore."]);
  assert.deepEqual(formes(e), []);
  const e2 = apprendre(["Bonjour, peux-tu voir GitLab ?", "Bonjour, GitLab encore."], e);
  assert.deepEqual(formes(e2), ["GitLab"]);
});

test("pas de doublon : même mot, casse différente, plusieurs fois dans un message", () => {
  const e = apprendre(["le serveur Zabbix, Zabbix et ZABBIX", "encore Zabbix ici", "et zabbix là avec Zabbix"]);
  const mots = V.motsAppris(e);
  assert.equal(mots.length, 1);
  assert.equal(mots[0].forme, "Zabbix");
  assert.equal(mots[0].n, 3);
});

test("jamais de secret : jetons, clés, mots de passe, entropie, URL avec jeton", () => {
  const secrets = [
    "voici la clé ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv et AKIAIOSFODNN7EXAMPLE",
    "voici la clé ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv et AKIAIOSFODNN7EXAMPLE",
    "le mot de passe du routeur Dupont est Soleil2024",
    "le mot de passe du routeur Dupont est Soleil2024",
    "token: Xk9QzT7LmP2vB8nR4wY6 et encore Xk9QzT7LmP2vB8nR4wY6",
    "va sur https://exemple.fr/api?token=AbCdEfGh123456 avec Zorglub",
    "va sur https://exemple.fr/api?token=AbCdEfGh123456 avec Zorglub",
    "jeton sk-proj-AbCdEf123456GhIjKl ; hash 3f2a9c8e7d6b5a4f3e2d1c0b",
    "jeton sk-proj-AbCdEf123456GhIjKl ; hash 3f2a9c8e7d6b5a4f3e2d1c0b",
    "eyJhbGciOiJIUzI1NiJ9 QmFzZTY0U2VjcmV0VmFsdWU9 Q7rT9xLp2Wm",
    "eyJhbGciOiJIUzI1NiJ9 QmFzZTY0U2VjcmV0VmFsdWU9 Q7rT9xLp2Wm",
  ];
  const appris = formes(apprendre(secrets)).join(" ");
  for (const interdit of ["ghp_", "AKIA", "Soleil2024", "Xk9QzT7", "AbCdEfGh", "sk-proj", "3f2a9c", "eyJ", "QmFzZT", "Q7rT9xLp2Wm", "Dupont"]) {
    assert.ok(!appris.includes(interdit), `${interdit} ne doit pas être appris (${appris})`);
  }
  // Le seul mot sûr, vu deux fois hors de tout contexte de secret, est gardé.
  assert.deepEqual(formes(apprendre(secrets)), ["Zorglub"]);
});

test("V.estSecret : formes connues et chaînes à forte entropie", () => {
  for (const s of ["ghp_A1b2C3d4E5f6G7h8", "xoxb-12345-abcdef", "sk-ant-api03-Abc", "AKIAIOSFODNN7EXAMPLE", "Soleil2024", "a1B2c3D4e5", "0123456789abcdef0123", "dGhpcyBpcyBhIHNlY3JldA"]) {
    assert.equal(V.estSecret(s), true, s);
  }
  for (const s of ["Grafana", "pfSense", "IPv6", "Win11", "GitLab", "GDMS", "S3"]) {
    assert.equal(V.estSecret(s), false, s);
  }
});

test("code, chemins, adresses et commandes ne sont pas lus", () => {
  const e = apprendre([
    "lance `MonScript.Run` puis ```\nconst MaClasse = FooBar();\n``` dans C:\\Users\\Dupont\\Projet et /home/moi/Truc, écris à jean.Dupuis@exemple.fr /Goal",
    "lance `MonScript.Run` puis ```\nconst MaClasse = FooBar();\n``` dans C:\\Users\\Dupont\\Projet et /home/moi/Truc, écris à jean.Dupuis@exemple.fr /Goal",
  ]);
  assert.deepEqual(formes(e), []);
});

test("retirer un mot : il disparaît et n'est plus réappris", () => {
  let e = apprendre(["voir Grafana et Zabbix", "encore Grafana et Zabbix"]);
  e = V.retirer(e, "grafana");
  assert.deepEqual(formes(e), ["Zabbix"]);
  e = apprendre(["toujours Grafana", "et Grafana"], e);
  assert.deepEqual(formes(e), ["Zabbix"]);
  e = V.toutEffacer(e);
  assert.deepEqual(formes(e), []);
});

test("vocabulaire envoyé à Whisper : manuel d'abord, sans doublon, sans les termes de base, borné", () => {
  let e = V.etatVide();
  for (let i = 0; i < 80; i++) {
    const mot = "Projet" + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)) + "x";
    e = apprendre([`voir le ${mot}`, `encore le ${mot}`], e);
  }
  e = apprendre(["voir Tauri et Grafana", "encore Tauri et Grafana"], e);
  const texte = V.vocabulaireEffectif("Dupont SA, grafana; Kubernetes", e);
  assert.ok(texte.startsWith("Dupont SA, grafana, Kubernetes, "), texte);
  assert.ok(texte.length <= V.LIMITE_VOCABULAIRE, String(texte.length));
  assert.ok(!/\bTauri\b/.test(texte), "Tauri est déjà dans l'amorce de base");
  assert.equal(texte.toLowerCase().split("grafana").length - 1, 1, "pas de doublon");
  assert.ok(!texte.endsWith(", "));
  assert.equal(V.vocabulaireEffectif("", V.etatVide()), "");
});

test("apprentissage désactivé : rien n'est appris ni envoyé", () => {
  let e = V.avecActif(V.etatVide(), false);
  e = apprendre(["voir Grafana", "encore Grafana"], e);
  assert.deepEqual(formes(e), []);
  assert.equal(V.vocabulaireEffectif("", e), "");
});

test("taille bornée : les mots les plus anciens et rares sont oubliés", () => {
  let e = V.etatVide();
  for (let i = 0; i < V.MAX_SUIVIS + 50; i++) {
    const mot = "Mot" + i.toString(36).toUpperCase().replace(/[0-9]/g, (c) => "QRSTUVWXYZ"[Number(c)]) + "z";
    e = V.apprendre(e, `voir ${mot}`, i);
  }
  assert.ok(Object.keys(e.suivis).length <= V.MAX_SUIVIS);
});

test("état stocké illisible ou ancien : repli sur un état vide", () => {
  assert.deepEqual(V.lireEtat("pas du json"), V.etatVide());
  assert.deepEqual(V.lireEtat(JSON.stringify({ suivis: 3 })), V.etatVide());
  const e = apprendre(["voir Grafana", "encore Grafana"]);
  assert.deepEqual(V.lireEtat(JSON.stringify(e)), e);
});
