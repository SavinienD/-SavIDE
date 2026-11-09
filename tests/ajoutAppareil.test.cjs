const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

// Réglages > Appareils : commande à lancer sur la machine à ajouter et lecture de sa réponse.
Module._extensions[".ts"] = (module, filename) => {
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(javascript, filename);
};
const racine = path.resolve(__dirname, "..");
const { commandeAppareil, lireReponse, clePublique, obstacles, DEBUT, FIN } = require(path.join(racine, "src/components/settings/ajoutAppareilOutils.ts"));

const EMP = "SHA256:cI77mtv+nEz46KX6ka3ThiYTe5aI00jUqNykzhcwdSQ";
const FICHE = { v: 1, nom: "atelier", os: "Debian 13", utilisateur: "savinien", ips: ["192.168.1.30", "fe80::1", "pas-une-ip"], port: 2222,
  empreintes: [{ type: "ED25519", sha256: EMP }, { type: "RSA", sha256: "abc" }], ssh: true, axecode: "/usr/bin/axecode", cle: "oui", cleMessage: "" };
const bloc = (o, b64 = Buffer.from(JSON.stringify(o)).toString("base64")) => `${DEBUT}\n${b64}\n${FIN}\n`;
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIChbUXxQLAanJKOMMQjQUFddSlzH+1Iy6YJM/xB2bDQM";

test("bloc base64 complet : fiche lue et nettoyée", () => {
  const r = lireReponse(bloc(FICHE));
  assert.equal(r.ok, true);
  assert.deepEqual(r.fiche.ips, ["192.168.1.30", "fe80::1"]);
  assert.deepEqual(r.fiche.empreintes, [{ type: "ED25519", sha256: EMP }]);
  assert.equal(r.fiche.port, 2222);
  assert.equal(r.fiche.cle, "oui");
  assert.equal(r.fiche.axecode, "/usr/bin/axecode");
  assert.equal("cleMessage" in r.fiche, false);
});

test("bloc coupé en lignes, avec retrait, BOM, CRLF et texte autour", () => {
  const b64 = Buffer.from(JSON.stringify({ ...FICHE, nom: "Poste été" })).toString("base64");
  const morceaux = b64.match(/.{1,40}/g).join("\r\n   ");
  const r = lireReponse(`\uFEFFPS C:\\> commande\r\nClé ajoutée\r\n${DEBUT}\r\n   ${morceaux}\r\n${FIN}\r\nPS C:\\>`);
  assert.equal(r.ok, true);
  assert.equal(r.fiche.nom, "Poste été");
});

test("JSON seul ou entre les repères", () => {
  assert.equal(lireReponse(JSON.stringify(FICHE)).ok, true);
  assert.equal(lireReponse(`${DEBUT}${JSON.stringify(FICHE)}${FIN}`).ok, true);
});

test("une seule adresse ou une seule empreinte (sans tableau)", () => {
  const r = lireReponse(bloc({ ...FICHE, ips: "10.0.0.2", empreintes: { type: "ED25519", sha256: EMP } }));
  assert.deepEqual(r.fiche.ips, ["10.0.0.2"]);
  assert.equal(r.fiche.empreintes.length, 1);
});

test("erreurs claires", () => {
  const err = (t) => { const r = lireReponse(t); assert.equal(r.ok, false); return r.erreur; };
  assert.match(err(""), /Colle le bloc/);
  assert.match(err("bonjour"), /pas la réponse/);
  assert.match(err(`${DEBUT}\nabcd`), /incomplet.*FIN/);
  assert.match(err(`abcd\n${FIN}`), /incomplet.*DEBUT/);
  assert.match(err(`${DEBUT}\n${FIN}`), /vide/);
  assert.match(err(`${DEBUT}\n@@@\n${FIN}`), /abîmé/);
  assert.match(err(bloc(FICHE, Buffer.from(JSON.stringify(FICHE)).toString("base64").slice(0, 50))), /abîmé/);
  assert.match(err(bloc({ ...FICHE, v: 2 })), /autre version/);
  assert.match(err(bloc({ ...FICHE, utilisateur: " " })), /compte/);
  assert.match(err(bloc({ ...FICHE, port: 70000 })), /Port/);
  assert.match(err(bloc([1, 2])), /abîmé/);
});

test("clé publique : commentaire nettoyé, texte dangereux refusé", () => {
  assert.equal(clePublique(`${KEY} moi@pc\n`), `${KEY} moi@pc`);
  assert.equal(clePublique(`${KEY} a'b; rm -rf ~`), `${KEY} abrm-rf`);
  assert.equal(clePublique(`ssh-ed25519 AAAA'$(id)`), null);
  assert.equal(clePublique("-----BEGIN OPENSSH PRIVATE KEY-----"), null);
  assert.equal(clePublique(null), null);
});

test("commandes : une ligne, repères, clé seulement si demandée", () => {
  for (const s of ["linux", "macos", "windows"]) {
    const avec = commandeAppareil(s, `${KEY} moi@pc`);
    const sans = commandeAppareil(s, null);
    assert.equal(/[\r\n]/.test(avec), false, s);
    assert.ok(avec.includes(DEBUT) && avec.includes(FIN), s);
    assert.ok(avec.includes(KEY), s);
    assert.equal(sans.includes("ssh-ed25519"), false, s);
    assert.equal(sans.includes("authorized_keys"), false, s);
  }
  assert.match(commandeAppareil("windows", KEY), /administrators_authorized_keys/);
});

test("obstacles signalés", () => {
  const f = lireReponse(bloc({ ...FICHE, ssh: false, ips: [], empreintes: [], axecode: null, cle: "echec", cleMessage: "Accès refusé" })).fiche;
  const o = obstacles(f, true).join(" | ");
  assert.match(o, /n'écoute pas sur le port 2222/);
  assert.match(o, /Aucune adresse/);
  assert.match(o, /Aucune clé d'hôte/);
  assert.match(o, /SavIDE n'est pas installé/);
  assert.match(o, /Accès refusé/);
  assert.deepEqual(obstacles(lireReponse(bloc(FICHE)).fiche, true), []);
});

test("commande Linux lancée pour de vrai (sh, HOME temporaire)", { skip: process.platform !== "linux" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "axe-appareil-"));
  try {
    const cmd = commandeAppareil("linux", `${KEY} test@pc`);
    const run = () => execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const r = lireReponse(run());
    assert.equal(r.ok, true, r.erreur);
    assert.equal(r.fiche.utilisateur, os.userInfo().username);
    assert.equal(r.fiche.cle, "oui");
    run();
    const autorisees = fs.readFileSync(path.join(home, ".ssh/authorized_keys"), "utf8");
    assert.equal(autorisees, `${KEY} test@pc\n`);
    assert.equal(fs.statSync(path.join(home, ".ssh/authorized_keys")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
