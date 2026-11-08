// Revue des changements : hôte de la vue « Changements », monté une fois dans la fenêtre d'un
// dossier (Workspace). Ouverture : Ctrl+Maj+D, bouton « Voir les changements » du
// panneau Git, ou l'événement EVENEMENT_OUVRIR. Une note prise dans l'aperçu Markdown
// (EVENEMENT_NOTER) ouvre le tiroir des notes, avec le même envoi à l'agent.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { fournirActions } from "../../axe/raccourcis";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { VueRevue, type OngletRevue } from "./VueRevue";
import { PanneauNotes, type BrouillonNote } from "./PanneauNotes";
import { EVENEMENT_NOTER, type DemandeNote } from "./NoteApercu";
import { magasinNotes } from "./notes";
import "./revue.css";

export const EVENEMENT_OUVRIR = "revue:ouvrir";

export type DemandeRevue = { dossier?: string; fichier?: string | null; onglet?: OngletRevue };

export function ouvrirRevue(demande: DemandeRevue = {}): void {
  window.dispatchEvent(new CustomEvent<DemandeRevue>(EVENEMENT_OUVRIR, { detail: demande }));
}

/** Tiroir des notes ouvert depuis l'aperçu Markdown (brouillon en tête). */
function TiroirNotes({ dossier, brouillon, onFinBrouillon, onFermer, onVoir }: {
  dossier: string;
  brouillon: BrouillonNote | null;
  onFinBrouillon: () => void;
  onFermer: () => void;
  onVoir: () => void;
}) {
  const magasin = magasinNotes();
  const notes = useSyncExternalStore(magasin.abonner, () => magasin.notes(dossier));
  const ref = useRef({ brouillon, onFinBrouillon, onFermer });
  ref.current = { brouillon, onFinBrouillon, onFermer };
  // Échap : abandonne le brouillon, puis ferme le tiroir.
  useEffect(
    () =>
      fournirActions({
        stop: () => {
          if (ref.current.brouillon) ref.current.onFinBrouillon();
          else ref.current.onFermer();
        },
      }),
    [],
  );
  return (
    <div className="revue-tiroir" role="dialog" aria-label="Notes de relecture">
      <div className="revue-tiroir__barre">
        <button type="button" className="revue-lien" onClick={onVoir}>
          Voir les changements
        </button>
        <span className="revue-espace" />
        <button type="button" className="revue-icone" onClick={onFermer} title="Fermer" aria-label="Fermer les notes">
          <Icon icon="solar:close-circle-linear" width={16} height={16} />
        </button>
      </div>
      <PanneauNotes dossier={dossier} notes={notes} brouillon={brouillon} onFinBrouillon={onFinBrouillon} />
    </div>
  );
}

export function HoteRevue({ workspacePath }: { workspacePath: string }) {
  const [demande, setDemande] = useState<DemandeRevue | null>(null);
  const [tiroir, setTiroir] = useState<{ brouillon: BrouillonNote | null } | null>(null);
  // Dossiers de ce PC seulement : un espace cloud n'a pas de dépôt local.
  const local = cloudConnectionFromPath(workspacePath) === null;

  useEffect(() => {
    const surDemande = (e: Event) => {
      const d = ((e as CustomEvent<DemandeRevue>).detail ?? {}) as DemandeRevue;
      if (!local || (d.dossier && d.dossier !== workspacePath)) return;
      setTiroir(null);
      setDemande({ ...d });
    };
    const surNote = (e: Event) => {
      const d = (e as CustomEvent<DemandeNote>).detail;
      if (!d) return;
      setTiroir({ brouillon: { fichier: d.fichier, cote: "apercu", debut: d.debut, fin: d.fin, extrait: d.extrait } });
    };
    window.addEventListener(EVENEMENT_OUVRIR, surDemande);
    window.addEventListener(EVENEMENT_NOTER, surNote);
    return () => {
      window.removeEventListener(EVENEMENT_OUVRIR, surDemande);
      window.removeEventListener(EVENEMENT_NOTER, surNote);
    };
  }, [local, workspacePath]);

  useEffect(
    () =>
      fournirActions({
        revueChangements: () => {
          if (!local) return false;
          setTiroir(null);
          setDemande((d) => (d ? null : {}));
        },
      }),
    [local],
  );

  useEffect(() => {
    setDemande(null);
    setTiroir(null);
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
  if (tiroir) {
    return createPortal(
      <TiroirNotes
        dossier={workspacePath}
        brouillon={tiroir.brouillon}
        onFinBrouillon={() => setTiroir({ brouillon: null })}
        onFermer={() => setTiroir(null)}
        onVoir={() => {
          setTiroir(null);
          setDemande({});
        }}
      />,
      document.body,
    );
  }
  return null;
}
