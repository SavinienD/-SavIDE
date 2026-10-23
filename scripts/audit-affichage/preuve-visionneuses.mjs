// Preuve : chaque type de fichier s'ouvre depuis l'explorateur, rendu non vide, aucune requête externe.
// Usage : node preuve-visionneuses.mjs <dossier des fichiers de test>
import http from "node:http"; import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, extname, dirname } from "node:path"; import { fileURLToPath } from "node:url";
import { build } from "vite"; import puppeteer from "puppeteer-core"; import { trouverNavigateur } from "./navigateur.mjs";
const ici = dirname(fileURLToPath(import.meta.url)); const FIX = process.argv[2]; const BUILD = join(ici, "sortie", "build");
await build({ configFile: join(ici, "vite.config.mjs"), logLevel: "error" });
const noms = readdirSync(FIX).sort();
const srv = http.createServer((q, r) => {
  const c = decodeURIComponent(q.url.split("?")[0]);
  const f = c.startsWith("/fixtures/") ? join(FIX, c.slice(10)) : join(BUILD, c);
  if (!existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  const T = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
  r.writeHead(200, { "Content-Type": T[extname(f)] ?? "application/octet-stream" }); r.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r)); const port = srv.address().port;
const nav = await puppeteer.launch({ executablePath: await trouverNavigateur(), headless: true, args: ["--no-sandbox"] });
const page = await nav.newPage(); const errs=[]; page.on("pageerror",e=>errs.push(String(e).slice(0,200))); page.on("console",m=>{if(m.type()==="error")errs.push(m.text().slice(0,200))}); await page.setViewport({ width: 1600, height: 1000 });
const externes = []; await page.setRequestInterception(true);
page.on("request", async (q) => {
  const u = new URL(q.url());
  if (u.hostname === "asset.localhost") { const n = decodeURIComponent(u.pathname).split(/[\\/]/).pop(); return q.respond({ status: 200, body: readFileSync(join(FIX, n)) }); }
  if (u.protocol.startsWith("http") && u.hostname !== "127.0.0.1") { externes.push(q.url()); return q.abort(); }
  q.continue();
});
const scene = { fournisseur: true, fichiers: noms };
await page.goto(`http://127.0.0.1:${port}/scripts/audit-affichage/banc.html?s=${encodeURIComponent(JSON.stringify(scene))}`);
await page.waitForSelector(".welcome", { timeout: 20000 }); await new Promise(r=>setTimeout(r,800));
await page.evaluate(() => [...document.querySelectorAll("button.welcome__recent")].find((x) => x.textContent.includes("axecode"))?.click());
await page.waitForSelector(".workspace .composer", { timeout: 20000 }).catch(async()=>{console.log("ERREURS",errs.slice(0,3));console.log(JSON.stringify(await page.evaluate(()=>Object.keys(window.__bancInconnues||{}))));console.log((await page.evaluate(()=>document.body.innerText)).slice(0,400));process.exit(2)});
await page.waitForSelector(".tree-row", { timeout: 15000 });
const res = [];
for (const n of noms) {
  await page.waitForSelector(`.tree-row[data-entry-path="${n}"], .tree-row`, { timeout: 8000 });
  const ok = await page.evaluate((n) => { const r = [...document.querySelectorAll(".tree-row")].find((e) => e.textContent.trim().endsWith(n)); r?.click(); return !!r; }, n);
  await new Promise((r) => setTimeout(r, 3500));
  const m = await page.evaluate(() => {
    const z = document.querySelector(".editor-host"); if (!z) return { txt: 0, vis: 0, err: "" };
    const vis = [...z.querySelectorAll("canvas,img,video,audio,svg,table,iframe,.monaco-editor,.xv-pdf__page,p,h1")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 10 && b.height > 10; }).length;
    const err = [...z.querySelectorAll("[class*='error'],[class*='erreur']")].map((e) => e.textContent.trim()).filter(Boolean).join(" | ").slice(0, 160);
    return { txt: z.innerText.trim().length, vis, err };
  });
  await page.screenshot({ path: join(ici, "sortie", `preuve-${n}.png`) });
  res.push({ n, clic: ok, ...m, rendu: ok && m.vis > 0 && !m.err });
}
for (const r of res) console.log(`${r.rendu ? "✓" : "✗"} ${r.n.padEnd(12)} éléments=${r.vis} texte=${r.txt} ${r.err ? "ERREUR " + r.err : ""}`);
console.log("requêtes externes :", externes.length, externes.slice(0, 5).join(" "));
await nav.close(); srv.close(); process.exit(res.every((r) => r.rendu) && !externes.length ? 0 : 1);
