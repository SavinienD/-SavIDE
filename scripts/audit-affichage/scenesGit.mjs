// Scènes du panneau Git (onglet Git du volet bas) : compteurs avance / retard,
// fetch, poussée forcée sûre, abandon d'une fusion, rédaction IA du message, « modifier
// le dernier commit », hook qui refuse un commit (« Réparer avec l'IA »).
// Témoins par sélecteur (jamais par libellé) ; données simulées : banc/git.ts.
import { WS_BANC } from "./constantes.mjs";

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

// Onglets PR et Issues : forge Forgejo / Gitea simulée (banc/git.ts : PR, checks, revues, issues).
export function scenesForge({ colonnes, ids }) {
  const ONGLET = ".terminal-tab[data-tab='git']";
  const PR = ".git-panel__sub-tab[data-vue='pr']";
  const ISSUES = ".git-panel__sub-tab[data-vue='issues']";
  const DETAIL = ".git-pr__ligne[data-numero='12']";
  const base = { stockage: () => colonnes([ids(3)]), terminal: true, pauseClics: 900 };
  return [
    { id: "git-pr-liste", ...base, sim: {}, clics: [ONGLET, PR],
      temoins: ["compte:.git-pr__ligne=3", "sel:.git-pr__puce", "sel:.git-pr__forge-nom", "clic:.git-panel__head-btn[data-action='nouvelle-pr']",
        "clic:.git-panel__sub-tab[data-vue='depot']", "absent:.git-panel__commit"] },
    { id: "git-pr-detail", ...base, sim: {}, clics: [ONGLET, PR, DETAIL],
      temoins: ["sel:.git-pr__check[data-etat='echec'] .git-pr__pastille", "clic:.git-pr__bouton[data-action='envoyer-check']", "compte:.git-pr__commentaire=4",
        "sel:.git-pr__lieu", "sel:.git-pr__revue[data-etat='approuvee']", "clic:.git-panel__head-btn[data-action='web']", "sel:.git-pr__description"] },
    { id: "git-pr-check-agent", ...base, sim: {}, clics: [ONGLET, PR, DETAIL, ".git-pr__bouton[data-action='envoyer-check']"],
      temoins: ["appel:forge_journal", "sel:.git-panel__notice[data-cle='consigne-saisie']"] },
    { id: "git-pr-commentaires-agent", ...base, sim: {}, clics: [ONGLET, PR, DETAIL, ".git-pr__commentaire[data-cle='com:c1'] input", ".git-panel__action[data-action='envoyer-commentaires']"],
      temoins: ["sel:.git-panel__notice[data-cle='consigne-saisie']"] },
    { id: "git-pr-nouvelle", ...base, sim: {}, clics: [ONGLET, PR, ".git-panel__head-btn[data-action='nouvelle-pr']"],
      temoins: ["sel:.git-pr__formulaire [data-champ='titre']", "sel:.git-pr__formulaire [data-champ='base']", "clic:.git-pr__bouton[data-action='rediger-pr']", "sel:.git-pr__case input"] },
    { id: "git-pr-rediger", ...base, sim: {}, clics: [ONGLET, PR, ".git-panel__head-btn[data-action='nouvelle-pr']", ".git-pr__bouton[data-action='rediger-pr']"],
      temoins: ["champ:.git-pr__formulaire [data-champ='titre']=Panneau Git lisible à 800 px", "appel:ia_appel_unique", "clic:.git-panel__action[data-action='creer-pr']"] },
    { id: "git-pr-creer", ...base, sim: {}, clics: [ONGLET, PR, ".git-panel__head-btn[data-action='nouvelle-pr']", ".git-pr__bouton[data-action='rediger-pr']", ".git-panel__action[data-action='creer-pr']"],
      temoins: ["appel:forge_creer_pr", "sel:.git-pr__detail", "sel:.git-panel__notice[data-cle='pr-creee']"] },
    { id: "git-pr-jeton", ...base, sim: { sansJeton: true }, clics: [ONGLET, PR],
      temoins: ["sel:.git-pr__jeton-champ", "sel:.git-panel__action[data-action='enregistrer-jeton']", "sel:.git-pr__forge-jeton[data-jeton='non']"] },
    { id: "git-issues", ...base, sim: {}, clics: [ONGLET, ISSUES],
      temoins: ["compte:.git-pr__issue=3", "clic:.git-pr__bouton[data-action='travailler']", "sel:.git-pr__forge-nom"] },
    { id: "git-issues-travailler", ...base, sim: {}, clics: [ONGLET, ISSUES, ".git-pr__issue[data-numero='7'] .git-pr__bouton[data-action='travailler']"],
      temoins: ["champ:.git-pr__formulaire [data-champ='branche']=issue-7-ecran-pr-liste-des-checks-forgejo", "clic:.git-panel__action[data-action='creer-worktree']"] },
    { id: "git-issues-ouvrir", ...base, sim: { travaillerIssue: true, ouvrirChemin: true },
      clics: [ONGLET, ISSUES, ".git-pr__issue[data-numero='7'] .git-pr__bouton[data-action='travailler']", ".git-panel__action[data-action='creer-worktree']"],
      temoins: ["appel:git_create_worktree_command", "appel:create_conversation", `ouvert:${WS_BANC}-issue-7-ecran-pr-liste-des-checks-forgejo`] },
  ];
}
