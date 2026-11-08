// Scènes du panneau Git (onglet Git du volet bas) : compteurs avance / retard,
// fetch, poussée forcée sûre, abandon d'une fusion, rédaction IA du message, « modifier
// le dernier commit », hook qui refuse un commit (« Réparer avec l'IA »).
// Témoins par sélecteur (jamais par libellé) ; données simulées : banc/git.ts.

export function scenesGit({ colonnes, ids }) {
  const ONGLET = ".terminal-tab[data-tab='git']";
  const FICHIER = ".git-panel__row--file";
  const VALIDER = ".git-panel__action[data-action='valider']";
  const base = { stockage: () => colonnes([ids(3)]), terminal: true, pauseClics: 800 };
  const divergente = { gitEtat: { avance: 2, retard: 1, operation: "fusion" } };
  return [
    { id: "git-etat", ...base, sim: divergente, clics: [ONGLET],
      temoins: ["sel:.git-pr__compteur[data-sens='avance']", "sel:.git-pr__compteur[data-sens='retard']", "clic:.git-pr__forcer",
        "clic:.git-pr__bandeau-btn", "clic:.git-panel__head-btn[data-action='fetch']", "sel:.git-pr__bouton[data-action='rediger']", "sel:.git-pr__case input"] },
    { id: "git-fetch", ...base, sim: {}, clics: [ONGLET, ".git-panel__head-btn[data-action='fetch']"],
      temoins: ["appel:git_fetch_command", "sel:.git-panel__notice[data-kind='success']"] },
    { id: "git-forcer", ...base, sim: divergente, clics: [ONGLET, ".git-pr__forcer"],
      temoins: ["sel:.git-panel__dialog", "clic:.git-panel__dialog-btn--primary[data-danger='true']", "sansappel:git_pousser_command"] },
    { id: "git-forcer-pousse", ...base, sim: divergente, clics: [ONGLET, ".git-pr__forcer", ".git-panel__dialog-btn--primary"],
      temoins: ["appel:git_pousser_command", "absent:.git-panel__dialog", "sel:.git-panel__notice[data-kind='success']"] },
    { id: "git-poussee-refusee", ...base, sim: { pousseeRejetee: true }, clics: [ONGLET, ".git-panel__head-action[title='git push']"],
      temoins: ["sel:.git-panel__notice[data-kind='error']", "clic:.git-pr__notice-action[data-action='forcer']", "clic:.git-pr__notice-lien"] },
    { id: "git-abandon", ...base, sim: divergente, clics: [ONGLET, ".git-pr__bandeau-btn"],
      temoins: ["sel:.git-panel__dialog", "clic:.git-panel__dialog-btn--primary[data-danger='true']", "sansappel:git_abandonner_command"] },
    { id: "git-abandon-fait", ...base, sim: divergente, clics: [ONGLET, ".git-pr__bandeau-btn", ".git-panel__dialog-btn--primary"],
      temoins: ["appel:git_abandonner_command", "absent:.git-pr__bandeau", "absent:.git-panel__dialog"] },
    { id: "git-rediger", ...base, sim: {}, clics: [ONGLET, FICHIER, ".git-pr__bouton[data-action='rediger']"],
      temoins: ["champ:.git-pr__message=Corrige l'affichage du panneau Git à 800 px", "appel:git_contexte_ia_command", "appel:ia_appel_unique", "clic:" + VALIDER] },
    { id: "git-rediger-masques", ...base, sim: { redactionMasques: true }, clics: [ONGLET, FICHIER, ".git-pr__bouton[data-action='rediger']"],
      temoins: ["sel:.git-pr__note", "champ:.git-pr__message=Corrige l'affichage du panneau Git à 800 px"] },
    { id: "git-modifier-dernier", ...base, sim: { gitEtat: { avance: 1 } }, clics: [ONGLET, ".git-pr__case input"],
      temoins: ["champ:.git-pr__message=Banc : panneau Git à 800 px", "sel:.git-pr__note[data-genre='attention']", "clic:" + VALIDER] },
    { id: "git-hook", ...base, sim: { hookRefuse: true }, clics: [ONGLET, FICHIER], saisies: [[".git-pr__message", "Corrige le banc"]], apresSaisies: [VALIDER],
      temoins: ["sel:.git-panel__notice[data-kind='error']", "clic:.git-pr__notice-action[data-action='reparer']", "clic:.git-pr__notice-lien"] },
    { id: "git-hook-details", ...base, sim: { hookRefuse: true }, clics: [ONGLET, FICHIER], saisies: [[".git-pr__message", "Corrige le banc"]], apresSaisies: [VALIDER, ".git-pr__notice-lien"],
      temoins: ["sel:.git-pr__sortie", "clic:.git-pr__notice-action[data-action='reparer']"] },
    { id: "git-hook-reparer", ...base, sim: { hookRefuse: true }, clics: [ONGLET, FICHIER], saisies: [[".git-pr__message", "Corrige le banc"]],
      apresSaisies: [VALIDER, ".git-pr__notice-action[data-action='reparer']"],
      temoins: ["sel:.git-panel__notice[data-cle='consigne-saisie']"] },
  ];
}

