// Revue des changements : hôte de la vue « Changements », monté une fois dans la fenêtre d'un
// dossier (Workspace). Ouverture : Ctrl+Maj+D, bouton « Voir les changements » du
// panneau Git, ou l'événement EVENEMENT_OUVRIR.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fournirActions } from "../../axe/raccourcis";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { VueRevue, type OngletRevue } from "./VueRevue";
import "./revue.css";

export const EVENEMENT_OUVRIR = "revue:ouvrir";

export type DemandeRevue = { dossier?: string; fichier?: string | null; onglet?: OngletRevue };

export function ouvrirRevue(demande: DemandeRevue = {}): void {
  window.dispatchEvent(new CustomEvent<DemandeRevue>(EVENEMENT_OUVRIR, { detail: demande }));
}

export function HoteRevue({ workspacePath }: { workspacePath: string }) {
  const [demande, setDemande] = useState<DemandeRevue | null>(null);
  // Dossiers de ce PC seulement : un espace cloud n'a pas de dépôt local.
  const local = cloudConnectionFromPath(workspacePath) === null;

  useEffect(() => {
    const surDemande = (e: Event) => {
      const d = ((e as CustomEvent<DemandeRevue>).detail ?? {}) as DemandeRevue;
      if (!local || (d.dossier && d.dossier !== workspacePath)) return;
      setDemande({ ...d });
    };
    window.addEventListener(EVENEMENT_OUVRIR, surDemande);
    return () => window.removeEventListener(EVENEMENT_OUVRIR, surDemande);
  }, [local, workspacePath]);

  useEffect(
    () =>
      fournirActions({
        revueChangements: () => {
          if (!local) return false;
          setDemande((d) => (d ? null : {}));
        },
      }),
    [local],
  );

  useEffect(() => {
    setDemande(null);
  }, [workspacePath]);

  if (typeof document === "undefined") return null;
  if (demande && local) {
    return createPortal(
      <VueRevue
        key={workspacePath}
        dossier={workspacePath}
        fichier={demande.fichier ?? null}
        ongletInitial={demande.onglet}
        onFermer={() => setDemande(null)}
      />,
      document.body,
    );
  }
  return null;
}
