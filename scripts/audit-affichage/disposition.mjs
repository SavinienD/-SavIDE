#!/usr/bin/env node
// Banc DISPOSITION : chaque dossier retrouve sa disposition (largeurs des volets, volets
// réduits, terminal, hauteur du terminal), quelle que soit la façon d'y revenir
// (Ctrl+1/2/3, accueil puis carte du dossier) et après un rechargement de la page.
// Vraie interface (src/) + backend simulé du banc d'affichage, dans Chromium sans écran.
//   node scripts/audit-affichage/disposition.mjs [--sans-build] [--strict] [--mac]
// --mac : macOS simulé (raccourcis avec ⌘ au lieu de Ctrl).
// Fenêtre normale (1366x768) puis plein écran simulé (1920x1080).
import { build } from "vite";
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { trouverNavigateur } from "./navigateur.mjs";
import { emulerMac, emulerWindows } from "./windows.mjs";

const ici = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const MAC = argv.includes("--mac");
const MOD = MAC ? "Meta" : "Control";
const BUILD = join(ici, "sortie", "build-disposition");
process.env.AXECODE_AUDIT_BUILD = BUILD;
if (!argv.includes("--sans-build") || !existsSync(join(BUILD, "scripts/audit-affichage/banc.html"))) {
  await build({ configFile: join(ici, "vite.config.mjs"), logLevel: "error" });
}
const { default: puppeteer } = await import("puppeteer-core");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const serveur = http.createServer((req, res) => {
  const f = join(BUILD, decodeURIComponent((req.url ?? "/").split("?")[0]));
  if (!f.startsWith(BUILD) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${serveur.address().port}/scripts/audit-affichage/banc.html`;
const navigateur = await puppeteer.launch({ executablePath: await trouverNavigateur(), headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=fr-FR"] });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const D1 = "C:\\Users\\utilisateur\\Documents\\Projets\\savide";
const D2 = "C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin";
const D3 = "C:\\Users\\utilisateur\\Documents\\Clients\\atelier-durand";
const RECENTS = [
  { path: D1, name: "savide", lastOpenedMs: 1_790_000_000_000 },
  { path: D2, name: "cabinet-martin", lastOpenedMs: 1_789_990_000_000 },
  { path: D3, name: "atelier-durand", lastOpenedMs: 1_789_980_000_000 },
];
const NOMS = { [D1]: "savide", [D2]: "cabinet-martin", [D3]: "atelier-durand" };
const scene = { accelerer: true, ouvrirChemin: true, garderStockage: true, stockage: { "axecode.recentWorkspaces": RECENTS } };

let echecs = 0;
const verifs = [];
function noter(ok, texte) {
  verifs.push({ ok, texte });
  if (!ok) echecs += 1;
  console.log(`${ok ? "ok    " : "ÉCHEC "} ${texte}`);
}

async function touche(page, combo) {
  const parties = combo.split("+");
  const t = parties.pop();
  for (const m of parties) await page.keyboard.down(m);
  await page.keyboard.press(t);
  for (const m of parties.reverse()) await page.keyboard.up(m);
}

async function ouvert(page) {
  return page.evaluate(() => (window.__bancOuverts ?? []).at(-1) ?? null);
}

// Disposition visible : largeur des volets (0 = réduit), terminal affiché et sa hauteur.
async function mesure(page) {
  return page.evaluate(() => {
    const main = document.querySelector(".workspace .main");
    if (!main) return null;
    const enfants = [...main.children];
    const sidebar = main.querySelector(":scope > .sidebar");
    const gouttieres = enfants.filter((e) => e.classList.contains("gutter"));
    const droite = enfants.at(-1);
    const terminal = document.querySelector(".workspace .terminal-shell");
    const visible = (e) => !!e && getComputedStyle(e).display !== "none";
    return {
      gauche: visible(sidebar) ? Math.round(sidebar.getBoundingClientRect().width) : 0,
      droite: visible(droite) ? Math.round(droite.getBoundingClientRect().width) : 0,
      terminal: visible(terminal) ? Math.round(terminal.getBoundingClientRect().height) : 0,
      gouttieres: gouttieres.length,
    };
  });
}

async function glisser(page, quelle, dx, dy = 0) {
  const boite = await page.evaluate((quelle) => {
    const main = document.querySelector(".workspace .main");
    let g;
    if (quelle === "terminal") g = document.querySelector(".workspace .workbench-center > .gutter-h");
    else {
      const gs = [...main.children].filter((e) => e.classList.contains("gutter"));
      g = quelle === "gauche" ? gs[0] : gs.at(-1);
    }
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, quelle);
  if (!boite) throw new Error(`poignée ${quelle} introuvable`);
  await page.mouse.move(boite.x, boite.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) await page.mouse.move(boite.x + (dx * i) / 5, boite.y + (dy * i) / 5);
  await page.mouse.up();
  await pause(150);
}

async function attendreDossier(page, chemin) {
  for (let i = 0; i < 60; i += 1) {
    if ((await ouvert(page)) === chemin && (await page.$(".workspace .main"))) { await pause(400); return; }
    await pause(100);
  }
  throw new Error(`dossier non ouvert : ${chemin}`);
}

// Va au dossier par Ctrl+n (n = numéro figé tant qu'on ne repasse pas par l'accueil).
async function parNumero(page, n, chemin) {
  await touche(page, `${MOD}+${n}`);
  await attendreDossier(page, chemin);
}

// Revient à l'accueil puis clique la carte du dossier.
async function parAccueil(page, chemin) {
  await touche(page, `${MOD}+Shift+H`);
  await page.waitForSelector(".welcome", { timeout: 10000 });
  await pause(200);
  const ok = await page.evaluate((nom) => {
    const b = [...document.querySelectorAll("button.welcome__recent")].find((x) => x.textContent.includes(nom));
    b?.click();
    return !!b;
  }, NOMS[chemin]);
  if (!ok) throw new Error(`carte introuvable : ${NOMS[chemin]}`);
  await attendreDossier(page, chemin);
}

const proche = (a, b) => Math.abs(a - b) <= 2;
function comparer(etiquette, obtenu, attendu) {
  const ok = obtenu && proche(obtenu.gauche, attendu.gauche) && proche(obtenu.droite, attendu.droite) && proche(obtenu.terminal, attendu.terminal);
  noter(ok, `${etiquette} : ${JSON.stringify(obtenu && { gauche: obtenu.gauche, droite: obtenu.droite, terminal: obtenu.terminal })}${ok ? "" : ` attendu ${JSON.stringify(attendu)}`}`);
}

const erreurs = [];
async function parcours(largeur, hauteur) {
  console.log(`\n=== Fenêtre ${largeur}x${hauteur}${MAC ? " (macOS)" : ""} ===`);
  const contexte = await navigateur.createBrowserContext();
  const page = await contexte.newPage();
  page.on("pageerror", (e) => erreurs.push(String(e)));
  await (MAC ? emulerMac : emulerWindows)(page);
  await page.setViewport({ width: largeur, height: hauteur });
  await page.goto(`${BASE}?s=${encodeURIComponent(JSON.stringify(scene))}`, { waitUntil: "load" });
  await page.waitForSelector(".welcome", { timeout: 15000 });
  await pause(300);

  // Dossier 1 : chat élargi de 200 px.
  await parNumero(page, 1, D1);
  const base = await mesure(page);
  console.log(`  disposition par défaut : ${JSON.stringify(base)}`);
  await glisser(page, "droite", -200);
  const att1 = await mesure(page);
  // Dossier 2 : volet de gauche élargi, terminal ouvert puis agrandi de 100 px.
  await parNumero(page, 2, D2);
  comparer("dossier 2, premier passage = disposition par défaut", await mesure(page), base);
  await glisser(page, "gauche", 120);
  await touche(page, `${MOD}+j`);
  await pause(500);
  await glisser(page, "terminal", 0, -100);
  const att2 = await mesure(page);
  // Dossier 3 : volet de gauche réduit (Ctrl+B), chat rétréci.
  await parNumero(page, 3, D3);
  comparer("dossier 3, premier passage = disposition par défaut", await mesure(page), base);
  await touche(page, `${MOD}+b`);
  await pause(200);
  await glisser(page, "droite", 80);
  const att3 = await mesure(page);
  console.log(`  réglé : d1 ${JSON.stringify(att1)}  d2 ${JSON.stringify(att2)}  d3 ${JSON.stringify(att3)}`);
  noter(att1.droite > base.droite + 150, `dossier 1 : chat élargi (${base.droite} -> ${att1.droite})`);
  noter(att2.terminal > 0 && att2.gauche > base.gauche + 100, "dossier 2 : terminal ouvert, volet gauche élargi");
  noter(att3.gauche === 0, "dossier 3 : volet gauche réduit");
  const attendus = { [D1]: att1, [D2]: att2, [D3]: att3 };

  for (let tour = 1; tour <= 3; tour += 1) {
    for (const [n, d] of [[1, D1], [2, D2], [3, D3], [2, D2], [1, D1]]) {
      await parNumero(page, n, d);
      comparer(`tour ${tour}, Ctrl+${n} -> ${NOMS[d]}`, await mesure(page), attendus[d]);
    }
  }
  // Par l'accueil (liste des dossiers récents).
  for (const d of [D3, D2, D1]) {
    await parAccueil(page, d);
    comparer(`accueil -> ${NOMS[d]}`, await mesure(page), attendus[d]);
  }
  // Rechargement (redémarrage simulé) : le dossier en cours puis les autres.
  const courant = await ouvert(page);
  await page.reload({ waitUntil: "load" });
  await attendreDossier(page, courant);
  comparer(`rechargement -> ${NOMS[courant]} (repris)`, await mesure(page), attendus[courant]);
  for (const d of [D2, D3, D1]) {
    if (d === (await ouvert(page))) continue;
    await parAccueil(page, d);
    comparer(`après rechargement, accueil -> ${NOMS[d]}`, await mesure(page), attendus[d]);
  }
  // Ordre figé de nouveau : Ctrl+1/2/3 après rechargement.
  const ordre = await page.evaluate(() => [...document.querySelectorAll(".barre-dossiers__btn")].map((b) => b.getAttribute("title")));
  console.log(`  barre des dossiers : ${JSON.stringify(ordre)}`);
  await contexte.close();
  return attendus;
}

// Fenêtre normale, plein écran simulé ; puis passage d'une taille à l'autre sur la même page.
await parcours(1366, 768);
await parcours(1920, 1080);
{
  console.log("\n=== Passage fenêtre normale -> plein écran -> fenêtre normale ===");
  const contexte = await navigateur.createBrowserContext();
  const page = await contexte.newPage();
  page.on("pageerror", (e) => erreurs.push(String(e)));
  await (MAC ? emulerMac : emulerWindows)(page);
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(`${BASE}?s=${encodeURIComponent(JSON.stringify(scene))}`, { waitUntil: "load" });
  await page.waitForSelector(".welcome", { timeout: 15000 });
  await parNumero(page, 1, D1);
  await glisser(page, "droite", -150);
  const a1 = await mesure(page);
  await page.setViewport({ width: 1920, height: 1080 });
  await pause(300);
  await parNumero(page, 2, D2);
  await glisser(page, "droite", -400);
  const a2 = await mesure(page);
  await parNumero(page, 1, D1);
  comparer("plein écran, Ctrl+1 -> savide (réglé en fenêtre normale)", await mesure(page), a1);
  await page.setViewport({ width: 1366, height: 768 });
  await pause(300);
  await parNumero(page, 2, D2);
  const m2 = await mesure(page);
  noter(m2.droite > 0 && m2.droite <= 1366, `fenêtre normale, Ctrl+2 -> cabinet-martin (réglé à ${a2.droite} en plein écran) : chat ${m2.droite} px, tient dans la fenêtre`);
  await page.setViewport({ width: 1920, height: 1080 });
  await pause(300);
  comparer("de nouveau plein écran : largeur choisie en plein écran retrouvée", await mesure(page), a2);
  await contexte.close();
}

if (erreurs.length) console.log(`\nErreurs JS : ${erreurs.slice(0, 5).join(" | ")}`);
console.log(`\n${verifs.length - echecs}/${verifs.length} vérifications réussies`);
await navigateur.close();
serveur.close();
if (STRICT && echecs) process.exit(1);
