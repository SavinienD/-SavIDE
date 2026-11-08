// Accroche de l'espace affiché (Workspace.tsx) : dit au centre quelle
// conversation la fenêtre montre (ses événements deviennent lus quand la fenêtre a le focus)
// et fournit l'ouvreur prioritaire (conversation du dossier, autre dossier, journal).
import { useEffect, useRef } from "react";
import { LOCAL_CONNECTION } from "../settings/connectionsApi";
import { memeDossier } from "../agents/agentsStatut";
import { notificationsApi } from "./notificationsApi";
import { cheminPoste, fournirOuvreur } from "./ouvrir";

type Espace = {
  workspacePath: string;
  /** Connexion de l'espace (espace cloud) ou le poste. */
  connexion: string;
  /** Conversation (ou journal de sous-agent) affichée. */
  affichee: string | null;
  ouvrirIci: (sessionId: string) => void;
  ouvrirJournal: (sessionId: string, connexion: string, titre: string) => void;
  ouvrirDossier?: (chemin: string, sessionId?: string) => void;
  ouvrirLibre?: (sessionId: string) => void;
};

export function useNotificationsEspace(espace: Espace): void {
  const ref = useRef(espace);
  ref.current = espace;
  useEffect(() => {
    void notificationsApi.vue(espace.affichee).catch(() => undefined);
  }, [espace.affichee]);
  useEffect(() => {
    const surFocus = () => void notificationsApi.vue(ref.current.affichee).catch(() => undefined);
    window.addEventListener("focus", surFocus);
    const retirer = fournirOuvreur((cible) => {
      const e = ref.current;
      const connexion = cible.connexion || LOCAL_CONNECTION;
      const titre = cible.titre || "agent";
      if (cible.sousAgent) {
        e.ouvrirJournal(cible.sessionId, connexion, titre);
        return true;
      }
      if (connexion !== e.connexion) {
        if (connexion !== LOCAL_CONNECTION) {
          e.ouvrirJournal(cible.sessionId, connexion, titre);
          return true;
        }
      } else if (connexion !== LOCAL_CONNECTION || !cible.dossier || memeDossier(cible.dossier, e.workspacePath)) {
        e.ouvrirIci(cible.sessionId);
        return true;
      }
      if (cible.libre && e.ouvrirLibre) {
        e.ouvrirLibre(cible.sessionId);
        return true;
      }
      if (cible.dossier && e.ouvrirDossier) {
        e.ouvrirDossier(cheminPoste(cible.dossier), cible.sessionId);
        return true;
      }
      return false;
    }, 10);
    return () => {
      window.removeEventListener("focus", surFocus);
      retirer();
      void notificationsApi.vue(null).catch(() => undefined);
    };
  }, []);
}
