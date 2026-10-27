// axe:0.1.71 — la dictée n'est proposée que si un moteur de transcription répond.
// Avant, le micro s'affichait toujours : sans moteur, on obtenait « Transcription
// impossible… connexion refusée (service arrêté ou port non permis…) ; whisper small
// (VM)… » (SavIDE, Axecode sans espace). Module pur : testé par tests/voixDisponible.test.cjs.

export type MoteurVoix = { url: string; label: string; ok: boolean; error?: string | null };
export type EtatServiceVoix = { connexion: string; ok: boolean; moteurs?: MoteurVoix[] | null; erreur?: string };
export type EtatVoix = { services: EtatServiceVoix[]; openai: boolean };

export const SERVICE_LOCAL = "service local";

export type OptionsDisponibilite = {
  /** SavIDE (100 % local) : seul le service local du poste compte, ni espace ni OpenAI. */
  localSeulement?: boolean;
};

/** Un service joignable dont au moins un moteur Whisper répond (ou, hors mode local, une clé OpenAI). */
export function dicteeDisponible(etat: EtatVoix | null | undefined, options: OptionsDisponibilite = {}): boolean {
  if (!etat) return false;
  const services = (etat.services ?? []).filter((s) => !options.localSeulement || s.connexion === SERVICE_LOCAL);
  if (services.some((s) => s.ok && (s.moteurs ?? []).some((m) => m.ok))) return true;
  return !options.localSeulement && etat.openai === true;
}

export const MESSAGE_DICTEE_INDISPONIBLE =
  "Dictée vocale indisponible : aucun moteur de transcription ne répond. Le bouton micro est masqué.";

/** SavIDE : la dictée ne vise jamais le Whisper de la VM. */
export const MESSAGE_DICTEE_INDISPONIBLE_LOCAL =
  "Dictée vocale indisponible : SavIDE fonctionne 100 % en local et aucun moteur de transcription ne tourne sur ce poste. Le bouton micro est masqué ; il reviendra dès qu'un moteur local répondra.";
