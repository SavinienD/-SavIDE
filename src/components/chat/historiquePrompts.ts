// axe:hist169 - historique des prompts (fleche HAUT/BAS comme un terminal).
const CLE_GLOBALE = "axe:historique-prompts";
const cleConv = (id: string) => `axe:historique-prompts:${id}`;
const MAX = 200;

function lire(cle: string): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(cle) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function ecrire(cle: string, liste: string[]) {
  try {
    window.localStorage.setItem(cle, JSON.stringify(liste.slice(-MAX)));
  } catch {
    /* stockage plein : ignore */
  }
}

/** Memorise un prompt envoye (conversation + global, sans doublon consecutif). */
export function memoriserPrompt(conversationId: string, texte: string) {
  const t = texte.trim();
  if (!t) return;
  for (const cle of [cleConv(conversationId), CLE_GLOBALE]) {
    const l = lire(cle);
    if (l[l.length - 1] !== t) l.push(t);
    ecrire(cle, l);
  }
}

/** Global (absents de la conversation) puis conversation ; plus anciens d'abord. */
export function historiquePrompts(conversationId: string): string[] {
  const conv = lire(cleConv(conversationId));
  const vus = new Set(conv);
  return [...lire(CLE_GLOBALE).filter((x) => !vus.has(x)), ...conv];
}

export type EtatHistorique = { index: number | null; brouillon: string };

/** Nouveau texte + etat, ou null si la touche ne doit pas etre prise. */
export function naviguer(
  sens: "haut" | "bas",
  texte: string,
  curseur: number,
  liste: string[],
  etat: EtatHistorique,
): { texte: string; etat: EtatHistorique } | null {
  const surPremiere = !texte.slice(0, curseur).includes("\n");
  const surDerniere = !texte.slice(curseur).includes("\n");
  if (texte !== "" && (sens === "haut" ? !surPremiere : !surDerniere)) return null;
  if (sens === "haut") {
    if (liste.length === 0) return null;
    const brouillon = etat.index === null ? texte : etat.brouillon;
    const index = etat.index === null ? liste.length - 1 : Math.max(0, etat.index - 1);
    return { texte: liste[index], etat: { index, brouillon } };
  }
  if (etat.index === null) return null;
  const index = etat.index + 1;
  if (index >= liste.length) return { texte: etat.brouillon, etat: { index: null, brouillon: "" } };
  return { texte: liste[index], etat: { index, brouillon: etat.brouillon } };
}
