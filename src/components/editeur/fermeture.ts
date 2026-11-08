// Fermeture des onglets de fichiers :
// - onglet modifié avec la sauvegarde automatique active : le texte est écrit sur le disque
//   avant que l'onglet disparaisse (Ctrl+W, croix, clic molette, « Fermer tous les fichiers ») ;
//   échec : notification (contrat ide-notification) ;
// - onglets fermés gardés pour « Rouvrir l'onglet fermé » ; « Fermer tous les fichiers ».

import { api } from "../../lib/ipc";
import type { EditorTab } from "../../types";
import { doitSauverAvantFermeture, noterFermeture, partagerFermetureTous, reprendreFermeture } from "./onglets";
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
          texte: `${onglet.doc.name} : ${err instanceof Error ? err.message : String(err)}`,
          dossier: espace,
        },
      }),
    );
  });
}

// ---- onglets fermés (« Rouvrir l'onglet fermé ») : une pile par dossier, le temps de la session.
const piles = new Map<string, string[]>();

/** Note un onglet fermé (fichier de l'espace ; les fichiers externes ne se rouvrent pas). */
export function memoriserFermeture(espace: string, onglet: EditorTab | undefined): void {
  if (!onglet || onglet.external) return;
  piles.set(espace, noterFermeture(piles.get(espace) ?? [], onglet.relativePath));
}

/** Chemin à rouvrir (le dernier fermé qui n'est pas ouvert), retiré de la pile. */
export function cheminARouvrir(espace: string, ouverts: readonly string[]): string | null {
  const { chemin, pile } = reprendreFermeture(piles.get(espace) ?? [], ouverts);
  piles.set(espace, pile);
  return chemin;
}

export function peutRouvrir(espace: string, ouverts: readonly string[]): boolean {
  return (piles.get(espace) ?? []).some((c) => !ouverts.includes(c));
}

/** « Fermer tous les fichiers » : onglets gardés (modifiés, sans sauvegarde automatique) et message. */
export function fermerTousLesFichiers(espace: string, onglets: EditorTab[]): { garder: EditorTab[]; message: string | null } {
  const { garder, fermer } = partagerFermetureTous(onglets, lireReglagesEditeur().sauvegardeAuto);
  for (const onglet of fermer) {
    sauverAvantFermeture(espace, onglet);
    memoriserFermeture(espace, onglet);
  }
  const n = garder.length;
  const message = n
    ? `${n} fichier${n > 1 ? "s" : ""} modifié${n > 1 ? "s" : ""} non enregistré${n > 1 ? "s" : ""} : gardé${n > 1 ? "s" : ""} ouvert${n > 1 ? "s" : ""}.`
    : null;
  return { garder, message };
}
