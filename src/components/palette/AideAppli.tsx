// Réglages > À propos : « Aide » (dossier des journaux ; sous Windows,
// relancer l'application en administrateur). Sous macOS et Linux, le menu natif Aide le propose aussi.
import { useState } from "react";
import { Icon } from "@iconify/react";
import { estWindows } from "../../lib/plateforme";
import { ouvrirDossierJournaux, relancerAdministrateur } from "./ouvrirAvec";
import "./palette.css";

export function AideAppli() {
  const [message, setMessage] = useState<string | null>(null);
  const essayer = (action: () => Promise<unknown>, reussite?: (r: unknown) => string) => {
    setMessage(null);
    action()
      .then((r) => setMessage(reussite ? reussite(r) : null))
      .catch((e) => setMessage(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="aide-appli" aria-label="Aide">
      <h2 className="aide-appli__titre">Aide</h2>
      <div className="aide-appli__actions">
        <button
          type="button"
          className="settings-pane__btn"
          data-action="ouvrir-journaux"
          title="Ouvrir le dossier des journaux (daemon.log) dans l'explorateur de fichiers"
          onClick={() => essayer(ouvrirDossierJournaux, (d) => `Journaux\u00a0: ${String(d)}`)}
        >
          <Icon icon="solar:document-text-linear" width={13} height={13} />
          <span>Ouvrir le dossier des journaux</span>
        </button>
        {estWindows() ? (
          <button
            type="button"
            className="settings-pane__btn"
            data-action="relancer-admin"
            title="Relancer SavIDE avec les droits d'administrateur (Windows demande la confirmation)"
            onClick={() => essayer(relancerAdministrateur)}
          >
            <Icon icon="solar:shield-up-linear" width={13} height={13} />
            <span>Relancer en administrateur</span>
          </button>
        ) : null}
      </div>
      {message ? (
        <p className="aide-appli__message" role="status" title={message}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
