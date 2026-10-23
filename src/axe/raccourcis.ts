// axe:raccourcis — registre UNIQUE des raccourcis clavier de SavIDE.
// Chaque raccourci est déclaré ici une seule fois (touches, libellé, catégorie) ;
// les composants ne font que fournir l'action (`fournirActions`). Un seul
// écouteur `keydown` (phase de capture) sur window applique le registre, et
// l'onglet Settings > Raccourcis l'affiche tel quel : le pense-bête ne peut donc
// pas mentir sur les touches réelles.
//
// Choix des touches : pas de Ctrl+Alt (= AltGr sur clavier français : €, @, #...),
// rien que Monaco ou xterm utilisent déjà de façon courante, Ctrl+Tab laissé au
// terminal (cycle de ses onglets, TerminalPanel.tsx).

export type RaccourciId =
  | "nouvelleConversation"
  | "fermerOnglet"
  | "ongletSuivant"
  | "ongletPrecedent"
  | "conversationSuivante"
  | "conversationPrecedente"
  | "terminal"
  | "enregistrer"
  | "settings"
  | "accueil"
  | "pousserCloud"
  | "remote"
  | "dictee"
  | "rechercheFichiers"
  | "colonneChat"
  | "archiver"
  | "stop"
  | "focusExplorateur"
  | "focusChat"
  | "zoomPlus"
  | "zoomMoins"
  | "zoomReset"
  | "entreeEnvoyer"
  | "entreeForcer"
  | "nouvelleLigne"
  | "annulerDictee"
  | "fermerMolette"
  | "deplacerColonne";

type Touche = {
  /** Ctrl (ou Cmd sur macOS). */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** `event.key` en minuscules, ou `event.code` (préfixe "code:"). */
  touches: string[];
};

export type Raccourci = {
  id: RaccourciId;
  categorie: "Conversations" | "Onglets" | "Panneaux" | "Cloud et appareils" | "Affichage";
  libelle: string;
  /** Texte affiché, ex. « Ctrl + Maj + N ». */
  combinaison: string;
  touche: Touche;
  /** Vrai si Windows seulement (Ctrl+W est laissé au système ailleurs). */
  windowsSeulement?: boolean;
};

export const RACCOURCIS: Raccourci[] = [
  { id: "nouvelleConversation", categorie: "Conversations", libelle: "Nouvelle conversation", combinaison: "Ctrl + Maj + N", touche: { ctrl: true, shift: true, touches: ["n"] } },
  { id: "conversationSuivante", categorie: "Conversations", libelle: "Conversation suivante (onglets du chat)", combinaison: "Ctrl + Maj + Page suiv.", touche: { ctrl: true, shift: true, touches: ["pagedown"] } },
  { id: "conversationPrecedente", categorie: "Conversations", libelle: "Conversation précédente", combinaison: "Ctrl + Maj + Page préc.", touche: { ctrl: true, shift: true, touches: ["pageup"] } },
  { id: "archiver", categorie: "Conversations", libelle: "Archiver la conversation active", combinaison: "Ctrl + Maj + A", touche: { ctrl: true, shift: true, touches: ["a"] } },
  { id: "stop", categorie: "Conversations", libelle: "Arrêter la réponse en cours", combinaison: "Ctrl + Maj + Retour arrière", touche: { ctrl: true, shift: true, touches: ["backspace"] } },
  { id: "dictee", categorie: "Conversations", libelle: "Dicter dans la zone de saisie", combinaison: "Ctrl + Maj + D", touche: { ctrl: true, shift: true, touches: ["d"] } },
  { id: "colonneChat", categorie: "Conversations", libelle: "Mettre la conversation dans une nouvelle colonne", combinaison: "Ctrl + \\", touche: { ctrl: true, touches: ["\\", "code:Backslash", "code:IntlBackslash"] } },

  { id: "fermerOnglet", categorie: "Onglets", libelle: "Fermer l'onglet actif (fichier, Réglages, À distance)", combinaison: "Ctrl + W", touche: { ctrl: true, touches: ["w"] }, windowsSeulement: true },
  { id: "ongletSuivant", categorie: "Onglets", libelle: "Onglet de fichier suivant", combinaison: "Ctrl + Page suiv.", touche: { ctrl: true, touches: ["pagedown"] } },
  { id: "ongletPrecedent", categorie: "Onglets", libelle: "Onglet de fichier précédent", combinaison: "Ctrl + Page préc.", touche: { ctrl: true, touches: ["pageup"] } },
  { id: "enregistrer", categorie: "Onglets", libelle: "Enregistrer le fichier", combinaison: "Ctrl + S", touche: { ctrl: true, touches: ["s"] } },
  { id: "rechercheFichiers", categorie: "Onglets", libelle: "Rechercher dans les fichiers", combinaison: "Ctrl + Maj + F", touche: { ctrl: true, shift: true, touches: ["f"] } },

  { id: "terminal", categorie: "Panneaux", libelle: "Afficher / masquer le terminal", combinaison: "Ctrl + J", touche: { ctrl: true, touches: ["j"] } },
  { id: "focusExplorateur", categorie: "Panneaux", libelle: "Aller à l'explorateur de fichiers", combinaison: "Ctrl + 1", touche: { ctrl: true, touches: ["code:Digit1", "code:Numpad1"] } },
  { id: "focusChat", categorie: "Panneaux", libelle: "Aller à la zone de saisie du chat", combinaison: "Ctrl + 2", touche: { ctrl: true, touches: ["code:Digit2", "code:Numpad2"] } },
  { id: "settings", categorie: "Panneaux", libelle: "Ouvrir les Réglages", combinaison: "Ctrl + ,", touche: { ctrl: true, touches: [",", "code:Comma"] } },
  { id: "accueil", categorie: "Panneaux", libelle: "Revenir à l'accueil", combinaison: "Ctrl + Maj + H", touche: { ctrl: true, shift: true, touches: ["h"] } },

  { id: "pousserCloud", categorie: "Cloud et appareils", libelle: "Pousser un dossier de ce PC sur le cloud", combinaison: "Ctrl + Maj + U", touche: { ctrl: true, shift: true, touches: ["u"] } },

  { id: "zoomPlus", categorie: "Affichage", libelle: "Zoom avant (toute l'interface)", combinaison: "Ctrl + +", touche: { ctrl: true, touches: ["+", "=", "code:NumpadAdd", "code:Equal"] } },
  { id: "zoomMoins", categorie: "Affichage", libelle: "Zoom arrière", combinaison: "Ctrl + −", touche: { ctrl: true, touches: ["-", "code:Minus", "code:NumpadSubtract"] } },
  { id: "zoomReset", categorie: "Affichage", libelle: "Zoom à 100 %", combinaison: "Ctrl + 0", touche: { ctrl: true, touches: ["code:Digit0", "code:Numpad0"] } },
  // axe:gestes - pense-bete : gestes de saisie et de souris (aucune touche interceptee).
  { id: "entreeEnvoyer", categorie: "Conversations", libelle: "Envoyer le message (mis en file si l'agent travaille)", combinaison: "Entrée", touche: { touches: [] } },
  { id: "entreeForcer", categorie: "Conversations", libelle: "Forcer la file : le dernier message en attente part tout de suite et le tour en cours s'arrête (deux appuis rapides pendant que l'agent travaille)", combinaison: "Entrée × 2 (rapide)", touche: { touches: [] } },
  { id: "nouvelleLigne", categorie: "Conversations", libelle: "Nouvelle ligne dans le message", combinaison: "Maj + Entrée", touche: { touches: [] } },
  { id: "annulerDictee", categorie: "Conversations", libelle: "Annuler la dictée en cours", combinaison: "Échap", touche: { touches: [] } },
  { id: "fermerMolette", categorie: "Onglets", libelle: "Fermer un onglet (fichier, conversation, terminal)", combinaison: "Clic molette sur l'onglet", touche: { touches: [] } },
  { id: "deplacerColonne", categorie: "Onglets", libelle: "Déplacer un fichier vers une autre colonne (écran partagé)", combinaison: "Clic droit sur l'onglet, ou glisser", touche: { touches: [] } },
];

function estMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function estWindows(): boolean {
  return typeof navigator !== "undefined" && /win/i.test(navigator.platform);
}

/** Vrai si l'événement correspond à la combinaison. Exporté pour les tests. */
export function correspond(r: Raccourci, e: KeyboardEvent): boolean {
  const t = r.touche;
  const ctrl = estMac() ? e.metaKey : e.ctrlKey;
  if (!!t.ctrl !== ctrl) return false;
  if (!!t.alt !== e.altKey) return false;
  // Shift : exigé quand demandé ; ignoré pour les zooms (Ctrl + = / + selon le clavier).
  const ignoreShift = r.id === "zoomPlus" || r.id === "zoomMoins";
  if (!ignoreShift && !!t.shift !== e.shiftKey) return false;
  const key = (e.key || "").toLowerCase();
  return t.touches.some((k) => (k.startsWith("code:") ? e.code === k.slice(5) : key === k));
}

type Actions = Partial<Record<RaccourciId, () => void>>;
const fournisseurs: Actions[] = [];
let installe = false;

function surTouche(e: KeyboardEvent): void {
  for (const r of RACCOURCIS) {
    if (r.windowsSeulement && !estWindows()) continue;
    if (!correspond(r, e)) continue;
    // Le fournisseur le plus récent (vue au premier plan) l'emporte.
    for (let i = fournisseurs.length - 1; i >= 0; i--) {
      const action = fournisseurs[i][r.id];
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        action();
        return;
      }
    }
    return;
  }
}

/** Un composant fournit ses actions ; renvoie la fonction de retrait. */
export function fournirActions(actions: Actions): () => void {
  if (!installe && typeof window !== "undefined") {
    window.addEventListener("keydown", surTouche, true);
    installe = true;
  }
  fournisseurs.push(actions);
  return () => {
    const i = fournisseurs.indexOf(actions);
    if (i >= 0) fournisseurs.splice(i, 1);
  };
}
