// Tours en cours qui concernent l'espace affiché.
// Le démon peut rendre le chemin de l'espace sous une autre forme que celle de la vue
// (préfixe \\?\ de Windows, casse, barres) : l'accueil comparait avec samePath et
// montrait le rond, la liste comparait à l'identique et ne montrait rien. Un tour
// compte aussi dès que sa conversation est dans la liste affichée.
import type { ActiveTurnSummary } from "../types";

// Même règle que samePath (freechatApi), sans dépendre de Tauri (testable sous node).
function memeChemin(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function toursDeLEspace<T extends Pick<ActiveTurnSummary, "workspaceId" | "conversationId">>(
  tours: T[],
  espace: string,
  conversationsAffichees: Iterable<string> = [],
): T[] {
  const ids = new Set(conversationsAffichees);
  return tours.filter(
    (tour) => ids.has(tour.conversationId) || (!!espace && !!tour.workspaceId && memeChemin(tour.workspaceId, espace)),
  );
}
