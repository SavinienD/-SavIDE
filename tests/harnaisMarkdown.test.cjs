const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// partager une entrée du harnais en .md (clic droit > « Exporter en .md… » /
// « Copier en Markdown », import d'un .md, garde-fou des secrets). Scènes du banc : harnais-*.
const racine = path.resolve(__dirname, "..");
for (const ext of [".ts", ".tsx"]) {
  Module._extensions[ext] = (module, filename) => {
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    module._compile(js, filename);
  };
}
const md = require(path.join(racine, "src/lib/harnaisMarkdown.ts"));

const DATE = new Date("2026-11-07T01:30:00.000Z");
const memoire = {
  id: "mem_1", kind: "memory", scope: "global", title: "Accès VM : SSH (port 12222)", tags: ["vm", "ssh"],
  body: "Port 12222, clé seulement.\n\n---\n\nVoir aussi : ~/.ssh/config", created: 1, updated: Date.parse("2026-11-06T10:00:00Z"),
};
const skill = {
  id: "sk_1", kind: "skill", scope: "project", title: "qcm", tags: [],
  body: "Questions à cocher.\n\n```python\nimport qcm\n```", code: "def ecrire(t):\n    s = \"```\"\n    return t\n",
  created: 1, updated: 2,
};
const agent = { id: "sa_1", kind: "subagent_spec", scope: "global", title: "relecteur", tags: ["model:anthropic/claude", "disabled"], body: "Tu relis le code.", created: 1, updated: 3 };

test("nom de fichier : titre en kebab-case + .md (accents, ponctuation), plusieurs = harnais-N-entrees.md", () => {
  assert.equal(md.nomFichierHarnais([memoire]), "acces-vm-ssh-port-12222.md");
  assert.equal(md.nomFichierHarnais([{ ...memoire, title: "  Élan  // déjà ! " }]), "elan-deja.md");
  assert.equal(md.nomFichierHarnais([{ ...memoire, title: "???" }]), "entree-harnais.md");
  assert.equal(md.nomFichierHarnais([memoire, skill, agent]), "harnais-3-entrees.md");
  assert.ok(md.nomFichierHarnais([{ ...memoire, title: "x".repeat(200) }]).length <= 64);
});

test("une entrée : en-tête YAML (format, type, titre, portée, tags, date, version) puis le corps tel quel", () => {
  const texte = md.harnaisVersMarkdown([memoire], { version: "0.1.84", date: DATE });
  assert.ok(texte.startsWith("---\nformat: harnais-md/1\n"), texte.slice(0, 80));
  assert.match(texte, /^type: memory\b/m);
  assert.match(texte, /^titre: "Accès VM : SSH \(port 12222\)"$/m);
  assert.match(texte, /^portee: global$/m);
  assert.match(texte, /^tags: \["vm", ?"ssh"\]$/m);
  assert.match(texte, /^date: 2026-11-07T01:30:00.000Z$/m);
  assert.match(texte, /^version: 0\.1\.84$/m);
  assert.ok(texte.includes("\n---\n\n" + memoire.body + "\n"), "corps tel quel");
});

test("skill : SKILL.md puis le code Python dans un bloc ```python (clôture plus longue que le code)", () => {
  const texte = md.harnaisVersMarkdown([skill], { version: "0.1.84", date: DATE });
  assert.ok(texte.includes(skill.body));
  assert.match(texte, /^````python$/m);
  assert.ok(texte.includes(skill.code));
});

test("aller-retour : ce qui est exporté se réimporte à l'identique (une ou plusieurs entrées)", () => {
  for (const lot of [[memoire], [skill], [agent], [memoire, skill, agent]]) {
    const texte = md.harnaisVersMarkdown(lot, { version: "0.1.84", date: DATE });
    const lu = md.lireHarnaisMarkdown(texte);
    assert.equal(lu.ok, true, lu.erreur);
    assert.equal(lu.entrees.length, lot.length);
    lot.forEach((e, i) => {
      const r = lu.entrees[i];
      assert.equal(r.kind, e.kind);
      assert.equal(r.title, e.title);
      assert.equal(r.scope, e.scope);
      assert.deepEqual(r.tags, e.tags);
      assert.equal(r.body, e.body);
      assert.equal(r.code ?? null, e.code ?? null);
    });
  }
});

test("plusieurs entrées : un seul .md, en-tête commun puis une section par entrée", () => {
  const texte = md.harnaisVersMarkdown([memoire, agent], { version: "0.1.84", date: DATE });
  assert.match(texte, /^entrees: 2$/m);
  assert.equal((texte.match(/^<!-- harnais-md:entree -->$/gm) ?? []).length, 2);
});

test("refus propre : fichier sans en-tête, type inconnu, titre vide, YAML cassé", () => {
  for (const [texte, motif] of [
    ["# Juste une note\n\nbonjour", /en-tête/],
    ["---\nformat: harnais-md/1\ntype: recette\ntitre: \"x\"\n---\n\ncorps", /type/],
    ["---\nformat: harnais-md/1\ntype: memory\ntitre: \"\"\n---\n\ncorps", /titre/],
    ["---\nformat: harnais-md/1\ntype: memory\ntitre: \"x\n", /en-tête/],
    ["", /vide/],
  ]) {
    const lu = md.lireHarnaisMarkdown(texte);
    assert.equal(lu.ok, false, texte);
    assert.match(lu.erreur, motif);
  }
});

test("un .md écrit à la main (sans format ni portée) s'importe : portée absente = non imposée", () => {
  const lu = md.lireHarnaisMarkdown("---\ntype: memory\ntitre: Note rapide\ntags: [a, b]\n---\nTexte.\n");
  assert.equal(lu.ok, true, lu.erreur);
  assert.equal(lu.entrees[0].title, "Note rapide");
  assert.deepEqual(lu.entrees[0].tags, ["a", "b"]);
  assert.equal(lu.entrees[0].scope, null);
  assert.equal(lu.entrees[0].body, "Texte.");
});

test("secrets : clés connues, mot de passe = valeur, clé privée, URL avec mot de passe, chaîne à forte entropie", () => {
  const texte = [
    "clé : sk-ant-api03-AbCdEf0123456789AbCdEf0123456789",
    "token github ghp_ABCDEFabcdef0123456789ABCDEFabcdef01",
    "mot de passe : Azerty123!",
    "password=hunter22",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "https://admin:S3cretPass@exemple.fr/api",
    "jeton brut Zx8Qw2Lp9Rt5Vb7Nm3Kj6Hg4Fd1Sa0Ty",
    "AKIAABCDEFGHIJKLMNOP",
  ].join("\n");
  const trouves = md.detecterSecrets(texte);
  assert.ok(trouves.length >= 8, JSON.stringify(trouves.map((t) => t.raison)));
  const masque = md.masquerSecrets(texte);
  for (const s of ["AbCdEf0123456789AbCdEf", "ghp_ABCDEF", "Azerty123!", "hunter22", "b3BlbnNzaC1rZXktdjEAAAAA", "S3cretPass", "Zx8Qw2Lp9Rt5Vb7Nm3Kj6Hg4Fd1Sa0Ty", "AKIAABCDEFGHIJKLMNOP"]) {
    assert.ok(!masque.includes(s), `encore visible : ${s}`);
  }
  assert.ok(masque.includes("mot de passe : " + md.MASQUE));
  // l'extrait montré à l'écran ne recopie jamais le secret entier
  for (const t of trouves) assert.ok(t.apercu.length <= 12 && t.apercu.endsWith("…"), t.apercu);
});

test("secrets : pas de fausse alerte sur un texte ordinaire (identifiants, hash git, UUID, chemins, dates)", () => {
  const texte = [
    "Commit 2c3749d0a1b2c3d4e5f60718293a4b5c6d7e8f90 sur main.",
    "Session 1b2c3d4e-0a1b-4c2d-8e3f-a4b5c6d7e8f9, mem_0a1b2c3d.",
    "Chemin /home/utilisateur/projets/appli/src/components/settings/HarnessPane.tsx",
    "Le mot de passe est dans Bitwarden (entrée « Dev/Forge »).",
    "harness_cloud_publish et ProtocolError setTouchEmulationEnabled.",
    "date: 2026-11-07T01:30:00.000Z",
  ].join("\n");
  assert.deepEqual(md.detecterSecrets(texte).map((t) => t.raison), []);
  const exporte = md.harnaisVersMarkdown([memoire, skill, agent], { version: "0.1.84", date: DATE });
  assert.deepEqual(md.detecterSecrets(exporte).map((t) => t.raison), []);
});

test("sélection multiple : clic simple, Ctrl+clic (bascule), Maj+clic (plage depuis l'ancre)", () => {
  const ids = ["a", "b", "c", "d"];
  let s = md.selectionApresClic([], ids, "b", {}, null);
  assert.deepEqual(s.selection, ["b"]);
  s = md.selectionApresClic(s.selection, ids, "d", { ctrl: true }, s.ancre);
  assert.deepEqual(s.selection, ["b", "d"]);
  s = md.selectionApresClic(s.selection, ids, "b", { ctrl: true }, s.ancre);
  assert.deepEqual(s.selection, ["d"]);
  s = md.selectionApresClic(["b"], ids, "d", { shift: true }, "b");
  assert.deepEqual(s.selection, ["b", "c", "d"]);
  assert.equal(s.ancre, "b");
  // clic droit sur une entrée hors sélection : elle seule ; dans la sélection : la sélection reste
  assert.deepEqual(md.selectionPourMenu(["b", "c"], "c"), ["b", "c"]);
  assert.deepEqual(md.selectionPourMenu(["b", "c"], "a"), ["a"]);
});

// Le même format dans Axecode et SavIDE (« harnais-md/1 ») : un .md exporté par l'une
// s'importe dans l'autre. Ce texte est celui qu'écrit l'autre appli (version 0.1.79).
test("format commun : un .md exporté par l'autre appli se relit (une entrée + un skill)", () => {
  const autre = [
    "---", "format: harnais-md/1", "entrees: 2", "date: 2026-11-07T02:00:00.000Z", "version: 0.1.79", "---", "",
    "# Harnais : 2 entrées", "",
    "<!-- harnais-md:entree -->", "---", "type: memory  # Mémoire", "titre: \"Accès VM\"", "portee: global", "tags: [\"vm\"]",
    "modifie: 2026-11-06T10:00:00.000Z", "---", "", "Port 12222, clé seulement.", "",
    "<!-- harnais-md:entree -->", "---", "type: skill  # Skill Python", "titre: \"qcm\"", "portee: project", "tags: []", "---", "",
    "Questions à cocher.", "", "<!-- harnais-md:code -->", "## Code Python (`__init__.py`)", "", "```python", "def ecrire(t):", "    return t", "```", "",
  ].join("\n");
  const lu = md.lireHarnaisMarkdown(autre);
  assert.equal(lu.ok, true, lu.erreur);
  assert.deepEqual(lu.entrees.map((e) => [e.kind, e.title, e.scope]), [["memory", "Accès VM", "global"], ["skill", "qcm", "project"]]);
  assert.equal(lu.entrees[0].body, "Port 12222, clé seulement.");
  assert.equal(lu.entrees[1].code, "def ecrire(t):\n    return t\n");
  // et ce qu'écrit cette appli porte le même nom de format, sans nom de produit
  const ici = md.harnaisVersMarkdown([{ kind: "memory", scope: "global", title: "x", tags: [], body: "y" }], { version: "1", date: DATE });
  assert.match(ici, /^format: harnais-md\/1$/m);
  assert.doesNotMatch(ici, /axecode|savide/i);
});
