// Réglages > Éditeur : sauvegarde automatique, retour à la ligne, minimap.
// Le réglage vaut pour toutes les colonnes d'éditeur, tout de suite.

import { useEffect, useState } from "react";
import { formaterTexte } from "../../lib/plateforme";
import {
  changerReglagesEditeur,
  ecouterReglagesEditeur,
  lireReglagesEditeur,
  type SauvegardeAuto,
} from "./reglagesEditeur";
import "./editeur.css";

const EXPLICATIONS: Record<SauvegardeAuto, string> = {
  desactivee: "Ctrl + S enregistre le fichier.",
  delai: "Enregistré 1 s après la dernière frappe, et quand vous quittez l'onglet.",
  quitter: "Enregistré quand vous changez d'onglet, cliquez ailleurs ou fermez l'onglet.",
};

export function ReglagesEditeurSection() {
  const [reglages, setReglages] = useState(lireReglagesEditeur);
  useEffect(() => ecouterReglagesEditeur(setReglages), []);
  return (
    <div className="axe-appearance axe-editeur-reglages" data-reglages="editeur">
      <header>
        <h2 title="Éditeur">Éditeur</h2>
      </header>
      <section className="axe-appearance__block">
        <h3 title="Sauvegarde automatique">Sauvegarde automatique</h3>
        <select
          aria-label="Sauvegarde automatique"
          data-reglage="sauvegarde-auto"
          value={reglages.sauvegardeAuto}
          onChange={(e) => changerReglagesEditeur({ sauvegardeAuto: e.target.value as SauvegardeAuto })}
        >
          <option value="desactivee">Désactivée</option>
          <option value="delai">Après 1 s</option>
          <option value="quitter">En quittant l'onglet</option>
        </select>
        <span className="axe-appearance__hint" data-explication={reglages.sauvegardeAuto}>
          {formaterTexte(EXPLICATIONS[reglages.sauvegardeAuto])}
        </span>
      </section>
      <section className="axe-appearance__block">
        <h3 title="Affichage du texte">Affichage du texte</h3>
        <label className="axe-editeur-reglages__case">
          <input
            type="checkbox"
            data-reglage="retour-ligne"
            checked={reglages.retourLigne}
            onChange={(e) => changerReglagesEditeur({ retourLigne: e.target.checked })}
          />
          <span title="Retour à la ligne">Retour à la ligne</span>
        </label>
        <label className="axe-editeur-reglages__case">
          <input
            type="checkbox"
            data-reglage="minimap"
            checked={reglages.minimap}
            onChange={(e) => changerReglagesEditeur({ minimap: e.target.checked })}
          />
          <span title="Minimap">Minimap</span>
        </label>
      </section>
    </div>
  );
}
