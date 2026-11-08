/**
 * Texte envoyé à l'agent depuis le panneau Git : sortie d'un hook qui refuse un commit,
 * check en échec, commentaires de revue, issue à traiter.
 *
 * Le texte arrive dans la zone de saisie de la conversation affichée (celle qui a eu le
 * focus en dernier, dans le même dossier) ; il n'est jamais envoyé tout seul : on le
 * relit, puis Entrée. Pour une conversation pas encore affichée (« Travailler dessus »
 * ouvre un worktree), le texte attend qu'elle s'affiche.
 *
 * Module sans React (testé par node) : ChatPane y branche son compositeur, App y
 * branche l'ouverture d'un dossier.
 */

export type Livraison = "saisie" | "en-attente" | "presse-papiers";

type Compositeur = {
  conversationId: string;
  dossier: string;
  inserer: (texte: string) => void;
  element: () => HTMLElement | null;
  rang: number;
};

const compositeurs: Compositeur[] = [];
const enAttente = new Map<string, string>();
let horloge = 0;
let focusEcoute = false;
let copier: (texte: string) => Promise<void> | void = (texte) =>
  globalThis.navigator?.clipboard?.writeText(texte);

/** Même dossier, quelle que soit l'écriture (\\?\, barres, casse Windows, / final). */
export function memeDossier(a: string, b: string): boolean {
  const normaliser = (chemin: string) => {
    let c = chemin.trim().replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-zA-Z]:/.test(c)) c = c.toLowerCase();
    return c;
  };
  return normaliser(a) === normaliser(b);
}

function ecouterFocus(): void {
  if (focusEcoute || typeof document === "undefined") return;
  focusEcoute = true;
  document.addEventListener(
    "focusin",
    (e) => {
      const cible = e.target as Node | null;
      for (const c of compositeurs) {
        const el = c.element();
        if (el && cible && (el === cible || el.contains(cible))) c.rang = ++horloge;
      }
    },
    true,
  );
}

/** Un compositeur affiche `conversationId` dans `dossier` (retirer : la fonction rendue). */
export function brancherCompositeur(
  conversationId: string,
  dossier: string,
  moyens: { inserer: (texte: string) => void; element: () => HTMLElement | null },
): () => void {
  ecouterFocus();
  const c: Compositeur = { conversationId, dossier, ...moyens, rang: ++horloge };
  compositeurs.push(c);
  const texte = enAttente.get(conversationId);
  if (texte !== undefined) {
    enAttente.delete(conversationId);
    // Après le rendu : le compositeur vient de charger le brouillon de la conversation.
    setTimeout(() => livrer(c, texte), 0);
  }
  return () => {
    const i = compositeurs.indexOf(c);
    if (i >= 0) compositeurs.splice(i, 1);
  };
}

export function brancherPressePapiers(f: (texte: string) => Promise<void> | void): void {
  copier = f;
}

function livrer(c: Compositeur, texte: string): void {
  const el = c.element();
  // À la fin de ce qui est déjà écrit, jamais au milieu d'une phrase.
  const zone = el as HTMLTextAreaElement | null;
  if (zone && typeof zone.setSelectionRange === "function" && typeof zone.value === "string") {
    zone.setSelectionRange(zone.value.length, zone.value.length);
  }
  c.inserer(texte);
  // Sans faire défiler les colonnes : la saisie est toujours visible en bas.
  el?.focus({ preventScroll: true });
}

function notifier(titre: string, texte: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("ide-notification", { detail: { genre: "info", titre, texte } }),
  );
}

/**
 * Met `texte` dans la saisie de la conversation affichée (dans `dossier` s'il est donné).
 * Aucune conversation affichée : le texte est copié dans le presse-papiers.
 */
export function envoyerALAgent(texte: string, dossier?: string): Livraison {
  const propre = texte.trim();
  if (!propre) return "saisie";
  const candidats = compositeurs.filter((c) => !dossier || memeDossier(c.dossier, dossier));
  const cible = candidats.reduce<Compositeur | null>(
    (meilleur, c) => (!meilleur || c.rang > meilleur.rang ? c : meilleur),
    null,
  );
  if (cible) {
    livrer(cible, propre);
    return "saisie";
  }
  try {
    void Promise.resolve(copier(propre)).catch(() => undefined);
  } catch {
    /* presse-papiers indisponible */
  }
  notifier("Texte copié", "Aucune conversation ouverte ici : le texte est dans le presse-papiers.");
  return "presse-papiers";
}

/** Texte pour une conversation précise : saisie si elle est affichée, sinon à son affichage. */
export function deposerPourConversation(conversationId: string, texte: string): Livraison {
  const propre = texte.trim();
  const c = compositeurs.filter((x) => x.conversationId === conversationId).pop();
  if (c) {
    livrer(c, propre);
    return "saisie";
  }
  enAttente.set(conversationId, propre);
  return "en-attente";
}

export const EVENEMENT_OUVRIR_DOSSIER = "axecode:ouvrir-dossier-conversation";

/** Ouvre `dossier` sur `conversationId` (App) avec `texte` prêt dans sa saisie. */
export function ouvrirDossierAvecTexte(dossier: string, conversationId: string, texte: string): void {
  deposerPourConversation(conversationId, texte);
  window.dispatchEvent(
    new CustomEvent(EVENEMENT_OUVRIR_DOSSIER, { detail: { dossier, conversationId } }),
  );
}

/** App : ouvre le dossier demandé (retirer : la fonction rendue). */
export function ecouterOuvertureDossier(
  ouvrir: (dossier: string, conversationId: string) => void,
): () => void {
  const f = (e: Event) => {
    const d = (e as CustomEvent<{ dossier?: string; conversationId?: string }>).detail;
    if (d?.dossier && d.conversationId) ouvrir(d.dossier, d.conversationId);
  };
  window.addEventListener(EVENEMENT_OUVRIR_DOSSIER, f);
  return () => window.removeEventListener(EVENEMENT_OUVRIR_DOSSIER, f);
}

/** Pour les tests. */
export function reinitialiser(): void {
  compositeurs.length = 0;
  enAttente.clear();
  horloge = 0;
}
