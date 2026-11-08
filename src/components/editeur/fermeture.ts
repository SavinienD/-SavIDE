// Fermeture d'un onglet modifié avec la sauvegarde automatique active :
// le texte est écrit sur le disque avant que l'onglet disparaisse (Ctrl+W, croix, clic
// molette, « Fermer tous les fichiers »). Échec : notification (contrat ide-notification).

import { api } from "../../lib/ipc";
import type { EditorTab } from "../../types";
import { doitSauverAvantFermeture } from "./onglets";
import { lireReglagesEditeur } from "./reglagesEditeur";

export function sauverAvantFermeture(espace: string, onglet: EditorTab | undefined): void {
  if (!onglet || !doitSauverAvantFermeture(lireReglagesEditeur().sauvegardeAuto, onglet)) return;
  void api.writeFile(espace, onglet.relativePath, onglet.buffer).catch((err: unknown) => {
    console.error(err);
    window.dispatchEvent(
      new CustomEvent("ide-notification", {
        detail: {
          genre: "echec",
          titre: "Enregistrement impossible",
          texte: `${onglet.doc.name} : ${err instanceof Error ? err.message : String(err)}`,
          dossier: espace,
        },
      }),
    );
  });
}
