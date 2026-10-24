#!/usr/bin/env node
// Banc d'essai de l'affichage d'Axecode — UNE commande, sans intervention :
//   node scripts/audit-affichage/lancer.mjs            audit complet (captures PNG + rapport JSON)
//   node scripts/audit-affichage/lancer.mjs --strict   test de regression : echoue au premier defaut
// Options : --situations 800x600,1366x768  --echelles 1,1.25  --texte 1,1.1,1.1/1.3 (« a/b » : texte x a et libellés x b)  --scenes c1,c3
//           --sans-build  --travailleurs 3  --sortie <dossier>
//           --source <révision git> : rendre l'interface de cette version (ex. c066912 = 0.1.56)
//           --zones <fichier.json> : rectangles d'éléments à noter dans le rapport (planche)
// Sortie (ignoree par git) : sortie/rapport.json, sortie/captures/<situation>/<scene>.png
// (+ <scene>.annote.png quand il y a des defauts : cadres rouges numerotes).
import { build } from "vite";
import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { trouverNavigateur } from "./navigateur.mjs";
import { emulerWindows } from "./windows.mjs";
import { SCENES } from "./scenes.mjs";
import { WS_BANC } from "./constantes.mjs";

const ici = dirname(fileURLToPath(import.meta.url));
const debut = Date.now();
// Paquets du banc (navigateur de test, polices de l'appli) : installes au premier lancement.
if (!existsSync(join(ici, "node_modules", "puppeteer-core"))) {
  console.log("Installation des paquets du banc (npm ci)…");
  execSync("npm ci --no-audit --no-fund", { cwd: ici, stdio: "inherit" });
}
const { default: puppeteer } = await import("puppeteer-core");
const argv = process.argv.slice(2);
const opt = (nom, defaut) => {
  const i = argv.indexOf(`--${nom}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : defaut;
};
const drapeau = (nom) => argv.includes(`--${nom}`);
const STRICT = drapeau("strict");

const SORTIE = resolve(opt("sortie", join(ici, "sortie")));
// --source <révision> : interface d'une AUTRE version, extraite de git dans
// sortie/source-<rév>/ (avec un lien vers node_modules), sans toucher au dépôt ni
// aux autres worktrees. Sert à la planche avant / après (planche.mjs).
const racine = resolve(ici, "../..");
const SOURCE = opt("source", "");
let BUILD = join(ici, "sortie", "build");
let REVISION;
if (SOURCE) {
  const rev = execSync(`git rev-parse --short "${SOURCE}^{commit}"`, { cwd: racine }).toString().trim();
  const dossier = join(ici, "sortie", `source-${rev}`);
  const lien = join(dossier, "node_modules");
  if (!existsSync(join(dossier, "src", "main.tsx"))) {
    try { if (lstatSync(lien).isSymbolicLink()) unlinkSync(lien); } catch { /* absent */ }
    rmSync(dossier, { recursive: true, force: true });
    mkdirSync(dossier, { recursive: true });
    execSync(`git archive "${rev}" src tsconfig.json tsconfig.node.json | tar -x -C "${dossier}"`, { cwd: racine, shell: "/bin/bash" });
  }
  try { lstatSync(lien); } catch { symlinkSync(join(racine, "node_modules"), lien); }
  process.env.AXECODE_AUDIT_SOURCE = dossier;
  BUILD = join(ici, "sortie", `build-${rev}`);
  REVISION = rev;
  console.log(`Interface rendue : révision ${rev}`);
} else {
  const tete = execSync("git rev-parse --short HEAD", { cwd: racine }).toString().trim();
  const sale = execSync("git status --porcelain -- src scripts/audit-affichage", { cwd: racine }).toString().trim() !== "";
  REVISION = sale ? `${tete} + modifications non commitées` : tete;
}
process.env.AXECODE_AUDIT_BUILD = BUILD;
const TAILLES = opt("situations", "800x600,1024x768,1366x768,1920x1080").split(",").map((t) => t.split("x").map(Number));
const ECHELLES = opt("echelles", "1,1.25,1.5").split(",").map(Number);
// Taille du texte (x 1,1 : polices de Windows plus larges) et longueur des libellés
// (x 1,3 : marge pour la traduction française, environ 30 % plus longue).
const TEXTES = opt("texte", "1,1.1,1.1/1.3").split(",").map((v) => {
  const [t, lib] = v.split("/").map(Number);
  return { t: t || 1, l: lib || 1 };
});
const FILTRE_SCENES = opt("scenes", "") ? opt("scenes", "").split(",") : null;
const CONTOUR = opt("contour", "");
// --zones <fichier.json> : { "<scène>": { "<nom>": ["sélecteur CSS", …] } } — le rapport
// donne, pour chaque rendu, le rectangle (dans la fenêtre) qui englobe ces éléments.
const ZONES = opt("zones", "") ? JSON.parse(readFileSync(opt("zones", ""), "utf8")) : {};
const TRAVAILLEURS = Number(opt("travailleurs", "3"));
const EXCEPTIONS = JSON.parse(readFileSync(join(ici, "exceptions.json"), "utf8")).exceptions;
const CONTROLES = readFileSync(join(ici, "controles.js"), "utf8");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Construire la vraie interface avec l'entree du banc.
if (!drapeau("sans-build") || !existsSync(join(BUILD, "scripts/audit-affichage/banc.html"))) {
  process.stdout.write("Construction de l'interface (vite build)… ");
  const t = Date.now();
  await build({ configFile: join(ici, "vite.config.mjs"), logLevel: "error" });
  console.log(`${Math.round((Date.now() - t) / 1000)} s`);
}

// 2. Serveur statique local.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf" };
const serveur = http.createServer((req, res) => {
  const chemin = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const fichier = join(BUILD, chemin);
  if (!fichier.startsWith(BUILD) || !existsSync(fichier) || statSync(fichier).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(fichier)] ?? "application/octet-stream" });
  res.end(readFileSync(fichier));
});
await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${serveur.address().port}/scripts/audit-affichage/banc.html`;

// 3. Navigateur Chromium sans ecran (WebView2 est un Chromium).
const navigateur = await puppeteer.launch({
  executablePath: await trouverNavigateur(),
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: ["--no-sandbox", "--font-render-hinting=none", "--disable-gpu", "--lang=fr-FR"],
});

// Une situation = taille de fenetre x mise a l'echelle Windows x taille du texte.
const idSituation = (l, h, e, tx) =>
  `${l}x${h}@${Math.round(e * 100)}%` +
  (tx.t !== 1 ? `+texte${Math.round((tx.t - 1) * 100)}%` : "") +
  (tx.l !== 1 ? `+libelles${Math.round((tx.l - 1) * 100)}%` : "");
const situations = [];
for (const [l, h] of TAILLES) for (const e of ECHELLES) for (const tx of TEXTES) {
  situations.push({ id: idSituation(l, h, e, tx), largeur: l, hauteur: h, echelle: e, texte: tx.t, libelles: tx.l });
}
const scenes = SCENES.filter((s) => !FILTRE_SCENES || FILTRE_SCENES.includes(s.id));
// Un travail = une scene chargee une fois par taille de fenetre ; les mises a
// l'echelle et le texte agrandi sont ensuite appliques sur la page deja ouverte.
const travaux = [];
for (const [l, h] of TAILLES) for (const sc of scenes) travaux.push({ l, h, sc });
mkdirSync(join(SORTIE, "captures"), { recursive: true });

const ANTI_ANIMATION = `*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0.001s!important;animation-delay:0s!important;animation-iteration-count:1!important;caret-color:transparent!important}`;

async function attendre(page, sel, delai = 8000) {
  await page.waitForSelector(sel, { timeout: delai, visible: true });
}

async function glisser(page, el, dx) {
  const b = await el.boundingBox();
  if (!b) return false;
  const x = b.x + b.width / 2, y = b.y + Math.min(b.height / 2, 200);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(x + (dx * i) / 8, y);
  await page.mouse.up();
  return true;
}

// Clic sur l'élément dont le texte (ou le title) est exactement `texte` : gestes du collègue
// (« Racine de l'espace », titre d'une conversation, ligne de la liste des modèles).
async function cliquerTexte(page, selecteur, texte) {
  return page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((x) => (x.textContent || "").trim() === t || (x.getAttribute("title") || "") === t);
    if (!el) return false;
    el.click();
    return true;
  }, selecteur, texte);
}

async function preparerScene(page, si, sc) {
  const scene = {
    ...sc.sim,
    stockage: sc.stockage ? sc.stockage(si.largeur, si.hauteur) : {},
  };
  await page.setViewport({ width: si.largeur, height: si.hauteur, deviceScaleFactor: si.echelle });
  await page.goto(`${BASE}?s=${encodeURIComponent(JSON.stringify(scene))}`, { waitUntil: "load" });
  await page.addStyleTag({ content: ANTI_ANIMATION });
  await attendre(page, ".welcome");
  if (sc.espace === false) {
    await pause(500);
    return;
  }
  if (sc.espaceCloud) {
    // Accueil > « Dossier du cloud partagé » > « Racine de l'espace » (espace Axe Cloud).
    await page.waitForFunction(() => [...document.querySelectorAll("button.axc-btn")].some((b) => b.textContent.trim() === "Racine de l'espace"), { timeout: 8000 });
    await cliquerTexte(page, "button.axc-btn", "Racine de l'espace");
  } else if (sc.libre) {
    // Accueil > « Conversation sans dossier » (vue « chat », sans éditeur).
    await page.evaluate(() => document.querySelector("button.welcome__cta:last-of-type")?.click());
  } else {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button.welcome__recent")].find((x) => x.textContent.includes("axecode"));
      b?.click();
    });
  }
  await attendre(page, ".workspace .composer", 10000);
  if (sc.creer) {
    // « + » de la barre latérale, nom, Entrée (comme un collègue pour « test »).
    await page.click("button.sidebar__head-btn[title='Nouvelle conversation']");
    await attendre(page, ".conv-create__input", 4000);
    await page.type(".conv-create__input", sc.creer);
    await page.keyboard.press("Enter");
    await pause(800);
  }
  // Ouvrir une conversation de la liste par son titre (« conversation » : identifiant des événements).
  if (sc.ouvrir) {
    await page.waitForFunction((t) => [...document.querySelectorAll(".conv-row__title")].some((e) => e.textContent.trim() === t), { timeout: 8000 }, sc.ouvrir);
    await cliquerTexte(page, ".conv-row__title", sc.ouvrir);
    await pause(500);
  }
  // La copie des conversations vers la VM vient d'etre faite (indicateur « VM ✓ » de la barre).
  await page.evaluate(() => window.__bancEmettre?.("axe://mirror-status", { ok: true, atMs: Date.now() }));
  // Gestes repérés par sélecteur, événement ou raccourci de l'appli, jamais par le
  // texte d'un libellé (les libellés sont traduits).
  if (sc.terminal) {
    // Événement de l'appli (Workspace : TERMINAL_OPEN_EVENT).
    await page.evaluate(() => window.__bancEmettre?.("terminal-open-requested", null));
    await page.waitForSelector(".terminal-shell .terminal-tabs", { visible: true, timeout: 5000 }).catch(() => undefined);
    await pause(300);
  }
  if (sc.redimTerminal) {
    // Redimensionnement du volet après ouverture du terminal : l'hôte de xterm change
    // de hauteur (comme en tirant le bord du volet) ; xterm doit se réajuster.
    await page.evaluate((d) => {
      for (const x of document.querySelectorAll(".xterm")) {
        const hote = x.parentElement;
        hote.style.flex = `0 0 ${Math.max(60, hote.getBoundingClientRect().height - d)}px`;
      }
    }, sc.redimTerminal);
    await pause(400);
  }
  if (sc.elargirChat) {
    const gouttieres = await page.$$(".main > .gutter");
    if (gouttieres.length) await glisser(page, gouttieres[gouttieres.length - 1], -2000);
  }
  if (sc.reduireColonne) {
    const g = await page.$(".colonnes-chat > .gutter");
    if (g) await glisser(page, g, -2000);
  }
  if (sc.reduireVolets) {
    await page.keyboard.down("Control"); await page.keyboard.press("KeyB"); await page.keyboard.up("Control");
    await pause(300);
    await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("KeyB");
    await page.keyboard.up("Alt"); await page.keyboard.up("Control");
    await pause(300);
  }
  delete sc._echecPoignee;
  if (sc.glisserPoigneeColonnes) {
    const largeurs = () => page.evaluate(() => [...document.querySelectorAll(".colonnes-chat > .colonne-chat")].map((e) => Math.round(e.getBoundingClientRect().width)));
    const avant = await largeurs();
    const g = await page.$(".colonnes-chat > .gutter");
    if (g) await glisser(page, g, sc.glisserPoigneeColonnes);
    await pause(300);
    const apres = await largeurs();
    sc._mesure = { avant, apres };
    console.log(`poignée colonnes ${sc.id} : ${avant.join("/")} -> ${apres.join("/")}`);
    if (!g || avant.length < 2 || Math.abs((apres[0] ?? 0) - (avant[0] ?? 0)) < 20) sc._echecPoignee = `largeurs inchangées ${avant.join("/")} -> ${apres.join("/")}`;
  }
  if (sc.sansFournisseur) {
    await page.waitForSelector(".composer__connect-cta", { visible: true, timeout: 8000 }).catch(() => undefined);
  }
  // Scène « collegue-modele » : un autre modèle choisi dans la liste « Modèle » du compositeur.
  if (sc.choisirModele) {
    await page.click(".composer__picker[data-kind=model] .composer__picker-btn").catch(() => undefined);
    await pause(300);
    await cliquerTexte(page, ".composer__picker[data-kind=model] .composer__popover .composer__popover-row", sc.choisirModele);
    await pause(900);
  }
  // Scène « collegue » : clic sur le bouton de connexion (.composer__connect-cta, s'il est là), message écrit
  // puis envoyé, tour simulé : charges complètes (espace Axe Cloud) dans « evenementsTour ».
  if (sc.clicConnecter) {
    await page.evaluate(() => document.querySelector(".composer__connect-cta")?.click());
    await pause(600);
  }
  if (sc.ecrire) {
    await page.click(".composer textarea").catch(() => undefined);
    await page.keyboard.type(sc.ecrire);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".composer button.composer__send")].find((x) => !x.dataset.variant);
      if (b && !b.disabled) b.click();
    });
    await pause(600);
  }
  for (const ev of sc.evenementsTour ?? []) {
    await page.evaluate((e) => window.__bancEmettre?.("agent-event", e), ev);
    await pause(150);
  }
  if (sc.arbre) {
    await page.click(".composer button[aria-label='Session tree'], .composer button[aria-label='Arbre de la session']").catch(() => undefined);
    await pause(800);
  }
  if (sc.agents) await page.evaluate(() => window.dispatchEvent(new CustomEvent("axe:open-agents")));
  if (sc.reglages) {
    // Raccourci de l'appli : Ctrl + , (axe/raccourcis.ts).
    await page.keyboard.down("Control");
    await page.keyboard.press("Comma");
    await page.keyboard.up("Control");
    await page.waitForSelector(".settings-pane", { visible: true, timeout: 5000 }).catch(() => undefined);
  }
  // Clics successifs par sélecteur (attend que chacun soit visible), ex. Réglages > MCP > Supprimer.
  for (const sel of sc.clics ?? []) {
    await page.waitForSelector(sel, { visible: true, timeout: 5000 }).catch(() => undefined);
    await page.evaluate((s) => document.querySelector(s)?.click(), sel);
    await pause(400);
  }
  if (sc.arretForce) {
    const stop = "[data-focus=true] .composer__send[data-variant='stop']";
    await page.waitForSelector(stop, { visible: true, timeout: 6000 }).catch(() => undefined);
    await page.evaluate((s) => document.querySelector(s)?.click(), stop);
    await page.waitForSelector(".composer__send[data-variant='stop'][data-force='true']", { timeout: 6000 }).catch(() => undefined);
  }
  if (sc.evenements) {
    // Événements du moteur rejoués tels quels (« agent-event »), dans l'ordre.
    for (const event of sc.evenements) {
      await page.evaluate((charge) => window.__bancEmettre?.("agent-event", charge), { conversationId: sc.conversation ?? "c-001", workspaceId: WS_BANC, event });
      await pause(150);
    }
  }
  await pause(900);
}

async function stabiliser(page) {
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('400 13px "Geist"'), document.fonts.load('400 12px "Geist Mono"')]);
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await pause(150);
}

async function auditer(page, si, sc, journal, preparation) {
  const nom = `${si.id}/${sc.id}`;
  const dossier = join(SORTIE, "captures", si.id.replace(/[%+]/g, (c) => (c === "%" ? "pc" : "_")));
  mkdirSync(dossier, { recursive: true });
  await page.evaluate(CONTROLES);
  const audit = await page.evaluate((ex, s) => window.__auditerAffichage({ exceptions: ex, situation: s }), EXCEPTIONS, nom);
  // Écran d'erreur de l'appli (ErrorBoundary : bloc d'alerte avec le détail dans un <pre>).
  const plantage = await page.evaluate(() => (document.body.innerText || "").includes("Une erreur d'affichage est survenue") || !!document.querySelector('[role="alert"]:has(> pre)'));
  if (plantage) audit.defauts.unshift({ regle: "plantage", element: "ErrorBoundary", libelle: "Une erreur d'affichage est survenue", detail: journal.find((l) => l.includes("pageerror")) ?? "", rect: { x: 0, y: 0, l: si.largeur, h: si.hauteur }, gravite: 4, cle: "plantage" });
  // La scène est-elle vraiment atteinte (témoins : éléments VISIBLES repérés par
  // sélecteur, jamais par un libellé traduit) et les polices de l'appli chargées ?
  // « attendus » : textes de NOS données (pas de l'interface) qui doivent rester affichés.
  const verif = await page.evaluate((temoins, attendus) => {
    const texte = document.body.innerText || "";
    const vu = (sel) => [...document.querySelectorAll(sel)].some((el) => el.getClientRects().length > 0);
    // « clic: » : TOUS les éléments du sélecteur (au moins un) sont visibles ET cliquables
    // en leur centre (pas rognés par un parent overflow: hidden, pas recouverts).
    const cliquable = (sel) => {
      const els = [...document.querySelectorAll(sel)];
      return els.length > 0 && els.every((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const p = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!p && el.contains(p);
      });
    };
    // « absent: » : aucun élément visible pour ce sélecteur ; « appel: » : commande IPC reçue par la simulation.
    const ok = (t) => (t.startsWith("sel:") ? vu(t.slice(4)) : t.startsWith("clic:") ? cliquable(t.slice(5)) : t.startsWith("absent:") ? !vu(t.slice(7)) : t.startsWith("appel:") ? (window.__bancAppels?.[t.slice(6)] ?? 0) > 0 : texte.includes(t));
    const manquants = temoins.filter((t) => !ok(t));
    const disparus = attendus.filter((t) => !window.__texteVisible(t));
    const fil = document.querySelector(".colonne-chat[data-focus='true'] .chat-body")?.getBoundingClientRect();
    const polices = document.fonts.check('13px "Geist"') && document.fonts.check('12px "Geist Mono"');
    return { manquants, disparus, polices, fil: fil ? { x: Math.round(fil.x), y: Math.round(fil.y), l: Math.round(fil.width), h: Math.round(fil.height) } : null };
  }, sc.temoins ?? [], sc.attendus ?? []);
  for (const t of verif.disparus) {
    audit.defauts.unshift({ regle: "texte-disparu", element: "div.colonne-chat > div.chat-col > div.chat-body", libelle: t.slice(0, 70), detail: "texte de la conversation qui n'est plus visible à l'écran", rect: verif.fil ?? { x: 0, y: 0, l: si.largeur, h: si.hauteur }, gravite: 3, cle: "texte-disparu|" + t.slice(0, 40) });
  }
  if (!verif.polices) preparation = (preparation ? preparation + " ; " : "") + "polices Geist non chargées";
  if (sc._echecPoignee) preparation = (preparation ? preparation + " ; " : "") + "poignée : " + sc._echecPoignee;
  if (verif.manquants.length) preparation = (preparation ? preparation + " ; " : "") + "témoins absents : " + verif.manquants.join(", ");
  if (preparation) audit.defauts.unshift({ regle: "scene-incomplete", element: sc.id, libelle: "", detail: preparation, rect: { x: 0, y: 0, l: 1, h: 1 }, gravite: 0, cle: "scene-incomplete|" + sc.id });
  const defZones = { ...(ZONES["*"] ?? {}), ...(ZONES[sc.id] ?? {}) };
  const zones = Object.keys(defZones).length
    ? await page.evaluate((def) => {
        const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
        const out = {};
        for (const [nom, sels] of Object.entries(def)) {
          let u = null;
          for (const sel of sels) for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            const l = Math.max(0, r.left), t = Math.max(0, r.top), d = Math.min(vw, r.right), b = Math.min(vh, r.bottom);
            if (d - l < 1 || b - t < 1 || el.getClientRects().length === 0) continue;
            u = u ? { l: Math.min(u.l, l), t: Math.min(u.t, t), d: Math.max(u.d, d), b: Math.max(u.b, b) } : { l, t, d, b };
          }
          out[nom] = u ? { x: Math.floor(u.l), y: Math.floor(u.t), l: Math.ceil(u.d - u.l), h: Math.ceil(u.b - u.t) } : null;
        }
        return out;
      }, defZones)
    : undefined;
  const capture = join(dossier, `${sc.id}.png`);
  await page.screenshot({ path: capture });
  let annotee = null;
  if (audit.defauts.length) {
    await page.evaluate((d) => window.__annoterDefauts(d), audit.defauts);
    annotee = join(dossier, `${sc.id}.annote.png`);
    await page.screenshot({ path: annotee });
    await page.evaluate(() => window.__retirerAnnotations());
  }
  const inconnues = await page.evaluate(() => Object.keys(window.__bancInconnues ?? {}));
  if (CONTOUR) {
    const lignes = await page.evaluate((sel) => {
      const out = [];
      const marcher = (el, prof) => {
        if (prof > 6 || out.length > 120 || el.tagName === "svg") return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const cls = typeof el.className === "string" ? el.className.split(" ").slice(0, 2).join(".") : "";
        const txt = el.children.length === 0 ? (el.textContent || "").trim().slice(0, 30) : "";
        const s = getComputedStyle(el);
        out.push(`${"  ".repeat(prof)}${el.tagName.toLowerCase()}${cls ? "." + cls : ""} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} sw=${el.scrollWidth} ov=${s.overflowX} ${txt}`);
        for (const c of el.children) marcher(c, prof + 1);
      };
      for (const el of document.querySelectorAll(sel)) marcher(el, 0);
      return out;
    }, CONTOUR);
    console.log(`--- ${nom}\n` + lignes.join("\n"));
  }
  return {
    situation: si.id, scene: sc.id, capture: capture.slice(SORTIE.length + 1), annotee: annotee ? annotee.slice(SORTIE.length + 1) : null,
    defauts: audit.defauts, exceptes: audit.exceptes, mesures: audit.mesures, echelle: si.echelle, largeur: si.largeur, hauteur: si.hauteur, zones,
    erreursPage: journal.filter((l) => l.startsWith("[pageerror]") || l.startsWith("[error]")).slice(0, 5),
    commandesNonSimulees: inconnues,
  };
}

/** Une scene, une taille : chargee une fois, puis auditee a chaque echelle et taille de texte. */
async function executer(page, travail, journal, rendre) {
  journal.length = 0;
  const { l, h, sc } = travail;
  const premiere = situations.find((s) => s.largeur === l && s.hauteur === h);
  let preparation = null;
  try {
    await preparerScene(page, premiere, sc);
  } catch (err) {
    preparation = String(err).slice(0, 300);
  }
  for (const e of ECHELLES) {
    await page.setViewport({ width: l, height: h, deviceScaleFactor: e });
    for (const tx of TEXTES) {
      const si = situations.find((s) => s.largeur === l && s.hauteur === h && s.echelle === e && s.texte === tx.t && s.libelles === tx.l);
      const modifie = tx.t !== 1 || tx.l !== 1;
      if (modifie) await page.evaluate(CONTROLES);
      if (tx.t !== 1) await page.evaluate((f) => window.__agrandirTexte(f), tx.t);
      if (tx.l !== 1) await page.evaluate((f) => window.__allongerLibelles(f), tx.l);
      if (modifie) await pause(250);
      await stabiliser(page);
      const r = await auditer(page, si, sc, journal, preparation);
      if (tx.l !== 1) await page.evaluate(() => window.__retablirLibelles());
      if (tx.t !== 1) await page.evaluate(() => window.__retablirTexte());
      if (rendre(r)) return;
    }
  }
}

// 4. Travailleurs en parallele (une page chacun).
const resultats = [];
let suivant = 0;
let echec = null;
async function travailleur() {
  // Contexte isole par travailleur : stockage local separe (les scenes ne se melangent pas).
  const contexte = await navigateur.createBrowserContext();
  const page = await contexte.newPage();
  await emulerWindows(page);
  const journal = [];
  page.on("console", (m) => { if (m.type() === "error") journal.push(`[error] ${m.text()}`.slice(0, 300)); });
  page.on("pageerror", (e) => journal.push(`[pageerror] ${String(e)}`.slice(0, 300)));
  while (!echec && suivant < travaux.length) {
    const travail = travaux[suivant++];
    await executer(page, travail, journal, (r) => {
      resultats.push(r);
      const n = r.defauts.length;
      console.log(`${n ? "✗" : "✓"} ${r.situation.padEnd(26)} ${r.scene.padEnd(24)} ${n} défaut(s)${r.exceptes.length ? `, ${r.exceptes.length} excepté(s)` : ""}`);
      if (STRICT && n) echec = r;
      return !!echec;
    });
  }
  await page.close();
  await contexte.close();
}
await Promise.all(Array.from({ length: Math.min(TRAVAILLEURS, travaux.length) }, travailleur));
await navigateur.close();
serveur.close();

// 5. Rapport.
resultats.sort((a, b) => (a.situation + a.scene).localeCompare(b.situation + b.scene));
const parRegle = {};
const parSituation = {};
const parCle = {};
for (const r of resultats) {
  parSituation[r.situation] = (parSituation[r.situation] ?? 0) + r.defauts.length;
  for (const d of r.defauts) {
    parRegle[d.regle] = (parRegle[d.regle] ?? 0) + 1;
    const c = (parCle[d.cle] ??= { cle: d.cle, regle: d.regle, element: d.element, libelle: d.libelle, gravite: d.gravite, occurrences: 0, situations: [], exemple: null });
    c.occurrences += 1;
    if (c.situations.length < 400) c.situations.push(`${r.situation}/${r.scene}`);
    if (!c.exemple) c.exemple = { situation: r.situation, scene: r.scene, detail: d.detail, capture: r.annotee ?? r.capture };
  }
}
const total = resultats.reduce((n, r) => n + r.defauts.length, 0);
const distincts = Object.values(parCle).sort((a, b) => b.gravite * 1000 + b.occurrences - (a.gravite * 1000 + a.occurrences));
const rapport = {
  date: new Date().toISOString(),
  dureeSecondes: Math.round((Date.now() - debut) / 1000),
  mode: STRICT ? "strict" : "audit",
  revision: REVISION,
  situations: situations.map((s) => s.id),
  scenes: scenes.map((s) => s.id),
  rendus: resultats.length,
  totalDefauts: total,
  defautsDistincts: distincts.length,
  parRegle,
  parSituation,
  distincts,
  resultats,
};
writeFileSync(join(SORTIE, "rapport.json"), JSON.stringify(rapport, null, 1));
console.log(`\n${resultats.length} rendus, ${total} défaut(s) (${distincts.length} distincts) en ${rapport.dureeSecondes} s — ${join(SORTIE, "rapport.json")}`);
console.log("Défauts distincts les plus graves :");
for (const d of distincts.slice(0, 15)) console.log(`  [${d.regle}] ${d.element.split(" > ").slice(-2).join(" > ")} « ${d.libelle.slice(0, 40)} » × ${d.occurrences} — ex. ${d.exemple.situation}/${d.exemple.scene}`);
console.log("Défauts par situation :");
for (const [s, n] of Object.entries(parSituation)) console.log(`  ${s.padEnd(26)} ${n}`);
if (echec) {
  const d = echec.defauts[0];
  console.error(`\nÉCHEC (--strict) : ${echec.situation}/${echec.scene} — ${d.regle} : ${d.element} « ${d.libelle} » ${d.detail}\nCapture : ${join(SORTIE, echec.annotee ?? echec.capture)}`);
  process.exit(1);
}
if (STRICT && total) process.exit(1);
