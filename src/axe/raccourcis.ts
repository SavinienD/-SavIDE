// raccourcis — registre UNIQUE des raccourcis clavier de SavIDE.
// Chaque raccourci est déclaré ici une seule fois (touches, libellé, catégorie) ;
// les composants ne font que fournir l'action (`fournirActions`). Un seul
// écouteur `keydown` (phase de capture) sur window applique le registre, et
// l'onglet Settings > Raccourcis l'affiche tel quel : le pense-bête ne peut donc
// pas mentir sur les touches réelles.
//
// Choix des touches (06/11) : les combinaisons standard d'un navigateur ou de VS Code
// (Ctrl+T nouvel onglet = nouvelle conversation, Ctrl+Tab /
// Ctrl+Maj+Tab onglet suivant / précédent, Échap arrête la réponse, Ctrl+D dicter).
// Pas de Ctrl+Alt sur une touche qui donne un caractère avec AltGr (clavier français :
// €, @, #...) ; Ctrl+Maj+N (nouvelle fenêtre) et Ctrl+W restent au menu natif ; les
// touches du shell (Ctrl+N, Ctrl+T, Ctrl+D) sont laissées au terminal quand il a le
// focus (horsTerminal / horsEditeur). Ctrl+Tab vise les onglets de la zone qui a le
// focus : terminaux dans le terminal (TerminalPanel.tsx), fichiers dans l'éditeur,
// conversations ailleurs (l'action renvoie false pour laisser passer la touche).
//
// Ctrl+1…9 (⌘1…9 sur macOS) ouvre le dossier numéroté 1…9 (cartes de
// l'accueil, boutons de la barre du haut). L'ordre est figé tant qu'on ne revient pas à
// l'accueil (lib/recents.ts) : depuis le dossier 2, Ctrl+1 ramène au dossier 1.
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
  | "dossierRecent"
  | "validerAction";

type Touche = {
  /** Ctrl (ou Cmd sur macOS). */
  ctrl?: boolean;
  /** Vraie touche Control sur tous les systèmes (⌃Tab sur macOS : ⌘Tab est au système). */
  controle?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** `event.key` en minuscules, ou `event.code` (préfixe "code:"). */
  touches: string[];
  /** Touche physique (event.code) dont le caractère dépend du clavier : libellé lu dans la disposition. */
  physique?: string;
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
  /** Laissé au terminal quand il a le focus (touche utile au shell : Ctrl+N, Ctrl+T…). */
  horsTerminal?: boolean;
};

export const RACCOURCIS: Raccourci[] = [
  { id: "nouvelleConversation", categorie: "Conversations", libelle: "Nouvelle conversation (nouvel onglet du chat)", combinaison: "Ctrl + T", touche: { ctrl: true, touches: ["t"] }, horsTerminal: true },
  { id: "conversationSuivante", categorie: "Conversations", libelle: "Onglet suivant : conversations, ou fichiers si l'éditeur a le focus, ou terminaux si le terminal l'a", combinaison: "Contrôle + Tab", touche: { ctrl: true, controle: true, touches: ["tab"] } },
  { id: "conversationPrecedente", categorie: "Conversations", libelle: "Onglet précédent (même règle)", combinaison: "Contrôle + Maj + Tab", touche: { ctrl: true, controle: true, shift: true, touches: ["tab"] } },
  { id: "archiver", categorie: "Conversations", libelle: "Archiver la conversation active", combinaison: "Ctrl + Maj + A", touche: { ctrl: true, shift: true, touches: ["a"] } },
  { id: "stop", categorie: "Conversations", libelle: "Arrêter la réponse en cours (depuis la conversation, aucun menu ouvert)", combinaison: "Échap", touche: { touches: ["escape"] } },
  { id: "dictee", categorie: "Conversations", libelle: "Dicter dans la zone de saisie", combinaison: "Ctrl + D", touche: { ctrl: true, touches: ["d", "code:KeyD"] }, horsEditeur: true },
  { id: "validerAction", categorie: "Conversations", libelle: "Autoriser l'action en attente (mode « Demander avant d'agir »)", combinaison: "Ctrl + Maj + Entrée", touche: { ctrl: true, shift: true, touches: ["enter"] } },
  { id: "colonneChat", categorie: "Conversations", libelle: "Mettre la conversation dans une nouvelle colonne", combinaison: "Ctrl + \\", touche: { ctrl: true, touches: ["\\", "code:Backslash", "code:IntlBackslash"], physique: "Backslash" } },

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
  { id: "dossierRecent", categorie: "Dossiers", libelle: "Ouvrir le dossier n° 1 à 9 (ordre de l'accueil, inchangé jusqu'au retour à l'accueil)", combinaison: "Ctrl + 1…9", touche: { ctrl: true, touches: ["code:Digit1", "code:Digit2", "code:Digit3", "code:Digit4", "code:Digit5", "code:Digit6", "code:Digit7", "code:Digit8", "code:Digit9", "code:Numpad1", "code:Numpad2", "code:Numpad3", "code:Numpad4", "code:Numpad5", "code:Numpad6", "code:Numpad7", "code:Numpad8", "code:Numpad9"] } },

  { id: "pousserCloud", categorie: "Cloud et appareils", libelle: "Pousser un dossier de ce PC sur le cloud", combinaison: "Ctrl + Maj + U", touche: { ctrl: true, shift: true, touches: ["u"] } },

  { id: "zoomPlus", categorie: "Affichage", libelle: "Zoom avant (toute l'interface)", combinaison: "Ctrl + +", touche: { ctrl: true, touches: ["+", "=", "code:NumpadAdd", "code:Equal"] } },
  { id: "zoomMoins", categorie: "Affichage", libelle: "Zoom arrière", combinaison: "Ctrl + −", touche: { ctrl: true, touches: ["-", "code:Minus", "code:NumpadSubtract"] } },
  { id: "zoomReset", categorie: "Affichage", libelle: "Zoom à 100 %", combinaison: "Ctrl + 0", touche: { ctrl: true, touches: ["code:Digit0", "code:Numpad0"] } },
  // pense-bete : gestes de saisie et de souris (aucune touche interceptee).
  { id: "entreeEnvoyer", categorie: "Conversations", libelle: "Envoyer le message (mis en file si l'agent travaille)", combinaison: "Entrée", touche: { touches: [] } },
  { id: "entreeForcer", categorie: "Conversations", libelle: "Forcer la file : le dernier message en attente part tout de suite et le tour en cours s'arrête (deux appuis rapides pendant que l'agent travaille)", combinaison: "Entrée × 2 (rapide)", touche: { touches: [] } },
  { id: "nouvelleLigne", categorie: "Conversations", libelle: "Nouvelle ligne dans le message", combinaison: "Maj + Entrée", touche: { touches: [] } },
  { id: "annulerDictee", categorie: "Conversations", libelle: "Annuler la dictée en cours", combinaison: "Échap", touche: { touches: [] } },
  { id: "fermerMolette", categorie: "Onglets", libelle: "Fermer un onglet (fichier, conversation, terminal)", combinaison: "Clic molette sur l'onglet", touche: { touches: [] } },
  { id: "deplacerColonne", categorie: "Onglets", libelle: "Déplacer un fichier vers une autre colonne (écran partagé)", combinaison: "Clic droit sur l'onglet, ou glisser", touche: { touches: [] } },
];

// Disposition du clavier (navigator.keyboard.getLayoutMap, WebView2 / Chromium) : libellé
// réel des touches physiques (AZERTY : la touche « Backslash » porte « * »). Sans elle
// (WKWebView, tests), le libellé du registre.
let disposition: Map<string, string> | null = null;
/** Pour les tests et le chargement : table event.code → caractère de la touche. */
export function definirDispositionClavier(table: Map<string, string> | null): void {
  disposition = table;
}
if (typeof navigator !== "undefined") {
  const clavier = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
  void clavier?.getLayoutMap?.().then((m) => definirDispositionClavier(new Map(m))).catch(() => undefined);
}

/** Combinaison du registre, touche physique traduite selon le clavier. */
function combinaisonClavier(r: Raccourci): string {
  const perso = lirePerso()[r.id];
  if (perso) return perso.combinaison;
  const code = r.touche.physique;
  const c = code ? disposition?.get(code) : undefined;
  if (!c || !c.trim()) return r.combinaison;
  const i = r.combinaison.lastIndexOf("+");
  return `${r.combinaison.slice(0, i + 1)} ${c.length === 1 ? c.toUpperCase() : c}`;
}

/** Combinaison telle qu'affichée sur ce système (⌘ ⌥ ⇧ sur macOS). */
export function combinaisonAffichee(r: Raccourci, mac: boolean = estMac()): string {
  return formaterRaccourci(combinaisonClavier(r), mac);
}

/** Vrai si l'événement correspond à la combinaison. Exporté pour les tests. */
export function correspond(r: Raccourci, e: KeyboardEvent, mac: boolean = estMac()): boolean {
  const t = toucheDe(r);
  if (!t.touches.length) return false;
  if (t.controle) {
    // Vraie touche Control (⌃ sur macOS) ; Cmd ne compte pas.
    if (!!t.ctrl !== e.ctrlKey || e.metaKey) return false;
  } else {
    const ctrl = modPrincipal(e, mac);
    if (!!t.ctrl !== ctrl) return false;
    // Ailleurs que sur Mac, Échap ou Ctrl+T avec la touche Windows enfoncée : pas pour nous.
    if (mac ? e.ctrlKey && !t.ctrl : e.metaKey) return false;
  }
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

/** chiffre 1…9 de la touche (rangée du haut ou pavé numérique), sinon null. */
export function numeroTouche(e: { code?: string; key?: string }): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || "") ?? (!e.code ? /^([1-9])$/.exec(e.key || "") : null);
  return m ? Number(m[1]) : null;
}

/** L'action reçoit l'événement (ex. dossierRecent y lit le chiffre). Renvoyer `false` :
 *  la touche n'est pas pour elle (contexte), elle continue son chemin normalement. */
type Actions = Partial<Record<RaccourciId, (e: KeyboardEvent) => unknown>>;
const fournisseurs: Actions[] = [];
let installe = false;

/** Vrai si la touche vient de l'éditeur Monaco ou du terminal (ils gèrent ⌘F eux-mêmes). */
export function dansEditeur(cible: EventTarget | null): boolean {
  const el = cible as { closest?: (s: string) => unknown } | null;
  return Boolean(el && typeof el.closest === "function" && el.closest(".monaco-editor, .xterm"));
}

/** Vrai si la touche vient du terminal (xterm). */
export function dansTerminal(cible: EventTarget | null): boolean {
  const el = cible as { closest?: (s: string) => unknown } | null;
  return Boolean(el && typeof el.closest === "function" && el.closest(".xterm"));
}

/** Applique le registre à une touche (écouteur unique ; exporté pour les tests). */
export function traiterTouche(e: KeyboardEvent): void {
  if (suspendu) return;
  for (const r of RACCOURCIS) {
    if (r.windowsSeulement && !estWindows()) continue;
    if (r.macSeulement && !estMac()) continue;
    if (!correspond(r, e)) continue;
    if (r.horsEditeur && dansEditeur(e.target)) continue;
    if (r.horsTerminal && dansTerminal(e.target)) continue;
    // Le fournisseur le plus récent (vue au premier plan) l'emporte.
    for (let i = fournisseurs.length - 1; i >= 0; i--) {
      const action = fournisseurs[i][r.id];
      if (action) {
        if (action(e) === false) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    return;
  }
}

/** Un composant fournit ses actions ; renvoie la fonction de retrait. */
export function fournirActions(actions: Actions): () => void {
  if (!installe && typeof window !== "undefined") {
    window.addEventListener("keydown", traiterTouche, true);
    installe = true;
  }
  fournisseurs.push(actions);
  return () => {
    const i = fournisseurs.indexOf(actions);
    if (i >= 0) fournisseurs.splice(i, 1);
  };
}

// ---------------------------------------------------------------------------
// Raccourcis modifiables (Réglages > Raccourcis) : une combinaison choisie par
// l'utilisateur remplace celle du registre, partout (lecture des touches,
// info-bulles, pense-bête). Stockée dans le stockage local de l'appli.

export const CLE_RACCOURCIS = "axecode.raccourcis";
export type CombinaisonLue = {
  touche: Touche;
  /** Libellé au format du registre : « Ctrl + Maj + K ». */
  combinaison: string;
  /** Événement d'origine (sert à chercher les conflits). */
  evenement?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string; code: string };
};
let perso: Partial<Record<RaccourciId, CombinaisonLue>> | null = null;
let suspendu = false;
let version = 0;
const abonnes = new Set<() => void>();

/** Vrai pour les raccourcis à vraie touche (pas les gestes, pas la famille Ctrl+1…9). */
export function estModifiable(r: Raccourci): boolean {
  return r.touche.touches.length > 0 && r.id !== "dossierRecent";
}

function lirePerso(): Partial<Record<RaccourciId, CombinaisonLue>> {
  if (perso) return perso;
  const lu: Partial<Record<RaccourciId, CombinaisonLue>> = {};
  try {
    const brut = typeof localStorage !== "undefined" ? localStorage.getItem(CLE_RACCOURCIS) : null;
    const donnees = brut ? (JSON.parse(brut) as Record<string, CombinaisonLue>) : {};
    for (const r of RACCOURCIS) {
      const c = donnees?.[r.id];
      const t = c?.touche;
      if (!estModifiable(r) || !t || typeof c.combinaison !== "string" || !Array.isArray(t.touches) || !t.touches.length) continue;
      if (!t.touches.every((k) => typeof k === "string")) continue;
      lu[r.id] = { touche: { ctrl: !!t.ctrl, controle: !!t.controle, shift: !!t.shift, alt: !!t.alt, touches: t.touches }, combinaison: c.combinaison };
    }
  } catch {
    // données illisibles : on garde le registre
  }
  perso = lu;
  return lu;
}

function ecrirePerso(): void {
  try {
    const p = lirePerso();
    const sortie: Record<string, CombinaisonLue> = {};
    for (const [id, c] of Object.entries(p)) if (c) sortie[id] = { touche: c.touche, combinaison: c.combinaison };
    if (Object.keys(sortie).length) localStorage.setItem(CLE_RACCOURCIS, JSON.stringify(sortie));
    else localStorage.removeItem(CLE_RACCOURCIS);
  } catch {
    // stockage indisponible : le changement vaut pour cette session
  }
  version++;
  for (const f of [...abonnes]) f();
}

/** Touche effective : celle choisie par l'utilisateur, sinon celle du registre. */
function toucheDe(r: Raccourci): Touche {
  return (r.id && lirePerso()[r.id]?.touche) || r.touche;
}

/** Relit le stockage (autre fenêtre, tests). */
export function rechargerRaccourcis(): void {
  perso = null;
  version++;
  for (const f of [...abonnes]) f();
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key === CLE_RACCOURCIS) rechargerRaccourcis();
  });
}

/** Change un raccourci (null = combinaison par défaut). */
export function definirRaccourci(id: RaccourciId, c: CombinaisonLue | null): void {
  const p = lirePerso();
  if (c) p[id] = { touche: c.touche, combinaison: c.combinaison };
  else delete p[id];
  ecrirePerso();
}

/** Remet tous les raccourcis par défaut. */
export function reinitialiserRaccourcis(): void {
  perso = {};
  ecrirePerso();
}

export function estModifie(id: RaccourciId): boolean {
  return Boolean(lirePerso()[id]);
}

/** Abonnement aux changements (re-rendu de l'onglet et des info-bulles). */
export function ecouterRaccourcis(f: () => void): () => void {
  abonnes.add(f);
  return () => abonnes.delete(f);
}
export function versionRaccourcis(): number {
  return version;
}

/** Pendant qu'on tape une nouvelle combinaison, aucun raccourci ne se déclenche. */
export function suspendreRaccourcis(oui: boolean): void {
  suspendu = oui;
}

const NOMS_TOUCHES: Record<string, string> = {
  escape: "Échap", enter: "Entrée", tab: "Tab", backspace: "Retour arrière", delete: "Suppr", insert: "Inser",
  pagedown: "Page suiv.", pageup: "Page préc.", home: "Début", end: "Fin",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
};
const MODIFICATEURS = new Set(["control", "shift", "alt", "meta", "altgraph", "capslock", "os", "fn", "dead", "unidentified"]);

/** Combinaison tapée au clavier (null tant qu'on n'a appuyé que sur des modificateurs). */
export function lireCombinaison(
  e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string; code: string },
  mac: boolean = estMac(),
): CombinaisonLue | null {
  const key = (e.key || "").toLowerCase();
  if (!key || MODIFICATEURS.has(key)) return null;
  const ctrl = mac ? e.metaKey || e.ctrlKey : e.ctrlKey;
  const controle = mac && e.ctrlKey && !e.metaKey;
  let touche: string;
  let libelle: string;
  const lettreCode = /^Key([A-Z])$/.exec(e.code || "")?.[1];
  const chiffre = /^(?:Digit|Numpad)(\d)$/.exec(e.code || "")?.[1];
  if (/^[a-z]$/.test(key)) {
    touche = key;
    libelle = key.toUpperCase();
  } else if (mac && e.altKey && lettreCode) {
    touche = lettreCode.toLowerCase();
    libelle = lettreCode;
  } else if (chiffre) {
    touche = `code:${e.code}`;
    libelle = chiffre;
  } else if (NOMS_TOUCHES[key] || /^f\d{1,2}$/.test(key)) {
    touche = key;
    libelle = NOMS_TOUCHES[key] ?? key.toUpperCase();
  } else if (key === " ") {
    touche = "code:Space";
    libelle = "Espace";
  } else {
    touche = e.code ? `code:${e.code}` : key;
    libelle = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  const mods = [controle ? "Contrôle" : ctrl ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Maj" : ""].filter(Boolean);
  return {
    touche: { ctrl: ctrl || controle, controle: controle || undefined, alt: e.altKey || undefined, shift: e.shiftKey || undefined, touches: [touche] },
    combinaison: [...mods, libelle].join(" + "),
    evenement: { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, key: e.key, code: e.code },
  };
}

const RESERVEES: Record<string, string> = { c: "Copier", v: "Coller", x: "Couper", z: "Annuler", y: "Rétablir", a: "Tout sélectionner" };
const ALTGR = new Set(["Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "KeyE", "Minus", "Equal", "BracketRight", "BracketLeft"]);

/** Message d'erreur si la combinaison ne peut pas servir à ce raccourci, sinon null. */
export function verifierCombinaison(id: RaccourciId, c: CombinaisonLue | null, mac: boolean = estMac()): string | null {
  if (!c) return "Appuyez sur une touche avec Ctrl ou Alt.";
  const t = c.touche;
  const k = t.touches[0] ?? "";
  const ev = c.evenement;
  const fonction = /^f\d{1,2}$/.test(k);
  const nomCtrl = mac ? "⌘" : "Ctrl";
  if (!t.ctrl && !t.alt && !fonction) {
    return `Ajoutez ${nomCtrl} ou ${mac ? "⌥" : "Alt"} : sans eux, la touche s'écrirait dans le texte.`;
  }
  if (t.ctrl && !t.controle && !t.alt && !t.shift && RESERVEES[k]) return `${nomCtrl}+${k.toUpperCase()} est réservé à « ${RESERVEES[k]} ».`;
  if (t.ctrl && !t.alt && /^code:(?:Digit|Numpad)[1-9]$/.test(k)) return `${nomCtrl}+1…9 ouvre les dossiers récents.`;
  if (!mac && t.ctrl && t.alt && ev && ALTGR.has(ev.code)) {
    return "Ctrl+Alt sur cette touche = AltGr sur un clavier français (€, @, #…) : choisissez une autre touche.";
  }
  if (mac && t.ctrl && !t.controle && !t.alt && !t.shift && ["q", "w", "h", "m"].includes(k)) {
    return `⌘${k.toUpperCase()} est réservé par macOS.`;
  }
  if (ev) {
    const e = ev as unknown as KeyboardEvent;
    for (const r of RACCOURCIS) {
      if (r.id === id) continue;
      if (r.windowsSeulement && (mac || !estWindows())) continue;
      if (r.macSeulement && !mac) continue;
      if (correspond(r, e, mac)) return `Déjà pris par « ${r.libelle} ».`;
    }
  }
  return null;
}

/** Touches d'une combinaison, une pastille chacune : ["Ctrl", "Maj", "N"] ; macOS ["⇧", "⌘", "N"]. */
export function partiesCombinaison(r: Raccourci, mac: boolean = estMac()): string[] {
  const s = combinaisonAffichee(r, mac);
  if (mac) {
    const mods: string[] = [];
    let i = 0;
    while (i < s.length && "⌃⌥⇧⌘".includes(s[i])) mods.push(s[i++]);
    const reste = s.slice(i).trim();
    return mods.length ? (reste ? [...mods, reste] : mods) : [s];
  }
  return s.split(" + ").map((p) => p.trim()).filter(Boolean);
}

// info-bulle commune « Libellé · Ctrl+Maj+N », lue dans
// le registre ci-dessus (seule source de vérité ; Cmd sur macOS).
/** Combinaison compacte pour une info-bulle (« Ctrl+Maj+N » ; « ⇧⌘N », « ⌘, » sur macOS). */
export function combinaisonCourte(id: RaccourciId, mac: boolean = estMac()): string {
  const r = RACCOURCIS.find((x) => x.id === id);
  if (!r) return "";
  if (r.windowsSeulement && typeof navigator !== "undefined" && !estWindows()) return "";
  const c = combinaisonClavier(r);
  if (mac) return formaterRaccourci(c, true);
  return formaterRaccourci(c, false).split(" + ").join("+");
}

/** Info-bulle d'un bouton : « Libellé · Ctrl+Maj+N » (libellé seul sans raccourci). */
export function infoBulle(libelle: string, id: RaccourciId, mac: boolean = estMac()): string {
  const c = combinaisonCourte(id, mac);
  return c ? `${libelle} · ${c}` : libelle;
}

/** « Ctrl+3 » / « ⌘3 » : combinaison « … 1…9 » pour un chiffre donné. */
export function combinaisonNumero(id: RaccourciId, n: number, mac: boolean = estMac()): string {
  return combinaisonCourte(id, mac).replace("1…9", String(n));
}

/** Info-bulle d'une carte numérotée : « Ouvrir client · Ctrl+3 ». */
export function infoBulleNumero(libelle: string, id: RaccourciId, n: number, mac: boolean = estMac()): string {
  const c = combinaisonNumero(id, n, mac);
  return c ? `${libelle} · ${c}` : libelle;
}
