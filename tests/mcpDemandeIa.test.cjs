const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Réglages > MCP : une commande à lancer devient une demande à l'IA, prête dans le chat.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const D = require(path.join(racine, "src/axe/mcpDemandeIa.ts"));
const C = require(path.join(racine, "src/axe/mcpCatalog.ts"));
const V = require(path.join(racine, "src/components/pr/versAgent.ts"));

// Le texte suit la typographie française (espaces insécables) : comparé avec des espaces simples.
const n = (s) => s.replace(/[\u00a0\u202f]/g, " ");
const demande = (...a) => n(D.demandeInstallationMcp(...a));
const excel = () => C.buildMcpServerFromCatalog(C.MCP_CATALOG.find((e) => e.id === "excel"), {});

test("serveur local ou distant : seule une commande sur ce poste passe par l'IA", () => {
  assert.equal(D.serveurLocal(excel()), true);
  const linear = C.MCP_CATALOG.find((e) => e.id === "linear");
  assert.equal(D.serveurLocal(C.buildMcpServerFromCatalog(linear, {})), false);
  assert.equal(D.serveurLocal({ command: "", url: null }), false);
});

test("demande d'installation : commande exacte, système, prérequis, rien d'envoyé de secret", () => {
  const texte = demande(excel(), { systeme: "macOS" });
  assert.match(texte, /Installe et configure le serveur MCP « Excel » sur ce poste \(macOS\)/);
  assert.match(texte, /commande : npx -y @negokaz\/excel-mcp-server\n/);
  assert.match(texte, /Node\.js \(il fournit npx\)/);
  assert.match(texte, /répond et liste ses outils/);

  const github = C.MCP_CATALOG.find((e) => e.id === "github");
  const s = C.buildMcpServerFromCatalog(github, { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_SECRETVALEUR123456" });
  const t2 = demande(s, { systeme: "Windows" });
  assert.ok(!t2.includes("SECRETVALEUR"), t2);
  assert.match(t2, /GITHUB_PERSONAL_ACCESS_TOKEN/);
  assert.match(t2, /\(Windows\)/);
});

test("uvx, programme quelconque, valeurs à remplacer, remarque du catalogue", () => {
  assert.equal(D.prerequisCommande("uvx"), "uv (il fournit uvx)");
  assert.equal(D.prerequisCommande("C:\\Program Files\\nodejs\\npx.cmd"), "Node.js (il fournit npx)");
  assert.equal(D.prerequisCommande("cua-driver"), null);
  const obsidian = C.buildMcpServerFromCatalog(C.MCP_CATALOG.find((e) => e.id === "obsidian"), {});
  const t = demande(obsidian, { systeme: "macOS", note: "Remplacer CHEMIN_DU_COFFRE." });
  assert.match(t, /Demande-moi les valeurs à mettre à la place de CHEMIN_DU_COFFRE/);
  assert.match(t, /Remarque : Remplacer CHEMIN_DU_COFFRE\./);
  const cua = demande({ name: "Bureau", command: "cua-driver", args: ["mcp"] }, { systeme: "Linux" });
  assert.match(cua, /programme « cua-driver » est installé/);
  assert.equal(D.commandeServeur({ command: "npx", args: ["-y", "srv", "/Users/moi/Mes Documents"] }), 'npx -y srv "/Users/moi/Mes Documents"');
});

test("test en échec : erreur expliquée et journal masqué dans la demande", () => {
  const t = demande(excel(), {
    systeme: "macOS",
    erreur: { titre: "Commande introuvable : npx", journal: "unable to spawn `npx` token=abc123SECRET" },
  });
  assert.match(t, /ne fonctionne pas sur ce poste \(macOS\) : Commande introuvable : npx\./);
  assert.match(t, /Trouve la cause de l'erreur et corrige-la/);
  assert.ok(!t.includes("abc123SECRET"), t);
});

test("livraison : l'événement porte le texte, la saisie affichée le reçoit sans envoi", () => {
  const cible = new EventTarget();
  const recus = [];
  const retirer = D.ecouterDemandesIa((texte) => recus.push(texte), cible);
  D.confierALIa("  Installe X  ", cible);
  D.confierALIa("   ", cible);
  retirer();
  D.confierALIa("après retrait", cible);
  assert.deepEqual(recus, ["Installe X"]);

  V.reinitialiser();
  assert.equal(V.compositeurAffiche("/p"), false);
  const inseres = [];
  V.brancherCompositeur("c1", "/p", { inserer: (t) => inseres.push(t), element: () => null });
  assert.equal(V.compositeurAffiche("/p"), true);
  assert.equal(V.compositeurAffiche("/autre"), false);
  assert.equal(V.envoyerALAgent("Installe X", "/p"), "saisie");
  assert.deepEqual(inseres, ["Installe X"]);
  V.reinitialiser();
});
