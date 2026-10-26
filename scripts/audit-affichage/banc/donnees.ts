// Donnees de demonstration du banc d'affichage, fideles a l'usage de l'utilisateur :
// longue conversation (reflexions, cartes d'outils, erreurs), sous-agents au
// travail, file d'attente, compaction, titres tres longs.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const WS = "C:\\Users\\utilisateur\\Documents\\Projets\\axecode";
export const NOM_WS = "axecode";
export const MODELE = { provider: "anthropic", name: "claude-opus-5-5", effort: "high" as const };
export const MODES = { act: MODELE, plan: MODELE, goal: MODELE };
export const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);

export const TITRE_LONG =
  "Corriger tous les défauts d'affichage de la barre de titre, du compositeur et des colonnes à 800 px avec la mise à l'échelle Windows à 150 %";

const TITRES = [
  TITRE_LONG,
  "Facture OVH d'octobre : rapprochement des lignes et export comptable",
  "Tri des tickets Jira du jour",
  "Migration des postes du centrex du client (fichier FIC) pour le cabinet Martin et l'atelier Durand",
  "VPN BBATI",
  "Rapport DMARC hmcc.fr",
  "Compilation croisée Windows de la 0.1.57 et publication de l'installeur dans les téléchargements",
  "Questions sur le pare-feu pfSense du client",
  "Résumé de la réunion",
  "Script PowerShell de sauvegarde des mots de passe",
  "Agent vocal Asterisk : étude",
  "Nouvelle conversation",
];

export function idConv(i: number): string {
  return `c-${String(i + 1).padStart(3, "0")}`;
}

export function conversations(n = 24) {
  const out = [] as { id: string; title: string; updatedAtMs: number; archived?: boolean }[];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: idConv(i), title: TITRES[i % TITRES.length] + (i >= TITRES.length ? ` (${i})` : ""), updatedAtMs: T0 - i * 3_600_000 });
  }
  return out;
}

export function titreDe(id: string): string {
  const n = Number(id.replace(/^c-0*/, "")) - 1;
  return conversations().find((c) => c.id === id)?.title ?? TITRES[(n >= 0 ? n : 0) % TITRES.length];
}

const PENSEE =
  "Je dois d'abord comprendre pourquoi le bouton Send est coupé dans une colonne étroite. " +
  "Le compositeur aligne le sélecteur de modèle, le niveau de réflexion, le mode, le micro, la lecture à voix haute, " +
  "la compaction, /refine, /tree et la jauge de contexte sur une seule ligne. Sous 420 px, la somme dépasse la largeur " +
  "disponible et flex-shrink écrase le dernier élément. ".repeat(6);

let nOutil = 0;
function outil(name: string, input: any, sortie: string, erreur = false, meta: any = null) {
  nOutil += 1;
  const id = `toolu_${String(nOutil).padStart(4, "0")}`;
  return {
    appel: { type: "tool_call", id, name, input },
    resultat: { type: "tool_result", tool_call_id: id, content: sortie, is_error: erreur, meta },
  };
}

function echange(question: string, etapes: { pensee?: string; duree?: number; texte?: string; outils?: ReturnType<typeof outil>[] }[]) {
  const msgs: any[] = [{ role: "user", parts: [{ type: "text", text: question }] }];
  for (const e of etapes) {
    const parts: any[] = [];
    if (e.pensee) parts.push({ type: "thinking", text: e.pensee, meta: { duration_ms: e.duree ?? 251_200 } });
    if (e.texte) parts.push({ type: "text", text: e.texte });
    for (const o of e.outils ?? []) parts.push(o.appel);
    msgs.push({ role: "assistant", parts });
    if (e.outils?.length) msgs.push({ role: "user", parts: e.outils.map((o) => o.resultat) });
  }
  return msgs;
}

const DIFF = [
  {
    relativePath: "src/styles.css", kind: "modified", summary: "+2 −1", binary: false, addedLines: 2, removedLines: 1, truncated: false,
    lines: [
      { kind: "context", text: ".composer__gauge {" },
      { kind: "removed", text: "  min-width: 140px;" },
      { kind: "added", text: "  min-width: 0;" },
      { kind: "added", text: "  flex: 0 1 auto;" },
      { kind: "context", text: "}" },
    ],
  },
];

export function historique(options: { compaction?: boolean; long?: boolean } = {}) {
  nOutil = 0;
  const msgs: any[] = [];
  if (options.compaction) {
    msgs.push({ role: "user", parts: [{ type: "text", text: "Résumé de la conversation compactée : on corrige l'affichage d'Axecode ; le banc d'essai tourne ; il reste la barre de titre et les colonnes.", meta: { compaction_summary: true } }] });
    msgs.push({ role: "user", parts: [{ type: "text", text: "", meta: { compaction_marker: true, compacted_at_ms: T0 - 7_200_000 } }] });
  }
  msgs.push(
    ...echange(
      "Le bouton Send est coupé quand j'ouvre trois colonnes, et les icônes passent par-dessus « Connect a provider ». Tu peux regarder ? Il faut que ça marche de 800 à 1920 px.",
      [
        {
          pensee: PENSEE,
          duree: 251_200,
          texte: "Je regarde le compositeur et ses règles CSS.",
          outils: [
            outil("bash", { command: "rg -n \"composer__\" src/components/chat/ChatPane.tsx | head -40", description: "Chercher les classes du compositeur" }, "3843:  <span>Connect a provider</span>\n3901:  className=\"composer__send\"\n".repeat(8)),
            outil("read", { path: "src/styles.css", offset: 4200, limit: 120 }, ".composer { display: flex; }\n".repeat(30)),
          ],
        },
        {
          pensee: "La jauge de contexte a une largeur minimale fixe ; c'est elle qui pousse Send hors de la colonne.",
          duree: 12_400,
          texte:
            "Trouvé : la **jauge de contexte** garde `min-width: 140px`. Je la laisse se réduire et je passe les libellés secondaires en icônes sous 420 px.\n\n" +
            "| Largeur | Avant | Après |\n|---|---|---|\n| 800 px | Send coupé | OK |\n| 1024 px | OK | OK |\n\n" +
            "```css\n.composer__gauge { min-width: 0; flex: 0 1 auto; }\n.composer__send { flex: none; white-space: nowrap; }\n```",
          outils: [
            outil("edit_file", { path: "src/styles.css", old_string: "min-width: 140px", new_string: "min-width: 0" }, "Fichier modifié.", false, { file_changes: DIFF }),
            outil("bash", { command: "npx tsc -p . && node --test tests/", description: "Vérifier" }, "stream error: connection reset by peer (os error 104) while reading the response body from https://api.anthropic.com/v1/messages", true),
          ],
        },
        { texte: "Le test a été coupé par une erreur réseau (`stream error: connection reset by peer`). Je relance." },
      ],
    ),
  );
  const tours = options.long === false ? 1 : 5;
  for (let i = 0; i < tours; i += 1) {
    msgs.push(
      ...echange(
        i % 2 === 0
          ? "Et à 125 % de mise à l'échelle, la barre de titre passe sur deux lignes. Regarde aussi les onglets quand il y en a beaucoup."
          : "ok continue",
        [
          {
            pensee: "Je vérifie la barre de titre à 800 px : les dernières icônes sont rognées.",
            duree: 3_100 + i * 1000,
            texte: "Je lance le banc sur les quatre largeurs.",
            outils: [
              outil("bash", { command: "node scripts/audit-affichage/lancer.mjs --situations 800x600", description: "Banc d'affichage" }, "Situation 800x600@100% : 3 défauts\nSituation 800x600@150% : 5 défauts\n".repeat(4)),
              outil("python", { code: "import json\nrapport = json.load(open('sortie/rapport.json'))\nprint(len(rapport['defauts']))" }, "Traceback (most recent call last):\n  File \"<stdin>\", line 2, in <module>\nFileNotFoundError: [Errno 2] No such file or directory: 'sortie/rapport.json'", true),
            ],
          },
          { texte: "Voici l'état : 8 défauts restants, surtout dans la barre de titre et les onglets de colonnes. Je corrige d'abord la barre de titre, puis les colonnes, puis le compositeur." },
        ],
      ),
    );
  }
  return msgs;
}

export function conversationSauvee(id: string, options: { compaction?: boolean; long?: boolean } = {}) {
  return {
    id,
    workspaceId: WS,
    title: titreDe(id),
    model: MODELE,
    modeModelSettings: MODES,
    systemPrompt: "",
    todoList: {
      active: true,
      nextId: 5,
      tasks: [
        { id: "1", text: "Banc d'essai : captures et rapport JSON", status: "done" },
        { id: "2", text: "Inventaire des défauts avec captures", status: "done" },
        { id: "3", text: "Corriger la barre de titre à 800 px", status: "in_progress" },
        { id: "4", text: "Planche avant / après pour L'utilisateur", status: "pending" },
      ],
    },
    planWorkflow: { status: "idle" },
    goalWorkflow: { status: "idle" },
    history: historique(options),
  };
}

export function entrees(dossier: string) {
  const base = dossier ? dossier + "/" : "";
  const noms = dossier
    ? ["Workspace.tsx", "ChatPane.tsx", "stream.ts", "colonnes.ts", "fileAttente.ts", "styles-de-la-barre-de-titre-tres-longues.css"]
    : ["crates", "docs", "scripts", "src", "src-tauri", "tests", "web", "Cargo.toml", "package.json", "README.md", "RAPPORT.md", "un-nom-de-fichier-vraiment-tres-long-pour-voir-le-debordement.md"];
  return noms.map((name) => {
    const dir = !name.includes(".");
    return { name, relativePath: base + name, absolutePath: WS + "\\" + (base + name).replace(/\//g, "\\"), kind: dir ? "directory" : "file", hasChildren: dir };
  });
}

export function git() {
  return {
    gitAvailable: true,
    ghAvailable: false,
    isRepository: true,
    workspacePath: WS,
    repoRoot: WS,
    currentBranch: "night-ui-audit",
    mainBranch: "main",
    dirtyCount: 3,
    status: [
      { path: "src/styles.css", indexStatus: " ", worktreeStatus: "M", kind: "modified", staged: false },
      { path: "src/components/Workspace.tsx", indexStatus: " ", worktreeStatus: "M", kind: "modified", staged: false },
      { path: "scripts/audit-affichage/lancer.mjs", indexStatus: "?", worktreeStatus: "?", kind: "untracked", staged: false },
    ],
    worktrees: [],
    branches: [{ name: "night-ui-audit", kind: "local", current: true, upstream: null }],
    error: null,
  };
}

export function contexte(used = 168_000) {
  return {
    usedTokens: used, contextWindow: 200_000, preferredWindow: 200_000, maxOutputTokens: 32_000,
    inputTokens: used, outputTokens: 4_000, reasoningTokens: 2_000, cacheReadTokens: 120_000, cacheCreationTokens: 8_000,
    exact: true, error: null,
    breakdown: [
      { key: "system", label: "System prompt", tokens: 12_000 },
      { key: "tools", label: "Tools", tokens: 18_000 },
      { key: "messages", label: "Messages", tokens: used - 30_000 },
    ],
  };
}

// axe:html — page des scènes « html-* » : image et style locaux, image distante
// (doit être bloquée par la CSP de l'aperçu) et script (coupé par défaut).
export const PAGE_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Rapport client</title>
<link rel="stylesheet" href="style.css">
<style>body{font-family:sans-serif;padding:24px} h1{color:#fc610b}</style></head>
<body><h1>Rapport du cabinet Martin</h1>
<p>Intervention du 23 octobre : standard téléphonique, 12 postes.</p>
<img src="logo.png" alt="logo"> <img src="https://exemple.invalid/pixel.png" alt="pixel distant">
<script>document.body.insertAdjacentHTML("beforeend", "<p id=js>script exécuté</p>")</script>
</body></html>`;
