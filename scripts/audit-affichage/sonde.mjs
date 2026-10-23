// Sonde texte du banc : rejoue une scène « collegue » et décrit l'écran étape par étape
// (conversations, compositeur, bouton Send, erreurs, réglages ouverts, send_message reçus).
// Prérequis : interface construite par lancer.mjs (sortie/build).
// Usage : node scripts/audit-affichage/sonde.mjs collegue ['{"fournisseur":true}']
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { trouverNavigateur } from "./navigateur.mjs";
import { SCENES } from "./scenes.mjs";
const BANC = dirname(fileURLToPath(import.meta.url));
const BUILD = join(BANC, "sortie", "build");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm" };
const serveur = http.createServer((req, res) => {
  const f = join(BUILD, decodeURIComponent((req.url ?? "/").split("?")[0]));
  if (!f.startsWith(BUILD) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] ?? "application/octet-stream" }); res.end(readFileSync(f));
});
await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${serveur.address().port}/scripts/audit-affichage/banc.html`;
const nav = await puppeteer.launch({ executablePath: await trouverNavigateur(), headless: true, args: ["--no-sandbox", "--disable-gpu", "--lang=fr-FR"] });
const page = await nav.newPage();
const journal = [];
page.on("console", (m) => journal.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
page.on("pageerror", (e) => journal.push(`[pageerror] ${String(e).slice(0, 300)}`));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const idScene = process.argv[2] ?? "collegue";
const sc = SCENES.find((s) => s.id === idScene);
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const scene = { ...sc.sim, ...extra, stockage: sc.stockage ? sc.stockage(1366, 768) : {} };
await page.setViewport({ width: 1366, height: 768 });
await page.goto(`${BASE}?s=${encodeURIComponent(JSON.stringify(scene))}`, { waitUntil: "load" });
async function etat(titre) {
  const e = await page.evaluate(() => {
    const t = (sel) => [...document.querySelectorAll(sel)].map((x) => (x.innerText || x.textContent || "").trim().replace(/\s+/g, " ")).filter(Boolean);
    const send = [...document.querySelectorAll(".composer button.composer__send")].map((b) => `${b.textContent.trim()}${b.disabled ? " (désactivé)" : ""}`);
    return {
      ecran: document.querySelector(".welcome") ? "accueil" : document.querySelector(".workspace") ? "espace" : "?",
      conversations: t(".conv-row__title"),
      compositeur: t(".composer__actions-left button, .composer__connect-cta").slice(0, 6),
      envoyer: send,
      erreurs: t("[data-error=true]"),
      avis: t(".axe-slash-notice"),
      arbre: document.querySelector(".axe-tree-overlay") ? (document.querySelector(".axe-tree-overlay").innerText || "").replace(/\s+/g, " ").slice(0, 300) : null,
      sectionReglages: document.querySelector(".settings-pane") ? t(".settings-pane [data-active=true]").slice(0, 1) : null,
      reglages: document.querySelector(".settings-pane") ? (document.querySelector(".settings-pane").innerText || "").replace(/\s+/g, " ").slice(0, 700) : null,
      messages: t(".msg").slice(-4),
      barre: (document.querySelector(".sidebar")?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
      daemon: (window.__bancDaemon ?? []).join(","),
    };
  });
  console.log(`--- ${titre}\n` + JSON.stringify(e, null, 1));
}
await page.waitForSelector(".welcome", { timeout: 10000 }).catch(() => undefined);
await pause(800);
await etat("accueil");
if (sc.espaceCloud) {
  await page.waitForFunction(() => [...document.querySelectorAll("button.axc-btn")].some((x) => x.textContent.trim() === "Racine de l'espace"), { timeout: 8000 }).catch(() => undefined);
  await page.evaluate(() => { const b = [...document.querySelectorAll("button.axc-btn")].find((x) => x.textContent.trim() === "Racine de l'espace"); b?.click(); });
} else {
  await page.evaluate(() => { const b = [...document.querySelectorAll("button.welcome__recent")].find((x) => x.textContent.includes("axecode")); b?.click(); });
}
await page.waitForSelector(".workspace .composer", { timeout: 10000 }).catch(() => console.log("pas d'espace"));
await pause(1500);
await etat("espace ouvert");
if (sc.creer) {
  await page.click("button.sidebar__head-btn[title='Nouvelle conversation']").catch((e) => console.log("pas de +", String(e).slice(0, 80)));
  await page.waitForSelector(".conv-create__input", { timeout: 4000 }).catch(() => undefined);
  await page.type(".conv-create__input", sc.creer).catch(() => undefined);
  await page.keyboard.press("Enter");
  await pause(3000);
  await etat(`conversation « ${sc.creer} » créée (« + », 3 s)`);
}
{
  // Liste « Modèle » du compositeur (si le sélecteur est là), puis choix éventuel d'un modèle.
  const modeles = await page.evaluate(async () => {
    const b = document.querySelector(".composer__picker[data-kind=model] .composer__picker-btn");
    if (!b || b.disabled) return null;
    b.click();
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll(".composer__picker[data-kind=model] .composer__popover .axe-model-group, .composer__picker[data-kind=model] .composer__popover .composer__popover-row")].map((x) => x.textContent.trim());
    b.click();
    return rows;
  });
  console.log("liste « Modèle » :", JSON.stringify(modeles));
  if (sc.choisirModele) {
    const ok = await page.evaluate(async (nom) => {
      const b = document.querySelector(".composer__picker[data-kind=model] .composer__picker-btn");
      if (!b || b.disabled) return false;
      b.click();
      await new Promise((r) => setTimeout(r, 300));
      const row = [...document.querySelectorAll(".composer__picker[data-kind=model] .composer__popover .composer__popover-row")].find((x) => x.textContent.trim() === nom);
      row?.click();
      return !!row;
    }, sc.choisirModele);
    await pause(1200);
    await etat(`modèle « ${sc.choisirModele} » choisi (${ok ? "ligne trouvée" : "ligne absente"})`);
  }
}
if (sc.ouvrir) {
  await page.evaluate((t) => { const e = [...document.querySelectorAll(".conv-row__title")].find((x) => x.textContent.trim() === t); e?.click(); }, sc.ouvrir);
  await pause(3000);
  await etat(`conversation « ${sc.ouvrir} » ouverte (3 s)`);
}
if (sc.ecrire) {
  await page.click(".composer textarea").catch(() => undefined);
  await page.keyboard.type(sc.ecrire);
  await pause(200);
  await etat("message écrit");
  await page.keyboard.press("Enter");
  await pause(800);
  await etat("Entrée pressée");
  const envois = await page.evaluate(() => (window.__bancEnvois ?? []).map((a) => ({ conversationId: a.conversationId, model: a.model, text: a.text })));
  console.log("send_message reçus par le « Rust » simulé :", JSON.stringify(envois));
}
if (sc.clicConnecter) {
  await page.waitForSelector(".composer__connect-cta", { timeout: 8000 }).catch(() => undefined);
  const ok = await page.evaluate(() => { const b = document.querySelector(".composer__connect-cta"); b?.click(); return !!b; });
  await pause(800);
  await etat(`clic « Connect a provider » (${ok ? "bouton présent" : "bouton absent"})`);
}
for (const ev of sc.evenementsTour ?? []) {
  await page.evaluate((e) => window.__bancEmettre?.("agent-event", e), ev);
  await pause(200);
}
if ((sc.evenementsTour ?? []).length) { await pause(500); await etat("après les événements du tour"); }
if (sc.arbre) {
  await page.click(".composer button[aria-label='Session tree'], .composer button[aria-label='Arbre de la session']").catch((e) => console.log("pas de bouton /tree", String(e).slice(0, 80)));
  await pause(1200);
  await etat("arbre de la session ouvert (/tree)");
}
if (sc.compacter) {
  const r = await page.evaluate(async () => {
    const b = document.querySelector(".composer__compact");
    if (!b) return "bouton absent";
    if (b.disabled) return "bouton désactivé";
    b.click();
    await new Promise((f) => setTimeout(f, 400));
    const s = document.querySelector(".compact-pill__submit");
    if (!s) return "pas de champ de compaction";
    s.click();
    return "champ ouvert, compaction lancée";
  });
  await pause(1200);
  await etat(`clic « Compaction » (${r})`);
}
if (sc.reecrire) {
  const r = await page.evaluate(() => {
    const m = document.querySelector(".msg__body.user-text");
    if (!m) return "message absent";
    const modifiable = m.dataset.rewindable === "true";
    m.click();
    return modifiable ? "message modifiable" : "message non modifiable";
  });
  await pause(500);
  if (r === "message modifiable") {
    await page.click(".composer textarea").catch(() => undefined);
    await page.keyboard.press("Enter");
    await pause(1200);
  }
  await etat(`clic sur le message envoyé puis Entrée (${r})`);
}
const appels = await page.evaluate(() => window.__bancAppels);
console.log("appels IPC :", JSON.stringify(Object.fromEntries(Object.entries(appels).filter(([k]) => /provider|send|daemon|cloud|model/.test(k)))));
console.log("journal :", journal.filter((l) => /error|pageerror/i.test(l)).slice(0, 8).join("\n"));
await nav.close();
serveur.close();
