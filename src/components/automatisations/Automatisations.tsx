// automatisations — montage global : raccourci Ctrl+Maj+L, événement d'ouverture
// (`ide-ouvrir-automatisations`, pour la palette et la vue Agents) et l'écran lui-même.
// Monté par App.tsx sur l'accueil et dans un dossier.
import { useEffect, useState } from "react";
import { fournirActions, infoBulle } from "../../axe/raccourcis";
import { OUVRIR_AUTOMATISATIONS } from "./automatisationsApi";
import { EcranAutomatisations } from "./EcranAutomatisations";

export function AutomatisationsGlobal({ dossierCourant }: { dossierCourant?: string }) {
  const [ouvert, setOuvert] = useState(false);
  useEffect(() => fournirActions({ automatisations: () => setOuvert((o) => !o) }), []);
  useEffect(() => {
    const ouvrir = () => setOuvert(true);
    window.addEventListener(OUVRIR_AUTOMATISATIONS, ouvrir);
    return () => window.removeEventListener(OUVRIR_AUTOMATISATIONS, ouvrir);
  }, []);
  return ouvert ? <EcranAutomatisations dossierCourant={dossierCourant} onFermer={() => setOuvert(false)} /> : null;
}

/** Bouton d'entrée (vue Agents) : ouvre l'écran des automatisations. */
export function BoutonAutomatisations() {
  return (
    <button
      type="button"
      className="auto-entree"
      title={infoBulle("Automatisations : prompts planifiés", "automatisations")}
      onClick={() => window.dispatchEvent(new CustomEvent(OUVRIR_AUTOMATISATIONS))}
    >
      Automatisations planifiées
    </button>
  );
}

