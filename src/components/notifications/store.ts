// État du centre des notifications partagé par les composants d'une fenêtre
// (vue « Tableau », cloche, Réglages) : lu une fois, puis tenu à jour par l'événement du centre.
import { useSyncExternalStore } from "react";
import { ETAT_VIDE, notificationsApi, type EtatCentre } from "./notificationsApi";

let courant: EtatCentre = ETAT_VIDE;
const abonnes = new Set<() => void>();
let demarre = false;

function publier(etat: EtatCentre) {
  courant = etat;
  for (const f of abonnes) f();
}

function demarrer() {
  if (demarre) return;
  demarre = true;
  void notificationsApi.lister().then(publier).catch(() => undefined);
  void notificationsApi.surEtat(publier).catch(() => undefined);
}

function abonner(f: () => void) {
  demarrer();
  abonnes.add(f);
  return () => {
    abonnes.delete(f);
  };
}

export function useCentreNotifications(): EtatCentre {
  return useSyncExternalStore(abonner, () => courant, () => courant);
}

/** Relit l'état (après une action dont le centre ne renvoie rien). */
export function relireCentre(): void {
  void notificationsApi.lister().then(publier).catch(() => undefined);
}
