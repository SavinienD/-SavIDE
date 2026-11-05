// raccourcis — registre UNIQUE des raccourcis clavier de SavIDE.
// Chaque raccourci est déclaré ici une seule fois (touches, libellé, catégorie) ;
// les composants ne font que fournir l'action (`fournirActions`). Un seul
// écouteur `keydown` (phase de capture) sur window applique le registre, et
// l'onglet Settings > Raccourcis l'affiche tel quel : le pense-bête ne peut donc
// pas mentir sur les touches réelles.
//
// Choix des touches : pas de Ctrl+Alt (= AltGr sur clavier français : €, @, #...),
// rien que Monaco ou xterm utilisent déjà de façon courante, Ctrl+Tab laissé au
// terminal (cycle de ses onglets, TerminalPanel.tsx).
//
// Ctrl+1…9 (⌘1…9 sur macOS) ouvre le n-ième dossier récent, dans
// l'ordre affiché sur l'accueil au moment de l'appui (le plus récent d'abord). Ouvrir un
// dossier le remet en tête, comme un clic sur sa carte : depuis un dossier ouvert, Ctrl+1
// est donc le dossier courant (rien à faire) et Ctrl+2 ramène au dossier quitté juste avant.
// Ctrl+1 / Ctrl+2 servaient à aller à l'explorateur / à la saisie du chat : déplacés sur
// Ctrl+Maj+E / Ctrl+Maj+T. Pas de Ctrl+Alt+chiffre : sur clavier AZERTY, AltGr+3 = « # »,
// AltGr+4 = « { »… (indiscernables de Ctrl+Alt sous Windows).

import { estMac, estWindows, formaterRaccourci, modPrincipal } from "../lib/plateforme";

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
  | "deplacerColonne"
  | "rechercherMac"
  | "dossierRecent";

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
  categorie: "Conversations" | "Onglets" | "Panneaux" | "Dossiers" | "Cloud et appareils" | "Affichage";
  libelle: string;
  /** Texte affiché, ex. « Ctrl + Maj + N ». */
  combinaison: string;
  touche: Touche;
  /** Vrai si Windows seulement (Ctrl+W est laissé au système ailleurs). */
  windowsSeulement?: boolean;
  /** Vrai si macOS seulement (WKWebView n'a pas la recherche Ctrl+F de WebView2). */
  macSeulement?: boolean;
  /** Laissé à l'éditeur et au terminal quand ils ont le focus (leur propre ⌘F). */
  horsEditeur?: boolean;
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
  { id: "rechercherMac", categorie: "Onglets", libelle: "Rechercher dans les fichiers (hors éditeur et terminal)", combinaison: "Ctrl + F", touche: { ctrl: true, touches: ["f"] }, macSeulement: true, horsEditeur: true },
  { id: "rechercheFichiers", categorie: "Onglets", libelle: "Rechercher dans les fichiers", combinaison: "Ctrl + Maj + F", touche: { ctrl: true, shift: true, touches: ["f"] } },

  { id: "terminal", categorie: "Panneaux", libelle: "Afficher / masquer le terminal", combinaison: "Ctrl + J", touche: { ctrl: true, touches: ["j"] } },
  { id: "focusExplorateur", categorie: "Panneaux", libelle: "Aller à l'explorateur de fichiers", combinaison: "Ctrl + Maj + E", touche: { ctrl: true, shift: true, touches: ["e", "code:KeyE"] } },
  { id: "focusChat", categorie: "Panneaux", libelle: "Aller à la zone de saisie du chat", combinaison: "Ctrl + Maj + T", touche: { ctrl: true, shift: true, touches: ["t", "code:KeyT"] } },
  { id: "settings", categorie: "Panneaux", libelle: "Ouvrir les Réglages", combinaison: "Ctrl + ,", touche: { ctrl: true, touches: [",", "code:Comma"] } },
  { id: "accueil", categorie: "Panneaux", libelle: "Revenir à l'accueil", combinaison: "Ctrl + Maj + H", touche: { ctrl: true, shift: true, touches: ["h"] } },

  // touche physique (AZERTY : Ctrl + « & » = Ctrl+1) ; le numéro est lu par numeroTouche.
  { id: "dossierRecent", categorie: "Dossiers", libelle: "Ouvrir le dossier récent n° 1 à 9 (ordre de l'accueil, le dossier ouvert passe en tête)", combinaison: "Ctrl + 1…9", touche: { ctrl: true, touches: ["code:Digit1", "code:Digit2", "code:Digit3", "code:Digit4", "code:Digit5", "code:Digit6", "code:Digit7", "code:Digit8", "code:Digit9", "code:Numpad1", "code:Numpad2", "code:Numpad3", "code:Numpad4", "code:Numpad5", "code:Numpad6", "code:Numpad7", "code:Numpad8", "code:Numpad9"] } },

  { id: "pousserCloud", categorie: "Cloud et appareils", libelle: "Pousser un dossier de ce PC sur le cloud", combinaison: "Ctrl + Maj + U", touche: { ctrl: true, shift: true, touches: ["u"] } },

  { id: "zoomPlus", categorie: "Affichage", libelle: "Zoom avant (toute l'interface)", combinaison: "Ctrl + +", touche: { ctrl: true, touches: ["+", "=", "code:NumpadAdd", "code:Equal"] } },
  { id: "zoomMoins", categorie: "Affichage", libelle: "Zoom arrière", combinaison: "Ctrl + −", touche: { ctrl: true, touches: ["-", "code:Minus", "code:NumpadSubtract"] } },
  { id: "zoomReset", categorie: "Affichage", libelle: "Zoom à 100 %", combinaison: "Ctrl + 0", touche: { ctrl: true, touches: ["code:Digit0", "code:Numpad0"] } },
  // gestes - pense-bete : gestes de saisie et de souris (aucune touche interceptee).
  { id: "entreeEnvoyer", categorie: "Conversations", libelle: "Envoyer le message (mis en file si l'agent travaille)", combinaison: "Entrée", touche: { touches: [] } },
  { id: "entreeForcer", categorie: "Conversations", libelle: "Forcer la file : le dernier message en attente part tout de suite et le tour en cours s'arrête (deux appuis rapides pendant que l'agent travaille)", combinaison: "Entrée × 2 (rapide)", touche: { touches: [] } },
  { id: "nouvelleLigne", categorie: "Conversations", libelle: "Nouvelle ligne dans le message", combinaison: "Maj + Entrée", touche: { touches: [] } },
  { id: "annulerDictee", categorie: "Conversations", libelle: "Annuler la dictée en cours", combinaison: "Échap", touche: { touches: [] } },
  { id: "fermerMolette", categorie: "Onglets", libelle: "Fermer un onglet (fichier, conversation, terminal)", combinaison: "Clic molette sur l'onglet", touche: { touches: [] } },
  { id: "deplacerColonne", categorie: "Onglets", libelle: "Déplacer un fichier vers une autre colonne (écran partagé)", combinaison: "Clic droit sur l'onglet, ou glisser", touche: { touches: [] } },
];

/** Combinaison telle qu'affichée sur ce système (⌘ ⌥ ⇧ sur macOS). */
export function combinaisonAffichee(r: Raccourci, mac: boolean = estMac()): string {
  return formaterRaccourci(r.combinaison, mac);
}

/** Vrai si l'événement correspond à la combinaison. Exporté pour les tests. */
export function correspond(r: Raccourci, e: KeyboardEvent, mac: boolean = estMac()): boolean {
  const t = r.touche;
  const ctrl = modPrincipal(e, mac);
  if (!!t.ctrl !== ctrl) return false;
  if (!!t.alt !== e.altKey) return false;
  // Shift : exigé quand demandé ; ignoré pour les zooms (Ctrl + = / + selon le clavier).
  const ignoreShift = r.id === "zoomPlus" || r.id === "zoomMoins";
  if (!ignoreShift && !!t.shift !== e.shiftKey) return false;
  const key = (e.key || "").toLowerCase();
  return t.touches.some((k) => {
    if (k.startsWith("code:")) return e.code === k.slice(5);
    if (key === k) return true;
    // macOS : Option change le caractère (⌥⌘B donne « ∫ ») ; on lit alors la touche physique.
    return mac && e.altKey && /^[a-z]$/.test(k) && e.code === `Key${k.toUpperCase()}`;
  });
}

/** Chiffre 1…9 de la touche (rangée du haut ou pavé numérique), sinon null. */
export function numeroTouche(e: { code?: string; key?: string }): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || "") ?? (!e.code ? /^([1-9])$/.exec(e.key || "") : null);
  return m ? Number(m[1]) : null;
}

/** L'action reçoit l'événement (ex. dossierRecent y lit le chiffre). */
type Actions = Partial<Record<RaccourciId, (e: KeyboardEvent) => void>>;
const fournisseurs: Actions[] = [];
let installe = false;

/** Vrai si la touche vient de l'éditeur Monaco ou du terminal (ils gèrent ⌘F eux-mêmes). */
export function dansEditeur(cible: EventTarget | null): boolean {
  const el = cible as { closest?: (s: string) => unknown } | null;
  return Boolean(el && typeof el.closest === "function" && el.closest(".monaco-editor, .xterm"));
}

function surTouche(e: KeyboardEvent): void {
  for (const r of RACCOURCIS) {
    if (r.windowsSeulement && !estWindows()) continue;
    if (r.macSeulement && !estMac()) continue;
    if (!correspond(r, e)) continue;
    if (r.horsEditeur && dansEditeur(e.target)) continue;
    // Le fournisseur le plus récent (vue au premier plan) l'emporte.
    for (let i = fournisseurs.length - 1; i >= 0; i--) {
      const action = fournisseurs[i][r.id];
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        action(e);
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

/** Combinaison compacte (« Ctrl+3 » ; « ⌘3 » sur macOS) du raccourci `id`. */
function combinaisonCourte(id: RaccourciId, mac: boolean): string {
  const r = RACCOURCIS.find((x) => x.id === id);
  if (!r) return "";
  if (r.windowsSeulement && typeof navigator !== "undefined" && !estWindows()) return "";
  if (mac) return formaterRaccourci(r.combinaison, true);
  return r.combinaison.split(" + ").join("+");
}

/** Dossiers récents : « Ctrl+3 » / « ⌘3 », combinaison « … 1…9 » pour un chiffre donné. */
export function combinaisonNumero(id: RaccourciId, n: number, mac: boolean = estMac()): string {
  return combinaisonCourte(id, mac).replace("1…9", String(n));
}

/** Info-bulle d'une carte numérotée : « Ouvrir client · Ctrl+3 ». */
export function infoBulleNumero(libelle: string, id: RaccourciId, n: number, mac: boolean = estMac()): string {
  const c = combinaisonNumero(id, n, mac);
  return c ? `${libelle} · ${c}` : libelle;
}
