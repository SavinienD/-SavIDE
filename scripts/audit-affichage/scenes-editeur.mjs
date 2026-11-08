// Scènes de l'éditeur et des visionneuses (fichiers simulés : banc/editeur.ts,
// activés par « sim: { editeur: true } »). Branchées à la fin de SCENES (scenes.mjs).
import { WS_BANC as WS } from "./constantes.mjs";

const colonne = () => ({
  [`axe:v2:onglets-chat:${WS}`]: [{ id: "c-001", titre: "Corriger tous les défauts d'affichage" }],
  [`axe:v2:colonnes-chat:${WS}`]: { colonnes: [["c-001"]], focus: 0 },
});
const avecReglages = (reglages) => () => ({ ...colonne(), "axecode.reglagesEditeur": { sauvegardeAuto: "desactivee", retourLigne: false, minimap: false, ...reglages } });
const EDITEUR = { sim: { editeur: true }, stockage: colonne };
const MONACO = ".editor-monaco-layer .monaco-editor .view-lines";

export const SCENES_EDITEUR = [
  // ED1a — Réglages > Éditeur : sauvegarde automatique, retour à la ligne, minimap.
  { id: "editeur-reglages", stockage: colonne, reglages: true,
    clics: [".settings-pane__nav-item[data-section='editor']"],
    temoins: ["clic:.axe-editeur-reglages select[data-reglage='sauvegarde-auto']", "clic:.axe-editeur-reglages input[data-reglage='retour-ligne']",
      "clic:.axe-editeur-reglages input[data-reglage='minimap']", "sel:.axe-editeur-reglages [data-explication='desactivee']"] },
  // « Après 1 s » : la frappe est enregistrée seule, le point « modifié » disparaît.
  { id: "editeur-sauvegarde-delai", ...EDITEUR, stockage: avecReglages({ sauvegardeAuto: "delai", minimap: true, retourLigne: true }), ouvrirFichier: "app.ts",
    taper: [{ sel: MONACO, texte: "// note du banc", ajouter: true }],
    cliquer: [".editor-col .tabs__spacer"], pauseClics: 1500,
    temoins: ["ecritcontient:// note du banc", "absent:.editor-col .tab[data-active='true'] .tab__dirty", "sel:.editor-monaco-layer[data-minimap='true'][data-retour-ligne='true']"] },
  // « En quittant l'onglet » : rien n'est écrit tant qu'on tape dans l'onglet.
  { id: "editeur-sauvegarde-quitter", ...EDITEUR, stockage: avecReglages({ sauvegardeAuto: "quitter" }), ouvrirFichier: "app.ts",
    taper: [{ sel: MONACO, texte: "// pas encore", ajouter: true }],
    cliquer: [".editor-col .tabs__spacer"], pauseClics: 1500,
    temoins: ["sansappel:write_workspace_file_command", "sel:.editor-col .tab[data-active='true'] .tab__dirty", "sel:.editor-monaco-layer[data-minimap='false'][data-retour-ligne='false']"] },
  // ED1b — marques dans la marge par rapport au dernier commit : app.ts (modifié, ajouté, supprimé) ;
  // notes.md inchangé : aucune marque.
  { id: "editeur-marge-git", ...EDITEUR, ouvrirFichier: "app.ts",
    temoins: ["sel:.editor-monaco-layer .marge-git--modif", "sel:.editor-monaco-layer .marge-git--ajout", "sel:.editor-monaco-layer .marge-git--suppr", "appel:editeur_fichier_head"] },
  { id: "editeur-marge-inchange", ...EDITEUR, ouvrirFichier: "notes.md",
    temoins: ["appel:editeur_fichier_head", "absent:.editor-monaco-layer .marge-git", "sel:.editor-monaco-layer .monaco-editor"] },
  // ED1c — clic droit sur un onglet de fichier : « Fermer tous les fichiers » (Ctrl+Maj+W) et
  // « Rouvrir l'onglet fermé » (Ctrl+Alt+O, grisé tant que rien n'a été fermé).
  { id: "editeur-menu-onglet", ...EDITEUR, ouvrirFichier: "app.ts", clicDroit: ".editor-col .tab[data-onglet-chemin='app.ts']",
    temoins: ["clic:.menu-onglet-fichier [data-action='fermer-tous']", "sel:.menu-onglet-fichier [data-action='rouvrir']:disabled"] },
  { id: "editeur-fermer-tous", ...EDITEUR, ouvrirFichier: "app.ts", clics: [".tree-row[data-entry-path='notes.md']"],
    clicDroit: ".editor-col .tab[data-onglet-chemin='app.ts']", cliquer: [".menu-onglet-fichier [data-action='fermer-tous']"],
    temoins: ["absent:.editor-col .tab[data-onglet-chemin]", "sel:.editor-empty"] },
  { id: "editeur-rouvrir", ...EDITEUR, ouvrirFichier: "app.ts", clics: [".editor-col .tab[data-onglet-chemin='app.ts'] .tab__close"],
    touches: ["Control+Alt+o"],
    temoins: ["sel:.editor-col .tab[data-onglet-chemin='app.ts'][data-active='true']"] },
  // ED2a — Markdown : « Côte à côte » (source à gauche, aperçu à droite), défilement synchronisé
  // (Ctrl+Fin dans l'éditeur amène l'aperçu en bas), bascule Aperçu / Source inchangée.
  { id: "editeur-md-cote", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".md-actions [data-mode-md='cote']"],
    temoins: ["sel:.editor-text-stack[data-mode='cote'] .editor-md-preview h1", "sel:.editor-text-stack[data-mode='cote'] .editor-monaco-layer .monaco-editor .view-lines",
      "sel:.md-actions [data-mode-md='cote'][data-active='true']", "clic:.md-actions .editor-preview-toggle", "sel:.editor-md-preview[data-defile='haut']"] },
  { id: "editeur-md-defilement", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".md-actions [data-mode-md='cote']"],
    saisies: [[".editor-monaco-layer .monaco-editor textarea", ""]], touches: ["Control+End"],
    temoins: ["sel:.editor-md-preview[data-defile='bas']", "Fin de la procédure."] },
  { id: "editeur-md-apercu", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".editor-preview-toggle"],
    temoins: ["sel:.editor-text-stack[data-mode='apercu'] .editor-md-preview h1", "sel:.md-actions [data-mode-md='cote'][data-active='false']"] },
  // ED2b — image déposée depuis l'explorateur du système sur l'éditeur d'un .md : enregistrée dans
  // images/ (editeur_image_markdown simulé) et lien inséré dans le texte ; Côte à côte : l'aperçu l'affiche.
  { id: "editeur-md-image-deposee", ...EDITEUR, ouvrirFichier: "notes.md",
    depot: { cible: ".editor-monaco-layer[data-depot-markdown='notes.md']", chemins: ["C:\\Users\\utilisateur\\Images\\capture ecran.png"] },
    temoins: ["appel:editeur_image_markdown", "(images/capture-ecran.png)", "sel:.editor-col .tab[data-active='true'] .tab__dirty"] },
  { id: "editeur-md-image-apercu", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".md-actions [data-mode-md='cote']"],
    temoins: ["sel:.editor-md-preview img[src*='renvois.png']", "absent:.editor-md-preview img[src='images/renvois.png']"] },
];
