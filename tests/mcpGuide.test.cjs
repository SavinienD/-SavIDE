const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// mcp-guide — Réglages > MCP : ajout guidé (stdio / HTTP), états lisibles, journal d'erreur expliqué.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const G = require(path.join(racine, "src/axe/mcpGuide.ts"));
const C = require(path.join(racine, "src/axe/mcpCatalog.ts"));

test("ligne de commande découpée comme un shell simple (guillemets, espaces)", () => {
  assert.deepEqual(G.decouperLigneCommande('npx -y @scope/serveur --dir "C:\\Mes Documents\\x" \'a b\''), [
    "npx", "-y", "@scope/serveur", "--dir", "C:\\Mes Documents\\x", "a b",
  ]);
  assert.deepEqual(G.decouperLigneCommande("   "), []);
});

test("serveur local (stdio) : commande, arguments, variables, identifiant unique", () => {
  const s = G.construireServeurPerso(
    { mode: "stdio", nom: "Mon outil", commande: "uvx mon-outil --port 3", env: "API_KEY=abc\n\n MODE = rapide ", url: "", jeton: "" },
    ["mcp_mon_outil"],
  );
  assert.equal(s.id, "mcp_mon_outil_2");
  assert.equal(s.name, "Mon outil");
  assert.equal(s.command, "uvx");
  assert.deepEqual(s.args, ["mon-outil", "--port", "3"]);
  assert.deepEqual(s.env, [{ key: "API_KEY", value: "abc" }, { key: "MODE", value: "rapide" }]);
  assert.equal(s.url, null);
  assert.equal(s.enabled, true);
});

test("serveur distant (HTTP) : URL, jeton facultatif (sinon connexion par le navigateur)", () => {
  const sans = G.construireServeurPerso({ mode: "http", nom: "Linear", commande: "", env: "", url: " https://mcp.linear.app/mcp ", jeton: "" }, []);
  assert.equal(sans.command, "");
  assert.equal(sans.url, "https://mcp.linear.app/mcp");
  assert.equal(sans.auth, null);
  const avec = G.construireServeurPerso({ mode: "http", nom: "Interne", commande: "", env: "", url: "https://mcp.exemple.fr/mcp", jeton: "abc123" }, []);
  assert.deepEqual(avec.auth, { type: "bearer", token: "abc123", scopes: [] });
});

test("validation de l'ajout guidé", () => {
  const base = { mode: "stdio", nom: "X", commande: "npx -y x", env: "", url: "", jeton: "" };
  assert.equal(G.validerServeurPerso(base), null);
  assert.match(G.validerServeurPerso({ ...base, nom: " " }), /nom/i);
  assert.match(G.validerServeurPerso({ ...base, commande: "" }), /commande/i);
  assert.match(G.validerServeurPerso({ ...base, env: "PAS_DE_EGAL" }), /CLE=valeur/);
  const http = { ...base, mode: "http", commande: "" };
  assert.match(G.validerServeurPerso({ ...http, url: "" }), /adresse/i);
  assert.match(G.validerServeurPerso({ ...http, url: "ftp://x" }), /http/i);
  assert.equal(G.validerServeurPerso({ ...http, url: "http://localhost:3000/mcp" }), null);
});

test("erreurs expliquées en français, journal brut gardé (sans secret)", () => {
  const cmd = G.expliquerErreurMcp("unable to spawn `npx`: No such file or directory (os error 2)", { transport: "stdio" });
  assert.match(cmd.titre, /introuvable/i);
  assert.match(cmd.conseil, /Node\.js/);
  assert.match(G.expliquerErreurMcp("MCP request `initialize` timed out", { transport: "stdio" }).titre, /ne répond pas/i);
  assert.match(G.expliquerErreurMcp("MCP server closed stdout (Some(ExitStatus(1)))\nJournal du serveur :\nError: GITHUB_PERSONAL_ACCESS_TOKEN missing", { transport: "stdio" }).titre, /arrêté/i);
  assert.match(G.expliquerErreurMcp("whatever", { transport: "http", authRequired: true }).titre, /connexion requise/i);
  assert.match(G.expliquerErreurMcp("HTTP 404 Not Found", { transport: "http" }).titre, /introuvable/i);
  assert.match(G.expliquerErreurMcp("error sending request for url (https://x/mcp): Connection refused", { transport: "http" }).titre, /injoignable/i);
  const autre = G.expliquerErreurMcp("Bearer abcdef123456 refusé ; https://x/mcp?token=SECRET99&a=1 ghp_AbCdEf1234567890", { transport: "http" });
  assert.ok(!/abcdef123456|SECRET99|ghp_AbCdEf/.test(autre.journal), autre.journal);
  assert.match(autre.journal, /\*\*\*\*/);
  assert.equal(G.expliquerErreurMcp(null, { transport: "stdio" }), null);
});

test("état d'un serveur pour la liste : désactivé, vérification, connecté, connexion requise, erreur", () => {
  const srv = { id: "a", enabled: true };
  assert.deepEqual(G.etatServeurMcp({ ...srv, enabled: false }, null, false), { ton: "off", libelle: "Désactivé" });
  assert.equal(G.etatServeurMcp(srv, null, true).libelle, "Vérification…");
  assert.deepEqual(G.etatServeurMcp(srv, { ok: true, tools: [1, 2] }, false), { ton: "ok", libelle: "Connecté · 2 outils" });
  assert.deepEqual(G.etatServeurMcp(srv, { ok: true, tools: [1] }, false), { ton: "ok", libelle: "Connecté · 1 outil" });
  assert.deepEqual(G.etatServeurMcp(srv, { ok: false, tools: [], authRequired: true }, false), { ton: "auth", libelle: "Connexion requise" });
  assert.deepEqual(G.etatServeurMcp(srv, { ok: false, tools: [], error: "x" }, false), { ton: "error", libelle: "Erreur" });
});

test("catalogue : serveurs distants à connexion par navigateur (OAuth) et IA exposées en MCP", () => {
  const distants = C.MCP_CATALOG.filter((e) => e.url);
  assert.ok(distants.length >= 3);
  for (const e of distants) assert.match(e.url, /^https:\/\//);
  const linear = C.findMcpCatalogEntry("linear");
  assert.equal(linear.oauth, true);
  const s = C.buildMcpServerFromCatalog(linear, {});
  assert.equal(s.command, "");
  assert.equal(s.url, "https://mcp.linear.app/mcp");
  assert.deepEqual(s.args, []);
  const ia = C.MCP_CATALOG.filter((e) => e.categorie === "ia");
  assert.ok(ia.some((e) => e.id === "codex") && ia.some((e) => e.id === "gemini-cli"));
  // Un jeton porté par une variable « bearer » part dans l'en-tête Authorization, pas dans l'environnement.
  const gh = C.findMcpCatalogEntry("github-distant");
  const sg = C.buildMcpServerFromCatalog(gh, { GITHUB_TOKEN: "ghp_x" });
  assert.deepEqual(sg.auth, { type: "bearer", token: "ghp_x", scopes: [] });
  assert.deepEqual(sg.env, []);
  assert.ok(C.MCP_CATALOG.every((e) => e.id !== "personnalise"));
});
