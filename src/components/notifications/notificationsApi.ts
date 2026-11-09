// Appels au centre des notifications (src-tauri/src/notifications.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { franciser, texteNotification } from "./texteNotif";

/** « fini » : tour terminé ; « attente » : attend votre réponse ; « echec » : erreur ; « info ». */
export type GenreNotification = "fini" | "attente" | "echec" | "info";

export type EvenementNotif = {
  cle: string;
  genre: GenreNotification;
  titre: string;
  texte: string;
  dossier?: string;
  sessionId?: string;
  /** Connexion du service (absente : ce poste). */
  connexion?: string;
  sousAgent?: boolean;
  /** Conversation sans dossier. */
  libre?: boolean;
  ts: number;
  lu: boolean;
};

/** Ce qu'une fenêtre signale ; `alerter: false` = listé sans notification ni son. */
export type SignalementNotif = Omit<EvenementNotif, "lu" | "ts"> & { ts?: number; alerter?: boolean };

export type EtatSessionNotif = { genre: GenreNotification; depuis: number; texte: string; lu: boolean };

export type ReglagesNotif = {
  systeme: boolean;
  fini: boolean;
  attente: boolean;
  echec: boolean;
  sousAgents: boolean;
  son: boolean;
  nePasDeranger: boolean;
};

export type EtatCentre = {
  evenements: EvenementNotif[];
  etats: Record<string, EtatSessionNotif>;
  reglages: ReglagesNotif;
  nonLus: number;
};

export type DecisionNotif = { nouveau: boolean; systeme: boolean; son: boolean };

export const REGLAGES_DEFAUT: ReglagesNotif = {
  systeme: true,
  fini: true,
  attente: true,
  echec: true,
  sousAgents: false,
  son: true,
  nePasDeranger: false,
};

export const ETAT_VIDE: EtatCentre = { evenements: [], etats: {}, reglages: REGLAGES_DEFAUT, nonLus: 0 };

export const EVENEMENT_ETAT = "axe://notifications";
export const EVENEMENT_OUVRIR = "axe://notification-ouvrir";

/** État reçu du centre, complété (le banc et les vieux services peuvent rendre null). */
export function normaliserEtat(brut: unknown): EtatCentre {
  const e = (brut ?? {}) as Partial<EtatCentre>;
  // Événements gardés par une version précédente : affichés en français eux aussi.
  const evenements = (Array.isArray(e.evenements) ? e.evenements : []).map((x) =>
    x && typeof x === "object" ? { ...x, titre: texteNotification(x.titre ?? ""), texte: texteNotification(x.texte ?? "") } : x,
  );
  return {
    evenements,
    etats: e.etats && typeof e.etats === "object" ? e.etats : {},
    reglages: { ...REGLAGES_DEFAUT, ...(e.reglages ?? {}) },
    nonLus: typeof e.nonLus === "number" ? e.nonLus : evenements.filter((x) => !x.lu).length,
  };
}

export const notificationsApi = {
  lister: () => invoke<unknown>("notifications_lister").then(normaliserEtat),
  signaler: (signalement: SignalementNotif) =>
    invoke<DecisionNotif | null>("notifications_signaler", { signalement: franciser(signalement) }),
  effacerEtat: (sessionId: string) => invoke<void>("notifications_effacer_etat", { sessionId }),
  marquerLu: (cle?: string, sessionId?: string) =>
    invoke<void>("notifications_marquer_lu", { cle: cle ?? null, sessionId: sessionId ?? null }),
  /** Réglages > Notifications : lus (sans argument) ou enregistrés. */
  reglages: (reglages?: ReglagesNotif) =>
    invoke<ReglagesNotif | null>("notifications_reglages", { reglages: reglages ?? null }).then((r) => ({ ...REGLAGES_DEFAUT, ...(r ?? reglages ?? {}) })),
  /** Notification d'essai (montrée même si les notifications du système sont coupées). */
  essayer: () => invoke<DecisionNotif | null>("notifications_essayer"),
  /** Conversation affichée par cette fenêtre (null : aucune). */
  vue: (sessionId: string | null) => invoke<void>("notifications_vue", { sessionId }),
  surEtat: (f: (etat: EtatCentre) => void): Promise<UnlistenFn> =>
    listen<unknown>(EVENEMENT_ETAT, (e) => f(normaliserEtat(e.payload))),
  surOuvrir: (f: (ev: EvenementNotif) => void): Promise<UnlistenFn> =>
    listen<EvenementNotif>(EVENEMENT_OUVRIR, (e) => f(e.payload)),
};
