// axe:stop-force — Stop ne reste jamais sans effet.
//
// Le démon abandonne un tour qui ignore Stop au bout de 8 s
// (DaemonConfig.stop_grace) et tue son noyau. Si la conversation est encore
// « en cours » 10 s après Stop (ancien moteur, connexion perdue, tour
// fantôme), le bouton affiche « Arrêt forcé… » et l'arrêt est renvoyé ; un
// clic sur « Arrêt forcé… » libère la conversation tout de suite.

export const ARRET_FORCE_APRES_MS = 10_000;
export const LIBELLE_STOP = "Arrêter";
export const LIBELLE_ARRET_FORCE = "Arrêt forcé…";

export type DemandeArret = {
  /** Date.now() du premier Stop de ce tour. */
  demandeeA: number;
  /** « Arrêt forcé… » affiché et arrêt renvoyé. */
  forcee: boolean;
};

export type DemandesArret = ReadonlyMap<string, DemandeArret>;

/** Stop : la demande garde l'heure du premier clic. */
export function demander(demandes: DemandesArret, id: string, maintenant: number): DemandesArret {
  if (demandes.has(id)) return demandes;
  const suivant = new Map(demandes);
  suivant.set(id, { demandeeA: maintenant, forcee: false });
  return suivant;
}

/** Passe la demande en « Arrêt forcé… » (une seule fois). */
export function forcer(demandes: DemandesArret, id: string): DemandesArret {
  const demande = demandes.get(id);
  if (!demande || demande.forcee) return demandes;
  const suivant = new Map(demandes);
  suivant.set(id, { ...demande, forcee: true });
  return suivant;
}

export function clore(demandes: DemandesArret, id: string): DemandesArret {
  if (!demandes.has(id)) return demandes;
  const suivant = new Map(demandes);
  suivant.delete(id);
  return suivant;
}

/** Délai (ms) avant « Arrêt forcé… » ; null s'il n'y a rien à forcer. */
export function delaiAvantForcage(demande: DemandeArret | undefined, maintenant: number): number | null {
  if (!demande || demande.forcee) return null;
  return Math.max(0, demande.demandeeA + ARRET_FORCE_APRES_MS - maintenant);
}

/** Un clic sur « Arrêt forcé… » libère la conversation au lieu d'attendre encore. */
export function libereAuClic(demande: DemandeArret | undefined): boolean {
  return demande?.forcee === true;
}

/** Après ces événements le tour arrêté n'est plus affiché « en cours »
 *  (voir stream.ts), ou un nouveau tour a commencé. */
export function clotLaDemande(type: string): boolean {
  return type === "turn_finished" || type === "interrupted" || type === "error" || type === "turn_started";
}

export function libelleStop(forcee: boolean): string {
  return forcee ? LIBELLE_ARRET_FORCE : LIBELLE_STOP;
}
