// Entrées « Fermer tous les fichiers » et « Rouvrir l'onglet fermé » du menu
// (clic droit) d'un onglet de fichier, avec leur raccourci (registre src/axe/raccourcis.ts).

import { combinaisonAffichee, RACCOURCIS, type RaccourciId } from "../../axe/raccourcis";

const STYLE_ENTREE = {
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
  textAlign: "left" as const,
  padding: "5px 10px",
  background: "transparent",
  border: 0,
  color: "inherit",
  font: "inherit",
  fontSize: 12,
};

function raccourci(id: RaccourciId): string {
  const r = RACCOURCIS.find((x) => x.id === id);
  return r ? combinaisonAffichee(r) : "";
}

type Props = {
  onFermerTous: () => void;
  onRouvrir: () => void;
  peutRouvrir: boolean;
  /** Ferme le menu. */
  fermer: () => void;
};

export function EntreesMenuOnglet({ onFermerTous, onRouvrir, peutRouvrir, fermer }: Props) {
  const entrees = [
    { action: "fermer-tous", libelle: "Fermer tous les fichiers", id: "fermerTousFichiers" as const, actif: true, faire: onFermerTous },
    { action: "rouvrir", libelle: "Rouvrir l'onglet fermé", id: "rouvrirOnglet" as const, actif: peutRouvrir, faire: onRouvrir },
  ];
  return (
    <>
      <div role="separator" style={{ height: 1, margin: "4px 6px", background: "var(--line, #444)" }} />
      {entrees.map((e) => (
        <button
          key={e.action}
          type="button"
          role="menuitem"
          data-action={e.action}
          disabled={!e.actif}
          style={{ ...STYLE_ENTREE, opacity: e.actif ? 1 : 0.4, cursor: e.actif ? "pointer" : "default" }}
          onClick={() => {
            e.faire();
            fermer();
          }}
        >
          <span>{e.libelle}</span>
          <span style={{ color: "var(--text-3)", whiteSpace: "nowrap" }}>{raccourci(e.id)}</span>
        </button>
      ))}
    </>
  );
}
