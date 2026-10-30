/**
 * axe:voix — réglages de la dictée vocale, propres au poste (localStorage).
 * Lus à chaque dictée : un changement dans Réglages > Dictée vocale s'applique
 * tout de suite, sans recharger.
 */

export type ReglagesVoix = {
  /** « Nettoyer le texte avec l'IA » : ponctuation + termes techniques, par le modèle du chat. */
  nettoyer: boolean;
  /** Termes ajoutés à l'amorce de Whisper (noms propres, jargon du moment). */
  vocabulaire: string;
  /** Repli sur l'API OpenAI (gpt-4o-transcribe) si la VM est injoignable et qu'une clé existe. */
  repliOpenai: boolean;
  /** Dictée rapide : fenêtre Whisper réduite (≈ 3× plus rapide sur une phrase courte, moins précise). */
  rapide: boolean;
  /** axe:micro-local — modèle Whisper du poste : « base » (petit, ≈ 148 Mo), « small » (moyen, ≈ 488 Mo)
   *  ou « auto » (axe:0.1.75 : moyen s'il suit à moins de 2× le temps réel, sinon petit). */
  modeleLocal: "auto" | "base" | "small";
  /** axe:0.1.75 — transcription en direct pendant qu'on parle (texte provisoire grisé). */
  direct: boolean;
};

export const REGLAGES_VOIX_DEFAUT: ReglagesVoix = {
  nettoyer: true,
  vocabulaire: "",
  // axe:0.1.75 — moyens gratuits seulement par défaut (OpenAI est payant).
  repliOpenai: false,
  rapide: false,
  modeleLocal: "auto",
  direct: true,
};

const CLE = "axe.voix.reglages";
export const EVENEMENT_REGLAGES_VOIX = "axe:voix-reglages";

export function lireReglagesVoix(): ReglagesVoix {
  try {
    const brut = window.localStorage.getItem(CLE);
    if (!brut) return { ...REGLAGES_VOIX_DEFAUT };
    const lu = JSON.parse(brut) as Partial<ReglagesVoix>;
    return {
      nettoyer: typeof lu.nettoyer === "boolean" ? lu.nettoyer : REGLAGES_VOIX_DEFAUT.nettoyer,
      vocabulaire: typeof lu.vocabulaire === "string" ? lu.vocabulaire : "",
      repliOpenai: typeof lu.repliOpenai === "boolean" ? lu.repliOpenai : REGLAGES_VOIX_DEFAUT.repliOpenai,
      rapide: typeof lu.rapide === "boolean" ? lu.rapide : REGLAGES_VOIX_DEFAUT.rapide,
      modeleLocal: lu.modeleLocal === "small" || lu.modeleLocal === "base" ? lu.modeleLocal : "auto",
      direct: typeof lu.direct === "boolean" ? lu.direct : REGLAGES_VOIX_DEFAUT.direct,
    };
  } catch {
    return { ...REGLAGES_VOIX_DEFAUT };
  }
}

export function ecrireReglagesVoix(reglages: ReglagesVoix): void {
  try {
    window.localStorage.setItem(CLE, JSON.stringify(reglages));
  } catch {
    /* stockage plein ou interdit : réglage non conservé */
  }
  window.dispatchEvent(new CustomEvent(EVENEMENT_REGLAGES_VOIX));
}
