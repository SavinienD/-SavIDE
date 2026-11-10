// 0.1.75 — dictée en direct (moyens gratuits : Whisper local de la VM ou du poste).
// Pendant qu'on parle, l'audio est découpé en morceaux de 6 à 10 s (de préférence sur un
// court silence), transcrits au fil de l'eau : texte provisoire grisé, remplacé à la fin
// par la transcription de tout l'enregistrement (puis, en option, le nettoyage par l'IA
// de la conversation). Module pur : testé par tests/voixDirect.test.cjs.

export type TailleWhisper = "petit" | "moyen" | "grand";
export type ReglageTaille = "auto" | TailleWhisper;

/** Fréquence envoyée à Whisper (son format natif). */
export const FREQUENCE = 16_000;
/**
 * Morceau visé : coupé sur un silence entre 6 s et 10 s. Whisper encode au moins 768 trames
 * (≈ 10 s de voix) quelle que soit la durée : un morceau de 4 s coûte autant qu'un de 10 s.
 * Mesuré (10/11/2026, voix réelle, phrases de 4 à 5 s) : avec 4-8 s la phrase était coupée
 * vers 4 s et la fin attendait deux encodages (4,0 à 5,1 s) ; avec 6-10 s, un seul (2,4 à 2,6 s).
 */
export const MORCEAU_MIN_MS = 6_000;
export const MORCEAU_MAX_MS = 10_000;
export const SILENCE_MS = 250;
/**
 * Pause de fin de phrase : au-delà de 1,2 s de voix, un silence de 0,5 s coupe aussi. Le
 * morceau part pendant que l'on va cliquer sur Terminer, et la fin n'a plus rien à
 * transcrire. Mesuré : fin de dictée 2,2-2,4 s -> 1,6-1,7 s, même taux d'erreur.
 */
export const PAUSE_FIN_MS = 500;
export const PAUSE_FIN_MIN_MS = 1_200;
/** Au-delà de 2× le temps réel, le modèle « moyen » ne suit plus : on passe au « petit ». */
export const SEUIL_TEMPS_REEL = 2;
/** La mesure automatique est refaite au bout d'un jour (charge de la machine variable). */
export const VALIDITE_MESURE_MS = 24 * 3600 * 1000;

export function doitCouper(attenteMs: number, silenceMs: number): boolean {
  if (attenteMs >= MORCEAU_MAX_MS) return true;
  if (attenteMs >= PAUSE_FIN_MIN_MS && silenceMs >= PAUSE_FIN_MS) return true;
  return attenteMs >= MORCEAU_MIN_MS && silenceMs >= SILENCE_MS;
}

/** Rééchantillonnage linéaire (48 kHz du micro -> 16 kHz). */
export function reechantillonner(entree: Float32Array, de: number, vers = FREQUENCE): Float32Array {
  if (de === vers || entree.length === 0) return entree;
  const rapport = de / vers;
  const n = Math.floor(entree.length / rapport);
  const sortie = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = i * rapport;
    const a = Math.floor(x);
    const b = Math.min(a + 1, entree.length - 1);
    sortie[i] = entree[a] + (entree[b] - entree[a]) * (x - a);
  }
  return sortie;
}

/** WAV PCM 16 bits mono. */
export function pcmVersWav(echantillons: Float32Array, frequence = FREQUENCE): Uint8Array {
  const octets = new Uint8Array(44 + echantillons.length * 2);
  const v = new DataView(octets.buffer);
  const ecrire = (pos: number, texte: string) => { for (let i = 0; i < texte.length; i += 1) octets[pos + i] = texte.charCodeAt(i); };
  ecrire(0, "RIFF"); v.setUint32(4, 36 + echantillons.length * 2, true); ecrire(8, "WAVE");
  ecrire(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, frequence, true); v.setUint32(28, frequence * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ecrire(36, "data"); v.setUint32(40, echantillons.length * 2, true);
  for (let i = 0; i < echantillons.length; i += 1) {
    const s = Math.max(-1, Math.min(1, echantillons[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return octets;
}

export function octetsEnBase64(octets: Uint8Array): string {
  let binaire = "";
  for (let i = 0; i < octets.length; i += 0x8000) binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(binaire);
}

/** Mesure mémorisée sur le poste : facteur temps réel du modèle « moyen ». */
export type MesureTaille = { taille: "moyen" | "petit"; facteur: number; echantillons: number; le: number };

/** Taille à demander : le réglage, ou en « auto » le « moyen » sauf s'il a été mesuré trop lent. */
export function choisirTaille(reglage: ReglageTaille, mesure: MesureTaille | null, maintenant = Date.now()): TailleWhisper {
  if (reglage !== "auto") return reglage;
  if (!mesure || maintenant - mesure.le > VALIDITE_MESURE_MS) return "moyen";
  return mesure.taille;
}

/**
 * Note la durée d'un morceau transcrit par le modèle « moyen » (moyenne glissante du
 * facteur temps réel). Au-delà de 2× le temps réel (dès 2 morceaux, ou d’emblée à 3×),
 * le « petit » est retenu. Une mesure d'un autre modèle ne change rien.
 */
export function noterMesure(
  mesure: MesureTaille | null,
  taille: string | null | undefined,
  audioMs: number,
  transcriptionMs: number,
  maintenant = Date.now(),
): MesureTaille | null {
  if (taille !== "moyen" || audioMs < 500 || !(transcriptionMs > 0)) return mesure;
  const facteur = transcriptionMs / audioMs;
  const avant = mesure && mesure.taille === "moyen" && maintenant - mesure.le <= VALIDITE_MESURE_MS ? mesure : null;
  const n = (avant?.echantillons ?? 0) + 1;
  const moyenne = avant ? (avant.facteur * avant.echantillons + facteur) / n : facteur;
  const tropLent = (n >= 2 && moyenne > SEUIL_TEMPS_REEL) || facteur > SEUIL_TEMPS_REEL * 1.5;
  return { taille: tropLent ? "petit" : "moyen", facteur: Math.round(moyenne * 100) / 100, echantillons: n, le: maintenant };
}

/** Texte provisoire : morceaux recollés, espaces normalisées. */
export function assemblerProvisoire(morceaux: string[]): string {
  return morceaux.map((m) => m.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

/** L'aperçu en direct ne suit plus (même en « petit ») : on l'arrête au lieu d'empiler. */
export function apercuTropLent(facteurs: number[]): boolean {
  const derniers = facteurs.slice(-2);
  return derniers.length === 2 && derniers.every((f) => f > SEUIL_TEMPS_REEL * 1.5);
}

/** Son de la fin plus court que ça : rien à transcrire. */
export const RESTE_MIN_MS = 200;

/**
 * Fin de dictée : avec un aperçu en direct sain (PCM découpé sur les silences, aucun morceau
 * en erreur), le texte des morceaux est gardé et seule la fin pas encore envoyée est
 * transcrite, au lieu de retranscrire tout l'enregistrement (fenêtre Whisper de 30 s,
 * ≈ 10 s sur la VM même pour une phrase). Sinon (segments webm coupés toutes les 3 s,
 * morceau raté, aperçu arrêté), transcription complète comme avant.
 */
export function finParMorceaux(etat: { actif: boolean; pcm: boolean; segments: boolean; erreurs: number }): boolean {
  return etat.actif && etat.pcm && !etat.segments && etat.erreurs === 0;
}

const CLE_MESURE = "axe.voix.mesureTaille";

export function lireMesure(): MesureTaille | null {
  try {
    const brut = window.localStorage.getItem(CLE_MESURE);
    const m = brut ? (JSON.parse(brut) as MesureTaille) : null;
    return m && (m.taille === "moyen" || m.taille === "petit") && typeof m.le === "number" ? m : null;
  } catch {
    return null;
  }
}

export function ecrireMesure(mesure: MesureTaille | null): void {
  try {
    if (mesure) window.localStorage.setItem(CLE_MESURE, JSON.stringify(mesure));
  } catch {
    /* stockage indisponible : mesure refaite la prochaine fois */
  }
}
