// Worktrees — scènes du banc d'affichage : « Nouveau worktree », tâches de fond
// (création en arrière-plan, script visible), liste par dépôt et nettoyage.
// Gestes par sélecteur ou raccourci (Ctrl+Maj+W), jamais par un libellé traduit.

const NOUVEAU = { sim: { worktrees: true }, touches: ["Control+Shift+W"], taper: [{ sel: "#wt-titre", texte: "Corriger le calcul du panier" }] };

export const SCENES_WORKTREES = [
  // W1 — dialogue ouvert au clavier : branche proposée depuis le titre, commandes du projet à accepter.
  { id: "worktrees-nouveau", ...NOUVEAU,
    temoins: ["sel:.wt-nouveau", "champ:#wt-branche=corriger-le-calcul-du-panier", "sel:.wt-nouveau .wt-commandes",
      "clic:.wt-nouveau [data-action='valider']", "clic:.wt-nouveau [data-action='lancer-commandes'] input", "appel:worktrees_config"] },
  // W1 — dépôt sans worktrees.toml : rien n'est partagé ni lancé, « Créer le fichier » proposé.
  { id: "worktrees-nouveau-sans-fichier", sim: { worktrees: true, wtSansFichier: true }, touches: ["Control+Shift+W"],
    temoins: ["sel:.wt-nouveau", "clic:.wt-nouveau [data-action='creer-config']", "absent:.wt-nouveau .wt-commandes"] },
  // W1 — « Créer » : le dialogue se ferme tout de suite, la carte de la tâche suit les étapes (Annuler).
  { id: "worktrees-creation", ...NOUVEAU, cliquer: ".wt-nouveau [data-action='valider']",
    temoins: ["absent:.wt-nouveau", "appel:worktree_creer", "sel:.wt-carte[data-genre='creation'] .wt-carte__etapes li[data-etat='cours']",
      "clic:.wt-carte[data-genre='creation'] [data-action='annuler']"] },
  // W1 — tâches de fond : préparation en cours (terminal du script), échec (Relancer), suppression finie (avertissement).
  { id: "worktrees-taches", sim: { worktrees: true, wtTaches: true },
    temoins: ["compte:.wt-carte=3", "sel:.wt-carte[data-etat='en_cours'] .wt-script .xterm", "clic:.wt-carte[data-etat='echec'] [data-action='relancer']",
      "sel:.wt-carte[data-etat='reussi'] [data-action='fermer']", "appel:worktree_tache_sortie"] },
];
