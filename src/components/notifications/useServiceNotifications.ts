// Monté une fois par fenêtre (App.tsx) : suit les fins de tour dans les
// événements du service et les signale au centre (qui décide de la notification du système),
// joue le son court quand le centre le demande, écoute le contrat commun « ide-notification »
// des autres écrans (contrat.ts), ouvre la conversation d'une notification
// cliquée, et fournit l'ouvreur de secours (écran d'accueil : aucun espace affiché).
import { useEffect, useRef } from "react";
import { agentsApi } from "../agents/agentsApi";
import { LOCAL_CONNECTION } from "../settings/connectionsApi";
import { notificationsApi, type DecisionNotif, type SignalementNotif } from "./notificationsApi";
import { appliquer, nouveauSuivi, semer, type ActionSuivi } from "./suivi";
import { cheminPoste, cibleDe, fournirOuvreur, ouvrirCible } from "./ouvrir";
import { armerSon, jouerSon } from "./son";
import { ecouterIdeNotifications } from "./contrat";

type Secours = {
  /** Ouvre un dossier du poste sur une conversation. */
  ouvrirDossier: (chemin: string, sessionId?: string) => void;
  /** Ouvre une conversation sans dossier. */
  ouvrirLibre: (sessionId: string) => void;
};

type Dependances = {
  signaler: (s: SignalementNotif) => Promise<DecisionNotif | null>;
  effacer: (sessionId: string) => Promise<unknown>;
  jouer: (genre: string) => void;
};

/** Exécute les actions du suivi ; seule la fenêtre dont l'appel est le premier (« nouveau »)
 *  reçoit `son: true` du centre et joue le son. */
export function executerActions(actions: ActionSuivi[], d: Dependances): Promise<void> {
  const travaux = actions.map(async (action) => {
    try {
      if (action.type === "effacer") await d.effacer(action.sessionId);
      else if ((await d.signaler(action.signalement))?.son) d.jouer(action.signalement.genre);
    } catch {
      /* centre indisponible (banc, démarrage) : rien à faire */
    }
  });
  return Promise.all(travaux).then(() => undefined);
}

const DEPENDANCES: Dependances = {
  signaler: notificationsApi.signaler,
  effacer: notificationsApi.effacerEtat,
  jouer: jouerSon,
};

export function useServiceNotifications(secours: Secours): void {
  const ref = useRef(secours);
  ref.current = secours;
  useEffect(() => {
    let fini = false;
    const suivi = nouveauSuivi();
    const desarmer = armerSon();
    void agentsApi
      .list(LOCAL_CONNECTION)
      .then((sessions) => {
        if (!fini) semer(suivi, sessions);
      })
      .catch(() => undefined);
    const arrets = [
      agentsApi.onEvent((ev) => void executerActions(appliquer(suivi, ev, Date.now()), DEPENDANCES)),
      notificationsApi.surOuvrir((ev) => void ouvrirCible(cibleDe(ev))),
    ];
    // Contrat commun (contrat.ts) : traité comme une fin de tour.
    const arreterContrat = ecouterIdeNotifications(window, (signalement) =>
      void executerActions([{ type: "signaler", signalement }], DEPENDANCES),
    );
    const retirer = fournirOuvreur((cible) => {
      if (cible.connexion && cible.connexion !== LOCAL_CONNECTION) return false;
      if (cible.libre) ref.current.ouvrirLibre(cible.sessionId);
      else if (cible.dossier) ref.current.ouvrirDossier(cheminPoste(cible.dossier), cible.sousAgent ? undefined : cible.sessionId);
      else return false;
      return true;
    }, 0);
    return () => {
      fini = true;
      desarmer();
      arreterContrat();
      retirer();
      for (const arret of arrets) void arret.then((f) => f()).catch(() => undefined);
    };
  }, []);
}
