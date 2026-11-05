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

// dossier « au travail » d'après le service local lui-même (sessions.list puis
// événements « status »). Les tours relevés par list_active_turns ne sont que ceux que la
// fenêtre a envoyés : un tour relancé par le service (résultat d'un sous-agent, réveil d'un
// guet, /heartbeat, file d'attente) et les sous-agents eux-mêmes n'y étaient pas, d'où une
// carte du dossier sans rond alors que plusieurs de ses sessions tournaient.
export type SessionService = { id?: string; workspaceId?: string; status?: string };
export type EvenementService = { event?: string; sessionId?: string; data?: unknown; connectionId?: string };

/** Sessions du service en cours (statut « running ») : identifiant → dossier. */
export function sessionsEnCours(sessions: SessionService[] | null | undefined): Map<string, string> {
  const enCours = new Map<string, string>();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && s.id && s.status === "running" && s.workspaceId) enCours.set(s.id, s.workspaceId);
  }
  return enCours;
}

/**
 * Applique un événement du service local (« status » porte la fiche complète de la session).
 * Rend une nouvelle table si quelque chose change, sinon `null`. Les événements d'une
 * connexion distante (`connectionId`) sont ignorés : seul le service du poste compte ici.
 */
export function majSessionsEnCours(
  enCours: Map<string, string>,
  ev: EvenementService | null | undefined,
): Map<string, string> | null {
  if (!ev || ev.connectionId || ev.event !== "status") return null;
  const data = (ev.data ?? {}) as SessionService;
  const id = ev.sessionId ?? data.id;
  if (!id) return null;
  const dossier = data.workspaceId ?? enCours.get(id);
  if (data.status === "running" && dossier) {
    if (enCours.get(id) === dossier) return null;
    return new Map(enCours).set(id, dossier);
  }
  if (!enCours.has(id)) return null;
  const suite = new Map(enCours);
  suite.delete(id);
  return suite;
}

/** Le dossier a-t-il un tour en cours (tours de la fenêtre ou sessions du service) ? */
export function dossierAuTravail(
  chemin: string,
  tours: Iterable<string>,
  service: Map<string, string> | Iterable<string>,
): boolean {
  const dossiers = service instanceof Map ? service.values() : service;
  for (const id of tours) if (id && memeChemin(id, chemin)) return true;
  for (const id of dossiers) if (id && memeChemin(id, chemin)) return true;
  return false;
}
