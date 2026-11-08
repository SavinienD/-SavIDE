// Scènes du banc pour la revue des changements : vue « Changements », notes,
// indexation, conflits, note sur l'aperçu Markdown. Simulation : banc/revue.ts.
import { WS_BANC as WS } from "./constantes.mjs";

const OUVRIR = ["Control+Shift+KeyD"];
const NOTES = () => ({
  [`revue:notes:${WS}`]: [
    { id: "n1", fichier: "src/lib/titres.ts", debut: 4, fin: 7, cote: "nouveau", extrait: "export function titreCourt(titre: string, max = LONGUEUR_MAX): string {", texte: "Garde 80 caractères : la barre de titre en a besoin à 1920 px.", creeLe: 1 },
    { id: "n2", fichier: "src/lib/titres.ts", debut: 34, fin: 36, cote: "nouveau", extrait: "export function estVide(titre: string | null | undefined): boolean {", texte: "Ajoute un test pour estVide avec une chaîne d'espaces insécables, et vérifie que titreCourt ne coupe jamais au milieu d'un mot accentué.", creeLe: 2 },
  ],
});

export const SCENES_REVUE = [
  // Ctrl+Maj+D : fichiers (non indexés, indexés), diff Monaco côte à côte, deux notes en attente.
  { id: "revue-changements", sim: { revue: "simple" }, stockage: NOTES, touches: OUVRIR,
    temoins: ["sel:.revue-vue", "sel:.revue-fichier[data-fichier='src/lib/titres.ts'][data-actif='true']", "sel:.revue-diff__monaco .monaco-diff-editor",
      "compte:.revue-notes__liste .revue-note=2", "clic:.revue-notes__envoyer", "appel:revue_liste", "appel:revue_diff"],
    attendus: ["titres.ts", "Garde 80 caractères"] },
  // Bouton « Voir les changements » du panneau Git (volet bas).
  { id: "revue-depuis-git", sim: { revue: "simple", cloud: false }, terminal: true, cliquer: [".terminal-tab[data-tab='git']", "[data-revue='ouvrir']"], pauseClics: 800,
    temoins: ["sel:.revue-vue", "appel:revue_liste"] },
  // Diff en ligne, notes masquées (choix gardés dans le stockage local).
  { id: "revue-en-ligne", sim: { revue: "simple" }, stockage: () => ({ "revue:en-ligne": "1", "revue:notes-visibles": "0" }), touches: OUVRIR,
    // Sous 700 px de diff, Monaco passe seul en ligne et les deux boutons se masquent : témoin en grande fenêtre.
    temoins: ["si>1000:sel:.revue-segments button[data-actif='true']:last-child", "absent:.revue-notes", "sel:.revue-diff__monaco .monaco-diff-editor"] },
  // Alt+N : note sur le bloc courant, Ctrl+Entrée n'est pas tapé (bouton), puis envoi en un message (file du service).
  { id: "revue-noter-envoyer", sim: { revue: "simple" }, touches: [...OUVRIR, "Alt+KeyN"],
    taper: [{ sel: ".revue-note--brouillon .revue-note__saisie", texte: "Renomme cette fonction en titreAbrege." }],
    cliquer: [".revue-note--brouillon .revue-bouton--principal", ".revue-notes__envoyer"], pauseClics: 800,
    temoins: ["appel:queue_push", "absent:.revue-note--brouillon", "sel:.revue-notes__envoi .revue-avis[data-genre='ok']"] },
  // « Indexer le bloc » (premier bloc) : patch partiel côté backend.
  { id: "revue-indexer", sim: { revue: "simple" }, touches: OUVRIR, cliquer: [".revue-diff__barre .revue-bouton"], pauseClics: 900,
    temoins: ["appel:revue_appliquer", "sel:.revue-diff__avis"] },
  { id: "revue-vide", sim: { revue: "vide" }, touches: OUVRIR, temoins: ["sel:.revue-fichiers__vide"] },
  // Fichier binaire : pas de diff, message clair.
  { id: "revue-binaire", sim: { revue: "simple" }, touches: OUVRIR,
    cliquer: [".revue-fichier[data-fichier='src-tauri/icons/icon.png'] .revue-fichier__principal"], pauseClics: 600,
    temoins: ["sel:.revue-diff__message", "absent:.revue-diff__monaco"] },
];

// Aperçu Markdown : texte choisi (triple clic sur le titre), « Noter » : tiroir des notes avec le brouillon.
SCENES_REVUE.push(
  { id: "revue-apercu-note", sim: { fichierQcm: true }, ouvrirFichier: "qcm.md", clics: [".editor-preview-toggle"], taper: [{ sel: ".editor-md-preview h1", texte: "" }],
    cliquer: [".revue-apercu-noter"], pauseClics: 600,
    temoins: ["sel:.revue-tiroir .revue-note--brouillon .revue-note__saisie", "sel:.revue-tiroir .revue-note__extrait"] },
);

// Conflits : fusion arrêtée, l'onglet des conflits s'ouvre seul ; « Prendre la nôtre » ; « Demander à l'agent ».
SCENES_REVUE.push(
  { id: "revue-conflits", sim: { revue: "conflit" }, touches: OUVRIR,
    temoins: ["sel:.revue-conflits", "sel:.revue-conflits__versions .monaco-editor", "sel:.revue-conflits__resultat .monaco-editor",
      "compte:.revue-conflits .revue-fichier=2", "sel:.revue-conflits .revue-diff__barre[data-blocs='2']", "appel:revue_conflit_fichier", "clic:[data-action='prendre-nous']"] },
  { id: "revue-conflits-prendre", sim: { revue: "conflit" }, touches: OUVRIR, cliquer: ["[data-action='prendre-nous']", "[data-action='prendre-eux']"], pauseClics: 600,
    temoins: ["sel:.revue-conflits .revue-diff__barre[data-blocs='0']", "clic:[data-action='marquer-resolu']"] },
  { id: "revue-conflits-agent", sim: { revue: "conflit" }, touches: OUVRIR, cliquer: ["[data-action='demander-agent']"], pauseClics: 900,
    temoins: ["appel:queue_push", "sel:.revue-conflits > .revue-avis[data-genre='ok']"] },
);
