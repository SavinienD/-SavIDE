const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  m._compile(js, p);
  return m.exports;
}
const A = charger("../src/components/chat/arrierePlan.ts");
const F = charger("../src/components/chat/fileAttente.ts");

// Faux démon : la conversation tourne encore `toursAvantArret` lectures après Stop.
function demon({ toursAvantArret = 2, forkEchoue = false } = {}) {
  const appels = [];
  let lectures = 0;
  let arrete = false;
  return {
    appels,
    services: {
      arreter: async (id) => {
        appels.push(["stop", id]);
        arrete = true;
      },
      statut: async (id) => {
        appels.push(["statut", id]);
        if (!arrete) return "running";
        lectures += 1;
        return lectures > toursAvantArret ? "idle" : "running";
      },
      forker: async (id, nom, parentId) => {
        appels.push(["fork", id, nom, parentId]);
        if (forkEchoue) throw new Error("fork refusé");
        return { id: "clone-1", name: nom };
      },
      envoyer: async (id, texte) => {
        appels.push(["send", id, texte]);
      },
      attendre: async (ms) => {
        appels.push(["attente", ms]);
      },
    },
  };
}

test("stop, attente de la fin du tour, fork enfant de la conversation, consigne au clone", async () => {
  const d = demon({ toursAvantArret: 2 });
  const r = await A.mettreEnArrierePlan(d.services, { id: "conv", titre: "Migration FIC" }, { pasMs: 250 });
  assert.deepEqual(r, { id: "clone-1", nom: "Migration FIC — arrière-plan" });
  const ordre = d.appels.map((a) => a[0]);
  assert.deepEqual(ordre, ["stop", "statut", "attente", "statut", "attente", "statut", "fork", "send"]);
  assert.deepEqual(d.appels[6], ["fork", "conv", "Migration FIC — arrière-plan", "conv"]);
  const [, cible, consigne] = d.appels[7];
  assert.equal(cible, "clone-1");
  assert.match(consigne, /^Tu continues en arrière-plan la tâche de la conversation « Migration FIC », que l'utilisateur a libérée\./);
  assert.match(consigne, /Reprends exactement où le travail s'est arrêté, sans refaire ce qui est fait\./);
  assert.match(consigne, /messages\.send\(…, receiver_role='parent'\)\.$/);
});

test("le tour ne s'arrête pas : erreur, ni fork ni envoi", async () => {
  const d = demon({ toursAvantArret: 1000 });
  await assert.rejects(
    A.mettreEnArrierePlan(d.services, { id: "conv", titre: "x" }, { attenteMaxMs: 1000, pasMs: 250 }),
    /ne s'est pas arrêté/,
  );
  assert.ok(!d.appels.some((a) => a[0] === "fork" || a[0] === "send"));
});

test("échec du fork : l'erreur remonte, rien n'est envoyé", async () => {
  const d = demon({ toursAvantArret: 0, forkEchoue: true });
  await assert.rejects(A.mettreEnArrierePlan(d.services, { id: "conv", titre: "x" }), /fork refusé/);
  assert.ok(!d.appels.some((a) => a[0] === "send"));
});

test("titres : vide, espaces ; note devant le message", () => {
  assert.equal(A.nomArrierePlan(""), "Conversation — arrière-plan");
  assert.equal(A.nomArrierePlan("  Devis   B BATI "), "Devis B BATI — arrière-plan");
  const note = A.noteConversation("Devis — arrière-plan");
  assert.equal(note, "(Le travail en cours continue en arrière-plan dans « Devis — arrière-plan » : ne le reprends pas ici.)");
  assert.equal(A.avecNote(note, "Et le planning ?"), `${note}\n\nEt le planning ?`);
  assert.equal(A.avecNote(null, "Et le planning ?"), "Et le planning ?");
});

test("conversation occupée pendant l'opération, puis le premier message part avec la note", async () => {
  const s = new Map();
  const stockage = {
    get length() { return s.size; },
    key: (i) => Array.from(s.keys())[i] ?? null,
    getItem: (k) => (s.has(k) ? s.get(k) : null),
    setItem: (k, v) => void s.set(k, String(v)),
    removeItem: (k) => void s.delete(k),
  };
  const m = new F.MagasinFiles(stockage);
  const msg = (id) => ({ id, text: `texte ${id}`, attachments: [] });
  m.modifierFile("conv", () => [msg("q1"), msg("q2")]);
  const libre = { occupe: false, sousAgent: false, edition: false };
  m.occuper("conv");
  // Le Stop rend la conversation libre côté interface : rien ne part encore.
  assert.equal(m.prochain("conv", libre), null);
  const d = demon({ toursAvantArret: 0 });
  const r = await A.mettreEnArrierePlan(d.services, { id: "conv", titre: "Tâche" });
  m.poserNote("conv", A.noteConversation(r.nom));
  m.liberer("conv");
  const premier = m.prochain("conv", libre);
  assert.equal(premier.id, "q1");
  assert.equal(m.prendreEnvoi("conv", premier.id), true);
  const texte = A.avecNote(m.prendreNote("conv"), premier.text);
  assert.equal(texte, "(Le travail en cours continue en arrière-plan dans « Tâche — arrière-plan » : ne le reprends pas ici.)\n\ntexte q1");
  // La note ne part qu'une fois.
  assert.equal(m.prendreNote("conv"), null);
  // Gardée au redémarrage tant qu'elle n'est pas partie.
  m.poserNote("conv", "note");
  assert.equal(new F.MagasinFiles(stockage).note("conv"), "note");
  m.prendreNote("conv");
  assert.equal(new F.MagasinFiles(stockage).note("conv"), null);
});
