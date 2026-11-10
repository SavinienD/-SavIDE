const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Slash commands: every command of the registry that the composer proposes is coloured once
// chosen, and every command coloured at a given place is proposed there (start of the message,
// or after a blank anywhere else, e.g. « /autonomous /goal »).
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const lire = (rel) => fs.readFileSync(path.join(racine, rel), "utf8");
const { commandesAProposer, decouperJetons, COMMANDES_PARTOUT } = require(path.join(racine, "src/components/chat/jetonsMessage.ts"));

function registre() {
  const src = lire("src/components/chat/SlashCommands.tsx");
  const debut = src.indexOf("export const SLASH_COMMANDS");
  const bloc = src.slice(debut, src.indexOf("];", debut));
  return [...bloc.matchAll(/\{\s*name:\s*"([a-z_-]+)"/g)].map((m) => m[1]);
}
const REGISTRE = registre();

/** Commandes colorées si on écrit « /nom » à la place du jeton « / » final de `avant`. */
function colorees(avant, apres = "") {
  return REGISTRE.filter((nom) => {
    const texte = `${avant}/${nom} ${apres}`;
    let pos = 0;
    return decouperJetons(texte, REGISTRE).some((s) => {
      const ok = s.genre === "commande" && s.texte.toLowerCase() === `/${nom}` && pos === avant.length;
      pos += s.texte.length;
      return ok;
    });
  });
}
const proposees = (avant, requete = "", apres = "") =>
  commandesAProposer(`${avant}/${requete}${apres}`, avant.length, requete, REGISTRE);

test("registre lu", () => {
  assert.ok(REGISTRE.length >= 8, REGISTRE.join(","));
  for (const nom of ["goal", "autonomous", "heartbeat"]) assert.ok(REGISTRE.includes(nom), nom);
});

test("en tête du message : toutes les commandes du registre sont proposées et colorées", () => {
  assert.deepEqual(proposees(""), REGISTRE);
  assert.deepEqual(colorees(""), REGISTRE);
  assert.deepEqual(proposees("  "), REGISTRE);
});

test("après une commande ou du texte : liste proposée = liste colorée", () => {
  for (const avant of ["/autonomous ", "/autonomous --max-turns 3 ", "/compact puis ", "texte ", "a\n", "/goal x ", "a /goal x ", "/heartbeat 5m coucou "]) {
    assert.deepEqual(proposees(avant), colorees(avant), JSON.stringify(avant));
  }
  // Le cas signalé : « /autonomous /goal » propose /goal et /heartbeat (et /nonstop, mode sans fin), et /goal est coloré.
  assert.deepEqual(proposees("/autonomous "), ["goal", "nonstop", "heartbeat"]);
  assert.deepEqual(proposees("texte "), ["goal", "nonstop", "heartbeat"]);
  assert.deepEqual(proposees("a /goal x "), ["nonstop", "heartbeat"]);
  assert.deepEqual(
    decouperJetons("/autonomous /goal", REGISTRE).map((s) => `${s.genre}:${s.texte}`),
    ["commande:/autonomous", "texte: ", "commande:/goal"],
  );
  // Ailleurs qu'en tête, seules les commandes que le service lit à cet endroit.
  assert.deepEqual([...proposees("texte ")].sort(), REGISTRE.filter((n) => COMMANDES_PARTOUT.includes(n)).sort());
});

test("filtre par les lettres tapées, texte après le curseur, collé à un mot", () => {
  assert.deepEqual(proposees("/autonomous ", "go"), ["goal"]);
  assert.deepEqual(proposees("/autonomous ", "goal"), []);
  assert.deepEqual(proposees("", "g"), REGISTRE.filter((n) => n.startsWith("g") && n !== "g"));
  assert.deepEqual(proposees("finir ", "he", " puis relire"), ["heartbeat"]);
  assert.deepEqual(proposees("src", ""), []);
  assert.deepEqual(commandesAProposer("x/a b", 1, "a b", REGISTRE), []);
});

test("le service applique la même règle et le compositeur passe le jeton sous le curseur", () => {
  const rust = lire("crates/axecode-app/src/session_commands.rs");
  const partout = /pub const COMMANDES_PARTOUT: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust);
  assert.ok(partout, "COMMANDES_PARTOUT du service introuvable");
  assert.deepEqual([...partout[1].matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]), [...COMMANDES_PARTOUT]);
  assert.ok(/for cmd in user_text\(request\)[^\n]*parse_slashes/.test(rust), "toutes les commandes du message sont exécutées");
  const pane = lire("src/components/chat/ChatPane.tsx");
  assert.ok(pane.includes("useSlashCommandMenu(text, setText, jetonSlash"), "menu ouvert sur le jeton courant");
});
