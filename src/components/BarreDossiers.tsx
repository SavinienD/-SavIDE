// barre-dossiers — boutons 1 2 3… des dossiers numérotés (Ctrl+1…9), dans la barre du haut,
// à droite des boutons (juste avant Terminal / Volets ; après Réglages sans dossier). Même ordre que Ctrl+1…9 et les cartes de l'accueil
// (lib/recents.ts : figé tant qu'on ne revient pas à l'accueil). Clic = bascule vers ce
// dossier ; le dossier ouvert est marqué ; son nom s'affiche au survol.
import { useSyncExternalStore } from "react";
import { NB_NUMEROTES, deriveName, dossiersNumerotes, ecouterOrdre, versionOrdreDossiers } from "../lib/recents";
import { infoBulleNumero } from "../axe/raccourcis";
import { samePath } from "./freechat/freechatApi";
import "./barreDossiers.css";

type Props = {
  /** Dossier ouvert (marqué), absent dans la conversation sans dossier. */
  courant?: string;
  onOuvrir: (path: string) => void;
};

export function BarreDossiers({ courant, onOuvrir }: Props) {
  useSyncExternalStore(ecouterOrdre, versionOrdreDossiers);
  const dossiers = dossiersNumerotes().slice(0, NB_NUMEROTES);
  if (dossiers.length === 0) return null;
  return (
    <nav className="barre-dossiers" aria-label="Dossiers récents">
      {dossiers.map((d, i) => {
        const n = i + 1;
        const actif = Boolean(courant && samePath(courant, d.path));
        const nom = (d.name || deriveName(d.path)) + (d.epingle ? " (épinglé)" : "");
        return (
          <button
            key={d.path}
            type="button"
            className="barre-dossiers__btn"
            data-numero={n}
            data-epingle={d.epingle ? "true" : undefined}
            aria-current={actif ? "true" : undefined}
            aria-label={`Dossier ${n} : ${nom}`}
            title={infoBulleNumero(actif ? `${nom} (ouvert)` : nom, "dossierRecent", n)}
            onClick={() => {
              if (!actif) onOuvrir(d.path);
            }}
          >
            {n}
          </button>
        );
      })}
    </nav>
  );
}
