// axe:journal-espace — ouverture du journal (lecture seule) d'un agent depuis la vue Agents.
// Un journal demandé au PC alors que l'agent vit dans l'espace (ancienne ouverture sans
// machine) est relu sur la machine active ; jamais « session not found » brut à l'écran.
const INTROUVABLE = /session not found/i;

export async function chargerJournal<T>(
  lire: (sessionId: string, connectionId: string) => Promise<T>,
  sessionId: string,
  connectionId: string,
  active: string,
): Promise<T> {
  try {
    return await lire(sessionId, connectionId);
  } catch (e) {
    if (!INTROUVABLE.test(String(e)) || active === connectionId) throw e;
    return await lire(sessionId, active);
  }
}

export function messageJournal(e: unknown, traduire: (texte: string) => string = (t) => t): string {
  const brut = String(e);
  if (INTROUVABLE.test(brut))
    return "Journal introuvable : cet agent n'existe plus sur cette machine (supprimé, ou lancé sur une autre machine).";
  return traduire(brut);
}
