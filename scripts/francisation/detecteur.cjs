"use strict";
// Détecteur des textes visibles en anglais (francisation d'Axecode).
// Utilisé par scripts/francisation/inventaire.mjs et tests/francais.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const RACINE = process.env.FR_RACINE ? path.resolve(process.env.FR_RACINE) : path.resolve(__dirname, "../..");
const ZONES_TS = ["src", "web/src"];
const ZONE_RS = "src-tauri/src";

// Mots anglais absents du français (tirés du dictionnaire american-english moins french,
// limités au vocabulaire de l'appli) + faux amis employés ici dans leur sens anglais.
const MOTS = new Set(
  fs.readFileSync(path.join(__dirname, "mots-anglais.txt"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("#")).join(" ")
    .split(/\s+/).map((m) => m.trim().toLowerCase()).filter(Boolean),
);
const BLANCHE = JSON.parse(fs.readFileSync(path.join(__dirname, "liste-blanche.json"), "utf8"));

// Appels dont les arguments ne sont jamais affichés.
const APPELS_MUETS = new Set([
  "invoke", "listen", "emit", "once", "getItem", "setItem", "removeItem", "querySelector",
  "querySelectorAll", "closest", "matches", "addEventListener", "removeEventListener",
  "require", "import", "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "split",
  "replace", "replaceAll", "match", "matchAll", "test", "search", "createElement", "getAttribute",
  "setAttribute", "removeAttribute", "hasAttribute", "setProperty", "getPropertyValue", "add",
  "remove", "toggle", "contains", "has", "get", "delete", "Symbol", "RegExp", "URL",
  "getElementById", "dispatchEvent", "CustomEvent", "Event", "postMessage", "fetch", "join",
  "padStart", "padEnd", "lazy", "useCallback", "localeCompare", "toLocaleString",
  "toLocaleDateString", "toLocaleTimeString", "DateTimeFormat", "NumberFormat", "RelativeTimeFormat",
  "PluralRules", "Collator", "execCommand", "debug", "trace", "warnOnce", "mark", "measure",
  "invokeCmd", "invokeSafe", "convertFileSrc", "loader", "defineProperty", "loadLanguage",
]);
const CONSOLE = new Set(["log", "info", "warn", "error", "debug", "trace", "group", "groupCollapsed", "table", "time", "timeEnd"]);
// Attributs JSX jamais affichés.
const ATTRS_MUETS = /^(className|class|style|key|id|type|name|role|href|src|target|rel|htmlFor|value|defaultValue|lang|dir|accept|autoComplete|inputMode|method|action|form|ref|tabIndex|draggable|spellCheck|wrap|mode|variant|kind|size|icon|language|theme|path|width|height|viewBox|d|fill|stroke|xmlns|data-.*|on[A-Z].*)$/;

function estCode(s) {
  const t = s.trim();
  if (!t) return true;
  if (/^(https?|wss?|file|data|asset|tauri|blob|mailto):/i.test(t)) return true;
  if (!/\s/.test(t) && /[\/\\]/.test(t)) return true; // chemin
  if (!/\s/.test(t) && /^[a-z0-9_.:#@\-\[\]=\/%*]+$/.test(t)) return true; // identifiant, clé, classe
  if (!/\s/.test(t) && /^[A-Z0-9_]+$/.test(t) && t.length > 1 && /_/.test(t)) return true; // CONSTANTE
  if (/^[a-z0-9_\-:\[\]\/.%!#()&>,~+ ]+$/.test(t)) {
    // liste de classes CSS : la plupart des mots portent un tiret ou deux-points (flex items-center gap-2)
    const mots = t.split(/\s+/);
    if (mots.filter((m) => /[-:_]/.test(m)).length * 2 >= mots.length) return true;
  }
  if (/^(var|calc|rgba?|hsla?|url|translate|rotate|scale|linear-gradient)\(/.test(t)) return true;
  if (/^[@.#]?[\w\-]+\s*\{/.test(t)) return true; // CSS
  if (/^<\/?(path|svg|g|circle|rect|line|polyline|polygon|defs|use|style)\b/.test(t)) return true; // SVG
  if (/,\s*(monospace|sans-serif|serif|system-ui)\s*$/.test(t)) return true; // liste de polices
  if (/<\/?(html|head|meta|body|title|style|script|div|span|p|br)\b[^>]*>/i.test(t) && !/\s[a-z]{3,}\s[a-z]{3,}\s[a-z]{3,}/i.test(t.replace(/<[^>]*>/g, ""))) return true; // fragment HTML
  if (/^\d+(\.\d+)?(px|em|rem|%|ms|s|vh|vw|fr)?(\s+\d+(\.\d+)?(px|em|rem|%|ms|s|vh|vw|fr)?)*$/.test(t)) return true;
  return false;
}

// Retire ce qui est du code dans une phrase : `code`, fichiers et appels (memory.md, web.search),
// options (--daemon), VARIABLES_D_ENV, noms à chiffres (gpt-4o, whisper-1).
function nettoyer(s) {
  return s
    .replace(/`[^`]*`/g, " ")
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/\S*\w[._\/\\]\w\S*/g, " ")
    .replace(/\S+\/(?=\s|$)/g, " ")
    .replace(/(^|\s)--?[a-z][\w-]*/g, " ")
    .replace(/(^|\s)\/[a-z][\w-]*/g, " ")
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, " ")
    .replace(/\b[\w-]*\d[\w-]*\b/g, " ");
}

function motsAnglais(s) {
  const toks = nettoyer(s).match(/[A-Za-zÀ-ÖØ-öø-ÿŒœ][A-Za-zÀ-ÖØ-öø-ÿŒœ']*/g) || [];
  const out = [];
  for (const tok of toks) {
    if (/[^A-Za-z']/.test(tok)) continue; // mot accentué : français
    // découpe des identifiants camelCase : on ne compte pas les mots collés (onClick, setTab…)
    if (/[a-z][A-Z]/.test(tok)) continue;
    const m = tok.toLowerCase().replace(/'(s|t|re|ll|ve|d|m)$/, "");
    if (MOTS.has(m) || MOTS.has(tok.toLowerCase())) out.push(tok);
  }
  return out;
}

// Mots présents dans les deux langues (faux amis) : ne comptent pas seuls dans une phrase française.
const AMBIGUS = new Set(["active", "actives", "continue", "patch", "commit", "commits", "file", "files", "compact", "explorer", "queue", "stop", "pull", "input", "output", "single", "check", "live", "home", "goal", "record", "monitor", "sync", "round", "star", "look", "window", "banner"]);
const MARQUES_FR = /[àâäçéèêëîïôöùûüœ]|\b(le|la|les|un|une|des|du|de|et|en|au|aux|pour|par|sur|dans|avec|est|sont|pas|ne|ce|ces|cet|cette|il|elle|ils|elles|vous|nous|son|sa|ses|leur|leurs|qui|que|d'|l'|qu'|n')\b/i;
// Termes gardés en anglais DANS une phrase française (lexique : pull request, HEAD…) :
// retirés avant la recherche, le reste de la phrase est toujours contrôlé.
const TERMES = BLANCHE.filter((e) => e.terme).map((e) => ({ re: new RegExp(e.terme, "g"), fichier: e.fichier || "" }));
function sansTermes(s, rel) {
  let t = s;
  for (const { re, fichier } of TERMES) if (!fichier || rel === fichier || rel.startsWith(fichier)) t = t.replace(re, " ");
  return t;
}

function anglaisDe(texte, rel = "") {
  const mots = motsAnglais(sansTermes(texte, rel));
  if (mots.length && mots.every((m) => AMBIGUS.has(m.toLowerCase())) && MARQUES_FR.test(texte)) return [];
  return mots;
}

function enBlanche(rel, texte) {
  const t = texte.trim();
  for (const e of BLANCHE) {
    if (e.fichier && !(rel === e.fichier || rel.startsWith(e.fichier))) continue;
    if (e.texte !== undefined && e.texte === t) return e;
    if (e.motif !== undefined && new RegExp(e.motif).test(t)) return e;
  }
  return null;
}

function nomAppel(expr) {
  if (ts.isIdentifier(expr)) return { nom: expr.text, objet: "" };
  if (ts.isPropertyAccessExpression(expr)) {
    const objet = ts.isIdentifier(expr.expression) ? expr.expression.text
      : ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name.text : "";
    return { nom: expr.name.text, objet };
  }
  return { nom: "", objet: "" };
}

// Contexte muet ? (le texte n'est jamais montré à l'écran)
function contexteMuet(node) {
  let enfant = node;
  let p = node.parent;
  while (p) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode?.(p)) return "import";
    if (ts.isLiteralTypeNode(p) || ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return "type";
    if (ts.isCaseClause(p) && p.expression === enfant) return "case";
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
           ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
           ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword].includes(op)) return "comparaison";
    }
    if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration?.(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature?.(p)) && p.name === enfant) return "clé";
    if (ts.isElementAccessExpression(p) && p.argumentExpression === enfant) return "clé";
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const { nom, objet } = nomAppel(p.expression);
      if (objet === "console" && CONSOLE.has(nom)) return "console";
      if (APPELS_MUETS.has(nom) && p.expression !== enfant) return "appel:" + nom;
      return null; // autre appel : le texte peut être affiché
    }
    if (ts.isJsxAttribute(p)) {
      const n = p.name.getText();
      return ATTRS_MUETS.test(n) ? "attribut:" + n : null;
    }
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return null;
    if (ts.isTaggedTemplateExpression(p)) return "gabarit";
    if (ts.isEnumMember(p)) return null;
    if (ts.isVariableDeclaration(p) || ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isFunctionDeclaration(p)) return null;
    enfant = p;
    p = p.parent;
  }
  return null;
}

function texteGabarit(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  let s = node.head.text;
  for (const sp of node.templateSpans) s += "${}" + sp.literal.text;
  return s;
}

function analyserTs(rel, source) {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const trouves = [];
  const ajouter = (node, genre, texte) => {
    const t = texte.replace(/\s+/g, " ").trim();
    if (!t || !/[A-Za-z]/.test(t)) return;
    const mots = anglaisDe(t, rel);
    if (!mots.length) return;
    const ligne = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    trouves.push({ fichier: rel, ligne, genre, texte: t, mots, blanche: enBlanche(rel, t) });
  };
  const visiter = (node) => {
    if (ts.isJsxText(node)) {
      ajouter(node, "jsx", node.text);
    } else if (ts.isStringLiteral(node) && node.parent && ts.isExpressionStatement(node.parent)) {
      return; // directive ("use client")
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const texte = ts.isStringLiteral(node) ? node.text : texteGabarit(node);
      const muet = contexteMuet(node);
      const dansJsx = node.parent && (ts.isJsxAttribute(node.parent) || ts.isJsxExpression(node.parent));
      if (!muet && !estCode(texte)) {
        // un seul mot en minuscules hors JSX : identifiant (clé, état…) ; on ne le compte pas
        if (dansJsx || /\s/.test(texte.trim()) || /^[A-Z]/.test(texte.trim()) || /[…?!.:]$/.test(texte.trim())) ajouter(node, "chaîne", texte);
      }
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((sp) => visiter(sp.expression));
      return;
    }
    ts.forEachChild(node, visiter);
  };
  visiter(sf);
  return trouves;
}

// Rust : parcourt les lignes de code affichables (hors macros de journal et hors éléments
// #[cfg(test)] : module de tests, fonction ou import ; on suit la profondeur des accolades).
function parcourirRs(source, visite) {
  const lignes = source.split("\n");
  let profondeur = 0;
  let attente = false; // #[cfg(test)] vu, l'élément n'a pas encore commencé
  let sortie = null; // profondeur à retrouver pour quitter l'élément de test
  lignes.forEach((l, i) => {
    const nu = l.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, "");
    const ouvre = (nu.match(/\{/g) || []).length;
    const ferme = (nu.match(/\}/g) || []).length;
    const avant = profondeur;
    profondeur += ouvre - ferme;
    if (/#\[cfg\(test\)\]/.test(nu)) {
      const reste = nu.replace(/.*#\[cfg\(test\)\]/, "");
      if (!reste.trim() || /^\s*#\[/.test(reste)) attente = true;
      else if (ouvre > ferme) sortie = avant;
      return;
    }
    if (attente) {
      if (!nu.trim() || /^\s*#\[/.test(nu)) return;
      attente = false;
      if (ouvre === 0 && /;\s*$/.test(nu)) return; // use …; ou mod x; : une seule ligne
      if (ouvre === 0 || profondeur > avant) sortie = avant;
      return;
    }
    if (sortie !== null) {
      if (profondeur <= sortie && ferme > 0) sortie = null;
      return;
    }
    const code = l.replace(/^\s*\/\/.*$/, "");
    if (/\b(log::|tracing::|debug!|info!|warn!|error!|trace!|eprintln!|println!|eprint!|dbg!)/.test(code)) return;
    visite(code, i);
  });
}

// Rust : littéraux "…" des lignes affichables.
function analyserRs(rel, source) {
  const trouves = [];
  parcourirRs(source, (code, i) => {
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(code))) {
      const t = m[1].replace(/\\n/g, " ").replace(/\{[^}]*\}/g, "{}").trim();
      if (!t || estCode(t) || !/\s/.test(t) && !/^[A-Z]/.test(t)) continue;
      const mots = anglaisDe(t, rel);
      if (!mots.length) continue;
      trouves.push({ fichier: rel, ligne: i + 1, genre: "rust", texte: t, mots, blanche: enBlanche(rel, t) });
    }
  });
  return trouves;
}

function lister(dir, exts) {
  const out = [];
  const abs = path.join(RACINE, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...lister(rel, exts)); }
    else if (exts.some((x) => e.name.endsWith(x)) && !/(\.d\.ts|_tests?\.rs|\.test\.tsx?)$/.test(e.name) && e.name !== "tests.rs") out.push(rel);
  }
  return out;
}

function inventaire({ rust = true } = {}) {
  const res = [];
  for (const z of ZONES_TS) for (const f of lister(z, [".ts", ".tsx"])) res.push(...analyserTs(f, fs.readFileSync(path.join(RACINE, f), "utf8")));
  if (rust) for (const f of lister(ZONE_RS, [".rs"])) res.push(...analyserRs(f, fs.readFileSync(path.join(RACINE, f), "utf8")));
  return res;
}

module.exports = { inventaire, analyserTs, analyserRs, parcourirRs, lister, motsAnglais, anglaisDe, enBlanche, estCode, contexteMuet, MOTS, RACINE };
