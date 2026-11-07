import { useSyncExternalStore } from "react";

import { abonnerDictees, dicteesHorsEcran } from "./dicteeCible";

/** Conversations qui ont reçu du texte dicté hors écran (repère sur l'onglet / la ligne). */
export function useDicteesHorsEcran(): ReadonlySet<string> {
  return useSyncExternalStore(abonnerDictees, dicteesHorsEcran, dicteesHorsEcran);
}
