// Lot palette (P5) — actions proposées par Ctrl+K : ouvrir le dossier ou le fichier actif dans
// un éditeur du poste (VS Code, Cursor, Zed…), ouvrir le dossier des journaux, et sous Windows
// relancer l'application en administrateur.
import { estWindows } from "../../lib/plateforme";
import {
  ouvrirDansEditeur,
  ouvrirDossierJournaux,
  positionCurseur,
  relancerAdministrateur,
  type Editeur,
} from "./ouvrirAvec";
import type { Source } from "./sourcesAller";

export type Action = { source: Source; faire: () => unknown };

/** Échec d'une action : signalé par le contrat commun « ide-notification » (affiché par l'IDE). */
export function signalerEchec(titre: string): (err: unknown) => void {
  return (err) =>
    window.dispatchEvent(
      new CustomEvent("ide-notification", {
        detail: { genre: "echec", titre, texte: err instanceof Error ? err.message : String(err) },
      }),
    );
}

/** « Ouvrir le dossier dans VS Code », « Ouvrir a.ts dans VS Code (ligne 12) »… */
export function actionsEditeurs(editeurs: Editeur[], dossier: string, fichier: string | null): Action[] {
  const actions: Action[] = [];
  editeurs.forEach((e, i) => {
    if (e.dossier) {
      actions.push({
        source: { genre: "action", id: `dossier-${e.id}`, titre: `Ouvrir le dossier dans ${e.nom}`, icone: "solar:code-square-linear", ordre: i },
        faire: () => ouvrirDansEditeur(e.id, dossier).catch(signalerEchec(`Ouvrir dans ${e.nom}`)),
      });
    }
    if (fichier) {
      const nom = fichier.split("/").pop() || fichier;
      const position = positionCurseur(fichier);
      actions.push({
        source: {
          genre: "action",
          id: `fichier-${e.id}`,
          titre: `Ouvrir ${nom} dans ${e.nom}`,
          detail: position ? `ligne ${position.ligne}` : fichier,
          icone: "solar:code-square-linear",
          ordre: 20 + i,
        },
        // Ligne relue au moment du choix (le curseur a pu bouger).
        faire: () => {
          const p = positionCurseur(fichier);
          return ouvrirDansEditeur(e.id, dossier, fichier, p?.ligne, p?.colonne).catch(signalerEchec(`Ouvrir dans ${e.nom}`));
        },
      });
    }
  });
  return actions;
}

/** Aide : dossier des journaux ; sous Windows, relancer en administrateur. */
export function actionsAide(): Action[] {
  const actions: Action[] = [
    {
      source: { genre: "action", id: "journaux", titre: "Ouvrir le dossier des journaux", detail: "Aide", icone: "solar:document-text-linear", ordre: 50 },
      faire: () => ouvrirDossierJournaux().catch(signalerEchec("Dossier des journaux")),
    },
  ];
  if (estWindows()) {
    actions.push({
      source: { genre: "action", id: "administrateur", titre: "Relancer en administrateur", detail: "Aide", icone: "solar:shield-up-linear", ordre: 51 },
      faire: () => relancerAdministrateur().catch(signalerEchec("Relancer en administrateur")),
    });
  }
  return actions;
}
