// depot — glisser-déposer : position de Tauri → pixels CSS, zone visée, dépôt sans chemin.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const Module = require("node:module");
function charger(rel) {
  const p = path.resolve(__dirname, rel);
  const js = ts.transpileModule(fs.readFileSync(p, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = new Module(p, module); m.filename = p; m._compile(js, p); return m.exports;
}
const D = charger("../src/lib/depot.ts");
const ws = fs.readFileSync(path.resolve(__dirname, "../src/components/Workspace.tsx"), "utf8");

test("pointCss : point physique (Windows) ramené en CSS", () => {
  assert.deepEqual(D.pointCss({ x: 1600, y: 1200 }, 2), { x: 800, y: 600 });
  assert.deepEqual(D.pointCss({ x: 1500, y: 900 }, 1.5, 1.25), { x: 800, y: 480 });
  assert.deepEqual(D.pointCss({ x: 10, y: 10 }, 0, NaN), { x: 10, y: 10 });
  const champ = { left: 700, right: 900, top: 550, bottom: 650 };
  assert.equal(D.dansRect(D.pointCss({ x: 1600, y: 1200 }, 2), champ), true);
  assert.equal(D.dansRect({ x: 1600, y: 1200 }, champ), false); // ancien comportement : à côté
});

test("dépôt sans chemin : message clair (macOS : vignette de capture, ⌘V)", () => {
  assert.match(D.messageDepotVide(true), /⌘V/);
  assert.match(D.messageDepotVide(false), /Ctrl\+V/);
  assert.match(ws, /messageDepotVide\(estMac\(\)\)/);
  assert.match(ws, /pointCss\(\s*physique,/);
});

// Position telle que wry la donne : Windows = pixels physiques de la zone cliente ;
// macOS (draggingLocation) et Linux (GTK) = points logiques.
function positionTauri(css, echelle, windows) {
  return windows ? { x: css.x * echelle, y: css.y * echelle } : { x: css.x, y: css.y };
}
// Disposition mesurée au banc d'affichage (scène c1) : chat à droite, 397 px de large,
// sous la barre de titre (66 px), saisie en bas.
function disposition(l, h) {
  return { chat: { left: l - 420, right: l - 23, top: 66, bottom: h } };
}
const tailles = [[900, 600], [1280, 800], [1440, 900], [1728, 1117], [2560, 1440]];

test("échelle du dépôt : divisée seulement sous Windows", () => {
  assert.equal(D.echelleDepot(true, 2), 2);
  assert.equal(D.echelleDepot(true, 1.5), 1.5);
  assert.equal(D.echelleDepot(true, null), 1);
  assert.equal(D.echelleDepot(false, 2), 1);
  assert.equal(D.echelleDepot(false, 1), 1);
});

for (const echelle of [1, 2]) {
  for (const windows of [false, true]) {
    test(`toute la zone du chat reçoit le dépôt (${windows ? "Windows" : "macOS/Linux"}, ×${echelle})`, () => {
      for (const [l, h] of tailles) {
        const { chat } = disposition(l, h);
        const points = [];
        for (let x = chat.left + 1; x < chat.right; x += 17) for (let y = chat.top + 1; y < chat.bottom; y += 13) points.push({ x, y });
        points.push({ x: chat.left + 2, y: chat.bottom - 2 }, { x: (chat.left + chat.right) / 2, y: chat.bottom - 30 }); // saisie
        for (const p of points) {
          const q = D.pointCss(positionTauri(p, echelle, windows), D.echelleDepot(windows, echelle), 1);
          assert.equal(D.dansRect(q, chat), true, `${l}x${h} ${JSON.stringify(p)}`);
        }
        // hors du chat : pas de dépôt
        const dehors = D.pointCss(positionTauri({ x: chat.left - 20, y: 300 }, echelle, windows), D.echelleDepot(windows, echelle), 1);
        assert.equal(D.dansRect(dehors, chat), false);
      }
    });
  }
}

test("ancien calcul sur Retina : rien dans le chat à droite, un coin seulement d'un chat large", () => {
  const part = (chat) => {
    let dedans = 0, total = 0;
    for (let x = chat.left; x <= chat.right; x += 4) for (let y = chat.top; y <= chat.bottom; y += 4) {
      total++;
      if (D.dansRect(D.pointCss({ x, y }, 2, 1), chat)) dedans++; // macOS : point logique ÷ 2
    }
    return dedans / total;
  };
  for (const [l, h] of tailles) assert.equal(part(disposition(l, h).chat), 0, `${l}x${h}`);
  // conversation seule (sans éditeur), plein écran 1728x1117 : les bandes gauche et haute
  // ne répondent pas, seul le bas à droite marche
  const large = part({ left: 300, right: 1728, top: 66, bottom: 1117 });
  assert.ok(large > 0 && large < 0.8, String(large));
  assert.equal(D.dansRect(D.pointCss({ x: 400, y: 1000 }, 2, 1), { left: 300, right: 1728, top: 66, bottom: 1117 }), false);
  // le calcul corrigé : tout le chat
  assert.equal(D.dansRect(D.pointCss({ x: 310, y: 80 }, D.echelleDepot(false, 2), 1), { left: 300, right: 1728, top: 66, bottom: 1117 }), true);
});

test("zoom de l'interface pris en compte", () => {
  const { chat } = disposition(1440, 900);
  const css = { x: chat.left + 10, y: chat.bottom - 5 };
  const zoom = 1.25;
  const pos = { x: css.x * zoom, y: css.y * zoom }; // point logique (macOS) au zoom 125 %
  const q = D.pointCss(pos, D.echelleDepot(false, 2), zoom);
  assert.ok(Math.abs(q.x - css.x) < 1e-9 && Math.abs(q.y - css.y) < 1e-9);
});

test("plusieurs conversations : la zone sous le pointeur, la plus petite devant", () => {
  const zones = [
    { cle: "col1", rect: { left: 0, right: 500, top: 0, bottom: 800 } },
    { cle: "col2", rect: { left: 500, right: 1000, top: 0, bottom: 800 } },
    { cle: "detache", rect: { left: 300, right: 700, top: 100, bottom: 600 } },
  ];
  assert.equal(D.zoneSous({ x: 100, y: 700 }, zones), "col1");
  assert.equal(D.zoneSous({ x: 900, y: 50 }, zones), "col2");
  assert.equal(D.zoneSous({ x: 600, y: 300 }, zones), "detache");
  assert.equal(D.zoneSous({ x: 1200, y: 300 }, zones), null);
  assert.equal(D.zoneSous(null, zones), null);
});

test("Workspace : échelle selon le système, conversation mesurée à chaque événement", () => {
  assert.match(ws, /echelleDepot\(estWindows\(\)/);
  assert.match(ws, /const zoneChat = chatSousPoint\(position\)/);
  assert.doesNotMatch(ws, /dansRect\(position, chatRect\)/);
  const cp = fs.readFileSync(path.resolve(__dirname, "../src/components/chat/ChatPane.tsx"), "utf8");
  assert.match(cp, /cible !== zoneDepotRef\.current\) return;/);
  assert.match(cp, /ref=\{refZoneDepot\}/);
});
