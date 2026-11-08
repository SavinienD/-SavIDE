// Réglages > Navigateur : où s'ouvrent les liens du chat et du terminal.
import { useEffect, useState } from "react";
import { EVENEMENT_MODE_LIENS, MODES_LIENS, ecrireModeLiens, lireModeLiens, type ModeLiens } from "./liens";
import "./navigateur.css";

export function NavigateurReglages() {
  const [mode, setMode] = useState<ModeLiens>(() => lireModeLiens());
  useEffect(() => {
    const suivre = () => setMode(lireModeLiens());
    window.addEventListener(EVENEMENT_MODE_LIENS, suivre);
    return () => window.removeEventListener(EVENEMENT_MODE_LIENS, suivre);
  }, []);
  return (
    <div className="axe-appearance nav-reglages">
      <header>
        <h2 title="Navigateur">Navigateur</h2>
        <p className="axe-appearance__hint">
          Onglet Navigateur de l'IDE : votre appli web à côté de l'agent. Les téléchargements vont dans le dossier Téléchargements.
        </p>
      </header>
      <div className="axe-appearance__block" role="radiogroup" aria-label="Liens du chat et du terminal">
        <h3 title="Liens du chat et du terminal">Liens du chat et du terminal</h3>
        {MODES_LIENS.map((m) => (
          <label key={m.id} className="nav-reglages__choix" data-mode={m.id} title={m.detail}>
            <input
              type="radio"
              name="navigateur-liens"
              value={m.id}
              checked={mode === m.id}
              onChange={() => {
                ecrireModeLiens(m.id);
                setMode(m.id);
              }}
            />
            <span className="nav-reglages__libelle">{m.libelle}</span>
          </label>
        ))}
        <p className="axe-appearance__hint">Maj + clic sur un lien : l'autre navigateur.</p>
      </div>
    </div>
  );
}
