// Monté une fois par fenêtre (App.tsx) : suit les fins de tour dans les
// événements du service et les signale au centre, ouvre la conversation d'une notification
// cliquée, et fournit l'ouvreur de secours (écran d'accueil : aucun espace affiché).
import { useEffect, useRef } from "react";
import { agentsApi } from "../agents/agentsApi";
import { LOCAL_CONNECTION } from "../settings/connectionsApi";
import { notificationsApi } from "./notificationsApi";
import { appliquer, nouveauSuivi, semer, type ActionSuivi } from "./suivi";
import { cheminPoste, cibleDe, fournirOuvreur, ouvrirCible } from "./ouvrir";

type Secours = {
  /** Ouvre un dossier du poste sur une conversation. */
  ouvrirDossier: (chemin: string, sessionId?: string) => void;
  /** Ouvre une conversation sans dossier. */
  ouvrirLibre: (sessionId: string) => void;
};

function executer(actions: ActionSuivi[]) {
  for (const action of actions) {
    if (action.type === "effacer") void notificationsApi.effacerEtat(action.sessionId).catch(() => undefined);
    else void notificationsApi.signaler(action.signalement).catch(() => undefined);
  }
}

export function useServiceNotifications(secours: Secours): void {
  const ref = useRef(secours);
  ref.current = secours;
  useEffect(() => {
    let fini = false;
    const suivi = nouveauSuivi();
    void agentsApi
      .list(LOCAL_CONNECTION)
      .then((sessions) => {
        if (!fini) semer(suivi, sessions);
      })
      .catch(() => undefined);
    const arrets = [
      agentsApi.onEvent((ev) => executer(appliquer(suivi, ev, Date.now()))),
      notificationsApi.surOuvrir((ev) => void ouvrirCible(cibleDe(ev))),
    ];
    const retirer = fournirOuvreur((cible) => {
      if (cible.connexion && cible.connexion !== LOCAL_CONNECTION) return false;
      if (cible.libre) ref.current.ouvrirLibre(cible.sessionId);
      else if (cible.dossier) ref.current.ouvrirDossier(cheminPoste(cible.dossier), cible.sousAgent ? undefined : cible.sessionId);
      else return false;
      return true;
    }, 0);
    return () => {
      fini = true;
      retirer();
      for (const arret of arrets) void arret.then((f) => f()).catch(() => undefined);
    };
  }, []);
}
