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
  // Réglages > Éditeur : sauvegarde automatique, retour à la ligne, minimap.
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
  // Marques dans la marge par rapport au dernier commit : app.ts (modifié, ajouté, supprimé) ;
  // notes.md inchangé : aucune marque.
  { id: "editeur-marge-git", ...EDITEUR, ouvrirFichier: "app.ts",
    temoins: ["sel:.editor-monaco-layer .marge-git--modif", "sel:.editor-monaco-layer .marge-git--ajout", "sel:.editor-monaco-layer .marge-git--suppr", "appel:editeur_fichier_head"] },
  { id: "editeur-marge-inchange", ...EDITEUR, ouvrirFichier: "notes.md",
    temoins: ["appel:editeur_fichier_head", "absent:.editor-monaco-layer .marge-git", "sel:.editor-monaco-layer .monaco-editor"] },
  // Clic droit sur un onglet de fichier : « Fermer tous les fichiers » (Ctrl+Maj+W) et
  // « Rouvrir l'onglet fermé » (Ctrl+Alt+O, grisé tant que rien n'a été fermé).
  { id: "editeur-menu-onglet", ...EDITEUR, ouvrirFichier: "app.ts", clicDroit: ".editor-col .tab[data-onglet-chemin='app.ts']",
    temoins: ["clic:.menu-onglet-fichier [data-action='fermer-tous']", "sel:.menu-onglet-fichier [data-action='rouvrir']:disabled"] },
  { id: "editeur-fermer-tous", ...EDITEUR, ouvrirFichier: "app.ts", clics: [".tree-row[data-entry-path='notes.md']"],
    clicDroit: ".editor-col .tab[data-onglet-chemin='app.ts']", cliquer: [".menu-onglet-fichier [data-action='fermer-tous']"],
    temoins: ["absent:.editor-col .tab[data-onglet-chemin]", "sel:.editor-empty"] },
  { id: "editeur-rouvrir", ...EDITEUR, ouvrirFichier: "app.ts", clics: [".editor-col .tab[data-onglet-chemin='app.ts'] .tab__close"],
    touches: ["Control+Alt+o"],
    temoins: ["sel:.editor-col .tab[data-onglet-chemin='app.ts'][data-active='true']"] },
  // Markdown : « Côte à côte » (source à gauche, aperçu à droite), défilement synchronisé
  // (Ctrl+Fin dans l'éditeur amène l'aperçu en bas), bascule Aperçu / Source inchangée.
  { id: "editeur-md-cote", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".md-actions [data-mode-md='cote']"],
    temoins: ["sel:.editor-text-stack[data-mode='cote'] .editor-md-preview h1", "sel:.editor-text-stack[data-mode='cote'] .editor-monaco-layer .monaco-editor .view-lines",
      "sel:.md-actions [data-mode-md='cote'][data-active='true']", "clic:.md-actions .editor-preview-toggle", "sel:.editor-md-preview[data-defile='haut']"] },
  { id: "editeur-md-defilement", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".md-actions [data-mode-md='cote']"],
    saisies: [[".editor-monaco-layer .monaco-editor textarea", ""]], touches: ["Control+End"],
    // Témoins valables aussi texte agrandi (l'éditeur n'est alors plus tout en bas : l'aperçu suit).
    temoins: ["absent:.editor-md-preview[data-defile='haut']", "sel:.editor-md-preview[data-synchro='ok']", "Fin de la procédure."] },
  { id: "editeur-md-apercu", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".editor-preview-toggle"],
    temoins: ["sel:.editor-text-stack[data-mode='apercu'] .editor-md-preview h1", "sel:.md-actions [data-mode-md='cote'][data-active='false']"] },
  // Image déposée depuis l'explorateur du système sur l'éditeur d'un .md : enregistrée dans
  // images/ (editeur_image_markdown simulé) et lien inséré dans le texte ; Côte à côte : l'aperçu l'affiche.
  { id: "editeur-md-image-deposee", ...EDITEUR, ouvrirFichier: "notes.md",
    depot: { cible: ".editor-monaco-layer[data-depot-markdown='notes.md']", chemins: ["C:\\Users\\utilisateur\\Images\\capture ecran.png"] },
    temoins: ["appel:editeur_image_markdown", "(images/capture-ecran.png)", "sel:.editor-col .tab[data-active='true'] .tab__dirty"] },
  { id: "editeur-md-image-apercu", ...EDITEUR, ouvrirFichier: "notes.md", clics: [".md-actions [data-mode-md='cote']"],
    temoins: ["sel:.editor-md-preview img[src*='renvois.png']", "absent:.editor-md-preview img[src='images/renvois.png']"] },
  // Fichier Mermaid (.mmd) : diagramme rendu par-dessus le code ; clic = plein écran avec zoom.
  { id: "editeur-mermaid", ...EDITEUR, ouvrirFichier: "flux.mmd",
    temoins: ["sel:.xv-mermaid .mermaid-diagram[data-state='ready'] svg", "sel:.editor-preview-toggle[data-active='true']"] },
  { id: "editeur-mermaid-zoom", ...EDITEUR, ouvrirFichier: "flux.mmd", clics: [".xv-mermaid .mermaid-diagram[data-state='ready']"],
    temoins: ["sel:.mermaid-zoom[role='dialog'] .mermaid-zoom__svg svg", "clic:.mermaid-zoom__toolbar button"] },
  // CSV : tri par colonne (clic sur l'en-tête : croissant, décroissant, sans tri), filtre des
  // lignes trouvées (bouton entonnoir de la recherche) ; la 1re ligne (en-tête) reste en tête.
  { id: "editeur-csv-tri", ...EDITEUR, ouvrirFichier: "donnees.csv", clics: [".xv-grid__tri[data-colonne='2']"],
    temoins: ["sel:.xv-grid__colhead[aria-sort='ascending'] .xv-grid__tri[data-colonne='2']", "sel:.xv-grid__rowhead[data-r='1'][data-origine='4']",
      "sel:.xv-grid__rowhead[data-r='0'][data-origine='0']", "clic:.xv-grid__tri[data-colonne='0']"] },
  { id: "editeur-csv-tri-desc", ...EDITEUR, ouvrirFichier: "donnees.csv", clics: [".xv-grid__tri[data-colonne='2']", ".xv-grid__tri[data-colonne='2']"],
    temoins: ["sel:.xv-grid__colhead[aria-sort='descending'] .xv-grid__tri[data-colonne='2']", "sel:.xv-grid__rowhead[data-r='1'][data-origine='23']"] },
  { id: "editeur-csv-filtre", ...EDITEUR, ouvrirFichier: "donnees.csv", saisies: [[".xv-search input", "Lyon"]], apresSaisies: [".xv-search [data-action='filtrer']"],
    temoins: ["sel:.xv-search [data-action='filtrer'][data-active='true']", "compte:.xv-grid__rowheads .xv-grid__rowhead=9", "9 / 25 lignes"] },
  // Image modifiée depuis le dernier commit : « Avant / après » (glissière, côte à côte).
  { id: "editeur-image-avant-apres", ...EDITEUR, ouvrirFichier: "logo.png", clics: ["[data-action='avant-apres']"],
    temoins: ["sel:.xv-avap[data-mode='glissiere'] .xv-avap__cadre img.xv-avap__avant", "sel:.xv-avap__cadre img.xv-avap__apres", "clic:.xv-avap__curseur",
      "clic:.xv-avap [data-mode-avap='cote']", "appel:editeur_fichier_head"] },
  { id: "editeur-image-cote", ...EDITEUR, ouvrirFichier: "logo.png", clics: ["[data-action='avant-apres']", ".xv-avap [data-mode-avap='cote']"],
    temoins: ["sel:.xv-avap[data-mode='cote'] .xv-avap__panneau[data-cote='avant'] img", "sel:.xv-avap__panneau[data-cote='apres'] img", "160 × 100 px"] },
];
