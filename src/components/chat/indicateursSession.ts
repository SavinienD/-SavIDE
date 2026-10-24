// axe:commandes — indicateurs /heartbeat et /goal à côté du sélecteur de modèle
// (logique pure, testée par tests/indicateursSession.test.cjs).

export type HeartbeatEtat = { interval_ms: number; message: string; next_at_ms: number; last_at_ms?: number | null };
export type GoalEtat = { text: string; status: string; summary?: string | null };
export type EtatCommandes = { goal: GoalEtat | null; heartbeat: HeartbeatEtat | null };

export const ETAT_VIDE: EtatCommandes = { goal: null, heartbeat: null };

/** Réponse de `sessions.commands_state` (champs inattendus ignorés). */
export function normaliserEtat(brut: unknown): EtatCommandes {
  const r = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>;
  const hb = r.heartbeat as Record<string, unknown> | null | undefined;
  const g = r.goal as Record<string, unknown> | null | undefined;
  return {
    heartbeat:
      hb && typeof hb.interval_ms === "number" && typeof hb.message === "string"
        ? {
            interval_ms: hb.interval_ms,
            message: hb.message,
            next_at_ms: typeof hb.next_at_ms === "number" ? hb.next_at_ms : 0,
            last_at_ms: typeof hb.last_at_ms === "number" ? hb.last_at_ms : null,
          }
        : null,
    goal:
      g && typeof g.text === "string"
        ? {
            text: g.text,
            status: typeof g.status === "string" ? g.status : "active",
            summary: typeof g.summary === "string" ? g.summary : null,
          }
        : null,
  };
}

/** 60000 -> « 1 min », 90000 -> « 1 min 30 s », 5400000 -> « 1 h 30 ». */
export function formatIntervalle(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** Heure locale « 14:32 » (ou « 14:32:05 » avec les secondes). */
export function formatHeure(ms: number, secondes = false): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return secondes ? `${hh}:${mm}:${String(d.getSeconds()).padStart(2, "0")}` : `${hh}:${mm}`;
}

export function libelleStatutGoal(status: string): string {
  switch (status) {
    case "active":
      return "en cours";
    case "paused":
      return "en pause";
    case "complete":
      return "atteint";
    default:
      return status;
  }
}

/** Le heartbeat vient de se déclencher entre deux lectures (son prochain réveil a avancé). */
export function vientDeSeDeclencher(avant: EtatCommandes, apres: EtatCommandes): boolean {
  if (avant.heartbeat?.last_at_ms != null || apres.heartbeat?.last_at_ms != null) {
    return (
      !!avant.heartbeat &&
      !!apres.heartbeat &&
      (apres.heartbeat.last_at_ms ?? 0) > (avant.heartbeat.last_at_ms ?? 0)
    );
  }
  return (
    !!avant.heartbeat &&
    !!apres.heartbeat &&
    apres.heartbeat.next_at_ms > avant.heartbeat.next_at_ms &&
    avant.heartbeat.message === apres.heartbeat.message
  );
}

/** Message injecté par un réveil : `<heartbeat at_ms="…">\nmessage\n</heartbeat>`. */
export function lireReveil(texte: string): { message: string; atMs: number | null } | null {
  const m = /^<heartbeat(?:\s+at_ms="(\d+)")?\s*>\n?([\s\S]*?)\n?<\/heartbeat>$/.exec(texte.trim());
  if (!m) return null;
  return { message: m[2].trim(), atMs: m[1] ? Number(m[1]) : null };
}

/** Texte de la bulle discrète : « réveil : coucou · 14:32 ». */
export function texteReveil(message: string, atMs: number | null | undefined): string {
  return atMs ? `réveil : ${message} · ${formatHeure(atMs)}` : `réveil : ${message}`;
}
