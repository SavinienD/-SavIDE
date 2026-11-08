// Worktrees — scènes du banc d'affichage : « Nouveau worktree », tâches de fond
// (création en arrière-plan, script visible), liste par dépôt et nettoyage.
// Gestes par sélecteur ou raccourci (Ctrl+Alt+W), jamais par un libellé traduit.
import { WS_BANC as WS } from "./constantes.mjs";

const NOUVEAU = { sim: { worktrees: true }, touches: ["Control+Alt+W"], taper: [{ sel: "#wt-titre", texte: "Corriger le calcul du panier" }] };

export const SCENES_WORKTREES = [
  // Dialogue ouvert au clavier : branche proposée depuis le titre, commandes du projet à accepter.
  { id: "worktrees-nouveau", ...NOUVEAU,
    temoins: ["sel:.wt-nouveau", "champ:#wt-branche=corriger-le-calcul-du-panier", "sel:.wt-nouveau .wt-commandes",
      "clic:.wt-nouveau [data-action='valider']", "clic:.wt-nouveau [data-action='lancer-commandes'] input", "appel:worktrees_config"] },
  // Dépôt sans worktrees.toml : rien n'est partagé ni lancé, « Créer le fichier » proposé.
  { id: "worktrees-nouveau-sans-fichier", sim: { worktrees: true, wtSansFichier: true }, touches: ["Control+Alt+W"],
    temoins: ["sel:.wt-nouveau", "clic:.wt-nouveau [data-action='creer-config']", "absent:.wt-nouveau .wt-commandes"] },
  // « Créer » : le dialogue se ferme tout de suite, la carte de la tâche suit les étapes (Annuler).
  { id: "worktrees-creation", ...NOUVEAU, cliquer: ".wt-nouveau [data-action='valider']",
    temoins: ["absent:.wt-nouveau", "appel:worktree_creer", "sel:.wt-carte[data-genre='creation'] .wt-carte__etapes li[data-etat='cours']",
      "clic:.wt-carte[data-genre='creation'] [data-action='annuler']"] },
  // Tâches de fond : préparation en cours (terminal du script), échec (Relancer), suppression finie (avertissement).
  { id: "worktrees-taches", sim: { worktrees: true, wtTaches: true },
    temoins: ["compte:.wt-carte=3", "sel:.wt-carte[data-etat='en_cours'] .wt-script .xterm", "clic:.wt-carte[data-etat='echec'] [data-action='relancer']",
      "sel:.wt-carte[data-etat='reussi'] [data-action='fermer']", "appel:worktree_tache_sortie"] },
];

// Liste « Worktrees » (onglet du volet bas) : deux dépôts, épinglé, lien PR, endormi, introuvable, archives.
const LISTE = { sim: { worktrees: true, wtListe: true }, stockage: () => ({ "worktrees.v1": REGLAGES }), clics: ["button.sidebar-tab[data-onglet='worktrees']"] };
const CONTENEUR = `${WS}-worktrees`;
const REGLAGES = {
  depots: { [WS]: { base: "main" } },
  epingles: [`${CONTENEUR}\\corriger-le-panier`],
  liens: { [`${CONTENEUR}\\corriger-le-panier`]: "https://github.com/exemple/projet/pull/42" },
  endormis: [`${CONTENEUR}\\migration-des-postes-du-standard-telephonique-pour-le-cabinet`],
  archives: [{ depot: WS, branche: "vieille-idee", titre: "Vieille idée de cache", dossier: `${CONTENEUR}\\vieille-idee`, dateMs: 1_792_000_000_000 }],
};
const LIGNE = (n) => `.wt-groupe:first-of-type .wt-ligne:nth-child(${n})`;

SCENES_WORKTREES.push(
  { id: "worktrees-liste", ...LISTE,
    temoins: ["compte:.wt-groupe=2", "sel:.wt-ligne[data-principal='true']", "sel:.wt-ligne .wt-badge--lien", "sel:.wt-ligne[data-introuvable='true']",
      "sel:.wt-ligne[data-endormi='true']", "sel:.wt-archives", "clic:.wt-liste__tete [data-action='nouveau-worktree']", "appel:worktrees_lister"] },
  { id: "worktrees-liste-menu", ...LISTE, clics: [...LISTE.clics, `${LIGNE(2)} [data-action='menu']`],
    temoins: ["sel:.wt-menu [data-action='supprimer']", "sel:.wt-menu [data-action='endormir']", "sel:.wt-menu [data-action='lien']", "dedans:.wt-menu"] },
  { id: "worktrees-liste-selection", ...LISTE, clics: [...LISTE.clics, `${LIGNE(2)} .wt-ligne__case input`, `${LIGNE(3)} .wt-ligne__case input`],
    temoins: ["sel:.wt-selection", "compte:.wt-ligne[data-choisi='true']=2", "clic:.wt-selection [data-action='supprimer-choix']", "clic:.wt-selection [data-action='archiver-choix']"] },
  { id: "worktrees-suppression", ...LISTE,
    clics: [...LISTE.clics, `${LIGNE(2)} .wt-ligne__case input`, `${LIGNE(3)} .wt-ligne__case input`, ".wt-selection [data-action='supprimer-choix']"],
    temoins: ["sel:.wt-confirmation", "compte:.wt-confirmation__liste li=2", "sel:.wt-confirmation .wt-confirmation__alerte", "clic:.wt-confirmation [data-action='valider']", "sel:.wt-confirmation .wt-commandes"] },
  // Nettoyage : fusionnés, introuvables, anciens, taille ; suppression groupée après confirmation.
  { id: "worktrees-nettoyage", ...LISTE, clics: [...LISTE.clics, ".wt-liste__tete [data-action='nettoyer']"],
    temoins: ["sel:.wt-nettoyage", "compte:.wt-nettoyage__ligne=4", "sel:.wt-filtre[data-filtre='tous'][aria-pressed='true']",
      "clic:.wt-nettoyage [data-action='oublier-introuvables']", "clic:.wt-nettoyage [data-action='valider']", "appel:worktrees_nettoyage"] },
  { id: "worktrees-nettoyage-anciens", ...LISTE, clics: [...LISTE.clics, ".wt-liste__tete [data-action='nettoyer']", ".wt-filtre[data-filtre='anciens']"],
    temoins: ["compte:.wt-nettoyage__ligne=1", "sel:.wt-filtre[data-filtre='anciens'][aria-pressed='true']"] },
);
