"use strict";
// Typographie française des textes visibles (src/, web/src, src-tauri/src) :
// espace insécable (U+00A0) avant « : ; ? ! », avant « % » après un nombre et à l'intérieur des
// guillemets « », et « … » au lieu de « ... ».
//   node scripts/francisation/typographie.cjs             liste ce qui ne suit pas la règle
//   node scripts/francisation/typographie.cjs --corriger  corrige sur place (à relancer après une fusion)
//   node scripts/francisation/typographie.cjs --accents   mots sans accent (deja, reponse…) à relire
// Mêmes textes que l'inventaire : texte JSX, attributs et chaînes affichés, hors code (<code>, <pre>),
// hors textes gardés en anglais (liste blanche) et hors textes envoyés au modèle (EXCLUS).
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const d = require("./detecteur.cjs");

const NB = "\u00a0";
// Textes français envoyés au modèle : jamais retouchés.
const EXCLUS = [
  {
    fichier: "src/components/chat/arrierePlan.ts",
    motif: /^\(Le travail en cours continue en arrière-plan|^Tu continues en arrière-plan|^que l'utilisateur a libérée|^ce qui est fait|^ne le reprends pas ici/,
    raison: "consigne et note envoyées au modèle (session d'arrière-plan)",
  },
  { fichier: "src-tauri/src/voix.rs", motif: /Autres termes/, raison: "amorce envoyée au modèle de transcription" },
  {
    fichier: "src/components/Workspace.tsx",
    motif: /^\$\{\}\.\.\.$/,
    raison: "titre provisoire tronqué : même règle que le titre calculé par le moteur (store.rs écrit « ... »)",
  },
  { fichier: "web/src/api.ts", motif: /^\$\{\}\.\.\.$/, raison: "nom de session tronqué : même règle que l'IDE et le moteur (« ... »)" },
];
const ESPACE_AVANT = /(?<=[^\s\\])\u0020(?=[:;?!](?:$|[\s"'`»)\]\\]))/g;
const ESPACE_POURCENT = /(?<=\d)\u0020(?=%)/g;
const GUILLEMET_OUVRANT = /«\u0020/g;
const GUILLEMET_FERMANT = /\u0020»/g;
const TROIS_POINTS = /(?<=[A-Za-zÀ-ÖØ-öø-ÿ0-9])\.\.\.(?=$|[\s"'`»)\]\\])/g;
const BALISES_CODE = /^(code|pre|kbd|samp)$/;

function corriger(brut, apresExpression) {
  const s = (apresExpression ? "0" : "") + brut; // « 0 » : la valeur de l'expression qui précède
  const t = s
    .replace(ESPACE_AVANT, NB)
    .replace(ESPACE_POURCENT, NB)
    .replace(GUILLEMET_OUVRANT, "«" + NB)
    .replace(GUILLEMET_FERMANT, NB + "»")
    .replace(TROIS_POINTS, "…");
  return apresExpression ? t.slice(1) : t;
}

function texteAffiche(rel, texte) {
  const t = texte.replace(/\s+/g, " ").trim();
  if (!t || d.estCode(t) || d.enBlanche(rel, t)) return false;
  if (EXCLUS.some((e) => rel === e.fichier && e.motif.test(t))) return false;
  return d.anglaisDe(t, rel).length === 0; // anglais restant : géré par l'inventaire
}

function partiesTs(rel, source) {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const parties = [];
  const dansCode = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && BALISES_CODE.test(p.openingElement.tagName.getText(sf))) return true;
    }
    return false;
  };
  const ajouter = (debut, fin, apresExpression) => parties.push({ debut, fin, apresExpression });
  const visiter = (node) => {
    if (ts.isJsxText(node)) {
      if (!dansCode(node) && texteAffiche(rel, node.text)) ajouter(node.pos, node.end, true);
      return;
    }
    if (ts.isStringLiteral(node) && node.parent && ts.isExpressionStatement(node.parent)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!d.contexteMuet(node) && !dansCode(node) && texteAffiche(rel, node.text)) {
        ajouter(node.getStart(sf) + 1, node.getEnd() - 1, false);
      }
      return;
    }
    if (ts.isTemplateExpression(node)) {
      let cuit = node.head.text;
      for (const sp of node.templateSpans) cuit += "${}" + sp.literal.text;
      if (!d.contexteMuet(node) && !dansCode(node) && texteAffiche(rel, cuit)) {
        ajouter(node.head.getStart(sf) + 1, node.head.getEnd() - 2, false);
        for (const sp of node.templateSpans) {
          const lit = sp.literal;
          ajouter(lit.getStart(sf) + 1, lit.getEnd() - (ts.isTemplateTail(lit) ? 1 : 2), true);
        }
      }
      node.templateSpans.forEach((sp) => visiter(sp.expression));
      return;
    }
    ts.forEachChild(node, visiter);
  };
  visiter(sf);
  return parties;
}

function partiesRs(rel, source) {
  const parties = [];
  const debuts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") debuts.push(i + 1);
  d.parcourirRs(source, (code, i) => {
    const re = /(?<![r#\w])"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(code))) {
      const t = m[1].replace(/\\n/g, " ").replace(/\{[^}]*\}/g, "{}");
      if (!/\s/.test(t.trim()) || !texteAffiche(rel, t)) continue;
      const debut = debuts[i] + m.index + 1;
      parties.push({ debut, fin: debut + m[1].length, apresExpression: false });
    }
  });
  return parties;
}

function toutesParties() {
  const fichiers = [...d.lister("src", [".ts", ".tsx"]), ...d.lister("web/src", [".ts", ".tsx"]), ...d.lister("src-tauri/src", [".rs"])];
  return fichiers.map((rel) => {
    const abs = path.join(d.RACINE, rel);
    const source = fs.readFileSync(abs, "utf8");
    return { rel, abs, source, parties: rel.endsWith(".rs") ? partiesRs(rel, source) : partiesTs(rel, source) };
  });
}

function examiner({ corrigerSurPlace = false } = {}) {
  const fautes = [];
  for (const { rel, abs, source, parties } of toutesParties()) {
    const changements = [];
    for (const p of parties) {
      const brut = source.slice(p.debut, p.fin);
      const net = corriger(brut, p.apresExpression);
      if (net === brut) continue;
      fautes.push({ fichier: rel, ligne: source.slice(0, p.debut).split("\n").length, avant: brut, apres: net });
      changements.push({ ...p, net });
    }
    if (corrigerSurPlace && changements.length) {
      let s = source;
      for (const c of changements.sort((a, b) => b.debut - a.debut)) s = s.slice(0, c.debut) + c.net + s.slice(c.fin);
      fs.writeFileSync(abs, s);
    }
  }
  return fautes;
}

const sansAccents = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Mots écrits sans accent alors que le dictionnaire ne les connaît qu'accentués (deja → déjà). */
function accents(dictionnaire = "/usr/share/dict/french") {
  if (!fs.existsSync(dictionnaire)) return null;
  const dico = new Set();
  const formes = new Map();
  for (const l of fs.readFileSync(dictionnaire, "utf8").split("\n")) {
    const w = l.trim().toLowerCase();
    if (!w) continue;
    dico.add(w);
    const n = sansAccents(w);
    if (n !== w && !formes.has(n)) formes.set(n, w);
  }
  const res = [];
  const vus = new Set();
  for (const { rel, source, parties } of toutesParties()) {
    for (const p of parties) {
      const brut = source.slice(p.debut, p.fin);
      for (const tok of brut.match(/[A-Za-zÀ-ÖØ-öø-ÿŒœ]+/g) || []) {
        if (/[^A-Za-z]/.test(tok) || tok.length < 3) continue;
        const m = tok.toLowerCase();
        const juste = formes.get(m);
        if (dico.has(m) || !juste) continue;
        const ligne = source.slice(0, p.debut).split("\n").length;
        const cle = `${rel}:${ligne}:${m}`;
        if (vus.has(cle)) continue;
        vus.add(cle);
        res.push({ fichier: rel, ligne, mot: tok, juste });
      }
    }
  }
  return res;
}

module.exports = { examiner, corriger, accents, EXCLUS };

if (require.main === module) {
  if (process.argv.includes("--accents")) {
    const r = accents();
    if (!r) {
      console.log("dictionnaire /usr/share/dict/french absent");
    } else {
      for (const x of r) console.log(`${x.fichier}:${x.ligne}  ${x.mot} → ${x.juste}`);
      console.log(`${r.length} mot(s) sans accent à relire`);
    }
  } else {
    const corrigerSurPlace = process.argv.includes("--corriger");
    const fautes = examiner({ corrigerSurPlace });
    const voir = (s) => s.replace(/\u00a0/g, "⍽").replace(/\s+/g, " ").trim().slice(0, 150);
    for (const f of fautes) console.log(`${f.fichier}:${f.ligne}  ${voir(f.avant)}  →  ${voir(f.apres)}`);
    console.log(`${fautes.length} texte(s) ${corrigerSurPlace ? "corrigé(s)" : "à corriger"} (espace insécable avant : ; ? ! %, guillemets « », « … »)`);
  }
}
