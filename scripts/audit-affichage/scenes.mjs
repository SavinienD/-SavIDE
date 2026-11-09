// Scenes du banc d'affichage : etat de l'appli a rendre, et gestes pour y arriver.
// Chaque scene est rejouee dans chaque situation (taille de fenetre x mise a l'echelle x texte).
// Témoins (« sel: » + sélecteur CSS d'un élément visible) : jamais un libellé de
// l'interface, qui est traduit. « attendus » : textes de NOS données (pas de
// l'interface) qui doivent rester affichés (règle texte-disparu).
import { WS_BANC as WS } from "./constantes.mjs";
import { scenesForge, scenesGit } from "./scenesGit.mjs"; // panneau Git, PR, issues
import { SCENES_WORKTREES } from "./scenes-worktrees.mjs"; // worktrees
import { SCENES_REVUE } from "./scenesRevue.mjs"; // revue des changements
import { SCENES_EDITEUR } from "./scenes-editeur.mjs";
import { SCENES_INTEROP } from "./scenes-interop.mjs";

const ids = (n, depart = 0) => Array.from({ length: n }, (_, i) => `c-${String(depart + i + 1).padStart(3, "0")}`);
const recents25 = () => Array.from({ length: 25 }, (_, i) => ({ path: `C:\\Users\\utilisateur\\Documents\\Clients\\client-${String(i + 1).padStart(2, "0")}`, name: `client-${String(i + 1).padStart(2, "0")}`, lastOpenedMs: 1_790_000_000_000 - i * 3_600_000 }));
const EPINGLES = () => [
  { path: "C:\\Users\\utilisateur\\Documents\\Clients\\client-12", name: "client-12" },
  { path: "C:\\Users\\utilisateur\\Documents\\Clients\\client-07", name: "client-07" },
  { path: "C:\\Users\\utilisateur\\Documents\\Ancien-projet", name: "Ancien-projet", absent: true },
];
// formes réelles (sessions.list du service du poste) : préfixe \\?\ côté service,
// chemin simple dans les dossiers récents.
const SESSIONS_DOSSIER = (parent, enfants) => {
  const ws = "\\\\?\\C:\\Users\\utilisateur\\Documents\\mon-projet";
  const s = (id, name, status, parentId) => ({ id, name, status, parentId, workspaceId: ws, children: [], archived: false, scratch: false,
    model: { provider: "anthropic", name: "claude-opus-5-5" }, createdAtMs: 1_792_483_646_503, updatedAtMs: 1_793_890_099_980, entryCount: 6656 });
  return [s("45127dc0-5b2f-4f50-a166-5a7523cc769e", "principal", parent),
    s("ec1006d0-ea7d-434a-9bb9-cee9728310c4", "sous-agent-1", enfants, "45127dc0-5b2f-4f50-a166-5a7523cc769e"),
    s("507297f4-0000-4000-8000-000000000000", "sous-agent-2", enfants, "45127dc0-5b2f-4f50-a166-5a7523cc769e"),
    { ...s("550dc56f-0000-4000-8000-000000000000", "wifis", "inactive"), workspaceId: "\\\\?\\C:\\Users\\utilisateur\\Documents\\compta" }];
};
// onglet Agents (capture « 0 · 0 · 13 ») : la conversation c-001 travaille (tour envoyé par la
// fenêtre, le service la voit « déchargée »), 2 sous-agents tournent, 10 ont fini ; chemins du service en \\?\.
const SESSIONS_AGENTS = () => {
  const ws = "\\\\?\\" + WS;
  const s = (id, name, status, parentId) => ({ id, name, status, parentId, workspaceId: ws, children: [], archived: false, scratch: false,
    model: { provider: "anthropic", name: "claude-opus-5-5" }, createdAtMs: 1_792_483_646_503, updatedAtMs: 1_793_890_099_980, entryCount: 120 });
  return [s("c-001", "Conversation du banc", "inactive"), s("c-002", "Autre conversation", "inactive"),
    s("sa-1", "verif-tests", "running", "c-001"), s("sa-2", "revue-code", "running", "c-001"),
    ...Array.from({ length: 10 }, (_, i) => s(`fini-${i + 1}`, `t-fini-${i + 1}`, i % 2 ? "idle" : "inactive", "c-001"))];
};
// Vue « Tableau » : c-001 attend une réponse, c-002 a fini (non lu), c-003 a
// échoué, un sous-agent de c-001 travaille, deux conversations au repos (repliées).
const SESSIONS_TABLEAU = () => {
  const ws = "\\\\?\\" + WS;
  const s = (id, name, status, parentId, updatedAtMs = 1_793_890_099_980) => ({ id, name, status, parentId, workspaceId: ws, children: [], archived: false, scratch: false,
    model: { provider: "anthropic", name: "claude-opus-5-5" }, createdAtMs: 1_792_483_646_503, updatedAtMs, entryCount: 120 });
  return [s("c-001", TITRES["c-001"], "idle"), s("c-002", TITRES["c-002"], "inactive"), s("c-003", TITRES["c-003"], "idle"),
    s("sa-1", "t-lotA", "running", "c-001"), s("c-004", TITRES["c-004"], "inactive", undefined, 1_793_000_000_000), s("c-005", TITRES["c-005"], "idle", undefined, 1_792_900_000_000)];
};
const NOTIFS_TABLEAU = () => {
  const t = 1_793_890_099_980;
  const ev = (cle, genre, sessionId, titre, texte, lu = false) => ({ cle, genre, sessionId, titre, texte, dossier: "\\\\?\\" + WS, ts: t, lu });
  return {
    evenements: [
      ev("c-001:attente:1", "attente", "c-001", TITRES["c-001"], "Attend votre réponse\u00a0: Je relance le banc sur les quatre largeurs ou je publie tout de suite la 0.1.86 avec ces corrections ?"),
      ev("c-002:fini:1", "fini", "c-002", TITRES["c-002"], "Fini\u00a0: Les 42 lignes sont rapprochées, l'export comptable est dans exports/ovh-octobre.csv."),
      ev("c-003:echec:1", "echec", "c-003", TITRES["c-003"], "Échec\u00a0: retryable stream error: HTTP 529 overloaded_error: Overloaded"),
      { cle: "info:1", genre: "info", titre: "Worktree prêt", texte: "correctif-panier : dépendances installées, prêt à travailler.", ts: t - 60_000, lu: true },
    ],
    etats: {
      "c-001": { genre: "attente", depuis: t, texte: "Attend votre réponse\u00a0: Je relance le banc sur les quatre largeurs ou je publie tout de suite la 0.1.86 avec ces corrections ?", lu: false },
      "c-002": { genre: "fini", depuis: t, texte: "Fini\u00a0: Les 42 lignes sont rapprochées, l'export comptable est dans exports/ovh-octobre.csv.", lu: false },
      "c-003": { genre: "echec", depuis: t, texte: "Échec\u00a0: retryable stream error: HTTP 529 overloaded_error: Overloaded", lu: false },
    },
    reglages: { systeme: true, fini: true, attente: true, echec: true, sousAgents: false, son: true, nePasDeranger: false },
    nonLus: 3,
  };
};
const RECENTS_ACTIVITE = () => [
  { path: "C:\\Users\\utilisateur\\Documents\\site-web", name: "site-web", lastOpenedMs: 1_793_890_000_000 },
  { path: "C:\\Users\\utilisateur\\Documents\\mon-projet", name: "mon-projet", lastOpenedMs: 1_793_880_000_000 },
  { path: "C:\\Users\\utilisateur\\Documents\\compta", name: "compta", lastOpenedMs: 1_793_870_000_000 },
];
// ordre-dossiers — trois dossiers récents : l'espace du banc (1), cabinet-martin (2), atelier-durand (3).
const RECENTS_TROIS = () => [
  { path: WS, name: "savide", lastOpenedMs: 1_790_000_000_000 },
  { path: "C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin", name: "cabinet-martin", lastOpenedMs: 1_789_990_000_000 },
  { path: "C:\\Users\\utilisateur\\Documents\\Clients\\atelier-durand", name: "atelier-durand", lastOpenedMs: 1_789_980_000_000 },
];
const TITRES = {
  "c-001": "Corriger tous les défauts d'affichage de la barre de titre, du compositeur et des colonnes à 800 px avec la mise à l'échelle Windows à 150 %",
  "c-002": "Facture OVH d'octobre : rapprochement des lignes et export comptable",
  "c-003": "Tri des tickets Jira du jour",
  "c-004": "Migration des postes du centrex du client (fichier FIC) pour le cabinet Martin et l'atelier Durand",
  "c-005": "VPN du client",
  "c-006": "Rapport DMARC exemple.fr",
  "c-007": "Compilation croisée Windows de la 0.1.57 et publication de l'installeur dans les téléchargements",
  "c-008": "Questions sur le pare-feu pfSense du client",
  "c-009": "Résumé de la réunion",
  "x-404": "Ancienne conversation au fichier abîmé",
};
// Tour refusé par le compteur du cloud : événements tels que le pont du démon les émet
// (src-tauri/src/daemon_client.rs : turn_error → error, puis turn_finished).
const WS_CLOUD = "axe-cloud://axe-cloud/home/collegue/work";
const ERREUR_503 = "retryable stream error: HTTP 503 Service Unavailable: api_error: Clé Anthropic du serveur indisponible. Préviens l'administrateur.";
const tour = (conversationId, message) =>
  [{ type: "turn_started" }, { type: "error", message }, { type: "turn_finished" }].map((event, i) => ({ workspaceId: WS_CLOUD, conversationId, sequence: i + 1, event }));
const tourFini = (conversationId) =>
  [{ type: "turn_started" }, { type: "text_started" }, { type: "text_chunk", delta: "Bonjour." }, { type: "text_finished" }, { type: "turn_finished" }]
    .map((event, i) => ({ workspaceId: WS_CLOUD, conversationId, sequence: i + 1, event }));
const FIN_TOUR_PRECEDENT = "Fin du tour précédent : les colonnes tiennent dans le panneau, je relance le banc sur les quatre largeurs.";
const onglets = (liste) => liste.map((id) => ({ id, titre: TITRES[id] ?? id }));
// defil178 — liens des réponses de la conversation « liensHistorique » (donnees.ts) et
// clic sur l'un d'eux dans une colonne : au milieu (le lien du milieu, centré) ou tout en bas
// (le dernier lien) ; ouvre un onglet de l'éditeur (fichier) ou le navigateur (URL).
const LIENS = { fichier: ".md .chat-file-link", url: ".md .chat-link[title^='https://github']", markdown: ".md .chat-link[title^='https://docs']" };
const clicLien = (col, genre, position) => ({
  nom: `${genre}-${position}-colonne${col}`, col, sel: LIENS[genre], position,
  rang: position === "bas" ? "dernier" : undefined, ouvre: genre === "fichier" ? "fichier" : "url",
});

/** Stockage local d'un espace avec ces colonnes de conversation. */
function colonnes(cols, poids) {
  const tous = cols.flat();
  const s = {
    [`axe:v2:onglets-chat:${WS}`]: onglets(tous),
    [`axe:v2:colonnes-chat:${WS}`]: { colonnes: cols, focus: 0 },
  };
  if (poids) s[`axe:v2:colonnes-chat-largeurs:${WS}`] = poids;
  return s;
}
const fileAttente = (id, n) => ({
  [`axe:file-attente:${id}`]: Array.from({ length: n }, (_, i) => ({
    id: `f-${i + 1}`,
    text: [
      "Quand tu auras fini, relance le banc à 800 px avec le texte agrandi et envoie-moi la planche.",
      "ok",
      "Et vérifie aussi les onglets de colonnes quand il y en a beaucoup, avec des titres très longs qui ne tiennent pas.",
    ][i % 3],
    attachments: [],
  })),
});
const explorateurFerme = (largeur, hauteur) => ({
  "axe:v2:volets": [
    { cle: "explorateur", volet: "explorateur", exemplaire: 0, x: Math.round(largeur * 0.25), y: 60, largeur: 280, hauteur: Math.max(170, Math.round(hauteur * 0.35)), z: 1 },
    { cle: "panneauBas", volet: "panneauBas", exemplaire: 0, x: Math.round(largeur * 0.25), y: Math.round(hauteur * 0.5), largeur: 280, hauteur: Math.max(170, Math.round(hauteur * 0.35)), z: 2 },
  ],
});

// Réglages > Outils : l'élément « cible » amené au milieu de l'écran, puis les clics suivants.
const REGISTRE = (cible, ...suite) => ({ stockage: () => colonnes([ids(1)]), reglages: true,
  clics: [".settings-pane__nav-item[data-section='repl']"], cliquer: [cible, ...suite], defilerAvantClic: true, pauseClics: 500 });

// Quotas — reprises prévues (stockage « reprise.file ») : la conversation c-001 et un sous-agent au nom long.
const REPRISES = () => {
  const t0 = Date.now();
  const r = (sessionId, parentId, nom) => ({ sessionId, parentId, nom, provider: "anthropic", aMs: t0 + 2 * 3_600_000 + 6 * 60_000, source: "quota", essais: 0, creeMs: t0 });
  return [r("c-001", null, "Conversation du banc"), r("sa-1", "c-001", "t-lotA-correction-des-colonnes-du-banc-a-800-px-et-du-compositeur")];
};

const MCP_SERVEURS = [
  { id: "node_repl", name: "node_repl", command: "C:\\Users\\utilisateur\\AppData\\Local\\OpenAI\\Codex\\runtimes\\node\\node.exe",
    args: ["C:\\Users\\utilisateur\\AppData\\Local\\OpenAI\\Codex\\runtimes\\node_repl\\server.js", "--stdio"],
    env: [["CODEX_HOME", "C:\\Users\\utilisateur\\.codex"], ["NODE_OPTIONS", "--max-old-space-size=4096"], ["CODEX_SANDBOX", "seatbelt"], ["CODEX_API_KEY", "sk-proj-AbCdEf0123456789"], ["PATH", "C:\\Windows\\system32;C:\\Program Files\\nodejs"]].map(([key, value]) => ({ key, value })) },
  { id: "linear", name: "linear", url: "https://mcp.linear.app/mcp" },
  { id: "github", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "" }] },
];
// 14 serveurs : assez pour que la liste défile.
const MCP_LISTE_LONGUE = [...Array.from({ length: 11 }, (_, i) => ({ id: `srv${i}`, name: `serveur-${i + 1}`, command: "npx", args: ["-y", `@exemple/s${i}`] })), ...MCP_SERVEURS];
const MCP_OUTILS = { node_repl: [["eval", "Évalue du JavaScript dans une session Node persistante."], ["reset", "Réinitialise la session."], ["inspect", "Décrit une variable de la session."], ["install", "Installe un paquet npm dans la session."]] };
export const SCENES = [
  // Mise à jour disponible (demande utilisateur) : badge discret en haut à droite, jamais d'écran bloquant ;
  // au clic, fenêtre avec les notes et « Installer maintenant » / « Plus tard ».
  { id: "maj-badge", sim: { majDispo: "0.1.66" }, stockage: () => colonnes([ids(3)]), temoins: ["clic:.titlebar__update[data-state='available'] .titlebar__update-pill", "absent:.updater-lock"] },
  { id: "maj-badge-fenetre", sim: { majDispo: "0.1.66" }, stockage: () => colonnes([ids(3)]), cliquer: ".titlebar__update-pill", temoins: ["sel:.titlebar__update-popover .titlebar__update-popover-notes", "clic:.titlebar__update-popover-btn--primary", "clic:.titlebar__update-popover-btn--ghost", "absent:.updater-lock"] },
  { id: "maj-badge-accueil", sim: { majDispo: "0.1.66" }, espace: false, temoins: ["clic:.welcome__maj .titlebar__update-pill"] },
  // 25 dossiers récents : la liste défile, chaque carte a sa croix ; la croix retire l'entrée sans ouvrir le dossier.
  { id: "accueil-recents", sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }),
    temoins: ["defile:.welcome__recents[data-liste='dossiers']", "compte:.welcome__recents[data-liste='dossiers'] .welcome__recent=25", "compte:.welcome__recents[data-liste='dossiers'] .welcome__recent-retirer=25"] },
  { id: "accueil-recents-retrait", sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }),
    clics: [".welcome__recents[data-liste='dossiers'] .welcome__recent-retirer"],
    temoins: ["compte:.welcome__recents[data-liste='dossiers'] .welcome__recent=24", "stocke:axecode.recentWorkspaces=24", "absent:.workspace"] },
  // conversations sans dossier : TOUTES affichées (liste qui défile comme les dossiers), croix « Supprimer »
  // (1er clic : « Supprimer ? », 2e clic : même action que dans l'appli = archiver, archive_local).
  { id: "accueil-libres", sim: { cloud: true, libres: 20 }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }),
    temoins: ["defile:.welcome__recents[data-liste='conversations']", "compte:.welcome__recents[data-liste='conversations'] .welcome__recent=20",
      "compte:.welcome__recents[data-liste='conversations'] .welcome__recent-retirer=20"] },
  { id: "accueil-libres-confirmer", sim: { cloud: true, libres: 20 }, espace: false,
    clics: [".welcome__recents[data-liste='conversations'] .welcome__recent-retirer"],
    temoins: ["sel:.welcome__recents[data-liste='conversations'] .welcome__recent-retirer[data-confirm='true']", "Supprimer\u00a0?",
      "compte:.welcome__recents[data-liste='conversations'] .welcome__recent=20", "absent:.workspace", "sansappel:archive_local"] },
  { id: "accueil-libres-supprimer", sim: { cloud: true, libres: 20 }, espace: false,
    clics: [".welcome__recents[data-liste='conversations'] .welcome__recent-retirer", ".welcome__recent-retirer[data-confirm='true']"],
    temoins: ["appel:archive_local", "compte:.welcome__recents[data-liste='conversations'] .welcome__recent=19", "absent:.workspace"] },
  { id: "accueil", sim: { cloud: true }, espace: false, temoins: ["sel:button.welcome__cta", "absent:svg linearGradient"] },
  // 0.1.71 — bulle d'info de la dictée (« Transcrit par … en 6,0 s, nettoyé par l'IA. ») : elle débordait du compositeur.
  { id: "dictee-info", sim: {}, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".axe-voix__valider"], pauseClics: 1500, attendre: ".axe-voix__bulle--info", temoins: ["clic:.axe-voix__bulle--info"] },
  { id: "dictee-info-c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), cliquer: [".axe-voix__micro", ".axe-voix__valider"], pauseClics: 1500, attendre: ".axe-voix__bulle--info", temoins: ["clic:.axe-voix__bulle--info"] },
  // 0.1.71 — pendant l'enregistrement, la barre de dictée recouvrait le bouton Envoyer (colonne étroite).
  { id: "dictee-envoyer-c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), cliquer: ".axe-voix__micro", temoins: ["clic:.colonne-chat[data-focus='true'] .composer__send", "clic:.axe-voix__valider", "clic:.axe-voix__annuler"] },
  // micro-local — whisper.cpp embarqué : micro visible sans aucun service, réglage petit/moyen.
  { id: "dictee-micro-local", sim: { voixLocale: true }, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".axe-voix__valider"], pauseClics: 1500, attendre: ".axe-voix__bulle--info", temoins: ["clic:.axe-voix__bulle--info"] },
  { id: "dictee-reglage-modele", sim: { voixLocale: true }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='voice']"],
    temoins: ["sel:[data-testid='voix-modele-local'] input[type='radio']:checked", "Moyen (small)", "Petit (base)"] },
  // 0.1.75 — dictée en direct : texte provisoire grisé au-dessus du compositeur pendant l'enregistrement.
  // copier-code — bouton « Copier » d'un bloc de code du chat : clic puis retour « Copié ».
  // copie-selection — sélection à la souris du texte au-dessus d'un bloc de code + du bloc (ligne longue
  // coupée par le défilement horizontal), puis Ctrl+C : le presse-papiers a les lignes ENTIÈRES.
  { id: "copie-selection-code", sim: {}, stockage: () => colonnes([ids(3)]), copieSelection: {},
    temoins: ["sel:.chat-body .bloc-copie"] },
  { id: "copier-code", sim: {}, stockage: () => colonnes([ids(3)]), cliquer: ".chat-body .bloc-copie__btn", defilerAvantClic: true, pauseClics: 50, temoins: ["sel:.bloc-copie[data-etat='copie'] .bloc-copie__btn"] },
  { id: "dictee-direct", sim: {}, stockage: () => colonnes([ids(3)]), cliquer: ".axe-voix__micro", pauseClics: 4500, temoins: ["sel:.composer__box > .axe-voix__provisoire", "clic:.axe-voix__valider"] },
  { id: "dictee-direct-c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), cliquer: ".axe-voix__micro", pauseClics: 4500, temoins: ["sel:.composer__box > .axe-voix__provisoire", "clic:.axe-voix__valider", "clic:.axe-voix__annuler"] },
  { id: "dictee-enregistrement-c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), cliquer: ".axe-voix__micro", temoins: ["clic:.axe-voix__valider", "clic:.axe-voix__annuler"] },
  // Dictée commencée dans c-001, conversation changée pendant la transcription :
  // le texte va dans le brouillon de c-001, jamais dans la saisie affichée (c-002).
  { id: "dictee-cible-autre", sim: { transcriptionLente: 2500 }, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".axe-voix__valider", ".conv-list .conv-row:nth-child(2)"], pauseClics: 1500, temoins: ["champ:.composer textarea=", "sel:.conv-list .conv-row:nth-child(2)[data-active='true']", "absent:.axe-voix__provisoire", "sel:.conv-row[data-conversation-id='c-001'][data-dictee='true'] .axe-dictee-repere"] },
  { id: "dictee-cible-retour", sim: { transcriptionLente: 2500 }, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".axe-voix__valider", ".conv-list .conv-row:nth-child(2)", ".conv-list .conv-row:nth-child(1)"], pauseClics: 1500, temoins: ["champ:.composer textarea=Relance le banc.", "absent:.axe-dictee-repere"] },
  // Pendant la transcription, dans l'autre conversation : barre « pour l'autre conversation », jamais l'aperçu.
  { id: "dictee-cible-attente", sim: { transcriptionLente: 30000 }, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".axe-voix__valider", ".conv-list .conv-row:nth-child(2)"], pauseClics: 2500, temoins: ["sel:.axe-voix__barre--attente .axe-voix__libelle[data-ailleurs='true']", "absent:.axe-voix__provisoire", "clic:.axe-voix__barre--attente .axe-voix__annuler"] },
  // Conversation changée PENDANT l'enregistrement : l'enregistrement s'arrête et part vers c-001.
  { id: "dictee-cible-enregistrement", sim: { transcriptionLente: 1000 }, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".conv-list .conv-row:nth-child(2)", ".conv-list .conv-row:nth-child(1)"], pauseClics: 1500, temoins: ["champ:.composer textarea=Relance le banc."] },
  { id: "c1", sim: {}, stockage: () => colonnes([ids(3)]), temoins: ["sel:.thinking-block", "sel:.tool-card__err-dot", "sel:.composer__send"] },
  // 0.1.75 — capture utilisateur : onglet Git du volet bas, branche au nom long, liste des modifications vide/coupée, onglets tronqués.
  { id: "git-branche-longue", sim: { brancheLongue: true }, stockage: () => colonnes([ids(3)]), terminal: true, cliquer: ".terminal-tab[data-tab='git']", pauseClics: 800, temoins: ["sel:.terminal-shell .git-panel__row", "sel:.terminal-shell .git-panel__commit"] },
  { id: "git-branche-longue-local", sim: { brancheLongue: true, cloud: false }, stockage: () => colonnes([ids(3)]), terminal: true, cliquer: ".terminal-tab[data-tab='git']", pauseClics: 800, temoins: ["sel:.terminal-shell .git-panel__row", "sel:.terminal-shell .git-panel__commit"] },
  { id: "c1-terminal", sim: {}, stockage: () => colonnes([ids(3)]), terminal: true, temoins: ["sel:.terminal-shell .terminal-tabs"] },
  { id: "explorateur-hauteur", sim: {}, stockage: () => colonnes([ids(3)]), temoins: ["sel:.sidebar__section .tree-row"] },
  { id: "terminal-retreci", sim: {}, stockage: () => colonnes([ids(3)]), terminal: true, retrecirTerminal: 60, temoins: ["sel:.terminal-shell .xterm-screen"] },
  { id: "c1-terminal-redim", sim: {}, stockage: () => colonnes([ids(3)]), terminal: true, redimTerminal: 37, temoins: ["sel:.terminal-shell .terminal-tabs"] },
  { id: "c1-explorateur-ferme", sim: {}, stockage: (l, h) => ({ ...colonnes([ids(3)]), ...explorateurFerme(l, h) }), temoins: ["sel:.volet-flottant"] },
  { id: "c2", sim: {}, stockage: () => colonnes([ids(2), ["c-003"]]), terminal: true, temoins: ["sel:.colonne-chat + .gutter + .colonne-chat"] },
  { id: "c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), temoins: ["sel:.colonne-chat[data-colonne='2']"] },
  { id: "c3-terminal-large", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), terminal: true, elargirChat: true },
  { id: "c3-explorateur-ferme", sim: {}, stockage: (l, h) => ({ ...colonnes([ids(2), ["c-003"], ["c-004"]]), ...explorateurFerme(l, h) }) },
  // Demande de l'utilisateur : réduire entièrement les volets (Ctrl+B gauche, Ctrl+Alt+B droite).
  { id: "volets-reduits", sim: {}, stockage: () => colonnes([ids(2)]), reduireVolets: true, temoins: ["sel:.main[data-gauche-reduit='true'][data-droite-reduit='true']"] },
  // macOS : mêmes volets avec ⌘B et ⌥⌘B (Ctrl seul ne doit plus rien faire).
  { id: "volets-reduits-mac", mac: true, sim: {}, stockage: () => colonnes([ids(2)]), reduireVolets: true, temoins: ["sel:.main[data-gauche-reduit='true'][data-droite-reduit='true']"] },
  // Poignée entre deux colonnes de conversation : glissée, les largeurs doivent changer.
  { id: "c2-poignee", sim: {}, stockage: () => colonnes([ids(2), ["c-003"]]), elargirChat: true, glisserPoigneeColonnes: 120 },
  { id: "c2-colonne-min", sim: {}, stockage: () => colonnes([ids(2), ["c-003"]]), reduireColonne: true },
  { id: "onglets-nombreux", sim: {}, stockage: () => colonnes([ids(9)]), elargirChat: true, temoins: ["sel:.onglets-chat__tab:nth-child(9)"] },
  { id: "sans-fournisseur", sim: { fournisseur: false, accelerer: true }, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), sansFournisseur: true, temoins: ["sel:.composer__connect-cta"] },
  // PC sans fournisseur, dossier local : le clic sur « Connecter un fournisseur » (.composer__connect-cta) doit ouvrir la section des fournisseurs.
  { id: "sans-fournisseur-clic", sim: { fournisseur: false, accelerer: true }, stockage: () => colonnes([ids(3)]), sansFournisseur: true, clicConnecter: true, temoins: ["sel:.settings-pane"] },
  { id: "sans-fournisseur-c1", sim: { fournisseur: false, accelerer: true }, stockage: () => colonnes([ids(3)]), sansFournisseur: true, temoins: ["sel:.composer__connect-cta"] },
  { id: "tour-file-sous-agents", sim: { tour: "en_cours", sousAgents: 2 }, stockage: () => ({ ...colonnes([ids(2), ["c-003"]]), ...fileAttente("c-001", 3) }), temoins: ["sel:.composer__send[data-variant='stop']", "sel:.composer__send[data-variant='background']", "sel:.axe-agents-bandeau", "sel:.todo-strip__queue"] },
  // file-pause — après un Stop, la file attend : bouton « Reprendre la file ».
  { id: "file-en-pause", sim: { filePause: true }, stockage: () => ({ ...colonnes([ids(2), ["c-003"]]), ...fileAttente("c-001", 2) }), temoins: ["clic:[data-testid='reprendre-file']", "sel:.todo-strip__queue"] },
  { id: "arret-force", sim: { tour: "en_cours", sousAgents: 1, accelerer: true }, stockage: () => ({ ...colonnes([ids(2), ["c-003"], ["c-004"]]), ...fileAttente("c-001", 2) }), arretForce: true, temoins: ["sel:.composer__send[data-variant='stop'][data-force='true']", "sel:.axe-agents-bandeau"] },
  // file-envoi-affiche — « envoyer maintenant » pendant un tour (flèche de la file, double Entrée) : le tour
  // s'arrête (turn_finished), le service enverra le message plus tard ; en attendant, la bulle du message est
  // déjà dans la conversation (« en cours d'envoi »), retirée de la file, et le bouton reste « Stop ».
  { id: "file-envoi-maintenant", sim: { tour: "en_cours", arretFinit: true }, stockage: () => ({ ...colonnes([ids(2)]), ...fileAttente("c-001", 2) }),
    cliquer: ".todo-strip__queue-action[aria-label='Envoyer maintenant le message en attente']",
    temoins: ["sel:.msg[data-role='user'][data-envoi='en-cours']", "sel:.composer__send[data-variant='stop']", "compte:.todo-strip__queue-item=1"] },
  { id: "file-double-entree", sim: { tour: "en_cours", arretFinit: true }, stockage: () => ({ ...colonnes([ids(2)]), ...fileAttente("c-001", 2) }),
    doubleEntree: ".composer textarea",
    temoins: ["sel:.msg[data-role='user'][data-envoi='en-cours']", "sel:.composer__send[data-variant='stop']", "compte:.todo-strip__queue-item=1"] },
  // Le service envoie lui-même le 1er message de la file à la fin du tour (« sending ») : il apparaît tout de suite
  // dans la conversation, et la fin de l'ancien tour reçue entre-temps ne remet pas « Envoyer ».
  { id: "file-depart-auto", sim: { tour: "en_cours" }, stockage: () => ({ ...colonnes([ids(2)]), ...fileAttente("c-001", 2) }),
    emissions: [
      { demon: { event: "queue", sessionId: "c-001", data: { sessionId: "c-001", paused: false, sending: "f-1", items: [{ id: "f-2", text: "ok", display: { attachments: [] } }] } } },
      { agent: { type: "turn_finished", duration_ms: null } },
      { agent: { type: "turn_started" } },
    ],
    temoins: ["Quand tu auras fini, relance le banc à 800 px", "sel:.composer__send[data-variant='stop']", "compte:.todo-strip__queue-item=1", "absent:.msg[data-envoi='en-cours']"] },
  // attendus : le détail de l'erreur, affiché tel quel avant comme après la traduction du préfixe (« Réponse interrompue : … »).
  { id: "erreur-compaction", sim: { tour: "erreur", compaction: true }, stockage: () => colonnes([ids(3)]), temoins: ["sel:.tool-card__pre[data-error='true']", "sel:.compaction-marker, .compaction-summary"], attendus: ["error decoding response body"] },
  { id: "colonne-introuvable", sim: { conversationIllisible: true }, stockage: () => colonnes([ids(2), ["x-404"]]), temoins: ["sel:.colonne-chat[data-colonne='1']"] },
  // Bug du 22/10 : un tour de continuation enchaîné sans rien entre les deux, puis
  // coupé (« stream_retry ») : la fin du tour précédent ne doit pas disparaître.
  {
    id: "tour-enchaine-coupe", sim: {}, stockage: () => colonnes([ids(3)]),
    evenements: [
      { type: "turn_started" },
      { type: "text_started" },
      { type: "text_chunk", delta: FIN_TOUR_PRECEDENT },
      { type: "text_finished" },
      { type: "turn_started" },
      { type: "stream_retry" },
    ],
    temoins: ["sel:.chat-body"],
    attendus: [FIN_TOUR_PRECEDENT],
  },
  // commandes — « /heartbeat 1m coucou » et « /goal … » : icônes à côté du modèle,
  // réveil visible dans la conversation (« réveil : coucou » avec l'heure), détail au clic.
  {
    id: "commandes",
    sim: {
      commandes: {
        heartbeat: { interval_ms: 60_000, message: "coucou", next_at_ms: Date.UTC(2026, 9, 23, 12, 33) },
        goal: { text: "Finir le lot 3 de la recette", status: "active" },
        autonomous: null,
      },
    },
    stockage: () => colonnes([ids(1)]),
    evenements: [
      { type: "turn_started" },
      { type: "heartbeat_received", message: "coucou", at_ms: Date.UTC(2026, 9, 23, 12, 32) },
      { type: "text_started" },
      { type: "text_chunk", delta: "Réveil reçu." },
      { type: "text_finished" },
      { type: "turn_finished" },
    ],
    cliquer: ".axe-indicateur[data-kind='heartbeat']",
    temoins: ["sel:.axe-indicateur[data-kind='heartbeat']", "sel:.axe-indicateur[data-kind='goal']", "sel:.axe-reveil", "sel:.axe-indicateurs__detail"],
    attendus: ["coucou", "Arrêter le réveil", "Toutes les 1 min"],
  },
  // guet — deux guets : icône avec leur nombre à côté du modèle, détail au clic
  // (commande, depuis quand, prochain essai) avec Annuler ; bulle « guet … : terminée ».
  {
    id: "guets",
    sim: {
      commandes: {
        goal: null,
        heartbeat: null,
        autonomous: null,
        guets: [
          { id: "g1a2b3c", genre: "condition", cmd: "gh run view 4242 --exit-status", cree_ms: Date.UTC(2026, 9, 23, 12, 10), prochain_ms: Date.UTC(2026, 9, 23, 12, 33, 30), essais: 7, statut: "actif", message: "construction GitHub de la 0.1.68" },
          { id: "g4d5e6f", genre: "commande", cmd: "cargo test --workspace", cree_ms: Date.UTC(2026, 9, 23, 12, 25), statut: "actif" },
        ],
      },
    },
    stockage: () => colonnes([ids(1)]),
    evenements: [
      { type: "turn_started" },
      { type: "heartbeat_received", message: "guet g9a8b7c : terminée", at_ms: Date.UTC(2026, 9, 23, 12, 31) },
      { type: "text_started" },
      { type: "text_chunk", delta: "La construction est finie." },
      { type: "text_finished" },
      { type: "turn_finished" },
    ],
    cliquer: ".axe-indicateur[data-kind='guet']",
    temoins: ["sel:.axe-indicateur[data-kind='guet']", "sel:.axe-reveil[data-kind='guet']", "sel:.axe-indicateurs__detail", "sel:.axe-indicateurs__guet"],
    attendus: ["gh run view 4242 --exit-status", "cargo test --workspace", "Annuler", "Tout annuler", "Prochain essai", "guet g9a8b7c"],
  },
  // html — page .html : Code par défaut ; le bouton de bascule (le même que le
  // Markdown) passe au rendu, dans une iframe sandbox sans scripts ni réseau (CSP).
  {
    id: "html-rendu",
    sim: { fichierHtml: true },
    stockage: () => colonnes([ids(1)]),
    ouvrirFichier: "page.html",
    clics: [".editor-preview-toggle"],
    temoins: ["sel:iframe.xv-html__frame[sandbox='']", "sel:iframe.xv-html__frame[srcdoc*=\"connect-src 'none'\"]", "sel:iframe.xv-html__frame[srcdoc*=\"script-src 'none'\"]", "sel:.xv-html__status[data-on='false']", "sel:.editor-preview-toggle"],
  },
  // … le choix est mémorisé par fichier : rouverte, la page s'affiche directement en rendu ;
  // « Autoriser les scripts » recharge l'iframe avec allow-scripts (toujours sans réseau).
  {
    id: "html-memorise",
    sim: { fichierHtml: true },
    stockage: () => ({ ...colonnes([ids(1)]), "axecode.vueFichiers": { "C:\\Users\\utilisateur\\Documents\\Projets\\savide\\page.html": true } }),
    ouvrirFichier: "page.html",
    clics: [".xv-html .xv-btn--text"],
    temoins: ["sel:iframe.xv-html__frame[sandbox*='allow-scripts']", "sel:iframe.xv-html__frame[srcdoc*=\"connect-src 'none'\"]", "sel:.xv-html__status[data-on='true']"],
  },
  // liens — liens bien visibles (gras + fond d'accent) et cliquables, dans le message de
  // l'utilisateur (URL nue, chemin) et dans la réponse (URL nue raccourcie, [texte](url), chemins
  // Linux et Windows) : le clic ouvre le navigateur (open_external_url) ou le fichier dans l'éditeur.
  {
    id: "liens",
    sim: {},
    stockage: () => colonnes([ids(1)]),
    ecrire: "regarde https://exemple.fr/doc et src/main.ts",
    evenements: [
      { type: "turn_started" },
      { type: "text_started" },
      { type: "text_chunk", delta: "Voir [la notice](https://docs.exemple.fr/notice), https://github.com/exemple/projet/actions/runs/123456789/job/987654321 et `src/lib/ipc.ts`, puis src/components/chat/Markdown.tsx ou C:\\Users\\sav\\notes.txt." },
      { type: "text_finished" },
      { type: "turn_finished" },
    ],
    cliquer: [".msg[data-role='user'] .chat-link", ".md .chat-file-link"],
    temoins: [
      "sel:.msg[data-role='user'] .chat-link",
      "sel:.msg[data-role='user'] .chat-file-link",
      "gras:.chat-link", "surligne:.chat-link",
      "gras:.chat-file-link", "surligne:.chat-file-link",
      "clic:.md .chat-link", "clic:.md .chat-file-link",
      "appel:open_external_url_command",
      "appel:read_workspace_file_command|remote_workspace_read",
    ],
    attendus: ["la notice", "github.com/exemple/projet/actions", "src/lib/ipc.ts", "notes.txt"],
  },
  // explorateur — clavier dans l'explorateur : gauche replie « docs », bas, droite déplie
  // « scripts », bas = premier enfant, Ctrl+C = chemin absolu SANS « \\?\ ».
  {
    id: "explorateur-clavier", sim: {}, stockage: () => colonnes([ids(1)]),
    explorateur: { clic: "docs", touches: ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowDown", "Control+c"] },
    temoins: ["choisi:scripts/ChatPane.tsx", "presse:C:\\Users\\utilisateur\\Documents\\Projets\\savide\\scripts\\ChatPane.tsx", "sel:.tree-row[data-entry-path='scripts/ChatPane.tsx'][data-selected='true']"],
  },
  // Fin = dernière ligne (défilement qui suit), Ctrl+Maj+C = chemin relatif (séparateur Windows).
  {
    id: "explorateur-fin", sim: {}, stockage: () => colonnes([ids(1)]),
    explorateur: { clic: "src", touches: ["ArrowDown", "End", "Control+Shift+C"] },
    temoins: ["choisi:un-nom-de-fichier-vraiment-tres-long-pour-voir-le-debordement.md", "presse:un-nom-de-fichier-vraiment-tres-long-pour-voir-le-debordement.md", "sel:.tree-row[data-selected='true']"],
  },
  // Clic droit sur un fichier : « Ouvrir avec… », « Ouvrir dans l'explorateur », raccourcis affichés.
  {
    id: "explorateur-menu", sim: {}, stockage: () => colonnes([ids(1)]),
    explorateur: { clic: "tests", clicDroit: "Cargo.toml" },
    temoins: ["clic:.tree-menu .tree-menu__item", "sel:.tree-menu__hint"],
    attendus: ["Ouvrir avec…", "Ouvrir dans l'explorateur", "Ctrl+C", "Ctrl+Maj+C"],
  },
  {
    id: "explorateur-ouvrir-avec", sim: {}, stockage: () => colonnes([ids(1)]),
    explorateur: { clic: "tests", clicDroit: "Cargo.toml", menu: "Ouvrir avec…" },
    temoins: ["appel:open_workspace_entry_with_command", "absent:.tree-menu"],
  },
  // Menu de tri de l'en-tête : taille, décroissant, sans « dossiers d'abord » -> le plus gros fichier en tête.
  {
    id: "explorateur-tri", sim: {}, stockage: () => colonnes([ids(1)]),
    explorateur: { clic: "tests", menuTri: ["ouvrir", "[data-tri='taille']", "[data-sens='decroissant']", "[data-dossiers-dabord]"] },
    temoins: ["clic:.sidebar__head-btn[data-action='trier']", "clic:.tree-sort__menu .tree-menu__item", "premier:RAPPORT.md", "sel:.tree-sort__menu [data-tri='taille'][data-active='true']"],
  },
  // couleurs — commande slash en orange (accent) et skill en violet : dans la bulle du
  // message envoyé (« /goal … /revue-code ») et dans le compositeur (« /heartbeat 5s coucou … »).
  {
    id: "couleurs",
    sim: { skills: ["revue-code"] },
    stockage: () => colonnes([ids(1)]),
    ecrire: "/goal finir le lot 3 avec /revue-code",
    saisir: "/heartbeat 5s coucou /revue-code",
    temoins: [
      "couleur:.composer__overlay .jeton-commande[data-jeton='commande']=rgb(252, 97, 11)",
      "couleur:.composer__overlay .jeton-skill[data-jeton='skill']=rgb(167, 139, 250)",
      "couleur:.msg[data-role='user'] .user-text .jeton-commande=rgb(252, 97, 11)",
      "couleur:.msg[data-role='user'] .user-text .jeton-skill=rgb(167, 139, 250)",
    ],
    attendus: ["finir le lot 3 avec"],
  },
  // /goal et /heartbeat au milieu de la phrase : reconnus par le service, donc en orange aussi.
  {
    id: "couleurs-milieu",
    sim: {},
    stockage: () => colonnes([ids(1)]),
    ecrire: "Relis le module de paiement, puis /goal tous les tests passent",
    saisir: "puis /heartbeat 5m coucou",
    temoins: [
      "couleur:.composer__overlay .jeton-commande[data-jeton='commande']=rgb(252, 97, 11)",
      "couleur:.msg[data-role='user'] .user-text .jeton-commande=rgb(252, 97, 11)",
    ],
    attendus: ["Relis le module de paiement, puis"],
  },
  // Clic sur « N agent(s) au travail » : ouvre la conversation (journal) de l'agent, comme la vue Agents.
  // Tour en cours : rond animé sur la ligne de la liste et sur l'onglet, même quand
  // le démon rend le chemin sous une autre forme (\\?\ + casse) ou quand le tour est sur une autre conversation.
  { id: "activite-liste-chemin", sim: { tour: "en_cours", tourWs: "\\\\?\\c:\\users\\utilisateur\\documents\\projets\\savide" }, stockage: () => colonnes([ids(3)]), temoins: ["sel:.conv-row[data-streaming='true'] .conv-row__spinner", "sel:.onglets-chat__tab[data-streaming='true'] .onglets-chat__spinner"] },
  { id: "activite-liste-autre", sim: { tour: "en_cours", tourConv: "c-002" }, stockage: () => colonnes([ids(3)]), temoins: ["sel:.conv-row[data-streaming='true'] .conv-row__spinner", "sel:.onglets-chat__tab[data-streaming='true'] .onglets-chat__spinner", "sel:.composer__send:not([data-variant='stop'])"] },
  // accueil, dossier LOCAL (formes réelles du service, sessions.list) :
  // le parent est « idle » entre deux tours, ses sous-agents « running » ; aucun tour envoyé par
  // la fenêtre (list_active_turns vide). Le rond doit venir du service lui-même.
  { id: "accueil-activite-sous-agents", sim: { cloud: true, sessionsDemon: SESSIONS_DOSSIER("idle", "running") }, espace: false,
    stockage: () => ({ "axecode.recentWorkspaces": RECENTS_ACTIVITE() }),
    temoins: ["sel:.welcome__recent[data-active='true'] .welcome__recent-spinner", "compte:.welcome__recent[data-active='true']=1",
      "sel:.welcome__recent[data-active='true'][title^='Ouvrir mon-projet']"] },
  // Tour relancé par le service (résultat d'un sous-agent) : seul l'événement « status » l'annonce.
  { id: "accueil-activite-evenement", sim: { cloud: true, sessionsDemon: SESSIONS_DOSSIER("idle", "inactive") }, espace: false,
    stockage: () => ({ "axecode.recentWorkspaces": RECENTS_ACTIVITE() }),
    emissions: [{ demon: { event: "status", sessionId: "45127dc0-5b2f-4f50-a166-5a7523cc769e", data: SESSIONS_DOSSIER("running", "inactive")[0] } }],
    temoins: ["sel:.welcome__recent[data-active='true'][title^='Ouvrir mon-projet'] .welcome__recent-spinner", "compte:.welcome__recent[data-active='true']=1"] },
  // Fin du tour (« idle ») : le rond s'en va ; un événement d'une connexion distante ne compte pas.
  { id: "accueil-activite-fin", sim: { cloud: true, sessionsDemon: SESSIONS_DOSSIER("running", "inactive") }, espace: false,
    stockage: () => ({ "axecode.recentWorkspaces": RECENTS_ACTIVITE() }),
    emissions: [{ demon: { event: "status", sessionId: "45127dc0-5b2f-4f50-a166-5a7523cc769e", data: SESSIONS_DOSSIER("idle", "inactive")[0] } },
      { demon: { event: "status", sessionId: "c-distant", connectionId: "axe-cloud", data: { id: "c-distant", status: "running", workspaceId: "C:\\Users\\utilisateur\\Documents\\compta" } } }],
    temoins: ["absent:.welcome__recent-spinner", "compte:.welcome__recent[data-active='true']=0"] },
  { id: "bandeau-agents-clic", sim: { tour: "en_cours", sousAgents: 2 }, stockage: () => colonnes([ids(3)]), clicBandeau: true, temoins: ["sel:.axe-journal", "sel:.axe-agents"] },
  // Bug : après le chat d'un agent, un clic sur une conversation de la liste doit l'afficher (plus le journal de l'agent).
  { id: "agent-puis-conversation", sim: { tour: "en_cours", sousAgents: 2 }, stockage: () => colonnes([ids(3)]), clicBandeau: true, puisConversation: TITRES["c-002"], temoins: ["sel:.colonne-chat[data-focus='true'] .chat-body"] },
  { id: "agents", sim: { sousAgents: 3 }, stockage: () => colonnes([ids(3)]), agents: true, temoins: ["sel:.axe-agents"] },
  { id: "agents-compteurs", sim: { tour: "en_cours", sessionsDemon: SESSIONS_AGENTS() }, stockage: () => colonnes([ids(3)]), agents: true,
    temoins: ["sel:.axe-agents__counts[data-running='3'][data-idle='0'][data-inactive='1']", "compte:.axe-agents__row[data-sous-agent='true']=2",
      "compte:.axe-agents__row[data-status='running']=3"] },
  // Vue « Tableau » de l'onglet Agents (bascule mémorisée) : une carte par colonne,
  // « Au repos » replié puis déplié ; « tous les dossiers » montre le dossier de chaque carte.
  { id: "agents-tableau", sim: { sessionsDemon: SESSIONS_TABLEAU(), notifications: NOTIFS_TABLEAU() }, stockage: () => ({ ...colonnes([ids(3)]), "axe:agents:vue": "tableau" }), agents: true,
    temoins: ["sel:.axe-tableau", "sel:.axe-agents__vues button[data-vue='tableau'][aria-pressed='true']", "compte:.axe-tableau__carte[data-colonne='attente']=1",
      "compte:.axe-tableau__carte[data-colonne='travaille']=1", "compte:.axe-tableau__carte[data-colonne='fini']=1", "compte:.axe-tableau__carte[data-colonne='echec']=1",
      "compte:.axe-tableau__carte[data-colonne='repos']=0"] },
  { id: "agents-tableau-repos", sim: { sessionsDemon: SESSIONS_TABLEAU(), notifications: NOTIFS_TABLEAU() }, stockage: () => ({ ...colonnes([ids(3)]), "axe:agents:vue": "tableau", "axe:agents:tous-dossiers": "1" }), agents: true,
    clics: [".axe-tableau__plier"], temoins: ["compte:.axe-tableau__carte[data-colonne='repos']=2", "sel:.axe-tableau__plier[aria-expanded='true']"] },
  // Réglages > Notifications : sept cases, « Écouter », essai (message d'état).
  { id: "reglages-notifications", sim: { notifications: NOTIFS_TABLEAU() }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='notifications']", ".axe-notifs-reglages__bouton[data-action='essayer']"],
    temoins: ["sel:.axe-notifs-reglages", "compte:.axe-notifs-reglages__case=7", "sel:.axe-notifs-reglages [role='status']"] },
  // Cloche de la barre du haut : 3 non lus (attend, fini, échec) + une information lue ; puis sans rien.
  { id: "cloche-ouverte", sim: { notifications: NOTIFS_TABLEAU() }, stockage: () => colonnes([ids(3)]), clics: [".axe-cloche__bouton"],
    temoins: ["sel:.axe-cloche__bouton[data-non-lus='3']", "sel:.axe-cloche__panneau", "compte:.axe-cloche__item=4", "compte:.axe-cloche__item[data-lu='false']=3"] },
  { id: "cloche-vide", sim: {}, stockage: () => colonnes([ids(3)]), clics: [".axe-cloche__bouton"],
    temoins: ["sel:.axe-cloche__panneau", "sel:.axe-cloche__vide", "absent:.axe-cloche__compte"] },
  // Conversations endormies : Réglages > Notifications (délai) et bouton « Endormir » d'une conversation inactive.
  { id: "reglages-sommeil", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='notifications']"], temoins: ["sel:.axe-sommeil", "sel:select.axe-sommeil__delai"] },
  { id: "agents-endormir", sim: { sessionsDemon: SESSIONS_TABLEAU() }, stockage: () => colonnes([ids(3)]), agents: true, clics: [".axe-agents__row[data-status='idle']:not([data-sous-agent])"],
    temoins: ["sel:.axe-agents__actions button[data-action='endormir']"] },
  { id: "agents-archives", sim: { tour: "en_cours", sessionsDemon: SESSIONS_AGENTS() }, stockage: () => colonnes([ids(3)]), agents: true,
    clics: [".axe-agents__filters summary", ".axe-agents__filters input[data-filtre='archives']"],
    temoins: ["compte:.axe-agents__row[data-sous-agent='true']=12", "sel:.axe-agents__counts[data-running='3'][data-idle='5'][data-inactive='6']"] },
  // Bugs SavIDE 0.1.58 : dans une conversation sans dossier, Accueil / Ouvrir un dossier /
  // Réglages étaient rognés (barre d'actions de largeur 0) ; /login ouvrait « À propos » ou rien.
  { id: "libre-barre", sim: {}, libre: true, temoins: ["sel:.axe-freechat", "clic:.axe-freechat .titlebar__actions .titlebar__btn"] },
  // sans-dossier — barre latérale repliée (Ctrl+B ou bouton) : un rail d'icônes, le chat prend la place.
  { id: "libre-volet", sim: {}, libre: true, clics: [".axe-freechat__head [data-action='volet']"],
    temoins: ["sel:.axe-freechat__rail", "absent:.axe-freechat__sidebar", "clic:.axe-freechat__rail [data-action='volet']"] },
  // sans-dossier — on peut écrire dès l'arrivée : le compositeur a le focus.
  { id: "libre-focus", sim: {}, libre: true, temoins: ["sel:.axe-freechat__chat .composer :focus"] },
  { id: "libre-login", sim: {}, libre: true, ecrire: "/login", temoins: ["sel:.axe-freechat", "sel:.settings-pane .settings-pane__nav-item[data-section='providers'][data-active='true']"] },
  { id: "ide-login", sim: {}, stockage: () => colonnes([ids(3)]), ecrire: "/login", temoins: ["sel:.settings-pane .settings-pane__nav-item[data-section='providers'][data-active='true']"] },
  { id: "ide-barre", sim: {}, stockage: () => colonnes([ids(3)]), temoins: ["clic:.titlebar__btn[data-action='accueil']", "clic:.titlebar__btn[data-action='reglages']",
    "sel:.titlebar__brand-mark svg[data-logo='wordmark'] rect.logo__fond", "absent:svg linearGradient"] },
  { id: "reglages", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true, temoins: ["sel:.settings-pane"] },
  // Réglages > Harnais : clic droit sur une entrée → « Exporter en .md… » / « Copier en Markdown »
  // (partager une entrée). Menu « ⋯ » équivalent (clavier, tactile) ; Ctrl+clic = plusieurs
  // entrées dans UN .md ; garde-fou : un secret est masqué par défaut ; import d'un .md (bouton ou dépôt sur la liste).
  { id: "harnais-menu", sim: { harnais: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"], clicDroit: ".axe-harness__row[data-id='note_1']",
    temoins: ["clic:.tree-menu [data-action='exporter-md']", "clic:.tree-menu [data-action='copier-md']", "Exporter en .md…", "Copier en Markdown"] },
  { id: "harnais-plus", sim: { harnais: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"], cliquer: ".axe-harness__row-plus[data-id='note_2']",
    temoins: ["sel:.axe-harness__row-plus[data-id='note_1']", "clic:.tree-menu [data-action='exporter-md']", "clic:.tree-menu [data-action='copier-md']"] },
  { id: "harnais-copier", sim: { harnais: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"], clicDroit: ".axe-harness__row[data-id='note_1']", menu: "Copier en Markdown",
    temoins: ["pressecontient:format: harnais-md/1", "pressecontient:titre: \"Style des messages\"", "pressecontient:Messages très concis, sans emoji.",
      "absent:.tree-menu"] },
  { id: "harnais-multi", sim: { harnais: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"],
    clicsTouche: [["Control", ".axe-harness__row[data-id='note_1']"], ["Control", ".axe-harness__row[data-id='note_3']"]],
    clicDroit: ".axe-harness__row[data-id='note_3']", menu: "Copier en Markdown",
    temoins: ["compte:.axe-harness__row[data-selected='true']=2", "pressecontient:entrees: 2", "pressecontient:titre: \"Plan : lot 1 interface web\"",
      "pressecontient:titre: \"Style des messages\"", "pressesans:Garde-fou"] },
  { id: "harnais-secret", sim: { harnais: true, harnaisSecret: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"], clicDroit: ".axe-harness__row[data-id='note_s']", menu: "Copier en Markdown",
    temoins: ["sel:.axe-harnais-secrets", "clic:.axe-harnais-secrets [data-action='masquer-secrets']", "clic:.axe-harnais-secrets [data-action='exporter-quand-meme']"] },
  { id: "harnais-secret-masque", sim: { harnais: true, harnaisSecret: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"], clicDroit: ".axe-harness__row[data-id='note_s']", menu: "Copier en Markdown",
    cliquer: ".axe-harnais-secrets [data-action='masquer-secrets']",
    temoins: ["pressecontient:Clé API : [secret masqué]", "pressesans:AbCdEf0123456789", "absent:.axe-harnais-secrets"] },
  { id: "harnais-exporter", sim: { harnais: true, fichierEnregistre: "C:\\Users\\utilisateur\\Documents\\acces-vm-ssh.md" }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']", ".axe-harness__tabs [data-kind='memory']"], clicDroit: ".axe-harness__row[data-id='mem_1']", menu: "Exporter en .md…",
    temoins: ["appel:harness_md_write", "ecritcontient:type: memory", "ecritcontient:titre: \"Accès VM : SSH\"", "ecritcontient:Port 12222, clé seulement.",
      "sel:.axe-harness__status"] },
  { id: "harnais-import", sim: { harnais: true, fichierHarnais: "---\nformat: harnais-md/1\ntype: memory\ntitre: \"Note partagée par un collègue\"\nportee: project\ntags: [\"vpn\"]\n---\n\nLe VPN BBATI coupe SSH : passer par la VM.\n" },
    stockage: () => colonnes([ids(1)]), reglages: true, clics: [".settings-pane__nav-item[data-section='harness']"],
    depot: { cible: ".axe-harness__list", chemins: ["C:\\Users\\utilisateur\\Downloads\\note-partagee.md"] },
    temoins: ["sel:.axe-harnais-import", "Note partagée par un collègue", "champ:.axe-harnais-import select[data-champ='portee']=global",
      "clic:.axe-harnais-import [data-action='importer-confirmer']"] },
  { id: "harnais-import-cree", sim: { harnais: true, dossierChoisi: "C:\\Users\\utilisateur\\Downloads\\note-partagee.md", fichierHarnais: "---\nformat: harnais-md/1\ntype: memory\ntitre: \"Note partagée par un collègue\"\nportee: project\n---\n\nLe VPN BBATI coupe SSH.\n" },
    stockage: () => colonnes([ids(1)]), reglages: true, clics: [".settings-pane__nav-item[data-section='harness']", "[data-action='importer-md']"],
    cliquer: ".axe-harnais-import [data-action='importer-confirmer']",
    temoins: ["appel:harness_md_read", "appel:harness_create", "absent:.axe-harnais-import", "sel:.axe-harness__status"] },
  { id: "harnais-skill-copier", sim: { harnais: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='skills']"], clicDroit: ".settings-pane__skill-item[data-id='sk_1']", menu: "Copier en Markdown",
    temoins: ["pressecontient:type: skill", "pressecontient:Questions à cocher dans un .md.", "pressecontient:```python\ndef ecrire(titre, questions):",
      // « sel: » et non « clic: » : à 800 px, l'aperçu des skills fait 0 px de large (défaut de 0.1.84).
      "sel:[data-action='partager-skill']"] },
  { id: "harnais-import-refus", sim: { harnais: true, fichierHarnais: "# Compte rendu\n\nPas un export du harnais." },
    stockage: () => colonnes([ids(1)]), reglages: true, clics: [".settings-pane__nav-item[data-section='harness']"],
    depot: { cible: ".axe-harness__list", chemins: ["C:\\Users\\utilisateur\\Downloads\\compte-rendu.md"] },
    temoins: ["sel:.axe-harnais-import [data-erreur]", "absent:[data-action='importer-confirmer']", "absent:.composer .chips .chip"] },
  // Raccourcis : Ctrl/Alt sous Windows, ⌘/⌥/⇧ sous macOS (navigator.platform simulé).
  { id: "raccourcis-windows", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true, clics: [".settings-pane__nav-item[data-section='shortcuts']"],
    temoins: ["sel:.axe-raccourcis[data-mac='false'] kbd", "uneligne:.axe-raccourcis__touches",
      "sel:.axe-raccourcis__ligne[data-raccourci='archiver'][data-combinaison='Ctrl+Maj+A'] button.axe-raccourcis__combo"] },
  // Raccourcis modifiables — clic sur la combinaison, on tape la nouvelle : enregistrée (« Par défaut » apparaît) ;
  // déjà prise : refusée avec un message ; enregistrée : lue partout.
  { id: "raccourcis-modifier", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='shortcuts']", ".axe-raccourcis__ligne[data-raccourci='nouvelleConversation'] .axe-raccourcis__combo"],
    // Ctrl+K est pris par « Aller à » : Ctrl+Alt+K sert d'exemple de combinaison libre.
    touches: ["Control+Alt+k"],
    temoins: ["sel:.axe-raccourcis__ligne[data-raccourci='nouvelleConversation'][data-combinaison='Ctrl+Alt+K'][data-modifie='true']",
      "clic:.axe-raccourcis__ligne[data-raccourci='nouvelleConversation'] .axe-raccourcis__defaut", "clic:.axe-raccourcis__tout-defaut", "uneligne:.axe-raccourcis__touches"] },
  { id: "raccourcis-conflit", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='shortcuts']", ".axe-raccourcis__ligne[data-raccourci='nouvelleConversation'] .axe-raccourcis__combo"],
    touches: ["Control+j"],
    temoins: ["sel:.axe-raccourcis__ligne[data-raccourci='nouvelleConversation'] .axe-raccourcis__alerte",
      "sel:.axe-raccourcis__ligne[data-raccourci='nouvelleConversation'][data-combinaison='Ctrl+T']"] },
  { id: "raccourcis-ecoute", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='shortcuts']", ".axe-raccourcis__ligne[data-raccourci='archiver'] .axe-raccourcis__combo"],
    temoins: ["sel:.axe-raccourcis__combo[data-ecoute='true'] .axe-raccourcis__ecoute", "sel:.axe-raccourcis__aide"] },
  { id: "raccourcis-perso-utilise", sim: {}, stockage: () => ({ ...colonnes([ids(3)]),
      "axecode.raccourcis": { nouvelleConversation: { touche: { ctrl: true, touches: ["k"] }, combinaison: "Ctrl + K" } } }),
    touches: ["Control+k"], temoins: ["sel:.conv-create__input"] },
  // Ctrl+1…9 (⌘1…9 sur Mac) : n-ième dossier récent dans l'ordre affiché sur l'accueil,
  // depuis l'accueil ou depuis un dossier ouvert (même le curseur dans le champ du chat, sans y taper de chiffre),
  // numéro 1…9 sur les cartes et dans leur info-bulle ; ligne du pense-bête.
  { id: "accueil-numeros", sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }),
    temoins: ["compte:.welcome__recent-num=9", "sel:.welcome__recent[data-numero='3'][title$='· Ctrl+3']", "absent:.welcome__recent[data-numero='10']"] },
  { id: "accueil-ctrl-chiffre", sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }), touches: ["Control+3"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\client-03", "ouvertures:1", "sel:.workspace .composer"] },
  // Dossier récent renommé ou déplacé : retrouvé puis rouvert au nouveau chemin ; sinon carte
  // « Dossier introuvable » (Rechercher à nouveau / Choisir le nouvel emplacement / Retirer de la liste).
  { id: "accueil-dossier-retrouve", sim: { cloud: true, introuvables: ["C:\\Users\\utilisateur\\Documents\\Clients\\client-03"], retrouve: "C:\\Users\\utilisateur\\Documents\\Clients\\client-03 (2026)" }, espace: false,
    stockage: () => ({ "axecode.recentWorkspaces": recents25() }), clics: [".welcome__recent[data-numero='3']"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\client-03 (2026)", "ouvertures:2", "appel:dossier_deplacer", "sel:.workspace .composer"] },
  { id: "accueil-dossier-introuvable", sim: { cloud: true, introuvables: ["C:\\Users\\utilisateur\\Documents\\Clients\\client-03"] }, espace: false,
    stockage: () => ({ "axecode.recentWorkspaces": recents25() }), clics: [".welcome__recent[data-numero='3']"],
    temoins: ["Dossier introuvable", "clic:.dossier-introuvable [data-action='rechercher']", "clic:.dossier-introuvable [data-action='choisir']",
      "clic:.dossier-introuvable [data-action='retirer']", "ouvertures:1", "appel:dossier_retrouver", "absent:.workspace", "absent:.welcome__error"] },
  { id: "accueil-dossier-introuvable-retrait", sim: { cloud: true, introuvables: ["C:\\Users\\utilisateur\\Documents\\Clients\\client-03"] }, espace: false,
    stockage: () => ({ "axecode.recentWorkspaces": recents25() }), clics: [".welcome__recent[data-numero='3']", ".dossier-introuvable [data-action='retirer']"],
    temoins: ["absent:.dossier-introuvable", "compte:.welcome__recents[data-liste='dossiers'] .welcome__recent=24", "stocke:axecode.recentWorkspaces=24"] },
  { id: "accueil-numeros-mac", mac: true, sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }),
    temoins: ["compte:.welcome__recent-num=9", "sel:.welcome__recent[data-numero='9'][title$='· ⌘9']"] },
  { id: "accueil-cmd-chiffre-mac", mac: true, sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }), touches: ["Meta+9"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\client-09", "ouvertures:1"] },
  // Dossiers épinglés : section en tête (ordre d'épinglage), mêmes Ctrl+1…9 ; punaise au survol ; épinglé introuvable grisé.
  { id: "accueil-epingles", sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25(), "axecode.pinnedWorkspaces": EPINGLES() }),
    temoins: ["Épinglés", "Récents", "compte:.welcome__recent-item[data-epingle='true']=3", "compte:.welcome__recent-item[data-absent='true']=1",
      "sel:.welcome__recent-item[data-epingle='true'] .welcome__recent[data-numero='1'][title$='· Ctrl+1']", "compte:.welcome__recent-num=9",
      "compte:.welcome__recents[data-liste='dossiers'] .welcome__recent-retirer=23", "compte:.welcome__recents[data-liste='dossiers'] .welcome__recent=26", "compte:.welcome__recent-punaise=3"] },
  { id: "accueil-epingles-ctrl", sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25(), "axecode.pinnedWorkspaces": EPINGLES() }), touches: ["Control+2"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\client-07", "ouvertures:1"] },
  { id: "accueil-epingler-clic", sim: { cloud: true }, espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25() }),
    clics: [".welcome__recents[data-liste='dossiers'] .welcome__recent-item:not([data-epingle]) .welcome__recent-epingler"],
    temoins: ["stocke:axecode.pinnedWorkspaces=1", "compte:.welcome__recent-item[data-epingle='true']=1", "absent:.workspace"] },
  { id: "palette-aller-epingles", espace: false, stockage: () => ({ "axecode.recentWorkspaces": recents25(), "axecode.pinnedWorkspaces": EPINGLES() }), touches: ["Control+k"],
    temoins: ["épinglé · Ctrl+2", "Ctrl+4"] },
  { id: "ide-ctrl-chiffre", sim: {}, stockage: () => colonnes([ids(3)]), saisir: "bonjour", touches: ["Control+2"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin", "ouvertures:2"] },
  { id: "ide-ctrl-chiffre-introuvable", sim: { introuvables: ["C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin"] }, stockage: () => colonnes([ids(3)]), touches: ["Control+2"],
    temoins: ["ouvertures:2", "sel:.dossier-introuvable", "Dossier introuvable", "absent:.workspace"] },
  { id: "ide-ctrl-1-courant", sim: {}, stockage: () => colonnes([ids(3)]), saisir: "bonjour", touches: ["Control+1"],
    temoins: ["ouvertures:1", "valeur:bonjour"] },
  { id: "ide-cmd-chiffre-mac", mac: true, sim: {}, stockage: () => colonnes([ids(3)]), saisir: "bonjour", touches: ["Meta+2"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin", "ouvertures:2"] },
  { id: "raccourcis-dossiers", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true, clics: [".settings-pane__nav-item[data-section='shortcuts']"],
    temoins: ["sel:.axe-raccourcis li[data-raccourci='dossierRecent'] [data-fixe] kbd", "sel:.axe-raccourcis li[data-raccourci='focusExplorateur'] kbd"] },
  // raccourcis-simples (06/11) — Ctrl+T nouvelle conversation, Ctrl+Tab / Ctrl+Maj+Tab onglet du chat
  // suivant / précédent (⌃Tab sur Mac), Échap arrête la réponse (pas quand un menu est ouvert).
  { id: "ide-ctrl-t", sim: {}, stockage: () => colonnes([ids(3)]), touches: ["Control+t"], temoins: ["sel:.conv-create__input"] },
  { id: "ide-ctrl-tab", sim: {}, stockage: () => colonnes([ids(3)]), touches: ["Control+Tab"],
    temoins: ["sel:.onglets-chat__tab[data-active='true'][data-onglet='c-002']"] },
  { id: "ide-ctrl-maj-tab", sim: { active: "c-002" }, stockage: () => colonnes([ids(3)]), touches: ["Control+Shift+Tab"],
    temoins: ["sel:.onglets-chat__tab[data-active='true'][data-onglet='c-001']"] },
  { id: "ide-ctrl-tab-mac", mac: true, sim: {}, stockage: () => colonnes([ids(3)]), touches: ["Control+Tab"],
    temoins: ["sel:.onglets-chat__tab[data-active='true'][data-onglet='c-002']"] },
  { id: "ide-echap-stop", sim: { tour: "en_cours" }, stockage: () => colonnes([ids(3)]), touchesCompositeur: ["Escape"], temoins: ["appel:cancel_turn"] },
  { id: "ide-echap-menu", sim: { tour: "en_cours" }, stockage: () => colonnes([ids(3)]), touchesCompositeur: ["/", "Escape"],
    temoins: ["sansappel:cancel_turn", "sel:.composer__send[data-variant='stop']"] },
  // ordre-dossiers (06/11) — dossier 1, 2, 3 = Ctrl+1, 2, 3 ; l'ordre ne bouge pas tant qu'on ne revient
  // pas à l'accueil (depuis le dossier 2, Ctrl+1 ramène au 1) ; au retour à l'accueil, le plus récent d'abord.
  { id: "ide-ordre-stable", sim: { ouvrirChemin: true }, stockage: () => ({ ...colonnes([ids(3)]), "axecode.recentWorkspaces": RECENTS_TROIS() }), touches: ["Control+3", "Control+1"],
    temoins: [`ouvert:${WS}`, "ouvertures:3"] },
  { id: "ide-ordre-2-puis-1", sim: { ouvrirChemin: true }, stockage: () => ({ ...colonnes([ids(3)]), "axecode.recentWorkspaces": RECENTS_TROIS() }), touches: ["Control+2", "Control+1"],
    temoins: [`ouvert:${WS}`, "ouvertures:3"] },
  { id: "accueil-ordre-maj", sim: { ouvrirChemin: true }, stockage: () => ({ ...colonnes([ids(3)]), "axecode.recentWorkspaces": RECENTS_TROIS() }), touches: ["Control+3", "Control+Shift+h"],
    temoins: ["sel:.welcome__recent[data-numero='1'][title^='Ouvrir atelier-durand']", "sel:.welcome__recent[data-numero='2'][title^='Ouvrir savide']"] },
  // barre-dossiers (06/11) — boutons 1 2 3… juste avant l'indicateur de quota ; clic = bascule, l'ordre
  // ne bouge pas, le dossier ouvert est marqué ; nom au survol ; 9 au plus (moins si la barre est étroite).
  { id: "ide-barre-dossiers", sim: { ouvrirChemin: true }, stockage: () => ({ ...colonnes([ids(3)]), "axecode.recentWorkspaces": RECENTS_TROIS() }),
    temoins: ["si>1100:compte:.barre-dossiers__btn=3", "si>860:sel:.barre-dossiers__btn[data-numero='1'][aria-current='true']",
      "si>920:sel:.barre-dossiers__btn[data-numero='2'][title='cabinet-martin · Ctrl+2']",
      "si>920:clic:.barre-dossiers__btn[data-numero='3']", "si<861:absent:.barre-dossiers"] },
  { id: "ide-barre-dossiers-clic", sim: { ouvrirChemin: true }, stockage: () => ({ ...colonnes([ids(3)]), "axecode.recentWorkspaces": RECENTS_TROIS() }),
    clics: [".barre-dossiers__btn[data-numero='3']"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\atelier-durand", "si>860:sel:.barre-dossiers__btn[data-numero='3'][aria-current='true']",
      "si>1100:sel:.barre-dossiers__btn[data-numero='1'][title^='savide']"] },
  { id: "ide-barre-dossiers-9", sim: {}, stockage: () => ({ ...colonnes([ids(3)]), "axecode.recentWorkspaces": [{ path: WS, name: "savide", lastOpenedMs: 1_800_000_000_000 }, ...recents25()] }),
    temoins: ["si>1100:compte:.barre-dossiers__btn=9", "si>860:sel:.barre-dossiers__btn[data-numero='1'][aria-current='true']", "absent:.barre-dossiers__btn[data-numero='10']"] },
  { id: "libre-barre-dossiers", sim: {}, libre: true, temoins: ["si>920:sel:.axe-freechat .barre-dossiers__btn[data-numero='1']", "absent:.axe-freechat .barre-dossiers__btn[aria-current]"] },
  // macOS : ⌘F (hors éditeur) ouvre la recherche dans les fichiers.
  { id: "mac-cmd-f", mac: true, sim: {}, stockage: () => colonnes([ids(3)]), touches: ["Meta+f"], temoins: ["sel:.sidebar__head-btn[data-active='true']"] },
  // Glisser-déposer : Finder/Explorateur vers le champ du chat, écran Retina (×2) ; dépôt sans chemin = message.
  { id: "depot-chat-mac", mac: true, sim: {}, stockage: () => colonnes([ids(3)]), depot: { echelle: 2, cible: ".composer", chemins: ["/Users/marc/Desktop/Capture d’écran 2026-11-05.png"] }, temoins: ["sel:.composer .chips .chip"] },
  { id: "depot-chat-windows", sim: {}, stockage: () => colonnes([ids(3)]), depot: { cible: ".composer", chemins: ["C:\\Users\\a\\rapport.pdf"] }, temoins: ["sel:.composer .chips .chip"] },
  { id: "depot-vide-mac", mac: true, sim: {}, stockage: () => colonnes([ids(3)]), depot: { echelle: 2, cible: ".composer", chemins: [] }, temoins: ["sel:.sidebar__import-error"] },
  { id: "raccourcis-mac", mac: true, sim: {}, stockage: () => colonnes([ids(3)]), reglages: true, clics: [".settings-pane__nav-item[data-section='shortcuts']"],
    temoins: ["sel:.axe-raccourcis[data-mac='true'] kbd", "sel:.titlebar__btn[data-action='reglages'][title*='⌘']", "uneligne:.axe-raccourcis__touches",
      "sel:.axe-raccourcis__ligne[data-raccourci='conversationSuivante'][data-combinaison='⌃Tab']"] },
  // fournisseurs-178 — Réglages > Fournisseurs configurables, Ollama local avec qwen3:4b (capture d'un utilisateur) :
  // l'IDENTIFIANT (nom exact envoyé à Ollama) est une colonne visible et modifiable ; « qwen3:8b » tapé dans la ligne
  // de qwen3:4b est bien l'identifiant enregistré (avant : seul le libellé changeait, qwen3:4b restait appelé).
  // comptes — Réglages > Fournisseurs : la carte OpenAI montrait l'e-mail et « Plus »,
  // la carte Claude connectée (abonnement OAuth) rien. Chaque compte connecté montre son e-mail et son offre.
  // Réglages > REPL : compte utilisé par la recherche web et les images (abonnement ChatGPT
  // sans clé), API personnalisées (images et vidéo), gabarit JSON invalide signalé, boutons d'ajout.
  { id: "reglages-medias", sim: { comptes: true, medias: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='repl']"],
    temoins: ["sel:[data-regle='recherche'][data-route='abonnement']",
      "sel:.settings-pane__tool-provider-switch [data-fournisseur='auto'][data-active='true']",
      "sel:.settings-pane__tool-provider-switch [data-fournisseur='custom'][data-active='true']",
      "sel:.axe-medias__api[data-type='video'][data-api='fal']",
      "sel:.axe-medias__api[data-api='fal'] [data-erreur='gabarit']",
      "sel:.axe-medias__ajouts [data-prereglage='openai-videos']"] },
  { id: "fournisseurs-comptes", sim: { comptes: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']"],
    temoins: ["sel:.settings-pane__provider-card[data-fournisseur='anthropic'] [data-compte='email']",
      "sel:.settings-pane__provider-card[data-fournisseur='anthropic'] [data-compte='offre']",
      "sel:.settings-pane__provider-card[data-fournisseur='openai'] [data-compte='email']",
      "sel:.settings-pane__provider-card[data-fournisseur='openai'] [data-compte='offre']",
      "sel:.settings-pane__provider-card[data-fournisseur='google'] [data-compte='email']",
      "claude@example.com", "Plus", "Google AI Pro"] },
  // choix du modèle avec beaucoup de modèles (capture : ANTHROPIC Fable 5.1… invisibles,
  // liste plus haute que l'écran sans défilement) : liste bornée à la fenêtre, qui défile, champ de recherche
  // au-delà de 12 modèles ; le modèle choisi est visible à l'ouverture.
  { id: "modeles-nombreux", sim: { modelesNombreux: 40 }, stockage: () => colonnes([ids(1)]),
    clics: [".composer__picker[data-kind=model] .composer__picker-btn"],
    temoins: ["defile:.composer__picker[data-kind=model] .composer__popover-liste", "dedans:.composer__picker[data-kind=model] .composer__popover",
      "sel:.composer__picker[data-kind=model] input[data-champ='recherche-modele']",
      "clic:.composer__picker[data-kind=model] .composer__popover-row[data-selected='true']"] },
  // Recherche : « qwen3 » ne garde que les 3 modèles qwen3 ; Entrée choisit le premier et referme la liste.
  { id: "modeles-recherche", sim: { modelesNombreux: 40 }, stockage: () => colonnes([ids(1)]),
    clics: [".composer__picker[data-kind=model] .composer__picker-btn"],
    taper: [{ sel: ".composer__picker[data-kind=model] input[data-champ='recherche-modele']", texte: "qwen3" }],
    temoins: ["compte:.composer__picker[data-kind=model] .composer__popover-row=3", "dedans:.composer__picker[data-kind=model] .composer__popover"] },
  { id: "modeles-recherche-entree", sim: { modelesNombreux: 40 }, stockage: () => colonnes([ids(1)]),
    clics: [".composer__picker[data-kind=model] .composer__picker-btn"],
    taper: [{ sel: ".composer__picker[data-kind=model] input[data-champ='recherche-modele']", texte: "coder", entree: true }],
    temoins: ["absent:.composer__picker[data-kind=model] .composer__popover", "qwen3-coder:30b"] },
  // catalogue des fournisseurs intégrés complété par l'API (GET /v1/models) : Opus 6,
  // annoncé par Anthropic mais absent de la liste en dur, apparaît une fois (pas sa version datée,
  // pas de doublon d'Opus 5.5) ; 6 Anthropic + 1 nouveau + 3 OpenAI = 10.
  { id: "modeles-catalogue", sim: { catalogue: true }, stockage: () => colonnes([ids(1)]),
    clics: [".composer__picker[data-kind=model] .composer__picker-btn"],
    temoins: ["compte:.composer__picker[data-kind=model] .composer__popover-row=10", "Opus 6", "appel:catalogue_modeles"] },
  // deux comptes Claude connectés (claude@… = connexion d'avant, deuxieme@… ajouté) :
  // un groupe Anthropic par compte, e-mail en sous-titre ; un modèle du 2e compte se choisit.
  { id: "modeles-comptes", sim: { comptesMultiples: true }, stockage: () => colonnes([ids(1)]),
    clics: [".composer__picker[data-kind=model] .composer__picker-btn"],
    temoins: ["compte:.composer__picker[data-kind=model] .axe-model-group__compte=2", "deuxieme@example.com",
      "sel:.composer__popover-row[data-valeur='anthropic~2:claude-opus-5-5']"] },
  { id: "modeles-comptes-choix", sim: { comptesMultiples: true }, stockage: () => colonnes([ids(1)]),
    clics: [".composer__picker[data-kind=model] .composer__picker-btn", ".composer__popover-row[data-valeur='anthropic~2:claude-opus-5-5']"],
    temoins: ["sel:.composer__picker[data-kind=model] .composer__picker-btn[data-fournisseur='anthropic~2']"] },
  // Réglages > Fournisseurs : le compte ajouté sous la carte Claude (e-mail, offre, « Déconnecter »),
  // « Ajouter un compte » ; déconnecter le 2e compte ne touche pas au premier.
  { id: "fournisseurs-plusieurs-comptes", sim: { comptesMultiples: true, comptes: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']"],
    temoins: ["compte:.settings-pane__provider-card[data-fournisseur='anthropic'] [data-compte-ajoute]=1", "deuxieme@example.com",
      "sel:.settings-pane__provider-card[data-fournisseur='anthropic'] [data-action='ajouter-compte']",
      "sel:.settings-pane__provider-card[data-fournisseur='openai'] [data-action='ajouter-compte']",
      "sel:[data-action='deconnecter-compte'][data-compte='anthropic~2']"] },
  { id: "fournisseurs-deconnecter-compte", sim: { comptesMultiples: true, comptes: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", "[data-action='deconnecter-compte'][data-compte='anthropic~2']"],
    temoins: ["absent:[data-compte-ajoute='anthropic~2']", "appel:disconnect_provider_account",
      "sel:.settings-pane__provider-card[data-fournisseur='anthropic'] [data-compte='email']"] },
  // Peu de modèles (Anthropic + OpenAI) : pas de champ de recherche, liste entière dans la fenêtre.
  { id: "modeles-peu", sim: {}, stockage: () => colonnes([ids(1)]),
    clics: [".composer__picker[data-kind=model] .composer__picker-btn"],
    temoins: ["absent:.composer__picker[data-kind=model] input[data-champ='recherche-modele']", "dedans:.composer__picker[data-kind=model] .composer__popover",
      "clic:.composer__picker[data-kind=model] .composer__popover-row"] },
  { id: "fournisseurs-identifiant", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row"],
    taper: [{ sel: ".axe-providers__models input[data-champ='id']", texte: "qwen3:8b" }],
    cliquer: "[data-action='enregistrer-fournisseurs']",
    temoins: ["clic:.axe-providers__models input[data-champ='id']", "sel:.axe-providers__models input[data-champ='label']",
      "champ:.axe-providers__models input[data-champ='id']=qwen3:8b", "enregistre:ollama=qwen3:8b"] },
  // Identifiant vidé : erreur visible sous le tableau, « Enregistrer » grisé.
  { id: "fournisseurs-identifiant-vide", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row"],
    taper: [{ sel: ".axe-providers__models input[data-champ='id']", texte: "" }],
    temoins: ["sel:.axe-providers__model-error[data-erreur='modeles']", "sel:[data-action='enregistrer-fournisseurs']:disabled",
      "sel:.axe-providers__models input[data-champ='id'][aria-invalid='true']"] },
  // « Saisir » : champ « Identifiant exact » dans la carte (plus de window.prompt) ; un doublon est refusé.
  { id: "fournisseurs-saisir-doublon", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row", "[data-action='saisir-modele']"],
    taper: [{ sel: ".axe-providers__saisie input[data-champ='nouvel-id']", texte: "qwen3:4b", entree: true }],
    temoins: ["sel:.axe-providers__saisie [data-erreur='saisie']", "clic:[data-action='ajouter-modele']"] },
  // fenetre-locale — « Saisir » sur Ollama : 32 768 jetons de contexte (plus 128 000 : Ollama réservait 22 Go pour qwen3:4b) ;
  // un modèle qui annonce moins (gemma2:2b, 8 192 par /api/show) garde sa fenêtre ; le contexte reste modifiable.
  { id: "fournisseurs-saisir-local", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row", "[data-action='saisir-modele']"],
    taper: [{ sel: ".axe-providers__saisie input[data-champ='nouvel-id']", texte: "qwen3:8b", entree: true }],
    temoins: ["champ:.axe-providers__models input[data-champ='id']=qwen3:8b", "champ:.axe-providers__models input[data-champ='contexte']=32768",
      "absent:.axe-providers__models input[data-champ='contexte'][value='128000']", "sel:.axe-providers__models input[data-champ='contexte']"] },
  { id: "fournisseurs-saisir-annonce", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row", "[data-action='saisir-modele']"],
    taper: [{ sel: ".axe-providers__saisie input[data-champ='nouvel-id']", texte: "gemma2:2b", entree: true }],
    temoins: ["champ:.axe-providers__models input[data-champ='id']=gemma2:2b", "champ:.axe-providers__models input[data-champ='contexte']=8192"] },
  // « Découvrir » : les identifiants réels du serveur remplissent la colonne Identifiant.
  { id: "fournisseurs-decouvrir", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row", "[data-action='decouvrir-modeles']"],
    temoins: ["champ:.axe-providers__models input[data-champ='id']=gemma2:2b", "champ:.axe-providers__models input[data-champ='id']=qwen3:8b",
      "champ:.axe-providers__models input[data-champ='id']=qwen3:4b"] },
  // « Découvrir » avec un début d'identifiant tapé (champ filtre) : seuls les modèles
  // dont l'identifiant commence pareil sont ajoutés (qwen3:8b ; pas gemma2:2b ni llama3.1:8b).
  { id: "fournisseurs-decouvrir-filtre", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row"],
    taper: [{ sel: ".axe-providers__card input[data-champ='filtre-decouverte']", texte: "qwen3" }],
    cliquer: "[data-action='decouvrir-modeles']",
    temoins: ["compte:.axe-providers__models tbody tr=2", "champ:.axe-providers__models input[data-champ='id']=qwen3:8b"] },
  // 100 modèles ajoutés par erreur : « Annuler les modifications » revient à l'état enregistré, sans enregistrer.
  { id: "fournisseurs-annuler", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row", "[data-action='decouvrir-modeles']", "[data-action='annuler-modifications']"],
    temoins: ["compte:.axe-providers__models tbody tr=1", "champ:.axe-providers__models input[data-champ='id']=qwen3:4b",
      "sel:[data-action='annuler-modifications']:disabled"] },
  // … ou Échap (hors d'un champ de saisie).
  { id: "fournisseurs-annuler-echap", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row", "[data-action='decouvrir-modeles']"],
    touches: ["Escape"],
    temoins: ["compte:.axe-providers__models tbody tr=1", "champ:.axe-providers__models input[data-champ='id']=qwen3:4b"] },
  // Suppression de plusieurs modèles cochés.
  { id: "fournisseurs-retirer-selection", sim: { fournisseursLocaux: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='providers']", ".axe-providers__card .axe-providers__row", "[data-action='decouvrir-modeles']",
      ".axe-providers__models tbody tr:nth-child(1) input[data-champ='choisir']", ".axe-providers__models tbody tr:nth-child(2) input[data-champ='choisir']",
      "[data-action='retirer-selection']"],
    temoins: ["compte:.axe-providers__models tbody tr=2", "champ:.axe-providers__models input[data-champ='id']=qwen3:4b",
      "champ:.axe-providers__models input[data-champ='id']=qwen3:8b", "absent:[data-action='retirer-selection']"] },
  // Réglages > À propos : version lue à l'exécution (getVersion, simulée 0.1.65) sous le titre ; la
  // version lancée avant était la 0.1.64, donc la date de mise à jour est connue et affichée.
  // Lien du site : https://www.axe-international.com (sans « www. » le site ne répond pas).
  { id: "apropos", sim: {}, stockage: () => ({ ...colonnes([ids(3)]), "axe:version-lancee": { version: "0.1.64", majLe: null } }), reglages: true,
    clics: [".settings-pane__nav-item[data-section='about']"],
    temoins: ["sel:.settings-pane__about-version[data-version='0.1.65']", "sel:.settings-pane__about-maj",
      "sel:a.settings-pane__about-link[href='https://www.axe-international.com']", "www.axe-international.com",
      "absent:a[href='https://axe-international.com']",
      "sel:.settings-pane__about-mark svg[data-logo='mark'] rect.logo__fond", "absent:svg linearGradient"] },
  // Réglages > MCP : « Supprimer » sur le serveur « github » (un clic arme, le second confirme) :
  // l'entrée quitte la liste (le moteur la retire de la config), « postgres » reste. Identifiants
  // enregistrés (« cat_github ») ≠ identifiants de l'interface (« mcp_github », recalculés du JSON).
  { id: "mcp-supprimer", sim: { mcp: ["github", "postgres"] }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='mcp']", ".settings-pane__nav-list-item[data-server='github'] .settings-pane__nav-list-item-main", ".settings-pane__mcp-delete", ".settings-pane__mcp-delete[data-confirm='true']"],
    temoins: ["appel:delete_mcp_server", "absent:.settings-pane__nav-list-item[data-server='github']", "sel:.settings-pane__nav-list-item[data-server='postgres']"] },
  // 0.1.71 — session « test — arrière-plan » : hors de la liste, indicateur sur « test ».
  { id: "arriere-plan-liste", sim: { fournisseur: false, collegue: true, arrierePlan: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, temoins: ["clic:.conv-row__bg"] },
  // Parcours d'un collègue (Camille) : connecté au cloud, aucun fournisseur sur son PC,
  // son espace a le fournisseur axe-cloud. Il ouvre son espace, crée « test » (« + »), écrit et envoie.
  { id: "collegue", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, creer: "test", sansFournisseur: true, ecrire: "Bonjour, peux-tu résumer le dossier clients ?", temoins: ["sel:.conv-row"] },
  // … et clique sur ce que lui propose le compositeur (« Connect a provider » s'il est là).
  { id: "collegue-clic", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, creer: "test", sansFournisseur: true, clicConnecter: true, temoins: ["sel:.conv-row"] },
  // … et choisit un autre modèle de son espace dans « test ».
  { id: "collegue-modele", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, creer: "test", choisirModele: "Claude Sonnet 5.5", temoins: ["Claude Sonnet 5.5"] },
  // … ou garde la conversation d'accueil (brouillon du PC) et y choisit un autre modèle.
  { id: "collegue-brouillon-modele", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, choisirModele: "Claude Sonnet 5.5", temoins: ["Claude Sonnet 5.5"] },
  // … envoie un message et le compteur refuse (503, clé Anthropic du serveur absente) : texte
  // exact reçu par l'appli, relevé avec le faux compteur et un vrai démon (scripts/faux-compteur).
  { id: "collegue-erreur-503", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, creer: "test", ecrire: "Bonjour", evenementsTour: tour("s-1", ERREUR_503), temoins: ["erreur 503"] },
  // … reçoit une réponse, puis clique sur « Compaction » / sur son message pour le modifier (D10).
  { id: "collegue-compaction", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, creer: "test", ecrire: "Bonjour", evenementsTour: tourFini("s-1"), compacter: true, temoins: ["sel:.conv-row"] },
  { id: "collegue-reecriture", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, creer: "test", ecrire: "Bonjour", evenementsTour: tourFini("s-1"), reecrire: true, temoins: ["sel:.conv-row"] },
  // … puis ouvre l'arbre de la session (/tree) : il doit être lu sur l'espace (D11).
  // Réglages > Harnais : champ de recherche ; « facture » trouve les notes, mémoires, skills et
  // sous-agents qui le contiennent (titre ou contenu), mot surligné ; clic = l'entrée s'ouvre dans son onglet.
  { id: "harnais-recherche", sim: { harnais: true, harnaisC3: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"], taper: [{ sel: ".axe-harness__search", texte: "facture" }],
    temoins: ["compte:.axe-harness__hit=4", "compte:.axe-harness__hit mark=4", "sel:.axe-harness__hit[data-kind='prompt_note']",
      "sel:.axe-harness__hit[data-kind='memory']", "sel:.axe-harness__hit[data-kind='skill']", "sel:.axe-harness__hit[data-kind='subagent_spec']",
      "absent:.axe-harness__hit[data-id='mem_9aa28189']"] },
  // « Skills 3 » (Harnais) et « Skills 10 » (barre des Réglages) ne comptaient pas la même chose :
  // l'onglet du harnais dit « Skills du harnais » (paquets Python du poste), la barre « Skills » = tous (Markdown + harnais).
  { id: "harnais-skills", sim: { harnais: true, harnaisC3: true, skills: ["unslop", "revue-code"] }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']"],
    temoins: ["sel:.axe-harness__tabs button[data-onglet='skills'][title^='Skills Python du harnais']", "Skills du harnais"] },
  // onglet Affinages : la règle de purge est dite (ratés effacés au bout de 3 jours).
  { id: "harnais-affinages", sim: { harnais: true, harnaisC3: true }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='harness']", ".axe-harness__tabs button[data-onglet='refinements']"],
    temoins: ["sel:.axe-harness__records-note", "Aucun affinage pour l'instant"] },
  // À la réouverture de l'espace : la liste doit montrer les conversations de l'espace (« test »).
  { id: "collegue-liste", sim: { fournisseur: false, collegue: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, temoins: ["test"] },
  // defil178 — longue conversation défilée au milieu puis tout en bas : un clic sur un lien
  // voix-vocabulaire — Réglages > Dictée vocale : mots appris des messages tapés (pastilles), « × » retire « Grafana ».
  { id: "voix-vocabulaire", sim: {}, stockage: () => ({ ...colonnes([ids(3)]), "axe.voix.vocabulaireAuto": { version: 1, actif: true, retires: [], suivis: { grafana: { forme: "Grafana", n: 3, vu: 3 }, pfsense: { forme: "pfSense", n: 2, vu: 2 }, gitlab: { forme: "GitLab", n: 4, vu: 1 }, ivryseine: { forme: "Ivry-sur-Seine-Technopole", n: 2, vu: 1 }, zabbix: { forme: "Zabbix", n: 1, vu: 5 } } } }), reglages: true,
    clics: [".settings-pane__nav-item[data-section='voice']"], cliquer: ".axe-voix-appris__mot[data-mot='grafana'] .axe-voix-appris__retirer", defilerAvantClic: true,
    temoins: ["sel:.axe-voix-appris__mot[data-mot='pfsense']", "sel:.axe-voix-appris__mot[data-mot='gitlab']", "absent:.axe-voix-appris__mot[data-mot='grafana']", "absent:.axe-voix-appris__mot[data-mot='zabbix']", "sel:.axe-voix-appris__effacer", "sel:.axe-voix-appris__mot[data-mot='pfsense'] .axe-voix-appris__retirer"] },
  // mcp-guide — Réglages > MCP : « github » s'arrête au démarrage : la liste le signale (« Erreur »),
  // le détail explique (« s'est arrêté au démarrage ») avec le journal dépliable, et « Tester la connexion » relance la sonde.
  { id: "mcp-erreur", sim: { mcp: ["github", "postgres"], mcpErreur: "github" }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='mcp']", ".settings-pane__nav-list-item[data-server='github'] .settings-pane__nav-list-item-main", ".settings-pane__detail .settings-pane__mcp-tester", ".settings-pane__mcp-journal > summary"],
    temoins: ["sel:.settings-pane__nav-list-item[data-server='github'] .settings-pane__nav-list-item-main[data-etat='error']", "sel:.settings-pane__mcp-erreur", "sel:.settings-pane__mcp-journal[open] > pre", "appel:test_mcp_server", "clic:.settings-pane__detail .settings-pane__mcp-tester", "absent:.settings-pane__nav-list-item[data-server='postgres'] .settings-pane__nav-list-item-main[data-etat='error']"] },
  // … ajout guidé : « Serveur personnalisé » (par défaut), « Serveur distant », adresse, « Tester » -> connexion requise (OAuth).
  // Réglages > MCP : un serveur importé de Codex (stdio, 4 outils), un http et un en erreur.
  { id: "mcp-page", sim: { mcpServeurs: MCP_SERVEURS, mcpOutils: MCP_OUTILS, mcpErreur: "github" }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='mcp']", ".settings-pane__nav-list-item[data-server='node_repl'] .settings-pane__nav-list-item-main"],
    temoins: ["sel:.settings-pane__nav-list-item[data-server='node_repl']"] },
  // Réglages > MCP : liste longue (14 serveurs) amenée tout en bas : la dernière carte tient entière.
  { id: "mcp-liste-bas", sim: { mcpServeurs: MCP_LISTE_LONGUE, mcpOutils: MCP_OUTILS },
    stockage: () => colonnes([ids(3)]), reglages: true, clics: [".settings-pane__nav-item[data-section='mcp']"],
    temoins: ["fond:.mcp-serveur"] },
  // … terminal disponible mais masqué : la barre « Afficher le terminal » (24 px) occupe le bas de la colonne.
  { id: "mcp-liste-bas-terminal", sim: { mcpServeurs: MCP_LISTE_LONGUE, mcpOutils: MCP_OUTILS },
    stockage: () => colonnes([ids(3)]), terminal: true, reglages: true, clics: [".titlebar__btn[title^='Masquer le terminal']", ".settings-pane__nav-item[data-section='mcp']"],
    temoins: ["sel:.terminal-restore__button", "fond:.mcp-serveur"] },
  // … catalogue « Ajouter un serveur » ouvert au-dessus de la liste : la liste garde une hauteur utile et son bas reste atteignable.
  { id: "mcp-liste-bas-catalogue", sim: { mcpServeurs: MCP_LISTE_LONGUE, mcpOutils: MCP_OUTILS },
    stockage: () => colonnes([ids(3)]), terminal: true, reglages: true, clics: [".titlebar__btn[title^='Masquer le terminal']", ".settings-pane__nav-item[data-section='mcp']", ".settings-pane__header .settings-pane__btn[data-primary='true']"],
    temoins: ["sel:.terminal-restore__button", "fond:.mcp-serveur"] },
  { id: "mcp-page-tester", sim: { mcpServeurs: MCP_SERVEURS, mcpOutils: MCP_OUTILS, mcpErreur: "github" }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='mcp']", ".settings-pane__nav-list-item[data-server='github'] .settings-pane__nav-list-item-main", ".settings-pane__detail .settings-pane__mcp-tester"],
    temoins: ["appel:test_mcp_server", "sel:.settings-pane__mcp-erreur"] },
  { id: "mcp-ajout-perso", sim: { mcp: ["postgres"] }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='mcp']", ".settings-pane__header .settings-pane__btn[data-primary='true']", ".settings-pane__mcp-mode-btn[data-mode='http']"],
    saisies: [["input[data-champ='nom']", "Interne"], ["input[data-champ='url']", "https://mcp.exemple.fr/mcp"]],
    apresSaisies: [".settings-pane__mcp-catalog-actions .settings-pane__mcp-tester"],
    temoins: ["sel:.settings-pane__mcp-test[data-tone='auth']", "appel:test_mcp_server", "sel:.settings-pane__mcp-catalog-actions .settings-pane__mcp-ajouter", "sel:.settings-pane__mcp-catalog-item[data-entry='perso'][data-active='true']"] },
  // … modèle distant à connexion par navigateur (Linear) : « Ajouter et se connecter » enregistre puis lance la connexion OAuth.
  { id: "mcp-oauth", sim: { mcp: ["postgres"] }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='mcp']", ".settings-pane__header .settings-pane__btn[data-primary='true']", ".settings-pane__mcp-catalog-item[data-entry='linear']", ".settings-pane__mcp-catalog-actions .settings-pane__mcp-ajouter"],
    temoins: ["appel:save_mcp_settings", "appel:start_mcp_oauth_login_command", "sel:.settings-pane__nav-list-item[data-server='Linear']", "sel:.settings-pane__mcp-auth"] },
  // de fichier, une URL nue ou un lien Markdown ne fait plus bouger la conversation (en bas, elle
  // reste en bas) et le lien s'ouvre.
  { id: "defil-liens", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]),
    defilement: [clicLien(0, "fichier", "milieu"), clicLien(0, "url", "milieu"), clicLien(0, "markdown", "milieu"),
      clicLien(0, "fichier", "bas"), clicLien(0, "url", "bas"), clicLien(0, "markdown", "bas")],
    temoins: ["sel:.md .chat-file-link", "sel:.md .chat-link", "appel:open_external_url_command"] },
  // … et dans la colonne SANS focus (deux colonnes, clics alternés) : changer de colonne recréait
  // les fils des deux colonnes (retour en bas, clic perdu).
  { id: "defil-liens-c2", sim: { liensHistorique: true }, stockage: () => colonnes([["c-001"], ["c-002"]]),
    defilement: [clicLien(1, "fichier", "milieu"), clicLien(0, "url", "milieu"), clicLien(1, "markdown", "milieu"),
      clicLien(0, "fichier", "bas"), clicLien(1, "url", "bas"), clicLien(0, "markdown", "bas")],
    temoins: ["sel:.colonne-chat[data-colonne='1'] .md .chat-link", "appel:open_external_url_command"] },
  // bas169 — remonté dans un long chat : bouton flottant « ↓ » cliquable.
  { id: "chat-aller-en-bas", sim: {}, stockage: () => colonnes([ids(3)]), defilerChatHaut: true, temoins: ["clic:[data-testid='chat-aller-en-bas']"] },
  // hist169 — prompt envoyé puis flèche HAUT dans le compositeur vide : il revient.
  { id: "historique-prompts", sim: {}, stockage: () => colonnes([ids(1)]), ecrire: "relance le banc à 800 px", touchesCompositeur: ["ArrowUp"],
    temoins: ["valeur:relance le banc à 800 px"] },
  // Clic droit sur un chemin de fichier du chat (milieu d'une longue conversation) :
  // menu, puis « Afficher dans l'explorateur » (dossiers dépliés, fichier choisi) et les deux copies.
  { id: "chemin-chat-menu", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), cheminChat: {},
    temoins: ["clic:.chat-path-menu .tree-menu__item"] },
  { id: "chemin-chat-explorateur", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), cheminChat: { menu: "Afficher dans l'explorateur" },
    temoins: ["sel:.sidebar__body .tree-row[data-selected='true']", "absent:.chat-path-menu"] },
  { id: "chemin-chat-copier", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), cheminChat: { menu: "Copier le chemin" },
    temoins: ["absent:.chat-path-menu"] },
  { id: "chemin-chat-relatif", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), cheminChat: { menu: "Copier le chemin relatif" },
    temoins: ["absent:.chat-path-menu"] },
  // Barre des liens de la conversation : repliée (bouton + nombre), dépliée filtrable, clic = même
  // action que dans le chat, clic droit = menu des chemins ; la conversation ne bouge pas.
  { id: "liens-barre", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), barreLiens: {},
    temoins: ["sel:.chat-links__item"] },
  { id: "liens-barre-fichier", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), barreLiens: { filtre: "code", clic: "fichier" },
    temoins: ["sel:.editor-col .tabs .tab[data-active='true']"] },
  { id: "liens-barre-url", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), barreLiens: { filtre: "url", clic: "url" },
    temoins: ["appel:open_external_url_command"] },
  { id: "liens-barre-menu", sim: { liensHistorique: true }, stockage: () => colonnes([ids(1)]), barreLiens: { filtre: "code", clic: "droit" },
    temoins: ["clic:.chat-path-menu .tree-menu__item"] },
  // aperçu d'un QCM .md : cliquer une case la coche/décoche et ENREGISTRE le fichier
  // (seule la bonne ligne change, CRLF gardé, la fausse case du bloc de code ignorée) ; Ctrl+Z annule.
  { id: "cases-cocher", sim: { fichierQcm: true }, stockage: () => colonnes([ids(1)]), ouvrirFichier: "qcm.md",
    clics: [".editor-preview-toggle", ".editor-md-preview ul:nth-of-type(1) > li:nth-child(1) input[type='checkbox']"],
    temoins: ["qcm:# QCM\r\n\r\n<!-- id: q1 -->\r\n1. Choix A ?\r\n\r\n- [x] oui\r\n- [x] non\r\n\r\n```md\r\n- [ ] pas une case\r\n```\r\n\r\n<!-- id: q2 -->\r\n- [X] déjà\r\n- [ ] autre\r\n", "sel:.editor-md-preview ul:nth-of-type(1) > li:nth-child(1) input:checked"] },
  { id: "cases-decocher", sim: { fichierQcm: true }, stockage: () => colonnes([ids(1)]), ouvrirFichier: "qcm.md",
    clics: [".editor-preview-toggle", ".editor-md-preview ul:nth-of-type(2) > li:nth-child(1) input[type='checkbox']"],
    temoins: ["qcm:# QCM\r\n\r\n<!-- id: q1 -->\r\n1. Choix A ?\r\n\r\n- [ ] oui\r\n- [x] non\r\n\r\n```md\r\n- [ ] pas une case\r\n```\r\n\r\n<!-- id: q2 -->\r\n- [ ] déjà\r\n- [ ] autre\r\n"] },
  { id: "cases-annuler", sim: { fichierQcm: true }, stockage: () => colonnes([ids(1)]), ouvrirFichier: "qcm.md",
    clics: [".editor-preview-toggle", ".editor-md-preview ul:nth-of-type(1) > li:nth-child(2) input[type='checkbox']"],
    touches: ["Control+z"],
    temoins: ["qcm:# QCM\r\n\r\n<!-- id: q1 -->\r\n1. Choix A ?\r\n\r\n- [ ] oui\r\n- [x] non\r\n\r\n```md\r\n- [ ] pas une case\r\n```\r\n\r\n<!-- id: q2 -->\r\n- [X] déjà\r\n- [ ] autre\r\n", "sel:.editor-md-preview ul:nth-of-type(1) > li:nth-child(2) input:checked"] },
  // Réglages > Outils (capture d'un utilisateur : formulaire sans style ni hiérarchie). Cette édition est
  // 100 % locale : le registre de scripts (qui demande le serveur) n'est plus affiché ; les champs des outils
  // du REPL sont bordés, avec le libellé au-dessus et des cases à cocher de 24 px.
  { id: "outils-repl", ...REGISTRE(".axe-repl__card"),
    temoins: ["absent:.axe-registre", "sel:.axe-repl__field input[type='number']", "sel:.axe-repl__field select"] },
  { id: "outils-repl-modules", ...REGISTRE(".axe-repl__modules"),
    temoins: ["absent:.axe-registre", "sel:.axe-repl__case input[type='checkbox']", "compte:.axe-repl__module=3"] },
  ...scenesGit({ colonnes, ids }), // panneau Git
  ...scenesForge({ colonnes, ids }),
  // Quotas — quotas de tous les abonnements dans la barre du haut : vue compacte (fenêtre la plus
  // pleine, compte, heure de réinitialisation au-delà du seuil), détail au clic avec trois comptes (un
  // e-mail très long, un compte ChatGPT à renouveler), réglages % utilisé / % restant et seuil d'alerte.
  { id: "quotas-detail", sim: { quotas: "plusieurs" }, stockage: () => colonnes([ids(3)]), cliquer: ".axe-quota__pill",
    temoins: ["sel:.axe-quota__popover .axe-quota__provider .axe-quota__bar", "compte:.axe-quota__provider=3", "sel:.axe-quota__provider .axe-quota__error",
      "clic:.axe-quota__choix button[aria-pressed='false']", "sel:.axe-quota__seuil input"], attendus: ["atelier.durand@gmail.com"] },
  { id: "quotas-restant", sim: { quotas: "plusieurs" }, stockage: () => ({ ...colonnes([ids(3)]), "quotas.reglages": { mode: "restant", seuil: 80 } }),
    cliquer: [".axe-quota__pill", ".axe-quota__choix button[aria-pressed='false']"],
    temoins: ["sel:.axe-quota__pill .axe-quota__compact", "sel:.axe-quota__choix button[aria-pressed='true']"] },
  // Quotas — jauge du contexte (84 k / 200 k, repère du compactage) et minuteur du cache de 5 min
  // dans l'en-tête du chat, en une colonne et en trois colonnes étroites.
  // Colonne de 420 px (défaut) : barre, pourcentage et minuteur ; à 800 px, la colonne rétrécit : sans la barre.
  { id: "jauge-contexte", sim: { quotas: "plusieurs" }, stockage: () => colonnes([ids(3)]),
    temoins: ["sel:.chat-head .jauge-contexte__jauge .jauge-contexte__pct", "sel:.chat-head .jauge-contexte__cache",
      "si>1000:sel:.chat-head .jauge-contexte__jauge .jauge-contexte__barre"] },
  { id: "jauge-contexte-c3", sim: { quotas: "plusieurs" }, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]),
    temoins: ["sel:.colonne-chat[data-focus='true'] .chat-head .jauge-contexte__jauge"] },
  // Quotas — reprise automatique prévue après une limite d'abonnement : la conversation et un
  // sous-agent au nom long ; « Annuler » retire la reprise de la conversation (le sous-agent reste).
  { id: "reprise-bandeau", sim: { quotas: "plusieurs" }, stockage: () => ({ ...colonnes([ids(3)]), "reprise.file": REPRISES() }),
    temoins: ["sel:.bandeau-reprise", "compte:.bandeau-reprise__ligne=2", "clic:.bandeau-reprise__ligne[data-enfant='false'] .bandeau-reprise__annuler"] },
  { id: "reprise-annulee", sim: { quotas: "plusieurs" }, stockage: () => ({ ...colonnes([ids(3)]), "reprise.file": REPRISES() }),
    cliquer: ".bandeau-reprise__ligne[data-enfant='false'] .bandeau-reprise__annuler",
    temoins: ["compte:.bandeau-reprise__ligne=1", "stocke:reprise.file=1"] },
  ...SCENES_WORKTREES, // worktrees
  ...SCENES_REVUE, // revue des changements
  ...SCENES_EDITEUR,
  // Navigateur intégré : onglet ouvert depuis la barre de titre (accueil : serveurs du dossier),
  // page chargée + Design Mode (élément choisi, « Envoyer à la conversation »), volet Ports, réglage des liens.
  { id: "navigateur-accueil", sim: {}, stockage: () => colonnes([ids(1)]),
    cliquer: [".titlebar__btn[data-bouton='navigateur']"],
    temoins: ["sel:.tab[data-onglet-special='navigateur'][data-active='true']", "sel:.nav__barre .nav__champ",
      "sel:.nav__accueil .nav__port[data-port='5173']", "sel:.nav__accueil .nav__port[data-port='5173'] .nav__bouton"] },
  { id: "navigateur-element", sim: { navigateur: { url: "http://localhost:5173/", titre: "Tableau de bord — démo", choix: true } }, stockage: () => colonnes([ids(1)]),
    cliquer: [".titlebar__btn[data-bouton='navigateur']", ".nav__barre [data-action='design']"],
    temoins: ["sel:.nav__page", "sel:.nav__volet .nav__element", "sel:.nav__volet [data-action='envoyer']"] },
  { id: "navigateur-ports", sim: { navigateur: { url: "http://localhost:5173/", titre: "Tableau de bord — démo" } }, stockage: () => colonnes([ids(1)]),
    cliquer: [".titlebar__btn[data-bouton='navigateur']", ".nav__barre [data-action='ports']"],
    temoins: ["sel:.nav__volet .nav__port[data-port='3000']", "sel:.nav__volet .nav__port[data-port='8000'] .nav__bouton"] },
  { id: "reglages-navigateur", sim: {}, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='navigateur']"],
    temoins: ["sel:.nav-reglages__choix[data-mode='local'] input:checked", "sel:.nav-reglages__choix[data-mode='systeme']"] },
  // automatisations — écran Automatisations (Ctrl+Maj+L, ou bouton de la vue Agents) : toutes les
  // automatisations, historique, conversation d'une exécution, création guidée, jours cochés, état vide,
  // ouverture depuis l'accueil, Échap qui ferme l'écran.
  { id: "auto-raccourci", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), touches: ["Control+Shift+KeyL"],
    temoins: ["sel:.auto-ecran__panneau", "compte:.auto-carte=4", "clic:.auto-ecran__fermer", "Tri des tickets du support du matin"] },
  { id: "auto-liste", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), agents: true, clics: [".auto-entree"],
    temoins: ["compte:.auto-carte=4", "sel:.auto-carte[data-etat='en_cours'] [data-action='arreter']", "sel:.auto-carte[data-etat='pause']",
      "clic:.auto-carte[data-id='a-tickets'] [data-action='supprimer']", "Du lundi au vendredi à 8 h"] },
  { id: "auto-historique", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), agents: true,
    clics: [".auto-entree", ".auto-carte[data-id='a-tickets'] [data-action='historique']"],
    temoins: ["compte:.auto-historique .auto-exec=5", "clic:.auto-historique [data-action='voir']", "sel:.auto-exec .auto-statut[data-statut='echouee']"] },
  { id: "auto-journal", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), agents: true,
    clics: [".auto-entree", ".auto-carte[data-id='a-tickets'] [data-action='historique']", ".auto-historique [data-action='voir']"],
    temoins: ["sel:.auto-journal .axe-journal__msg", "clic:.auto-ecran__tete .auto-btn"] },
  { id: "auto-creer", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), agents: true,
    clics: [".auto-entree", ".auto-ecran__tete .auto-btn--primaire"],
    temoins: ["sel:.auto-form", "clic:.auto-form__actions .auto-btn--primaire", "clic:.auto-form__actions .auto-btn:not(.auto-btn--primaire)", "sel:.auto-apercu"] },
  // … les cases du bas, amenées à l'écran l'une après l'autre puis cliquées (à 800x600 les champs défilent, les
  // boutons restent visibles). Témoins « sel: » et non « clic: » : le banc agrandit le texte APRÈS les gestes,
  // ce qui repousse le bas d'une zone déjà défilée hors de la vue (constaté à texte 110 %).
  { id: "auto-creer-bas", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), agents: true,
    clics: [".auto-entree", ".auto-ecran__tete .auto-btn--primaire"], defilerAvantClic: true,
    cliquer: [".auto-form input[data-champ='rattrapage']", ".auto-form input[data-champ='active']"],
    temoins: ["sel:.auto-form input[data-champ='rattrapage']:not(:checked)", "sel:.auto-form input[data-champ='active']:not(:checked)",
      "clic:.auto-form__actions .auto-btn--primaire"] },
  { id: "auto-modifier-jours", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), agents: true,
    clics: [".auto-entree", ".auto-carte[data-id='a-tickets'] [data-action='modifier']"],
    temoins: ["compte:.auto-jour=7", "compte:.auto-jour[aria-pressed='true']=5", "clic:.auto-jour"] },
  { id: "auto-vide", sim: { automatisations: "aucune" }, stockage: () => colonnes([ids(1)]), agents: true, clics: [".auto-entree"],
    temoins: ["sel:.auto-vide", "clic:.auto-vide .auto-btn--primaire"] },
  { id: "auto-accueil", sim: { automatisations: "plusieurs" }, espace: false, touches: ["Control+Shift+KeyL"],
    temoins: ["sel:.auto-ecran__panneau", "compte:.auto-carte=4"] },
  { id: "auto-echap", sim: { automatisations: "plusieurs" }, stockage: () => colonnes([ids(1)]), touches: ["Control+Shift+KeyL", "Escape"],
    temoins: ["absent:.auto-ecran"] },
  // Agents en ligne de commande — Réglages : installés / absents (page d'installation), autonomie complète
  // avec avertissement, aperçu de la commande.
  { id: "agents-cli-reglages", sim: {}, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='agentsCli']"],
    temoins: ["sel:.acli-reglages [data-liste='installes'] .acli-agent[data-agent='claude']", "compte:.acli-reglages [data-liste='installes'] .acli-agent=3",
      "sel:.acli-reglages [data-liste='absents'] .acli-agent[data-agent='gemini']", "absent:.acli-erreur"],
 },
  { id: "agents-cli-autonomie", sim: { agentsCliAutonomie: ["claude"] }, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='agentsCli']"], cliquer: ".acli-agent[data-agent='claude'] > summary", defilerAvantClic: true,
    temoins: ["sel:.acli-agent[data-agent='claude'][open] .acli-avertissement", "sel:.acli-agent[data-agent='claude'] .acli-pastille[data-genre='autonomie']",
      "sel:.acli-agent[data-agent='claude'] .acli-agent__ligne code", "clic:.acli-agent[data-agent='claude'] .acli-case input"] },
  { id: "agents-cli-absent", sim: {}, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='agentsCli']"], cliquer: ".acli-agent[data-agent='gemini'] > summary", defilerAvantClic: true,
    temoins: ["clic:.acli-agent[data-agent='gemini'][open] .acli-agent__installer", "sel:.acli-agent[data-agent='gemini'] .acli-pastille[data-genre='absent']"] },
  // Agents en ligne de commande — terminal : menu « Nouvel agent » (dossier courant ou nouvel arbre de
  // travail, reprise de session), onglet « agent · dossier ».
  { id: "agents-cli-menu", sim: { cloud: false }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: ".terminal-tabs__actions [data-action='nouvel-agent']",
    temoins: ["sel:.acli-menu--agents .acli-menu__item[data-agent='claude']", "compte:.acli-menu--agents .acli-menu__ligne=3",
      "clic:.acli-menu--agents .acli-menu__choix button[data-ou='arbre']", "clic:.acli-menu--agents [data-action='reglages-agents']",
      "clic:.acli-menu--agents .acli-menu__ligne[data-agent='codex'] [data-action='reprendre']"] },
  { id: "agents-cli-lance", sim: { cloud: false }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: [".terminal-tabs__actions [data-action='nouvel-agent']", ".acli-menu--agents .acli-menu__item[data-agent='claude']"], pauseClics: 700,
    temoins: ["sel:.terminal-tab[data-agent='claude'][data-active='true']", "sel:.acli-surface[data-agent='claude'] .xterm-screen", "absent:.acli-menu--agents"] },
  { id: "agents-cli-arbre", sim: { cloud: false }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: [".terminal-tabs__actions [data-action='nouvel-agent']", ".acli-menu--agents .acli-menu__choix button[data-ou='arbre']",
      ".acli-menu--agents .acli-menu__item[data-agent='codex']"], pauseClics: 700,
    temoins: ["sel:.terminal-tab[data-agent='codex'][data-active='true']", "absent:.acli-menu--agents"] },
  // Agents en ligne de commande — état d'un agent de terminal : attend (BEL), arrêté avec un code
  // (barre « Relancer / Reprendre une session »), rouvert avec l'appli (rien ne tourne).
  { id: "agents-cli-attend", sim: { cloud: false, agentCli: "attend" }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: [".terminal-tabs__actions [data-action='nouvel-agent']", ".acli-menu--agents .acli-menu__item[data-agent='claude']"], pauseClics: 900,
    temoins: ["sel:.terminal-tab[data-agent='claude'] .terminal-tab__status[data-etat='attend']", "absent:.acli-fin"] },
  { id: "agents-cli-echec", sim: { cloud: false, agentCli: "echec" }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: [".terminal-tabs__actions [data-action='nouvel-agent']", ".acli-menu--agents .acli-menu__item[data-agent='claude']"], pauseClics: 900,
    temoins: ["sel:.terminal-tab[data-agent='claude'] .terminal-tab__status[data-etat='echec']", "clic:.acli-fin [data-action='relancer']",
      "clic:.acli-fin [data-action='reprendre']"] },
  { id: "agents-cli-rouvert", sim: { cloud: false }, terminal: true,
    stockage: () => ({ ...colonnes([ids(1)]), [`axecode:terminals:${WS}`]: [{ index: 1, title: "Terminal 1", shell: "powershell" },
      { index: 2, title: "Codex · axecode", shell: "powershell", agent: { cli: "codex", nom: "Codex", dossier: WS, reprise: true } }] }),
    cliquer: ".terminal-tab[data-agent='codex']",
    temoins: ["sel:.terminal-tab[data-agent='codex'] .terminal-tab__status[data-etat='pause']", "clic:.acli-fin [data-action='relancer']",
      "clic:.acli-fin [data-action='reprendre']"] },
  // Terminal : menu « Plus d'actions » (rechercher, copier toute la sortie, scinder), recherche (Ctrl+F),
  // terminal scindé en deux, gestionnaire des terminaux ouverts (aller à, arrêter, tout arrêter).
  { id: "terminal-actions", sim: { cloud: false }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: ".terminal-tabs__actions [data-action='plus-terminal']",
    temoins: ["clic:.acli-menu--actions [data-action='rechercher']", "clic:.acli-menu--actions [data-action='copier-tout']", "clic:.acli-menu--actions [data-action='scinder']"] },
  { id: "terminal-recherche", sim: { cloud: false }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: [".terminal-tabs__actions [data-action='plus-terminal']", ".acli-menu--actions [data-action='rechercher']"],
    temoins: ["sel:.terminal-views .acli-recherche input", "sel:.acli-recherche [data-action='fermer-recherche']", "absent:.acli-menu--actions"] },
  { id: "terminal-scinde", sim: { cloud: false }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: [".terminal-tabs__actions [data-action='plus-terminal']", ".acli-menu--actions [data-action='scinder']"], pauseClics: 700,
    temoins: ["sel:.terminal-views[data-scinde='true'] .terminal-viewport[data-cote='gauche'] .xterm-screen",
      "sel:.terminal-views[data-scinde='true'] .terminal-viewport[data-cote='droite'] .xterm-screen"] },
  { id: "terminaux-ouverts", sim: { cloud: false }, terminal: true,
    stockage: () => ({ ...colonnes([ids(1)]), [`axecode:terminals:${WS}`]: [{ index: 1, title: "Terminal 1", shell: "powershell" },
      { index: 2, title: "Construction de la 0.1.86 pour Windows et macOS", shell: "powershell" },
      { index: 3, title: "Codex · axecode", shell: "powershell", agent: { cli: "codex", nom: "Codex", dossier: WS, reprise: true } }] }),
    cliquer: ".terminal-tabs__actions [data-action='terminaux-ouverts']",
    temoins: ["compte:.acli-menu--terminaux .acli-menu__ligne=3", "clic:.acli-menu--terminaux .acli-menu__ligne[data-terminal='terminal-2'] [data-action='aller']",
      "sel:.acli-menu--terminaux [data-action='tout-arreter']"] },
  // Commandes et prompts enregistrés : Réglages > Commandes (exemples du premier lancement), menu de la
  // barre des terminaux, bouton du compositeur du chat.
  { id: "commandes-reglages", sim: {}, stockage: () => colonnes([ids(1)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='commandes']"],
    temoins: ["compte:.acli-commandes .acli-commande=2", "sel:.acli-commande[data-genre='prompt'] textarea", "clic:[data-action='ajouter-commande']",
      "si>900:clic:.acli-commande[data-commande='exemple-git'] [data-action='supprimer-commande']", "compte:.acli-commande [data-action='supprimer-commande']=2"] },
  { id: "commandes-terminal", sim: { cloud: false }, stockage: () => colonnes([ids(1)]), terminal: true,
    cliquer: ".terminal-tabs__actions [data-action='commandes-terminal']",
    temoins: ["clic:.acli-menu--commandes [data-commande='exemple-git']", "sel:.acli-menu--commandes [data-commande='exemple-relire'][aria-disabled='true']",
      "clic:.acli-menu--commandes [data-action='gerer-commandes']"] },
  { id: "commandes-chat", sim: {}, stockage: () => colonnes([ids(1)]),
    cliquer: [".composer [data-action='commandes-chat']", ".acli-menu--commandes [data-commande='exemple-git']"],
    temoins: ["valeur:git diff --stat", "absent:.acli-menu--commandes"] },
  // Ctrl+P : ouvrir un fichier par son nom (liste par rg --files simulée),
  // lettres trouvées surlignées, Entrée ouvre, Ctrl+Entrée ouvre dans une autre colonne.
  { id: "palette-fichiers", stockage: () => colonnes([ids(1)]), touches: ["Control+p"],
    temoins: ["sel:.palette[data-palette='fichiers'] .palette__champ input", "sel:.palette__element[data-actif='true']", "README.md", "appel:palette_fichiers"] },
  { id: "palette-fichiers-cherche", stockage: () => colonnes([ids(1)]), touches: ["Control+p"],
    taper: [{ sel: ".palette__champ input", texte: "wsp", ajouter: true }],
    temoins: ["sel:.palette__element[data-index='0'] .palette__titre[title='Workspace.tsx'] mark", "absent:.palette__element[data-index='0'] .palette__titre[title='README.md']"] },
  { id: "palette-fichiers-ouvrir", stockage: () => colonnes([ids(1)]), touches: ["Control+p"],
    taper: [{ sel: ".palette__champ input", texte: "readme", ajouter: true }], touchesFin: ["Enter"],
    temoins: ["absent:.palette", "sel:.editor-col .tabs .tab[data-active='true']", "appel:read_workspace_file_command"] },
  { id: "palette-fichiers-colonne", stockage: () => colonnes([ids(1)]), ouvrirFichier: "Cargo.toml", touches: ["Control+p"],
    taper: [{ sel: ".palette__champ input", texte: "stream", ajouter: true }], touchesFin: ["Control+Enter"],
    temoins: ["absent:.palette", "compte:.colonne-fichiers=2", "sel:.colonne-fichiers[data-colonne-index='1'] .tab[data-active='true']"] },
  // Ctrl+K « Aller à » : onglets, conversations de tous les dossiers, dossiers
  // récents, sous-agents, terminaux, Réglages ; dès 2 lettres, extraits du texte des conversations.
  { id: "palette-aller", sim: { sousAgents: 2 }, stockage: () => ({ ...colonnes([ids(2)]), "axecode.recentWorkspaces": RECENTS_TROIS() }), touches: ["Control+k"],
    temoins: ["sel:.palette[data-palette='aller'] .palette__champ input", "sel:.palette__groupe", "appel:palette_conversations", "Postes du cabinet Martin : import FIC", "cabinet-martin"] },
  { id: "palette-aller-contenu", stockage: () => colonnes([ids(1)]), touches: ["Control+k"], taper: [{ sel: ".palette__champ input", texte: "banc", ajouter: true }],
    temoins: ["sel:.palette__element[data-genre='extrait'] .palette__detail mark", "appel:palette_recherche_conversations"] },
  { id: "palette-aller-reglage", stockage: () => colonnes([ids(1)]), touches: ["Control+k"], taper: [{ sel: ".palette__champ input", texte: "outils repl", ajouter: true }],
    touchesFin: ["Enter"], temoins: ["absent:.palette", "sel:.settings-pane__nav-item[data-section='repl'][data-active='true']"] },
  { id: "palette-aller-accueil", espace: false, stockage: () => ({ "axecode.recentWorkspaces": RECENTS_TROIS() }), touches: ["Control+k"],
    temoins: ["sel:.palette[data-palette='aller'] .palette__element", "cabinet-martin", "absent:.workspace"] },
  { id: "palette-aller-accueil-dossier", espace: false, sim: { ouvrirChemin: true }, stockage: () => ({ "axecode.recentWorkspaces": RECENTS_TROIS() }),
    touches: ["Control+k", "c", "a", "b", "i", "n", "e", "t", "Enter"],
    temoins: ["ouvert:C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin", "absent:.palette"] },
  // Recherche dans les Réglages : un mot (sans accents ni casse) filtre les
  // sections et les réglages ; un clic ouvre la section et signale le réglage ; Ctrl+K les trouve aussi.
  { id: "reglages-recherche", stockage: () => colonnes([ids(1)]), reglages: true,
    taper: [{ sel: ".recherche-reglages__champ input", texte: "zoom", ajouter: true }],
    temoins: ["sel:.recherche-reglages[data-active='true'] .recherche-reglages__ligne[data-genre='reglage'] mark", "absent:.settings-pane__nav > .settings-pane__nav-item", "Zoom de l'interface"] },
  { id: "reglages-recherche-aller", stockage: () => colonnes([ids(1)]), reglages: true,
    taper: [{ sel: ".recherche-reglages__champ input", texte: "compactage", ajouter: true }], touchesFin: ["ArrowDown", "Enter"],
    temoins: ["sel:.recherche-reglages__resultats [data-section='repl'][data-active='true']"] },
  { id: "reglages-recherche-vide", stockage: () => colonnes([ids(1)]), reglages: true,
    taper: [{ sel: ".recherche-reglages__champ input", texte: "xyzw", ajouter: true }],
    temoins: ["sel:.recherche-reglages__vide"] },
  { id: "palette-aller-reglage-precis", stockage: () => colonnes([ids(1)]), touches: ["Control+k"],
    taper: [{ sel: ".palette__champ input", texte: "compactage auto", ajouter: true }], touchesFin: ["Enter"],
    temoins: ["absent:.palette", "sel:.settings-pane__nav-item[data-section='repl'][data-active='true']"] },
  // Explorateur : couleurs git (modifié, nouveau, ignoré, en conflit) sur les
  // fichiers et les dossiers ; clic droit « Rechercher dans ce dossier » (volet limité au dossier).
  { id: "explorateur-git", stockage: () => colonnes([ids(1)]), explorateur: { clic: "src" },
    temoins: ["sel:.tree-row[data-entry-path='src'][data-git='conflit'] .tree-row__git", "sel:.tree-row[data-entry-path='src/Workspace.tsx'][data-git='modifie']",
      "sel:.tree-row[data-entry-path='src/stream.ts'][data-git='nouveau']", "sel:.tree-row[data-entry-path='README.md'][data-git='modifie']",
      "sel:.tree-row[data-entry-path='web'][data-git='ignore']", "sel:.tree-row[data-entry-path='scripts'][data-git='nouveau']", "appel:explorateur_git"] },
  { id: "explorateur-recherche-dossier", stockage: () => colonnes([ids(1)]), explorateur: { clicDroit: "src", menu: "Rechercher dans ce dossier" },
    touchesFin: ["p", "a", "l", "e", "t", "t", "e"],
    temoins: ["sel:.search-pane__dossier", "Dans src", "appel:palette_recherche_dossier", "sel:.search-result__file[title='src/Workspace.tsx']"] },
  // « Ouvrir dans… » VS Code, Cursor, Zed (simulés) au clic droit et dans Ctrl+K ;
  // Aide dans Réglages > À propos (journaux ; sous Windows, relancer en administrateur).
  { id: "explorateur-ouvrir-dans", stockage: () => colonnes([ids(1)]), explorateur: { clicDroit: "README.md", menu: "Ouvrir dans VS Code" },
    temoins: ["appel:ouvrir_dans_editeur", "absent:.tree-menu"] },
  { id: "explorateur-menu-editeurs", stockage: () => colonnes([ids(1)]), explorateur: { clicDroit: "src" },
    temoins: ["Ouvrir dans VS Code", "Ouvrir dans Zed", "Rechercher dans ce dossier"] },
  { id: "palette-aller-editeur", stockage: () => colonnes([ids(1)]), touches: ["Control+k"],
    taper: [{ sel: ".palette__champ input", texte: "dossier dans cursor", ajouter: true }], touchesFin: ["Enter"],
    temoins: ["appel:ouvrir_dans_editeur", "absent:.palette"] },
  { id: "reglages-aide", stockage: () => colonnes([ids(1)]), reglages: true, clics: [".settings-pane__nav-item[data-section='about']"],
    cliquer: [".aide-appli [data-action='ouvrir-journaux']"],
    temoins: ["appel:ouvrir_dossier_journaux", "sel:.aide-appli__message"] },
];
SCENES.push(...SCENES_INTEROP);
