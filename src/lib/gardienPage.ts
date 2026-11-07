// écran noir après une longue utilisation : rattrapage de la page.
// Côté Rust (gardien_page.rs), WebView2 signale la mort du rendu ou une page figée : la page est
// rechargée. Ici : (1) l'écran ouvert est noté (dossier, conversation libre, espace cloud,
// conversation active) pour être rouvert au rechargement ; (2) un battement régulier dit au
// gardien que la page répond, avec la mémoire JS (notée dans page.log) ; (3) les erreurs JS non
// rattrapées sont journalisées (page.log) pour comprendre une panne après coup.

export type Ecran =
  | { kind: "accueil" }
  | { kind: "dossier"; chemin: string; conversationId?: string }
  | { kind: "libre"; conversationId?: string }
  | { kind: "cloud"; dossier?: string; conversationId?: string };

type Stockage = Pick<Storage, "getItem" | "setItem">;
type Cible = {
  addEventListener: (type: string, f: (e: any) => void) => void;
  removeEventListener: (type: string, f: (e: any) => void) => void;
};

const CLE = "savide.reprise-page";
/** Un écran noté il y a plus longtemps n'est plus rouvert (appli relancée le lendemain…). */
export const VALIDITE_MS = 12 * 3_600_000;
export const BATTEMENT_MS = 10_000;
export const MAX_ERREURS_JOURNAL = 20;

const cle = (fenetre: string) => `${CLE}:${fenetre}`;

export function noterEcran(stockage: Stockage, fenetre: string, ecran: Ecran, maintenant = Date.now()): void {
  try {
    stockage.setItem(cle(fenetre), JSON.stringify({ ecran, atMs: maintenant }));
  } catch {
    /* stockage plein ou coupé : pas de reprise, rien de plus */
  }
}

/** La conversation active change : elle sera rouverte avec l'écran (sauf sur l'accueil). */
export function noterConversation(stockage: Stockage, fenetre: string, conversationId: string, maintenant = Date.now()): void {
  const lu = lire(stockage, fenetre);
  if (!lu || lu.ecran.kind === "accueil") return;
  noterEcran(stockage, fenetre, { ...lu.ecran, conversationId }, maintenant);
}

function lire(stockage: Stockage, fenetre: string): { ecran: Ecran; atMs: number } | null {
  try {
    const brut = stockage.getItem(cle(fenetre));
    if (!brut) return null;
    const v = JSON.parse(brut);
    if (!v || typeof v.atMs !== "number" || !v.ecran || typeof v.ecran.kind !== "string") return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Écran à rouvrir au démarrage de l'interface : seulement après un rechargement (celui du
 * gardien, ou F5), jamais à une ouverture normale de l'appli, et jamais un écran trop ancien.
 */
export function ecranARouvrir(
  stockage: Stockage,
  fenetre: string,
  o: { repriseDemandee: boolean; rechargement: boolean; maintenant?: number },
): Ecran | null {
  if (!o.repriseDemandee && !o.rechargement) return null;
  const lu = lire(stockage, fenetre);
  if (!lu || lu.ecran.kind === "accueil") return null;
  if ((o.maintenant ?? Date.now()) - lu.atMs > VALIDITE_MS) return null;
  return lu.ecran;
}

/** Vrai quand la page vient d'être rechargée (F5, ou Reload() du gardien). */
export function estUnRechargement(perf: { getEntriesByType?: (t: string) => any[] } | undefined): boolean {
  try {
    return perf?.getEntriesByType?.("navigation")?.[0]?.type === "reload";
  } catch {
    return false;
  }
}

export type Mesure = { tasMo: number | null; noeuds: number | null };

/** Mémoire de la page (Chromium / WebView2 : performance.memory). */
export function mesurer(perf: any, doc: { getElementsByTagName?: (t: string) => { length: number } } | undefined): Mesure {
  const tas = perf?.memory?.usedJSHeapSize;
  return {
    tasMo: typeof tas === "number" ? Math.round(tas / 1048576) : null,
    noeuds: doc?.getElementsByTagName ? doc.getElementsByTagName("*").length : null,
  };
}

/**
 * Battement : tout de suite, puis toutes les BATTEMENT_MS, et au retour de la fenêtre au
 * premier plan (les minuteries d'une fenêtre cachée sont ralenties). Rend la fonction d'arrêt.
 */
export function demarrerBattement(o: {
  envoyer: () => void;
  minuterie?: { setInterval: (f: () => void, ms: number) => number; clearInterval: (id: number) => void };
  document?: Cible & { visibilityState?: string };
  fenetre?: Cible;
}): () => void {
  const minuterie = o.minuterie ?? { setInterval: (f, ms) => window.setInterval(f, ms), clearInterval: (id) => window.clearInterval(id) };
  const visible = () => {
    if (!o.document || o.document.visibilityState !== "hidden") o.envoyer();
  };
  o.envoyer();
  const id = minuterie.setInterval(o.envoyer, BATTEMENT_MS);
  o.document?.addEventListener("visibilitychange", visible);
  o.fenetre?.addEventListener("focus", visible);
  return () => {
    minuterie.clearInterval(id);
    o.document?.removeEventListener("visibilitychange", visible);
    o.fenetre?.removeEventListener("focus", visible);
  };
}

/** Erreurs JS non rattrapées -> journal (au plus MAX_ERREURS_JOURNAL par page). */
export function journaliserErreurs(fenetre: Cible, journal: (texte: string) => void): () => void {
  let n = 0;
  const ecrire = (texte: string) => {
    if (n >= MAX_ERREURS_JOURNAL) return;
    n += 1;
    journal(texte.slice(0, 1500));
  };
  const erreur = (e: any) => ecrire(`erreur JS : ${e?.message ?? e?.error ?? "?"}${e?.filename ? ` (${e.filename}:${e.lineno ?? "?"})` : ""}`);
  const rejet = (e: any) => ecrire(`promesse rejetée : ${String(e?.reason?.stack ?? e?.reason ?? "?")}`);
  fenetre.addEventListener("error", erreur);
  fenetre.addEventListener("unhandledrejection", rejet);
  return () => {
    fenetre.removeEventListener("error", erreur);
    fenetre.removeEventListener("unhandledrejection", rejet);
  };
}
