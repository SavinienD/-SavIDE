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
};

export const REGLAGES_VOIX_DEFAUT: ReglagesVoix = {
  nettoyer: false,
  vocabulaire: "",
  repliOpenai: true,
  rapide: false,
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
