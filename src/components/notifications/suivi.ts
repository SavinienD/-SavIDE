// Fins de tour repérées dans les événements du service (axe://daemon) :
// « fini », « attente » (question.ask : l'agent attend votre réponse), « echec » (turn_error).
// Module pur (tests/notificationsSuivi.test.cjs). Chaque fenêtre fait le même calcul : la clé
// d'une fin (session, genre, updatedAtMs du statut final) est la même partout, et le centre
// (src-tauri/src/notifications.rs) ne la garde, ne la montre et ne la sonne qu'une fois.
import type { GenreNotification, SignalementNotif } from "./notificationsApi";

export type MetaSuivie = {
  id: string;
  parentId?: string;
  name?: string;
  workspaceId?: string;
  status?: string;
  scratch?: boolean;
  updatedAtMs?: number;
};

export type EvenementService = { event?: string; sessionId?: string; data?: unknown; connectionId?: string };

type Tour = {
  /** Lancé par un message de l'utilisateur (pas un réveil /heartbeat, un guet, /goal). */
  parUtilisateur: boolean;
  /** Réveillé par un message d'une autre session (résultat d'un sous-agent). */
  parPair: boolean;
  question?: string;
  erreur?: string;
  dernierTexte?: string;
};

export type Suivi = {
  metas: Map<string, MetaSuivie & { connexion?: string }>;
  tours: Map<string, Tour>;
  /** Message de l'utilisateur journalisé juste avant le statut « running » qu'il déclenche. */
  envois: Set<string>;
  pairs: Set<string>;
};

export type ActionSuivi =
  | { type: "signaler"; signalement: SignalementNotif }
  | { type: "effacer"; sessionId: string };

export function nouveauSuivi(): Suivi {
  return { metas: new Map(), tours: new Map(), envois: new Set(), pairs: new Set() };
}

/** Sessions connues au démarrage (sessions.list) ; celles qui tournent ont un tour ouvert. */
export function semer(suivi: Suivi, sessions: MetaSuivie[] | null | undefined, connexion?: string): void {
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !s.id) continue;
    suivi.metas.set(s.id, { ...s, connexion });
    if (s.status === "running" && !suivi.tours.has(s.id)) suivi.tours.set(s.id, { parUtilisateur: true, parPair: false });
  }
}

/** Message « utilisateur » écrit par le système : réveil /heartbeat, guet, relance /goal. */
export function estReveil(texte: string): boolean {
  const t = texte.trimStart();
  return t.startsWith("<heartbeat") || t.startsWith("<guet ") || t.startsWith("<system_reminder");
}

function texteMessage(message: unknown): string {
  const parts = (message as { parts?: { type?: string; text?: unknown }[] } | undefined)?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
}

/** Première ligne utile d'un texte, sans marques Markdown simples, coupée à `max` caractères. */
export function extrait(texte: string | undefined, max = 140): string {
  const ligne =
    String(texte ?? "")
      .split("\n")
      .map((l) => l.replace(/^[\s#>*\-+`|]+/, "").replace(/[*`_]{1,3}/g, "").trim())
      .find(Boolean) ?? "";
  return ligne.length > max ? `${ligne.slice(0, max - 1)}…` : ligne;
}

function enfantsAuTravail(suivi: Suivi, id: string): boolean {
  for (const m of suivi.metas.values()) if (m.parentId === id && m.status === "running") return true;
  return false;
}

function tourDe(suivi: Suivi, id: string): Tour {
  let tour = suivi.tours.get(id);
  if (!tour) {
    // statut « running » manqué (fenêtre rechargée pendant le tour) : on suit quand même.
    tour = { parUtilisateur: true, parPair: false };
    suivi.tours.set(id, tour);
  }
  return tour;
}

function texteFin(genre: GenreNotification, tour: Tour): string {
  if (genre === "attente") return tour.question ? `Attend votre réponse : ${extrait(tour.question, 200)}` : "Attend votre réponse.";
  if (genre === "echec") return tour.erreur ? `Échec : ${extrait(tour.erreur, 200)}` : "Échec du tour.";
  return tour.dernierTexte ? `Fini : ${tour.dernierTexte}` : "Fini.";
}

/** Applique un événement du service ; rend ce qu'il faut signaler ou effacer. */
export function appliquer(suivi: Suivi, ev: EvenementService | null | undefined, maintenant: number): ActionSuivi[] {
  const actions: ActionSuivi[] = [];
  if (!ev || typeof ev !== "object") return actions;
  const data = (ev.data ?? {}) as Record<string, unknown>;
  if (ev.event === "status") {
    const id = ev.sessionId ?? (typeof data.id === "string" ? data.id : undefined);
    if (!id) return actions;
    const meta = { ...(suivi.metas.get(id) ?? {}), ...(data as Partial<MetaSuivie>), id, connexion: ev.connectionId };
    suivi.metas.set(id, meta);
    if (meta.status === "running") {
      if (!suivi.tours.has(id)) {
        suivi.tours.set(id, { parUtilisateur: suivi.envois.delete(id), parPair: suivi.pairs.delete(id) });
        actions.push({ type: "effacer", sessionId: id });
      }
      return actions;
    }
    const tour = suivi.tours.get(id);
    if (!tour) return actions;
    suivi.tours.delete(id);
    const genre: GenreNotification = tour.question !== undefined ? "attente" : tour.erreur !== undefined ? "echec" : "fini";
    const alerter = genre !== "fini" || ((tour.parUtilisateur || tour.parPair) && !enfantsAuTravail(suivi, id));
    actions.push({
      type: "signaler",
      signalement: {
        cle: `${id}:${genre}:${meta.updatedAtMs ?? maintenant}`,
        genre,
        titre: meta.name || "Conversation",
        texte: texteFin(genre, tour),
        dossier: meta.workspaceId,
        sessionId: id,
        connexion: ev.connectionId,
        sousAgent: Boolean(meta.parentId),
        libre: Boolean(meta.scratch),
        alerter,
      },
    });
    return actions;
  }
  if (ev.event !== "entry" || !ev.sessionId) return actions;
  const id = ev.sessionId;
  if (data.kind === "message") {
    const message = data.message as { role?: string } | undefined;
    const texte = texteMessage(message);
    if (message?.role === "user" && !estReveil(texte)) {
      const tour = suivi.tours.get(id);
      if (tour) {
        tour.parUtilisateur = true;
        tour.question = undefined; // réponse donnée pendant le tour
      } else suivi.envois.add(id);
      actions.push({ type: "effacer", sessionId: id });
    } else if (message?.role === "assistant" && texte.trim()) {
      const tour = suivi.tours.get(id);
      if (tour) tour.dernierTexte = extrait(texte);
    }
  } else if (data.kind === "peer_message") {
    const tour = suivi.tours.get(id);
    if (tour) tour.parPair = true;
    else suivi.pairs.add(id);
  } else if (data.kind === "extension") {
    const payload = (data.payload ?? {}) as Record<string, unknown>;
    if (data.name === "question") tourDe(suivi, id).question = String(payload.question ?? payload.text ?? "");
    else if (data.name === "turn_error") tourDe(suivi, id).erreur = String(payload.error ?? "");
  }
  return actions;
}
