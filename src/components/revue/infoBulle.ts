// Revue des changements : info-bulle « Libellé · Ctrl+Maj+D », combinaison lue dans le registre.
import { combinaisonCourte, type RaccourciId } from "../../axe/raccourcis";

export function infoBulle(libelle: string, id: RaccourciId): string {
  const c = combinaisonCourte(id);
  return c ? `${libelle} · ${c}` : libelle;
}
