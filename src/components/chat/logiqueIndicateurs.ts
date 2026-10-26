// axe:commandes — indicateurs /heartbeat et /goal à côté du sélecteur de modèle
// (logique pure, testée par tests/commandesSlash.test.cjs).

export type HeartbeatEtat = { interval_ms: number; message: string; next_at_ms: number; last_at_ms?: number | null };
export type GoalEtat = {
  text: string;
  status: string;
  summary?: string | null;
  /** axe:goal165 — prochaine relance automatique prévue (ms), sinon null. */
  next_relaunch_ms?: number | null;
  relaunches?: number;
  /** Raison d'une pause automatique (aucun avancement). */
  auto_pause?: string | null;
};
/** axe:guet — un guet en cours (état brut du service, normalisé). */
export type GuetEtat = {
  id: string;
  genre: string;
  cible: string;
  message: string | null;
  statut: string;
  depuis_ms: number;
  prochain_ms: number | null;
  essais: number;
};
export type EtatCommandes = { goal: GoalEtat | null; heartbeat: HeartbeatEtat | null; guets: GuetEtat[] };

export const ETAT_VIDE: EtatCommandes = { goal: null, heartbeat: null, guets: [] };

/** axe:guet — guets de `sessions.commands_state` (entrées illisibles ignorées). */
export function normaliserGuets(brut: unknown): GuetEtat[] {
  if (!Array.isArray(brut)) return [];
  const out: GuetEtat[] = [];
  for (const x of brut) {
    if (!x || typeof x !== "object") continue;
    const g = x as Record<string, unknown>;
    if (typeof g.id !== "string") continue;
    const genre = typeof g.genre === "string" ? g.genre : "commande";
    const cible =
      typeof g.cmd === "string" ? g.cmd : typeof g.chemin === "string" ? `fichier ${g.chemin}` : typeof g.cible === "string" ? g.cible : "";
    out.push({
      id: g.id,
      genre,
      cible,
      message: typeof g.message === "string" ? g.message : null,
      statut: typeof g.statut === "string" ? g.statut : "actif",
      depuis_ms: typeof g.cree_ms === "number" ? g.cree_ms : typeof g.depuis_ms === "number" ? g.depuis_ms : 0,
      prochain_ms: typeof g.prochain_ms === "number" ? g.prochain_ms : null,
      essais: typeof g.essais === "number" ? g.essais : 0,
    });
  }
  return out;
}

/** axe:guet — lignes du détail d'un guet (commande, depuis quand, prochain essai). */
export function detailGuet(g: GuetEtat, maintenant = Date.now()): string[] {
  const lignes: string[] = [];
  const genre = g.genre === "condition" ? "Condition" : g.genre === "fichier" ? "Fichier" : "Commande";
  lignes.push(`${genre}\u00a0: ${g.cible}`);
  if (g.depuis_ms) lignes.push(`Depuis ${formatHeure(g.depuis_ms)} (${formatIntervalle(maintenant - g.depuis_ms)})`);
  if (g.statut === "a_livrer") lignes.push("Fini\u00a0: réveil à la fin du tour en cours");
  else if (g.prochain_ms) {
    const essais = g.essais ? ` · ${g.essais} essai${g.essais > 1 ? "s" : ""}` : "";
    lignes.push(`Prochain essai\u00a0: ${formatHeure(g.prochain_ms, true)}${essais}`);
  } else lignes.push("En cours, réveil à sa fin");
  return lignes;
}

/** Statut d'un réveil de guet en clair. */
export function libelleStatutGuet(statut: string): string {
  switch (statut) {
    case "termine":
      return "terminée";
    case "reussi":
      return "condition remplie";
    case "delai_depasse":
      return "délai dépassé";
    case "interrompu":
      return "interrompue (service redémarré)";
    default:
      return statut;
  }
}

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
            next_relaunch_ms: typeof g.next_relaunch_ms === "number" ? g.next_relaunch_ms : null,
            relaunches: typeof g.relaunches === "number" ? g.relaunches : 0,
            auto_pause: typeof g.auto_pause === "string" ? g.auto_pause : null,
          }
        : null,
    guets: normaliserGuets(r.guets),
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

/** axe:goal165 — ligne « objectif : poursuite automatique » de l'indicateur. */
export function textePoursuite(goal: GoalEtat): string | null {
  if (goal.status === "active") {
    return goal.next_relaunch_ms
      ? `objectif\u00a0: poursuite automatique · prochaine relance ${formatHeure(goal.next_relaunch_ms, true)}`
      : "objectif\u00a0: poursuite automatique";
  }
  if (goal.status === "paused" && goal.auto_pause) return `poursuite automatique arrêtée\u00a0: ${goal.auto_pause}`;
  return null;
}

/** Relance automatique de l'objectif : `<goal_continue at_ms="…" n="…">\n…\n</goal_continue>`. */
export function lirePoursuite(texte: string): { message: string; atMs: number | null } | null {
  const m = /^<goal_continue((?:\s+[a-z_]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/goal_continue>$/.exec(texte.trim());
  if (!m) return null;
  const at = /at_ms="(\d+)"/.exec(m[1]);
  return { message: m[2].trim(), atMs: at ? Number(at[1]) : null };
}

/** Message injecté par un réveil : `<heartbeat at_ms="…">\nmessage\n</heartbeat>`. */
export function lireReveil(texte: string): { message: string; atMs: number | null } | null {
  // axe:guet — réveil d'un guet : `<guet id="…" statut="…" at_ms="…">…</guet>`.
  const g = /^<guet((?:\s+[a-z_]+="[^"]*")*)\s*>[\s\S]*<\/guet>$/.exec(texte.trim());
  if (g) {
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(g[1])?.[1] ?? "";
    const at = attr("at_ms");
    return { message: `guet ${attr("id")} : ${libelleStatutGuet(attr("statut"))}`, atMs: at ? Number(at) : null };
  }
  // Attributs supplémentaires acceptés (missed="2" : réveils manqués fusionnés).
  const m = /^<heartbeat((?:\s+[a-z_]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/heartbeat>$/.exec(texte.trim());
  if (!m) return null;
  const at = /at_ms="(\d+)"/.exec(m[1]);
  return { message: m[2].trim(), atMs: at ? Number(at[1]) : null };
}

/** Texte de la bulle discrète : « réveil : coucou · 14:32 ». */
export function texteReveil(message: string, atMs: number | null | undefined): string {
  if (estReveilGuet(message)) return atMs ? `${message} · ${formatHeure(atMs)}` : message;
  return atMs ? `réveil : ${message} · ${formatHeure(atMs)}` : `réveil : ${message}`;
}

/** axe:guet — la bulle « réveil » vient d'un guet (icône différente). */
export function estReveilGuet(message: string): boolean {
  return /^guet g[0-9a-f]{6}[ \u00a0]:[ \u00a0]/.test(message);
}
