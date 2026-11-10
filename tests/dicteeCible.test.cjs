const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// La dictée va dans la conversation où elle a commencé, jamais dans celle affichée.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const D = require(path.join(racine, "src/axe/voix/dicteeCible.ts"));

function monter() {
  D.reinitialiserDictees();
  const brouillons = new Map();
  const avis = [];
  const presse = [];
  D.brancherBrouillons({ lire: (id) => brouillons.get(id) ?? "", ecrire: (id, t) => brouillons.set(id, t) });
  D.brancherAvis((genre, texte) => avis.push([genre, texte]));
  D.brancherPressePapiers((t) => { presse.push(t); });
  return { brouillons, avis, presse };
}
const A = { conversationId: "conv-A", workspacePath: "C:/projet" };

test("ROUGE avant : la saisie affichée (B) ne reçoit jamais le texte d'une dictée commencée dans A", () => {
  const { brouillons } = monter();
  const saisieB = [];
  // Le compositeur affiche B (on a changé de conversation pendant la transcription).
  D.enregistrerComposeur("conv-B", (t) => saisieB.push(t));
  assert.equal(D.livrerDictee(A, "Relance le banc."), "brouillon");
  assert.deepEqual(saisieB, []);
  assert.equal(brouillons.get("conv-A"), "Relance le banc.");
  assert.ok(D.dicteesHorsEcran().has("conv-A"), "repère sur l'onglet de A");
});

test("A affichée (même dans une autre colonne) : insertion au curseur de SON compositeur", () => {
  const { brouillons } = monter();
  const saisieA = [];
  const saisieB = [];
  D.enregistrerComposeur("conv-B", (t) => saisieB.push(t));
  D.enregistrerComposeur("conv-A", (t) => saisieA.push(t));
  assert.equal(D.livrerDictee(A, "  bonjour  "), "saisie");
  assert.deepEqual(saisieA, ["bonjour"]);
  assert.deepEqual(saisieB, []);
  assert.equal(brouillons.size, 0);
  assert.equal(D.dicteesHorsEcran().size, 0);
});

test("brouillon existant : le texte s'ajoute à la fin avec une espace ; rouvrir efface le repère", () => {
  const { brouillons, avis } = monter();
  brouillons.set("conv-A", "Peux-tu");
  D.livrerDictee(A, "relancer le banc ?");
  assert.equal(brouillons.get("conv-A"), "Peux-tu relancer le banc ?");
  assert.equal(avis.at(-1)[0], "info");
  let vu = 0;
  const fin = D.abonnerDictees(() => vu++);
  const retirer = D.enregistrerComposeur("conv-A", () => undefined);
  assert.equal(D.dicteesHorsEcran().has("conv-A"), false);
  assert.equal(vu, 1);
  fin();
  retirer();
  // Compositeur démonté : la dictée suivante revient au brouillon.
  assert.equal(D.livrerDictee(A, "encore"), "brouillon");
  assert.equal(brouillons.get("conv-A"), "Peux-tu relancer le banc ? encore");
});

test("conversation archivée ou supprimée : rien n'est collé ailleurs, presse-papiers + message", () => {
  const { brouillons, avis, presse } = monter();
  const saisieB = [];
  D.enregistrerComposeur("conv-B", (t) => saisieB.push(t));
  D.brancherExistence((c) => (c.workspacePath === "C:/projet" ? c.conversationId !== "conv-A" : null));
  assert.equal(D.livrerDictee(A, "texte perdu ?"), "presse-papiers");
  assert.deepEqual(presse, ["texte perdu ?"]);
  assert.deepEqual(saisieB, []);
  assert.equal(brouillons.size, 0);
  assert.equal(avis.at(-1)[0], "error");
  assert.match(avis.at(-1)[1], /presse-papiers/);
});

test("dossier fermé entre-temps (personne ne connaît la conversation) : brouillon, pas presse-papiers", () => {
  const { brouillons, presse } = monter();
  D.brancherExistence(() => null);
  assert.equal(D.livrerDictee(A, "pour plus tard"), "brouillon");
  assert.equal(brouillons.get("conv-A"), "pour plus tard");
  assert.deepEqual(presse, []);
});

test("le dernier compositeur branché sur A reçoit le texte ; retrait propre", () => {
  monter();
  const un = [];
  const deux = [];
  const r1 = D.enregistrerComposeur("conv-A", (t) => un.push(t));
  const r2 = D.enregistrerComposeur("conv-A", (t) => deux.push(t));
  D.livrerDictee(A, "x");
  r2();
  D.livrerDictee(A, "y");
  r1();
  assert.deepEqual(un, ["y"]);
  assert.deepEqual(deux, ["x"]);
});

test("texte vide : rien n'est ajouté nulle part", () => {
  const { brouillons } = monter();
  D.livrerDictee(A, "   ");
  assert.equal(brouillons.size, 0);
  assert.equal(D.dicteesHorsEcran().size, 0);
});

test("useDictee : le texte passe par la cible mémorisée au démarrage, plus par le onTexte du rendu courant", () => {
  const src = fs.readFileSync(path.join(racine, "src/axe/voix/useDictee.ts"), "utf8");
  // Un seul appel restant : le repli sans conversation (dans livrer).
  assert.equal(src.split("onTexteRef.current(").length - 1, 1, "plus d'appel direct au onTexte affiché pour le texte final");
  assert.match(src, /if \(!c\) \{\n\s+const r = onTexteRef\.current\(texte\);/);
  assert.match(src, /const \{ ou, remplacer \} = livrerDicteeRemplacable\(c, texte\);/);
  assert.match(src, /livrerDicteeRemplacable\(c, texte\)/);
  const bouton = fs.readFileSync(path.join(racine, "src/axe/voix/DicteeBouton.tsx"), "utf8");
  assert.match(bouton, /!ailleurs && \(enregistre \|\| d\.phase === "transcription"\)/, "aperçu partiel jamais montré dans une autre conversation");
  const chat = fs.readFileSync(path.join(racine, "src/components/chat/ChatPane.tsx"), "utf8");
  assert.match(chat, /conversationId=\{conversationId\}/);
  assert.match(chat, /enregistrerComposeur\(conversationId/);
});

test("nettoyage différé : le texte inséré est remplacé seulement si la saisie n'a pas bougé", () => {
  const I = require(path.join(racine, "src/axe/voix/inserer.ts"));
  const ins = I.insererTexteDicte("Bonjour", 7, 7, "fais un commit");
  assert.equal(ins.valeur, "Bonjour fais un commit");
  const r = I.remplacerTexteDicte(ins.valeur, ins.valeur, ins.curseur, "fais un commit", "Fais un commit.");
  assert.deepEqual(r, { valeur: "Bonjour Fais un commit.", curseur: ins.curseur + 1 });
  // espace ajoutée après le texte dicté (insertion au milieu)
  const mid = I.insererTexteDicte("ab", 1, 1, "x y");
  assert.equal(mid.valeur, "a x y b");
  assert.equal(I.remplacerTexteDicte(mid.valeur, mid.valeur, mid.curseur, "x y", "X, Y.").valeur, "a X, Y. b");
  // saisie modifiée entre-temps : rien n'est remplacé
  assert.equal(I.remplacerTexteDicte(ins.valeur + "!", ins.valeur, ins.curseur, "fais un commit", "Fais un commit."), null);
  assert.equal(I.remplacerTexteDicte(ins.valeur, ins.valeur, ins.curseur, "fais un commit", "  "), null);
});

test("nettoyage différé : compositeur et brouillon rendent un remplacement", () => {
  const { brouillons } = monter();
  let saisie = "";
  D.enregistrerComposeur("conv-A", (t) => {
    const avant = saisie;
    saisie = (avant ? avant + " " : "") + t;
    const apres = saisie;
    return (n) => (saisie === apres ? ((saisie = avant ? avant + " " + n : n), true) : false);
  });
  const l = D.livrerDicteeRemplacable(A, "fais un commit");
  assert.equal(l.ou, "saisie");
  assert.equal(l.remplacer("Fais un commit."), true);
  assert.equal(saisie, "Fais un commit.");
  // brouillon d'une conversation non affichée
  brouillons.set("conv-B", "Note");
  const B = { conversationId: "conv-B", workspacePath: "C:/projet" };
  const lb = D.livrerDicteeRemplacable(B, "relance le service");
  assert.equal(lb.ou, "brouillon");
  assert.equal(brouillons.get("conv-B"), "Note relance le service");
  assert.equal(lb.remplacer("Relance le service."), true);
  assert.equal(brouillons.get("conv-B"), "Note Relance le service.");
  // brouillon modifié depuis : le remplacement est refusé
  const lb2 = D.livrerDicteeRemplacable(B, "et la VM");
  brouillons.set("conv-B", brouillons.get("conv-B") + " (modifié)");
  assert.equal(lb2.remplacer("Et la VM."), false);
  // ancien compositeur sans remplacement
  D.reinitialiserDictees();
  D.enregistrerComposeur("conv-A", () => undefined);
  assert.equal(D.livrerDicteeRemplacable(A, "x").remplacer, null);
});
