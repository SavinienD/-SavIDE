#!/usr/bin/env node
// Marges du terminal : un programme plein écran simulé (banc/terminalCadre.ts) dessine un
// cadre sur toute la surface que le PTY annonce (cols x rows). On vérifie, pixel par pixel
// sur une capture, que les 4 coins, toute la dernière ligne (barre d'état) et toute la
// dernière colonne sont visibles, avec une marge régulière, et que cols/rows envoyés au
// PTY sont ceux réellement affichés.
//   node scripts/audit-affichage/terminal-marges.mjs [--sans-build] [--source <rév>]
//        [--situations 1366x768,1920x1080,800x600] [--echelles 1,1.25,1.5,2] [--zooms 0.8,1,1.2]
//        [--modes normal,pleine,scinde,police,redim,defilement] [--captures] [--sortie <dossier>]
// Sortie : <sortie>/marges.json (+ captures PNG des cas en défaut, ou de tous avec --captures).
import { build } from "vite";
import http from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, lstatSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { trouverNavigateur } from "./navigateur.mjs";
import { SCENES } from "./scenes.mjs";

const ici = dirname(fileURLToPath(import.meta.url));
const racine = resolve(ici, "../..");
const argv = process.argv.slice(2);
const opt = (nom, defaut) => {
  const i = argv.indexOf(`--${nom}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : defaut;
};
const drapeau = (nom) => argv.includes(`--${nom}`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const SORTIE = resolve(opt("sortie", join(ici, "sortie", "marges")));
mkdirSync(SORTIE, { recursive: true });

// Interface rendue : celle du dépôt, ou celle d'une révision (--source), build à part
// (jamais le build partagé de lancer.mjs).
const SOURCE = opt("source", "");
let BUILD = join(ici, "sortie", "build-marges");
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
  BUILD = join(ici, "sortie", `build-marges-${rev}`);
}
process.env.AXECODE_AUDIT_BUILD = BUILD;
if (!drapeau("sans-build") || !existsSync(join(BUILD, "scripts/audit-affichage/banc.html"))) {
  const t = Date.now();
  await build({ configFile: join(ici, "vite.config.mjs"), logLevel: "error" });
  console.log(`build ${Math.round((Date.now() - t) / 1000)} s`);
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf" };
const serveur = http.createServer((req, res) => {
  const fichier = join(BUILD, decodeURIComponent((req.url ?? "/").split("?")[0]));
  if (!fichier.startsWith(BUILD) || !existsSync(fichier) || statSync(fichier).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(fichier)] ?? "application/octet-stream" });
  res.end(readFileSync(fichier));
});
await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${serveur.address().port}/scripts/audit-affichage/banc.html`;

const { default: puppeteer } = await import("puppeteer-core");
// WebGL logiciel (SwiftShader) : le rendu WebGL de xterm, comme dans l'appli.
const navigateur = await puppeteer.launch({
  executablePath: await trouverNavigateur(),
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: ["--no-sandbox", "--font-render-hinting=none", "--lang=fr-FR", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", ...(drapeau("sans-webgl") ? ["--disable-gpu"] : [])],
});

const TAILLES = opt("situations", "1366x768,1920x1080,800x600").split(",").map((t) => t.split("x").map(Number));
const ECHELLES = opt("echelles", "1,1.25,1.5,2").split(",").map(Number);
const ZOOMS = opt("zooms", "0.8,1,1.2").split(",").map(Number);
const POLICES = opt("polices", "app").split(",");
const ETAPES = opt("etapes", "normal,pleine,retour,scinde,redim,defilement,zoom+,zoom-,ecran").split(",");
const CAPTURES = drapeau("captures");
const stockage = SCENES.find((s) => s.id === "terminal-scinde").stockage;
// Polices du terminal (variable --font-mono lue à l'ouverture) : celle de l'appli, ou une autre.
const POLICE = { app: null, dejavu: '"DejaVu Sans Mono", monospace', liberation: '"Liberation Mono", monospace' };

// Chromium sans écran + échelle émulée : ResizeObserver « device-pixel-content-box » rend la
// taille CSS (pas la taille physique émulée) et le rendu WebGL de xterm réduit alors son canvas
// à tort (artefact du banc, absent d'une vraie fenêtre). On retire cette API, comme dans
// WebKit (macOS) qui ne l'a pas : xterm garde la taille calculée. --api-dpcb : la garder.
const SANS_DPCB = !drapeau("api-dpcb");
const vue = (cas, z = cas.z, e = cas.e) => ({ width: Math.round(cas.l / z), height: Math.round(cas.h / z), deviceScaleFactor: e * z });

async function ouvrir(page, cas) {
  if (SANS_DPCB) {
    await page.evaluateOnNewDocument(() => {
      try { delete ResizeObserverEntry.prototype.devicePixelContentBoxSize; } catch { /* absent */ }
    });
  }
  const v = vue(cas);
  await page.setViewport(v);
  const scene = { cloud: false, cadre: true, cadreNormal: true, stockage: stockage(v.width, v.height) };
  await page.goto(`${BASE}?s=${encodeURIComponent(JSON.stringify(scene))}`, { waitUntil: "load" });
  await page.addStyleTag({ content: "*,*::before,*::after{transition-duration:0s!important;animation-duration:0.001s!important}" });
  await page.waitForSelector(".welcome", { timeout: 15000 });
  if (POLICE[cas.police]) await page.evaluate((f) => document.documentElement.style.setProperty("--font-mono", f), POLICE[cas.police]);
  // Dossier le plus récent de l'accueil (celui du banc).
  await page.evaluate(() => document.querySelector("button.welcome__recent")?.click());
  await page.waitForSelector(".workspace .composer", { timeout: 15000 });
  await page.evaluate(() => window.__bancEmettre?.("terminal-open-requested", null));
  await page.waitForSelector(".acli-surface .xterm-screen", { visible: true, timeout: 15000 });
  await pause(800);
}

const clic = (page, sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
// Étapes jouées l'une après l'autre sur la même page (mesure après chacune).
const ETAPE = {
  normal: async () => {},
  pleine: async (page) => clic(page, ".terminal-action[title='Pleine hauteur']"),
  retour: async (page) => clic(page, ".terminal-action[title='Hauteur normale du terminal']"),
  scinde: async (page) => {
    await clic(page, ".terminal-tabs__actions [data-action='plus-terminal']");
    await pause(300);
    await clic(page, ".acli-menu--actions [data-action='scinder']");
  },
  // Fenêtre redimensionnée après coup (le volet change de taille).
  redim: async (page, cas) => { const v = vue(cas); await page.setViewport({ ...v, width: v.width - 137, height: v.height - 91 }); },
  // Pointeur sur le terminal : la barre de défilement de xterm s'affiche (long historique).
  defilement: async (page) => {
    const r = await page.evaluate(() => { const b = document.querySelector(".acli-surface .xterm").getBoundingClientRect(); return { x: b.right - 30, y: b.top + b.height / 2 }; });
    await page.mouse.move(r.x, r.y);
    await page.mouse.wheel({ deltaY: -60 });
    await pause(200);
    await page.mouse.wheel({ deltaY: 600 });
  },
  // Ctrl + puis Ctrl − (zoom natif de la webview : largeur CSS et échelle changent ensemble).
  "zoom+": async (page, cas) => { for (const p of [1, 2]) { await page.setViewport(vue(cas, cas.z * 1.1 ** p)); await pause(400); } },
  "zoom-": async (page, cas) => { for (const p of [1, 0, -1]) { await page.setViewport(vue(cas, cas.z * 1.1 ** p)); await pause(400); } },
  // Fenêtre déplacée sur un écran d'une autre échelle (Retina <-> standard) : même taille CSS.
  ecran: async (page, cas) => { await page.setViewport(vue(cas, cas.z * 1.1 ** -1, cas.e === 2 ? 1 : 2)); },
};

/** Mesures DOM + pixels (dans la page : la capture est décodée par un canvas). */
async function mesurer(page, png) {
  return page.evaluate(async (donnees) => {
    const img = new Image();
    img.src = "data:image/png;base64," + donnees;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const dpr = img.width / window.innerWidth;
    const C = { hautGauche: [255, 0, 0], hautDroite: [0, 255, 0], basGauche: [0, 0, 255], basDroite: [255, 0, 255], haut: [255, 128, 0], gauche: [0, 255, 255], droite: [255, 255, 0], barre: [0, 160, 0] };
    const noms = Object.keys(C);
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const vues = document.querySelector(".terminal-views");
    const rv = rect(vues);
    const tailles = Object.values(window.__bancCadre ?? {});
    const surfaces = [...document.querySelectorAll(".acli-surface[data-active='true']")].map((s) => {
      const hote = s.querySelector(".acli-surface__xterm"), x = s.querySelector(".xterm"), ecran = s.querySelector(".xterm-screen");
      const rs = rect(s), rh = rect(hote), rx = rect(x), re = rect(ecran);
      const barreDef = s.querySelector(".xterm-scrollable-element > .xterm-scrollbar.xterm-vertical, .xterm-scrollable-element > .scrollbar.vertical");
      const rbd = barreDef ? rect(barreDef) : null;
      const visibleDef = barreDef ? getComputedStyle(barreDef).opacity !== "0" && !barreDef.className.includes("invisible") : false;
      // Pixels de la surface.
      const x0 = Math.max(0, Math.floor(rs.x * dpr)), y0 = Math.max(0, Math.floor(rs.y * dpr));
      const x1 = Math.min(img.width, Math.ceil(rs.r * dpr)), y1 = Math.min(img.height, Math.ceil(rs.b * dpr));
      const px = cx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      const boites = {};
      for (const n of noms) boites[n] = { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity, n: 0 };
      const W = x1 - x0;
      for (let i = 0; i < px.data.length; i += 4) {
        const r = px.data[i], g = px.data[i + 1], b = px.data[i + 2];
        for (const n of noms) {
          const c = C[n];
          if (Math.abs(r - c[0]) <= 4 && Math.abs(g - c[1]) <= 4 && Math.abs(b - c[2]) <= 4) {
            const k = i / 4, xx = x0 + (k % W), yy = y0 + Math.floor(k / W);
            const o = boites[n];
            o.n += 1; if (xx < o.x) o.x = xx; if (yy < o.y) o.y = yy; if (xx + 1 > o.r) o.r = xx + 1; if (yy + 1 > o.b) o.b = yy + 1;
            break;
          }
        }
      }
      // En px CSS.
      const css = {};
      for (const n of noms) { const o = boites[n]; css[n] = o.n ? { x: o.x / dpr, y: o.y / dpr, r: o.r / dpr, b: o.b / dpr, w: (o.r - o.x) / dpr, h: (o.b - o.y) / dpr, n: o.n } : null; }
      // Éléments posés sur les coins (autre chose que le terminal ?).
      const dessus = {};
      for (const n of ["hautGauche", "hautDroite", "basGauche", "basDroite"]) {
        const o = css[n]; if (!o) continue;
        const el = document.elementFromPoint(o.x + o.w / 2, o.y + o.h / 2);
        dessus[n] = el && x.contains(el) ? "xterm" : el ? (el.className?.toString?.() || el.tagName) : "rien";
      }
      return { surface: rs, hote: rh, xterm: rx, ecran: re, barreDefilement: rbd, barreVisible: visibleDef, boites: css, dessus,
        padding: getComputedStyle(x).padding, boxSizing: getComputedStyle(x).boxSizing };
    });
    return { dpr, vues: rv, fenetre: { w: window.innerWidth, h: window.innerHeight }, tailles, surfaces };
  }, png);
}

function juger(m) {
  const defauts = [];
  const tol = 2.01 / m.dpr; // deux pixels physiques (bords anticrénelés aux échelles fractionnaires)
  if (!m.surfaces.length) defauts.push("aucune surface de terminal");
  for (const [i, s] of m.surfaces.entries()) {
    const B = s.boites;
    const manque = Object.entries(B).filter(([, v]) => !v).map(([k]) => k);
    if (manque.length) { defauts.push(`surface ${i} : non visible : ${manque.join(", ")}`); continue; }
    const cadre = { x: B.hautGauche.x, y: B.hautGauche.y, r: B.basDroite.r, b: B.basDroite.b };
    // Taille du cadre en cellules : celle que le PTY a reçue et dont les cellules ont la taille des coins.
    const cand = m.tailles.map((t) => ({ ...t, cw: (cadre.r - cadre.x) / t.cols, ch: (cadre.b - cadre.y) / t.rows }))
      .find((t) => Math.abs(t.cw - B.hautGauche.w) <= tol && Math.abs(t.ch - B.hautGauche.h) <= tol);
    if (!cand) { defauts.push(`surface ${i} : le cadre affiché ne correspond à aucune taille reçue par le PTY (${m.tailles.map((t) => `${t.cols}x${t.rows}`).join("/")})`); continue; }
    const cw = cand.cw, ch = cand.ch;
    for (const n of ["hautGauche", "hautDroite", "basGauche", "basDroite"]) {
      if (Math.abs(B[n].w - cw) > tol) defauts.push(`surface ${i} : coin ${n} coupé en largeur (${B[n].w.toFixed(2)} au lieu de ${cw.toFixed(2)} px)`);
      if (Math.abs(B[n].h - ch) > tol) defauts.push(`surface ${i} : coin ${n} coupé en hauteur (${B[n].h.toFixed(2)} au lieu de ${ch.toFixed(2)} px)`);
    }
    if (Math.abs(B.droite.w - cw) > tol) defauts.push(`surface ${i} : dernière colonne coupée (${B.droite.w.toFixed(2)} px au lieu de ${cw.toFixed(2)})`);
    if (Math.abs(B.barre.h - ch) > tol) defauts.push(`surface ${i} : barre d'état coupée (${B.barre.h.toFixed(2)} px au lieu de ${ch.toFixed(2)})`);
    for (const [n, v] of Object.entries(s.dessus)) if (v !== "xterm") defauts.push(`surface ${i} : coin ${n} recouvert par ${v}`);
    // Grille de xterm (élément .xterm-screen) = taille reçue par le PTY ?
    const grille = { cols: Math.round(s.ecran.w / cw), rows: Math.round(s.ecran.h / ch) };
    s.grille = grille; s.pty = { cols: cand.cols, rows: cand.rows }; s.cellule = { w: +cw.toFixed(3), h: +ch.toFixed(3) };
    if (grille.cols !== cand.cols || grille.rows !== cand.rows) defauts.push(`surface ${i} : PTY ${cand.cols}x${cand.rows} ≠ grille affichée ${grille.cols}x${grille.rows}`);
    s.marges = { gauche: +(cadre.x - s.surface.x).toFixed(2), haut: +(cadre.y - s.surface.y).toFixed(2), droite: +(s.surface.r - cadre.r).toFixed(2), bas: +(s.surface.b - cadre.b).toFixed(2) };
    const vue = { x: Math.max(s.surface.x, m.vues.x), y: Math.max(s.surface.y, m.vues.y), r: Math.min(s.surface.r, m.vues.r, m.fenetre.w), b: Math.min(s.surface.b, m.vues.b, m.fenetre.h) };
    if (cadre.x < vue.x - tol || cadre.y < vue.y - tol || cadre.r > vue.r + tol || cadre.b > vue.b + tol) defauts.push(`surface ${i} : cadre hors de la zone visible`);
    // Grille entière dans la surface (sinon xterm dessine des cellules hors de la vue).
    if (s.ecran.r > s.surface.r + tol || s.ecran.b > s.surface.b + tol) defauts.push(`surface ${i} : grille de xterm plus grande que la surface (${(s.ecran.r - s.surface.r).toFixed(1)} / ${(s.ecran.b - s.surface.b).toFixed(1)} px)`);
    if (s.barreVisible && s.barreDefilement && cadre.r > s.barreDefilement.x + tol) defauts.push(`surface ${i} : dernière colonne sous la barre de défilement (${(cadre.r - s.barreDefilement.x).toFixed(1)} px)`);
    for (const [k, v] of Object.entries(s.marges)) if (v < 1) defauts.push(`surface ${i} : marge ${k} ${v} px (collé au bord)`);
    // Place perdue : plus d'une cellule libre à droite ou en bas (au-delà du padding et de la barre).
    if (s.marges.droite > cw + 4 + 14 + 2) defauts.push(`surface ${i} : marge droite trop grande (${s.marges.droite} px)`);
    if (s.marges.bas > ch + 8 + 2) defauts.push(`surface ${i} : marge basse trop grande (${s.marges.bas} px)`);
  }
  return defauts;
}

const cas = [];
for (const [l, h] of TAILLES) for (const e of ECHELLES) for (const z of ZOOMS) for (const police of POLICES) cas.push({ l, h, e, z, police });
const resultats = [];
let n = 0;
for (const c of cas) {
  n += 1;
  const base = `${c.l}x${c.h}@${c.e}-zoom${c.z}${c.police !== "app" ? "-" + c.police : ""}`;
  // Une page neuve par situation : rien ne reste de la précédente (échelle, WebGL).
  const page = await navigateur.newPage();
  try {
    await ouvrir(page, c);
    for (const etape of ETAPES) {
      const id = `${base}-${etape}`;
      await ETAPE[etape](page, c);
      await pause(900);
      const png = await page.screenshot({ encoding: "base64" });
      const m = await mesurer(page, png);
      const defauts = juger(m);
      resultats.push({ id, ...c, etape, defauts, mesures: m });
      if (defauts.length || CAPTURES) writeFileSync(join(SORTIE, `${id}.png`), Buffer.from(png, "base64"));
      const s0 = m.surfaces[0];
      console.log(`${n}/${cas.length} ${id} : ${defauts.length ? "✗ " + defauts.join(" ; ") : "✓"} ${s0?.marges ? JSON.stringify(s0.marges) : ""} PTY ${m.tailles.map((t) => `${t.cols}x${t.rows}`).join("/")} dpr ${m.dpr.toFixed(3)}`);
    }
  } catch (err) {
    resultats.push({ id: base, ...c, defauts: [`erreur : ${String(err).slice(0, 200)}`] });
    console.log(`${n}/${cas.length} ${base} : erreur ${String(err).slice(0, 200)}`);
  }
  await page.close().catch(() => undefined);
}
writeFileSync(join(SORTIE, "marges.json"), JSON.stringify(resultats, null, 1));
const ko = resultats.filter((r) => r.defauts.length);
console.log(`FIN : ${resultats.length - ko.length}/${resultats.length} sans défaut`);
await navigateur.close();
serveur.close();
process.exit(ko.length ? 1 : 0);
