// onglet Agents : statut réel de chaque session et archivage des sous-agents terminés.
// Même source que le rond d'activité de l'accueil (lib/toursActifs) : sessions.list du
// service local, ses événements « status » (pris en compte avant la relecture de la liste), et les
// tours envoyés par la fenêtre (list_active_turns : la conversation ouverte travaille, mais le
// service la voit « déchargée »). Avant : « 0 · 0 · 13 » alors que la conversation
// et 2 sous-agents tournaient.
import type { SessionStatus } from "./agentsApi";

type Session = { id: string; parentId?: string; workspaceId: string; status: SessionStatus; archived?: boolean; scratch?: boolean };

// Même règle que samePath (préfixe \\?\ de Windows, barres, casse), sans dépendre de Tauri.
export function memeDossier(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Session à montrer pour ce dossier (les conversations sans dossier aussi). */
export function dansLeDossier(s: Pick<Session, "workspaceId" | "scratch">, dossier: string): boolean {
  return Boolean(s.scratch) || memeDossier(s.workspaceId, dossier);
}

/**
 * Statut affiché : « running » si le service le dit, si un événement « status » l'a annoncé
 * (`enCoursService` : identifiant → dossier) ou si la fenêtre a un tour en cours sur cette conversation.
 */
export function statutsEffectifs(
  sessions: Session[],
  toursFenetre: Set<string>,
  enCoursService: Map<string, string>,
): Map<string, SessionStatus> {
  const out = new Map<string, SessionStatus>();
  for (const s of sessions) {
    out.set(s.id, s.status === "running" || toursFenetre.has(s.id) || enCoursService.has(s.id) ? "running" : s.status);
  }
  return out;
}

/** Archivée : archivée dans le service, ou sous-agent qui a fini (ni en cours). Visible avec le filtre « archivés ». */
export function archive(s: Session, statut: Map<string, SessionStatus>): boolean {
  if (s.archived) return true;
  return Boolean(s.parentId) && (statut.get(s.id) ?? s.status) !== "running";
}

export function compter(sessions: Session[], statut: Map<string, SessionStatus>) {
  const c = { running: 0, idle: 0, inactive: 0 };
  for (const s of sessions) c[statut.get(s.id) ?? s.status] += 1;
  return c;
}
