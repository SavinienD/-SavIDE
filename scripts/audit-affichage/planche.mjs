#!/usr/bin/env node
// Planche avant / après de l'affichage d'Axecode — UNE commande, rejouable :
//   node scripts/audit-affichage/planche.mjs                  avant = c066912 (0.1.56), après = branche courante
//   node scripts/audit-affichage/planche.mjs --avant <rév>    autre version de référence
//   node scripts/audit-affichage/planche.mjs --sans-captures  réutilise les rendus précédents (mise en page seule)
//   node scripts/audit-affichage/planche.mjs --rapide         seulement les situations illustrées (~3 min)
// 1. lancer.mjs rend les scènes du banc (4 tailles de fenêtre, 3 tailles de texte) une
//    fois avec l'interface AVANT (--source <rév>), une fois avec celle de la branche ;
// 2. pour chaque correction, la même zone est découpée dans les deux rendus (JPEG) ;
// 3. une page HTML autonome est écrite (images intégrées, moins de 15 Mo) :
//    scripts/audit-affichage/sortie/planche/Axecode-affichage-avant-apres.html
// Les images viennent du banc (Chromium sans écran), pas de la WebView2 de Windows.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { trouverNavigateur } from "./navigateur.mjs";

const ici = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (nom, defaut) => {
  const i = argv.indexOf(`--${nom}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : defaut;
};
const drapeau = (nom) => argv.includes(`--${nom}`);
const AVANT = opt("avant", "c066912");
const SORTIE = resolve(opt("sortie", join(ici, "sortie", "planche")));
const FICHIER = join(SORTIE, "Axecode-affichage-avant-apres.html");
const RAPIDE = drapeau("rapide");
const QUALITE = Number(opt("qualite", "0.8"));
// Images prises à 125 % (mise à l'échelle Windows courante) : nettes sur un tel écran.
const ECHELLE = 1.25;
const PCT = Math.round(ECHELLE * 100);
const racine = resolve(ici, "../..");
const debut = Date.now();

// Une correction = une scène, une situation, la zone à montrer (sélecteurs CSS, null =
// toute la fenêtre) et une ligne en français simple. Les zones sont repérées par
// sélecteur, jamais par un libellé (traduits).
const CAS = [
  {
    id: "colonnes", scene: "c3", taille: "1366x768", zone: null,
    titre: "Trois colonnes de conversation",
    texte: "Avant, la 2e et la 3e colonne sortaient de l'écran : zone de saisie, bouton d'envoi et bouton pour fermer la colonne hors de portée. Maintenant, le panneau du chat s'élargit et les trois colonnes tiennent.",
  },
  {
    id: "sans-fournisseur", scene: "sans-fournisseur", taille: "1366x768", zone: [".colonnes-chat"],
    titre: "Sans fournisseur d'IA connecté, en trois colonnes",
    texte: "Le bouton pour connecter un fournisseur et les boutons voisins étaient coupés dans les colonnes de droite ; ils sont entiers dans chaque colonne.",
  },
  {
    id: "barre-titre", scene: "c1", taille: "800x600", zone: [".titlebar"],
    titre: "Barre de titre, fenêtre étroite",
    texte: "Les boutons de la barre de titre étaient rognés (il n'en restait que deux ou trois) ; ils utilisent maintenant toute la largeur libre de la barre.",
  },
  {
    id: "compositeur", scene: "c1", taille: "1366x768", zone: [".colonne-chat[data-focus='true'] .composer"],
    titre: "Zone de saisie : choix du modèle et de la réflexion",
    texte: "Le modèle et le niveau de réflexion n'affichaient que « O… » et « … » ; ils restent lisibles, les autres boutons passent à la ligne quand la place manque.",
  },
  {
    id: "onglets", scene: "onglets-nombreux", taille: "800x600", zone: [".colonne-chat[data-focus='true'] .onglets-chat"],
    titre: "Beaucoup d'onglets de conversation",
    texte: "Les onglets étaient écrasés à quelques pixels et leurs croix se chevauchaient ; chacun garde une largeur lisible et la barre d'onglets défile (à la molette aussi).",
  },
  {
    id: "accueil-compte", scene: "accueil", taille: "1366x768", zone: [".welcome__titlebar .titlebar__window-controls", "#root > .axc-btn"], marge: 14,
    titre: "Accueil : bouton du compte Axe Cloud",
    texte: "Le compte et « Se déconnecter » étaient posés sur Réduire / Agrandir / Fermer de Windows ; ils sont maintenant à leur gauche.",
  },
  {
    id: "tour-enchaine", scene: "tour-enchaine-coupe", taille: "1366x768", zone: [".colonne-chat[data-focus='true'] .chat-body"],
    titre: "Reprise après une coupure du flux",
    texte: "Quand un tour enchaîné était coupé puis relancé, la dernière réponse du tour précédent disparaissait de l'écran jusqu'à la fin du tour ; elle reste affichée (en bas).",
  },
  {
    id: "colonne-illisible", scene: "colonne-introuvable", taille: "1366x768", zone: [".colonne-chat[data-colonne='1']"],
    titre: "Conversation qui ne s'ouvre pas dans une colonne",
    texte: "« Ouverture de la conversation… » restait affiché pour toujours ; un message dit maintenant pourquoi, avec « Réessayer » et « Fermer l'onglet ».",
  },
  {
    id: "laterale", scene: "c1", taille: "800x600", zone: [".sidebar"],
    titre: "Barre latérale étroite",
    texte: "Les onglets Conversations / Agents n'affichaient que « C… » et « … », et le nom du dossier était illisible ; les onglets passent en icônes (nom au survol) et le nom du dossier reste lisible.",
  },
  {
    id: "agents", scene: "agents", taille: "1366x768", zone: [".sidebar__section--bottom"],
    titre: "Vue Agents",
    texte: "« 3 sous-agent(s) » passait sur deux lignes et le modèle était écrasé ; ils se rangent sous le nom de l'agent.",
  },
  {
    id: "explorateur-detache", scene: "c1-explorateur-ferme", taille: "1366x768", zone: [".volet-flottant"],
    titre: "Explorateur détaché dans une fenêtre",
    texte: "Détaché, l'explorateur n'occupait que la moitié de sa fenêtre et le nom du dossier disparaissait ; il remplit la fenêtre.",
  },
  {
    id: "reglages", scene: "reglages", taille: "800x600", zone: [".settings-pane"],
    titre: "Réglages, page « À propos », fenêtre étroite",
    texte: "Barre de défilement horizontale et lien sur deux lignes ; le texte passe à la ligne et les liens restent sur une ligne.",
  },
  {
    id: "accueil-haut", scene: "accueil", taille: "800x600", variante: "+texte10%", zone: null,
    titre: "Accueil dans une petite fenêtre",
    texte: "Le haut de l'écran d'accueil sortait de la fenêtre sans qu'on puisse y remonter ; la page commence en haut et défile.",
  },
];

// Corrections sans image : le dessin ne change pas, ou elles n'apparaissent qu'avec des
// libellés plus longs que ceux de la 0.1.56.
const SANS_IMAGE = [
  "Zones de clic portées à 20 px au moins (dessin inchangé ou presque) : boutons des onglets du terminal et de l'éditeur, croix des onglets de conversation, titre de la file d'attente, liens de fichiers, « Replier » et « Filtres » de la vue Agents, « Se déconnecter » de l'accueil.",
  "Titre de l'éditeur vide gardé sur une ligne quand l'éditeur est étroit, et lien cloud.exemple.invalid qui ne recouvre plus la fin de la liste de l'accueil (fenêtre basse, texte agrandi).",
];

const echapper = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const idSituation = (c) => `${c.taille}@${PCT}%${c.variante ?? ""}`;
const enClair = (c) => `Fenêtre ${c.taille.replace("x", " × ")}${c.variante ? ", texte agrandi de 10 %" : ""}`;
const git = (cmd) => execFileSync("git", cmd, { cwd: racine }).toString().trim();
const version = (rev) => {
  try {
    return JSON.parse(git(["show", `${rev}:package.json`])).version;
  } catch {
    return "?";
  }
};

// 1. Les deux séries de rendus (mêmes scènes, mêmes situations, même banc).
mkdirSync(SORTIE, { recursive: true });
const zones = {};
for (const c of CAS) if (c.zone) (zones[c.scene] ??= {})[c.id] = c.zone;
const fichierZones = join(SORTIE, "zones.json");
writeFileSync(fichierZones, JSON.stringify(zones, null, 1));
function rendre(nom, extra) {
  const sortie = join(SORTIE, nom);
  if (drapeau("sans-captures") && existsSync(join(sortie, "rapport.json"))) return sortie;
  const args = [join(ici, "lancer.mjs"), "--sortie", sortie, "--zones", fichierZones, "--travailleurs", opt("travailleurs", "4"), ...extra];
  if (RAPIDE) {
    args.push("--situations", [...new Set(CAS.map((c) => c.taille))].join(","), "--echelles", String(ECHELLE), "--texte", "1,1.1");
    args.push("--scenes", [...new Set(CAS.map((c) => c.scene))].join(","));
  }
  console.log(`\n== Rendus ${nom} : node ${args.slice(1).join(" ")}`);
  execFileSync(process.execPath, args, { stdio: "inherit" });
  return sortie;
}
const revAvant = git(["rev-parse", "--short", `${AVANT}^{commit}`]);
const dossierAvant = rendre("avant", ["--source", revAvant]);
const dossierApres = rendre("apres", []);
const rAvant = JSON.parse(readFileSync(join(dossierAvant, "rapport.json"), "utf8"));
const rApres = JSON.parse(readFileSync(join(dossierApres, "rapport.json"), "utf8"));
const vAvant = version(revAvant);
const vApres = JSON.parse(readFileSync(join(racine, "package.json"), "utf8")).version;
const nomAvant = `Avant (${vAvant})`;
const nomApres = vApres === vAvant ? "Après (corrigé)" : `Après (${vApres})`;

// 2. Découpe des zones (canvas d'un Chromium sans écran : aucune dépendance de plus).
const { default: puppeteer } = await import("puppeteer-core");
const nav = await puppeteer.launch({ executablePath: await trouverNavigateur(), headless: true, args: ["--no-sandbox"] });
const page = await nav.newPage();
function resultat(rapport, c) {
  return rapport.resultats.find((r) => r.scene === c.scene && r.situation === idSituation(c));
}
function cadre(r, c) {
  const L = r.largeur, H = r.hauteur;
  const z = c.zone ? r.zones?.[c.id] : null;
  if (c.zone && !z) console.warn(`Zone « ${c.id} » introuvable dans ${r.situation}/${r.scene} : fenêtre entière.`);
  if (!z) return { x: 0, y: 0, l: L, h: H, entier: true };
  const m = c.marge ?? 8;
  const x = Math.max(0, z.x - m), y = Math.max(0, z.y - m);
  return { x, y, l: Math.min(L, z.x + z.l + m) - x, h: Math.min(H, z.y + z.h + m) - y };
}
async function decouper(dossier, r, rect, qualite) {
  const b64 = readFileSync(join(dossier, r.capture)).toString("base64");
  return page.evaluate(async (donnees, rc, e, q) => {
    const img = new Image();
    img.src = "data:image/png;base64," + donnees;
    await img.decode();
    const x = Math.round(rc.x * e), y = Math.round(rc.y * e);
    const w = Math.min(img.naturalWidth - x, Math.round(rc.l * e));
    const h = Math.min(img.naturalHeight - y, Math.round(rc.h * e));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
    return c.toDataURL("image/jpeg", q);
  }, b64, rect, r.echelle ?? 1, qualite);
}

// 3. La page.
const parTaille = (rapport) => {
  const t = {};
  for (const [s, n] of Object.entries(rapport.parSituation)) {
    const k = s.split("@")[0];
    t[k] = (t[k] ?? 0) + n;
  }
  return t;
};
async function construire(qualite) {
  const sections = [];
  const manques = [];
  for (const c of CAS) {
    const ra = resultat(rAvant, c), rp = resultat(rApres, c);
    if (!ra || !rp) {
      manques.push(c.id);
      continue;
    }
    const figures = [];
    for (const [nom, r, dossier] of [[nomAvant, ra, dossierAvant], [nomApres, rp, dossierApres]]) {
      const rect = cadre(r, c);
      const src = await decouper(dossier, r, rect, qualite);
      figures.push(`<figure><figcaption>${echapper(nom)}</figcaption><img src="${src}" width="${Math.round(rect.l)}" height="${Math.round(rect.h)}" alt="${echapper(c.titre + " — " + nom)}"></figure>`);
    }
    const na = ra.defauts.length, np = rp.defauts.length;
    sections.push(`<section class="cas"><h2>${echapper(c.titre)}</h2><p>${echapper(c.texte)}</p><div class="paire">${figures.join("")}</div>` +
      `<p class="meta">${echapper(enClair(c))} · défauts relevés par le banc sur cet écran : ${na} → ${np}</p></section>`);
  }
  const ta = parTaille(rAvant), tp = parTaille(rApres);
  const lignes = Object.keys(ta)
    .sort((a, b) => Number(a.split("x")[0]) - Number(b.split("x")[0]))
    .map((k) => `<tr><td>${echapper(k.replace("x", " × "))}</td><td>${ta[k]}</td><td>${tp[k] ?? "—"}</td></tr>`)
    .join("");
  const nbScenes = rApres.scenes.length, nbSituations = rApres.situations.length;
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Axecode : affichage, avant / après</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#111317;color:#e8e9ec;font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:1500px;margin:0 auto;padding:24px 20px 48px}
h1{font-size:24px;margin:0 0 4px}
.sous{color:#9aa0aa;margin:0 0 18px}
.tuiles{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 14px}
.tuile{background:#1b1e24;border-radius:12px;padding:12px 16px;min-width:170px}
.tuile b{display:block;font-size:28px;line-height:1.2}
.tuile.ok b{color:#4ade80}.tuile.ko b{color:#fc610b}
table{border-collapse:collapse;margin:0 0 26px;font-size:14px}
td,th{padding:4px 14px;border-bottom:1px solid #2a2e36;text-align:right}
td:first-child,th:first-child{text-align:left}
.cas{background:#16191e;border-radius:14px;padding:16px 18px;margin:0 0 18px}
.cas h2{font-size:18px;margin:0 0 4px}
.cas p{margin:0 0 10px;max-width:980px}
.paire{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
figure{margin:0;max-width:100%}
figcaption{font-size:13px;font-weight:600;color:#9aa0aa;margin:0 0 4px}
img{display:block;max-width:100%;height:auto;border:1px solid #2a2e36;border-radius:6px}
.meta{font-size:13px;color:#9aa0aa;margin:8px 0 0!important}
ul{margin:0 0 10px;padding-left:20px}
.pied{font-size:13px;color:#9aa0aa}
</style></head><body><main>
<h1>Axecode : défauts d'affichage, avant / après</h1>
<p class="sous">Textes coupés, boutons qui se chevauchent ou sortent de l'écran, de 800 à 1920 px de large, à 100, 125 et 150 %, avec 1 à 3 colonnes de conversation.</p>
<div class="tuiles">
<div class="tuile ko"><b>${rAvant.totalDefauts}</b>défauts ${echapper(nomAvant.toLowerCase())}</div>
<div class="tuile ${rApres.totalDefauts ? "ko" : "ok"}"><b>${rApres.totalDefauts}</b>défauts ${echapper(nomApres.toLowerCase())}</div>
<div class="tuile"><b>${rApres.rendus}</b>écrans contrôlés (${nbScenes} vues × ${nbSituations} tailles de fenêtre, échelles et tailles de texte)</div>
</div>
<table><tr><th>Fenêtre</th><th>${echapper(nomAvant)}</th><th>${echapper(nomApres)}</th></tr>${lignes}</table>
${sections.join("\n")}
<section class="cas"><h2>Corrigé aussi, sans changement visible ici</h2><ul>${SANS_IMAGE.map((t) => `<li>${echapper(t)}</li>`).join("")}</ul></section>
<p class="pied">Images du banc d'essai : la vraie interface d'Axecode affichée par Chromium sans écran (le moteur de WebView2), avec des données d'exemple. Ce n'est pas votre écran : à confirmer sur le PC après installation.${manques.length ? ` Non illustré (écran absent des rendus) : ${echapper(manques.join(", "))}.` : ""}<br>
Rendus : avant ${echapper(rAvant.revision ?? revAvant)}, après ${echapper(rApres.revision ?? "")} · ${echapper(new Date().toLocaleString("fr-FR"))}</p>
</main></body></html>
`;
}
let qualite = QUALITE;
let html = await construire(qualite);
while (Buffer.byteLength(html) > 14.5e6 && qualite > 0.35) {
  qualite = Math.round((qualite - 0.15) * 100) / 100;
  console.log(`Page trop lourde : JPEG à ${qualite}`);
  html = await construire(qualite);
}
await nav.close();
writeFileSync(FICHIER, html);
const taille = statSync(FICHIER).size;
console.log(`\nPlanche : ${FICHIER} — ${(taille / 1e6).toFixed(2)} Mo, ${CAS.length} corrections illustrées, JPEG ${qualite}`);
console.log(`Défauts : ${nomAvant} ${rAvant.totalDefauts}, ${nomApres} ${rApres.totalDefauts} (${rApres.rendus} rendus) — ${Math.round((Date.now() - debut) / 1000)} s`);
if (taille > 15e6) {
  console.error("ÉCHEC : la planche dépasse 15 Mo.");
  process.exit(1);
}
