#!/usr/bin/env node
// Banc MÉMOIRE de l'appli (écran noir après une longue utilisation).
// Vraie interface (src/) + backend simulé du banc d'affichage, dans Chromium sans écran.
// Un « cycle » = passer par N conversations (longs historiques, images en base64),
// rejouer un tour complet (texte, outils, images), ouvrir/fermer le terminal, laisser
// tourner les minuteries. Après chaque cycle : ramasse-miettes forcé, puis relevé
// du tas JS (CDP), des nœuds DOM, des écouteurs et des minuteries actives.
//   node scripts/audit-affichage/memoire.mjs [--cycles 6] [--conversations 12] [--sans-build]
//        [--seuil-mo 4] [--json sortie.json] [--strict]
// --strict : échoue si le tas grossit de plus de --seuil-mo Mo entre le 2e et le dernier
// cycle, ou si les minuteries / écouteurs augmentent d'un cycle à l'autre.
import { build } from "vite";
import http from "node:http";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { trouverNavigateur } from "./navigateur.mjs";
import { execSync } from "node:child_process";

const ici = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (nom, defaut) => { const i = argv.indexOf(`--${nom}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : defaut; };
const CYCLES = Number(opt("cycles", "6"));
const NCONV = Number(opt("conversations", "12"));
const SEUIL = Number(opt("seuil-mo", "4"));
const STRICT = argv.includes("--strict");
const BUILD = join(ici, "sortie", "build-memoire");
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
const navigateur = await puppeteer.launch({
  executablePath: await trouverNavigateur(), headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--lang=fr-FR", "--js-flags=--expose-gc", "--enable-precise-memory-info"],
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const page = await navigateur.newPage();
await page.setViewport({ width: 1600, height: 900 });
// Compteur des minuteries actives (setInterval non annulés) et des abonnements Tauri.
await page.evaluateOnNewDocument(() => {
  const actifs = new Set();
  const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
  window.setInterval = (...a) => { const id = si(...a); actifs.add(id); return id; };
  window.clearInterval = (id) => { actifs.delete(id); return ci(id); };
  window.__memIntervalles = () => actifs.size;
});
const erreurs = [];
page.on("pageerror", (e) => erreurs.push(String(e)));
// --long N : chaque conversation compte N échanges de plus (très longs historiques).
const LONG = Number(opt("long", "0"));
const scene = { accelerer: true, memoire: true, memoireTours: LONG };
await page.goto(`${BASE}?s=${encodeURIComponent(JSON.stringify(scene))}`, { waitUntil: "load" });
await page.waitForSelector(".welcome", { timeout: 15000 });
await page.evaluate(() => [...document.querySelectorAll("button.welcome__recent")].find((x) => x.textContent.includes("savide"))?.click());
await page.waitForSelector(".workspace .composer", { timeout: 15000 });
await pause(1500);
const cdp = await page.createCDPSession();
await cdp.send("HeapProfiler.enable");

async function releve(etiquette) {
  for (let i = 0; i < 3; i += 1) { await cdp.send("HeapProfiler.collectGarbage"); await pause(150); }
  const tas = await cdp.send("Runtime.getHeapUsage");
  const dom = await cdp.send("Memory.getDOMCounters");
  const intervalles = await page.evaluate(() => window.__memIntervalles?.() ?? -1);
  const horsAppli = await page.evaluate(() => [...document.body.children].filter((e) => e.id !== "root" && e.tagName !== "SCRIPT").length);
  if (horsAppli) console.log(`  éléments laissés hors de l'appli dans <body> : ${horsAppli}`);
  const r = { etiquette, tasMo: +(tas.usedSize / 1048576).toFixed(2), noeuds: dom.nodes, ecouteurs: dom.jsEventListeners, documents: dom.documents, intervalles, renduMo: renduMo() };
  console.log(`${etiquette.padEnd(10)} tas ${String(r.tasMo).padStart(7)} Mo  nœuds ${String(r.noeuds).padStart(6)}  écouteurs ${String(r.ecouteurs).padStart(5)}  minuteries ${r.intervalles}  processus de rendu ${r.renduMo} Mo`);
  return r;
}

// Mémoire résidente du processus de rendu de Chromium (comme « renderer » de WebView2), Linux.
function renduMo() {
  try {
    const pid = navigateur.process()?.pid;
    const lignes = execSync("ps -eo pid=,ppid=,rss=,args=", { encoding: "utf8" }).split("\n");
    const procs = lignes.filter(Boolean).map((l) => {
      const [p, pp, rss, ...args] = l.trim().split(/\s+/);
      return { p: Number(p), pp: Number(pp), rss: Number(rss), args: args.join(" ") };
    });
    const parent = new Map(procs.map((x) => [x.p, x.pp]));
    const descend = (p) => { for (let i = 0; i < 6 && p; i += 1) { if (p === pid) return true; p = parent.get(p); } return false; };
    let total = 0;
    for (const x of procs) if (x.args.includes("--type=renderer") && descend(x.p)) total += x.rss;
    return Math.round(total / 1024);
  } catch {
    return -1;
  }
}

// Un tour complet rejoué sur la conversation active (texte long, outil, image).
const MORCEAUX = Number(opt("morceaux", "60"));
async function tour(cid, n) {
  await page.evaluate(async (cid, n, MORCEAUX) => {
    const img = "iVBORw0KGgo" + String(n).repeat(8) + "A".repeat(300_000);
    const ev = [{ type: "turn_started" }, { type: "text_started" }];
    for (let i = 0; i < MORCEAUX; i += 1) ev.push({ type: "text_chunk", delta: `Morceau ${i} du tour ${n} : je relis le journal et je relance le banc. ` });
    // Diagramme Mermaid écrit en direct (un rendu par morceau, souvent incomplet donc en erreur).
    const diagramme = "\n\n```mermaid\nflowchart LR\n  A[Banc] --> B[Colonne]\n  B --> C{Défaut ?}\n  C -->|oui| D[Corriger]\n  C -->|non| E[Fin]\n```\n";
    for (let i = 0; i < diagramme.length; i += 6) ev.push({ type: "text_chunk", delta: diagramme.slice(i, i + 6) });
    ev.push({ type: "text_finished" }, { type: "tool_started", id: `toolu_m${n}`, name: "bash" });
    ev.push({ type: "tool_ready", id: `toolu_m${n}`, summary: "capture", args_pretty: "{}" });
    for (let i = 0; i < Math.round(MORCEAUX * 2 / 3); i += 1) ev.push({ type: "tool_output_delta", id: `toolu_m${n}`, delta: `ligne ${i} `.repeat(20) + "\n" });
    ev.push({ type: "tool_finished", id: `toolu_m${n}`, output: "fini", is_error: false, file_changes: [], images: [{ media_type: "image/png", data: img }] });
    ev.push({ type: "turn_finished", duration_ms: 1200 });
    let s = 0;
    for (const event of ev) await window.__bancEmettre("agent-event", { conversationId: cid, workspaceId: "C:\\Users\\utilisateur\\Documents\\Projets\\savide", sequence: ++s, event });
  }, cid, n, MORCEAUX);
}

const resultats = [await releve("départ")];
const titres = await page.evaluate(() => [...document.querySelectorAll(".conv-row__title")].map((e) => e.textContent.trim()));
for (let c = 1; c <= CYCLES; c += 1) {
  for (let i = 0; i < Math.min(NCONV, titres.length); i += 1) {
    await page.evaluate((i) => document.querySelectorAll(".conv-row__title")[i]?.click(), i);
    await pause(120);
  }
  // Liste triée du plus récent au plus ancien : la n-ième ligne est c-00n.
  await tour(`c-${String(Math.min(NCONV, titres.length)).padStart(3, "0")}`, c);
  await page.evaluate(() => window.__bancEmettre?.("terminal-open-requested", null));
  await pause(500);
  await page.keyboard.down("Control"); await page.keyboard.press("j"); await page.keyboard.up("Control");
  await pause(1500);
  resultats.push(await releve(`cycle ${c}`));
}
// --instantane <fichier> : instantané du tas en fin de banc (analyse des rétentions).
const instantane = opt("instantane", "");
if (instantane) {
  const morceaux = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", (e) => morceaux.push(e.chunk));
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  writeFileSync(instantane, morceaux.join(""));
  console.log(`Instantané du tas : ${instantane}`);
}
const a = resultats[Math.min(2, resultats.length - 1)], z = resultats.at(-1);
const croissance = +(z.tasMo - a.tasMo).toFixed(2);
console.log(`Croissance du tas (cycle 2 -> ${CYCLES}) : ${croissance} Mo ; nœuds ${z.noeuds - a.noeuds} ; écouteurs ${z.ecouteurs - a.ecouteurs} ; minuteries ${z.intervalles - a.intervalles}`);
if (erreurs.length) console.log("Erreurs de la page :", erreurs.slice(0, 5).join(" | "));
const jsonSortie = opt("json", "");
if (jsonSortie) writeFileSync(jsonSortie, JSON.stringify({ resultats, croissance, erreurs }, null, 2));
await navigateur.close();
serveur.close();
const fuite = croissance > SEUIL || z.intervalles > a.intervalles || z.ecouteurs > a.ecouteurs + 20;
if (STRICT && fuite) { console.log("ÉCHEC : la mémoire grossit d'un cycle à l'autre."); process.exit(1); }
