// Scenes du banc d'affichage : etat de l'appli a rendre, et gestes pour y arriver.
// Chaque scene est rejouee dans chaque situation (taille de fenetre x mise a l'echelle x texte).
// Témoins (« sel: » + sélecteur CSS d'un élément visible) : jamais un libellé de
// l'interface, qui est traduit. « attendus » : textes de NOS données (pas de
// l'interface) qui doivent rester affichés (règle texte-disparu).
import { WS_BANC as WS } from "./constantes.mjs";

const ids = (n, depart = 0) => Array.from({ length: n }, (_, i) => `c-${String(depart + i + 1).padStart(3, "0")}`);
const TITRES = {
  "c-001": "Corriger tous les défauts d'affichage de la barre de titre, du compositeur et des colonnes à 800 px avec la mise à l'échelle Windows à 150 %",
  "c-002": "Facture OVH d'octobre : rapprochement des lignes et export comptable",
  "c-003": "Tri des tickets Jira du jour",
  "c-004": "Migration des postes du centrex du client (fichier FIC) pour le cabinet Martin et l'atelier Durand",
  "c-005": "VPN BBATI",
  "c-006": "Rapport DMARC hmcc.fr",
  "c-007": "Compilation croisée Windows de la 0.1.57 et publication de l'installeur dans les téléchargements",
  "c-008": "Questions sur le pare-feu pfSense du client",
  "c-009": "Résumé de la réunion",
  "x-404": "Ancienne conversation au fichier abîmé",
};
// Tour refusé par le compteur Axe Cloud : événements tels que le pont du démon les émet
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

export const SCENES = [
  // Mise à jour disponible (demande de Savinien, 23/10) : badge discret en haut à droite, jamais d'écran bloquant ;
  // au clic, fenêtre avec les notes et « Installer maintenant » / « Plus tard ».
  { id: "maj-badge", sim: { majDispo: "0.1.66" }, stockage: () => colonnes([ids(3)]), temoins: ["clic:.titlebar__update[data-state='available'] .titlebar__update-pill", "absent:.updater-lock"] },
  { id: "maj-badge-fenetre", sim: { majDispo: "0.1.66" }, stockage: () => colonnes([ids(3)]), cliquer: ".titlebar__update-pill", temoins: ["sel:.titlebar__update-popover .titlebar__update-popover-notes", "clic:.titlebar__update-popover-btn--primary", "clic:.titlebar__update-popover-btn--ghost", "absent:.updater-lock"] },
  { id: "maj-badge-accueil", sim: { majDispo: "0.1.66" }, espace: false, temoins: ["clic:.welcome__maj .titlebar__update-pill"] },
  { id: "accueil", sim: { cloud: true }, espace: false, temoins: ["sel:button.welcome__cta", "absent:svg linearGradient"] },
  // axe:0.1.71 — bulle d'info de la dictée (« Transcrit par … en 6,0 s, nettoyé par l'IA. ») : elle débordait du compositeur.
  { id: "dictee-info", sim: {}, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".axe-voix__valider"], pauseClics: 1500, attendre: ".axe-voix__bulle--info", temoins: ["clic:.axe-voix__bulle--info"] },
  { id: "dictee-info-c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), cliquer: [".axe-voix__micro", ".axe-voix__valider"], pauseClics: 1500, attendre: ".axe-voix__bulle--info", temoins: ["clic:.axe-voix__bulle--info"] },
  // axe:0.1.71 — pendant l'enregistrement, la barre de dictée recouvrait le bouton Envoyer (colonne étroite).
  { id: "dictee-envoyer-c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), cliquer: ".axe-voix__micro", temoins: ["clic:.colonne-chat[data-focus='true'] .composer__send", "clic:.axe-voix__valider", "clic:.axe-voix__annuler"] },
  // axe:micro-local — whisper.cpp embarqué : micro visible sans aucun service, réglage petit/moyen.
  { id: "dictee-micro-local", sim: { voixLocale: true }, stockage: () => colonnes([ids(3)]), cliquer: [".axe-voix__micro", ".axe-voix__valider"], pauseClics: 1500, attendre: ".axe-voix__bulle--info", temoins: ["clic:.axe-voix__bulle--info"] },
  { id: "dictee-reglage-modele", sim: { voixLocale: true }, stockage: () => colonnes([ids(3)]), reglages: true,
    clics: [".settings-pane__nav-item[data-section='voice']"],
    temoins: ["sel:[data-testid='voix-modele-local'] input[type='radio']:checked", "Moyen (small)", "Petit (base)"] },
  { id: "dictee-enregistrement-c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), cliquer: ".axe-voix__micro", temoins: ["clic:.axe-voix__valider", "clic:.axe-voix__annuler"] },
  { id: "c1", sim: {}, stockage: () => colonnes([ids(3)]), temoins: ["sel:.thinking-block", "sel:.tool-card__err-dot", "sel:.composer__send"] },
  // axe:0.1.75 — capture de Savinien : onglet Git du volet bas, branche au nom long, liste des modifications vide/coupée, onglets tronqués.
  { id: "git-branche-longue", sim: { brancheLongue: true }, stockage: () => colonnes([ids(3)]), terminal: true, cliquer: ".terminal-tab[data-tab='git']", pauseClics: 800, temoins: ["sel:.terminal-shell .git-panel__row", "sel:.terminal-shell .git-panel__commit"] },
  { id: "git-branche-longue-local", sim: { brancheLongue: true, cloud: false }, stockage: () => colonnes([ids(3)]), terminal: true, cliquer: ".terminal-tab[data-tab='git']", pauseClics: 800, temoins: ["sel:.terminal-shell .git-panel__row", "sel:.terminal-shell .git-panel__commit"] },
  { id: "c1-terminal", sim: {}, stockage: () => colonnes([ids(3)]), terminal: true, temoins: ["sel:.terminal-shell .terminal-tabs"] },
  { id: "explorateur-hauteur", sim: {}, stockage: () => colonnes([ids(3)]), temoins: ["sel:.sidebar__section .tree-row"] },
  { id: "c1-terminal-redim", sim: {}, stockage: () => colonnes([ids(3)]), terminal: true, redimTerminal: 37, temoins: ["sel:.terminal-shell .terminal-tabs"] },
  { id: "c1-explorateur-ferme", sim: {}, stockage: (l, h) => ({ ...colonnes([ids(3)]), ...explorateurFerme(l, h) }), temoins: ["sel:.volet-flottant"] },
  { id: "c2", sim: {}, stockage: () => colonnes([ids(2), ["c-003"]]), terminal: true, temoins: ["sel:.colonne-chat + .gutter + .colonne-chat"] },
  { id: "c3", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), temoins: ["sel:.colonne-chat[data-colonne='2']"] },
  { id: "c3-terminal-large", sim: {}, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), terminal: true, elargirChat: true },
  { id: "c3-explorateur-ferme", sim: {}, stockage: (l, h) => ({ ...colonnes([ids(2), ["c-003"], ["c-004"]]), ...explorateurFerme(l, h) }) },
  // Demande de l'utilisateur : réduire entièrement les volets (Ctrl+B gauche, Ctrl+Alt+B droite).
  { id: "volets-reduits", sim: {}, stockage: () => colonnes([ids(2)]), reduireVolets: true, temoins: ["sel:.main[data-gauche-reduit='true'][data-droite-reduit='true']"] },
  // Poignée entre deux colonnes de conversation : glissée, les largeurs doivent changer.
  { id: "c2-poignee", sim: {}, stockage: () => colonnes([ids(2), ["c-003"]]), elargirChat: true, glisserPoigneeColonnes: 120 },
  { id: "c2-colonne-min", sim: {}, stockage: () => colonnes([ids(2), ["c-003"]]), reduireColonne: true },
  { id: "onglets-nombreux", sim: {}, stockage: () => colonnes([ids(9)]), elargirChat: true, temoins: ["sel:.onglets-chat__tab:nth-child(9)"] },
  { id: "sans-fournisseur", sim: { fournisseur: false, accelerer: true }, stockage: () => colonnes([ids(2), ["c-003"], ["c-004"]]), sansFournisseur: true, temoins: ["sel:.composer__connect-cta"] },
  // PC sans fournisseur, dossier local : le clic sur « Connecter un fournisseur » (.composer__connect-cta) doit ouvrir la section des fournisseurs.
  { id: "sans-fournisseur-clic", sim: { fournisseur: false, accelerer: true }, stockage: () => colonnes([ids(3)]), sansFournisseur: true, clicConnecter: true, temoins: ["sel:.settings-pane"] },
  { id: "sans-fournisseur-c1", sim: { fournisseur: false, accelerer: true }, stockage: () => colonnes([ids(3)]), sansFournisseur: true, temoins: ["sel:.composer__connect-cta"] },
  { id: "tour-file-sous-agents", sim: { tour: "en_cours", sousAgents: 2 }, stockage: () => ({ ...colonnes([ids(2), ["c-003"]]), ...fileAttente("c-001", 3) }), temoins: ["sel:.composer__send[data-variant='stop']", "sel:.composer__send[data-variant='background']", "sel:.axe-agents-bandeau", "sel:.todo-strip__queue"] },
  // axe:file-pause — après un Stop, la file attend : bouton « Reprendre la file ».
  { id: "file-en-pause", sim: { filePause: true }, stockage: () => ({ ...colonnes([ids(2), ["c-003"]]), ...fileAttente("c-001", 2) }), temoins: ["clic:[data-testid='reprendre-file']", "sel:.todo-strip__queue"] },
  { id: "arret-force", sim: { tour: "en_cours", sousAgents: 1, accelerer: true }, stockage: () => ({ ...colonnes([ids(2), ["c-003"], ["c-004"]]), ...fileAttente("c-001", 2) }), arretForce: true, temoins: ["sel:.composer__send[data-variant='stop'][data-force='true']", "sel:.axe-agents-bandeau"] },
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
  // axe:commandes — « /heartbeat 1m coucou » et « /goal … » : icônes à côté du modèle,
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
  // axe:guet — deux guets : icône avec leur nombre à côté du modèle, détail au clic
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
  // axe:html — page .html : Code par défaut ; le bouton de bascule (le même que le
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
    stockage: () => ({ ...colonnes([ids(1)]), "axecode.vueFichiers": { "C:\\Users\\utilisateur\\Documents\\Projets\\axecode\\page.html": true } }),
    ouvrirFichier: "page.html",
    clics: [".xv-html .xv-btn--text"],
    temoins: ["sel:iframe.xv-html__frame[sandbox*='allow-scripts']", "sel:iframe.xv-html__frame[srcdoc*=\"connect-src 'none'\"]", "sel:.xv-html__status[data-on='true']"],
  },
  // axe:liens — liens bien visibles (gras + fond d'accent) et cliquables, dans le message de
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
  // axe:explorateur — clavier dans l'explorateur : gauche replie « docs », bas, droite déplie
  // « scripts », bas = premier enfant, Ctrl+C = chemin absolu SANS « \\?\ ».
  {
    id: "explorateur-clavier", sim: {}, stockage: () => colonnes([ids(1)]),
    explorateur: { clic: "docs", touches: ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowDown", "Control+c"] },
    temoins: ["choisi:scripts/ChatPane.tsx", "presse:C:\\Users\\utilisateur\\Documents\\Projets\\axecode\\scripts\\ChatPane.tsx", "sel:.tree-row[data-entry-path='scripts/ChatPane.tsx'][data-selected='true']"],
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
  // axe:couleurs — commande slash en orange (accent) et skill en violet : dans la bulle du
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
  // Clic sur « N agent(s) au travail » : ouvre la conversation (journal) de l'agent, comme la vue Agents.
  { id: "bandeau-agents-clic", sim: { tour: "en_cours", sousAgents: 2 }, stockage: () => colonnes([ids(3)]), clicBandeau: true, temoins: ["sel:.axe-journal", "sel:.axe-agents"] },
  // Bug : après le chat d'un agent, un clic sur une conversation de la liste doit l'afficher (plus le journal de l'agent).
  { id: "agent-puis-conversation", sim: { tour: "en_cours", sousAgents: 2 }, stockage: () => colonnes([ids(3)]), clicBandeau: true, puisConversation: TITRES["c-002"], temoins: ["sel:.colonne-chat[data-focus='true'] .chat-body"] },
  { id: "agents", sim: { sousAgents: 3 }, stockage: () => colonnes([ids(3)]), agents: true, temoins: ["sel:.axe-agents"] },
  // Bugs SavIDE 0.1.58 : dans une conversation sans dossier, Accueil / Ouvrir un dossier /
  // Réglages étaient rognés (barre d'actions de largeur 0) ; /login ouvrait « À propos » ou rien.
  { id: "libre-barre", sim: {}, libre: true, temoins: ["sel:.axe-freechat", "clic:.axe-freechat .titlebar__actions .titlebar__btn"] },
  { id: "libre-login", sim: {}, libre: true, ecrire: "/login", temoins: ["sel:.axe-freechat", "sel:.settings-pane .settings-pane__nav-item[data-section='providers'][data-active='true']"] },
  { id: "ide-login", sim: {}, stockage: () => colonnes([ids(3)]), ecrire: "/login", temoins: ["sel:.settings-pane .settings-pane__nav-item[data-section='providers'][data-active='true']"] },
  { id: "ide-barre", sim: {}, stockage: () => colonnes([ids(3)]), temoins: ["clic:.titlebar__btn[data-action='accueil']", "clic:.titlebar__btn[data-action='reglages']",
    "sel:.titlebar__brand-mark svg[data-logo='wordmark'] rect.logo__fond", "absent:svg linearGradient"] },
  { id: "reglages", sim: {}, stockage: () => colonnes([ids(3)]), reglages: true, temoins: ["sel:.settings-pane"] },
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
  // axe:0.1.71 — session « test — arrière-plan » : hors de la liste, indicateur sur « test ».
  { id: "arriere-plan-liste", sim: { fournisseur: false, collegue: true, arrierePlan: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, temoins: ["clic:.conv-row__bg"] },
  // Parcours d'un collègue (Camille) : connecté à Axe Cloud, aucun fournisseur sur son PC,
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
  { id: "collegue-arbre", sim: { fournisseur: false, collegue: true, espaceVide: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, creer: "test", ecrire: "Bonjour", evenementsTour: tourFini("s-1"), arbre: true, temoins: ["sel:.axe-tree-overlay"] },
  // À la réouverture de l'espace : la liste doit montrer les conversations de l'espace (« test »).
  { id: "collegue-liste", sim: { fournisseur: false, collegue: true, accelerer: true }, stockage: () => ({}), espaceCloud: true, temoins: ["test"] },
  // axe:bas169 — remonté dans un long chat : bouton flottant « ↓ » cliquable.
  { id: "chat-aller-en-bas", sim: {}, stockage: () => colonnes([ids(3)]), defilerChatHaut: true, temoins: ["clic:[data-testid='chat-aller-en-bas']"] },
  // axe:hist169 — prompt envoyé puis flèche HAUT dans le compositeur vide : il revient.
  { id: "historique-prompts", sim: {}, stockage: () => colonnes([ids(1)]), ecrire: "relance le banc à 800 px", touchesCompositeur: ["ArrowUp"],
    temoins: ["valeur:relance le banc à 800 px"] },
];
