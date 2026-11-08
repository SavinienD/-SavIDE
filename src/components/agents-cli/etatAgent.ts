// État d'un agent lancé dans un terminal, déduit de ce qui passe dans le pseudo-terminal :
// « travaille » tant que sa sortie bouge (hors écho des frappes), « attend » sur un signal
// (BEL, OSC 9, OSC 777), une invite reconnue après un court silence ou un long silence,
// « fini » / « echec » quand le processus s'arrête. Logique pure (tests/etatAgent.test.cjs) ;
// TerminalPanel.tsx l'alimente (xterm : onBell, gestionnaires OSC, horloge de 500 ms).

export type EtatAgent = "demarre" | "travaille" | "attend" | "fini" | "echec";

export type Suivi = {
  etat: EtatAgent;
  derniereSortie: number;
  derniereSaisie: number;
  /** Début du travail en cours (ms), pour ne prévenir qu'après un vrai travail. */
  debutTravail: number | null;
  codeSortie: number | null;
};

export type Transition = { suivi: Suivi; notifier: boolean };

/** Sortie arrivée juste après une frappe : son écho, pas du travail. */
export const ECHO_MS = 400;
/** Silence après lequel une invite reconnue à l'écran vaut « attend ». */
export const SILENCE_INVITE_MS = 1500;
/** Silence après lequel l'agent attend, invite reconnue ou non. */
export const SILENCE_MS = 5000;
/** Travail assez long pour prévenir quand il s'arrête. */
export const TRAVAIL_NOTIFIE_MS = 4000;

const termine = (s: Suivi) => s.etat === "fini" || s.etat === "echec";

export function suiviInitial(maintenant: number): Suivi {
  return { etat: "demarre", derniereSortie: maintenant, derniereSaisie: Number.NEGATIVE_INFINITY, debutTravail: null, codeSortie: null };
}

export function surSaisie(s: Suivi, maintenant: number): Suivi {
  return termine(s) ? s : { ...s, derniereSaisie: maintenant };
}

export function surSortie(s: Suivi, maintenant: number): Suivi {
  if (termine(s)) return s;
  if (maintenant - s.derniereSaisie <= ECHO_MS && s.etat !== "travaille") return { ...s, derniereSortie: maintenant };
  return {
    ...s,
    etat: "travaille",
    derniereSortie: maintenant,
    debutTravail: s.etat === "travaille" && s.debutTravail !== null ? s.debutTravail : maintenant,
  };
}

function attendre(s: Suivi): Transition {
  const notifier = s.etat === "travaille" && s.debutTravail !== null && s.derniereSortie - s.debutTravail >= TRAVAIL_NOTIFIE_MS;
  return { suivi: { ...s, etat: "attend", debutTravail: null }, notifier };
}

/** BEL, OSC 9 ou OSC 777 : l'agent demande l'attention (une notification par attente). */
export function surSignal(s: Suivi, _maintenant: number, _message: string | null): Transition {
  if (termine(s) || s.etat === "attend") return { suivi: s, notifier: false };
  return { suivi: { ...s, etat: "attend", debutTravail: null }, notifier: true };
}

/** Horloge : un silence fait passer de « travaille » à « attend ». */
export function surHorloge(s: Suivi, maintenant: number, ecran: string, invites: RegExp[]): Transition {
  if (s.etat !== "travaille") return { suivi: s, notifier: false };
  const silence = maintenant - s.derniereSortie;
  if (silence >= SILENCE_MS) return attendre(s);
  if (silence >= SILENCE_INVITE_MS && invites.some((r) => r.test(ecran))) return attendre(s);
  return { suivi: s, notifier: false };
}

/** Le processus s'est arrêté. */
export function surFin(s: Suivi, code: number | null): Transition {
  return { suivi: { ...s, etat: code === 0 ? "fini" : "echec", codeSortie: code, debutTravail: null }, notifier: true };
}

/** OSC 9 : notification (ConEmu, Windows Terminal) ; « 9;4;… » = barre de progression, ignorée. */
export function messageOsc9(donnees: string): string | null {
  if (/^4;/.test(donnees)) return null;
  const texte = donnees.trim();
  return texte || null;
}

/** OSC 777 : « notify;titre;corps » (rxvt, Ghostty…). */
export function messageOsc777(donnees: string): string | null {
  const [genre, titre = "", ...corps] = donnees.split(";");
  if (genre !== "notify") return null;
  const texte = [titre.trim(), corps.join(";").trim()].filter(Boolean).join(" : ");
  return texte || null;
}

export function libelleEtat(s: Suivi): string {
  switch (s.etat) {
    case "demarre":
      return "Démarre";
    case "travaille":
      return "Travaille";
    case "attend":
      return "Attend une réponse";
    case "fini":
      return "Fini";
    default:
      return s.codeSortie === null ? "Arrêté" : `Arrêté (code ${s.codeSortie})`;
  }
}

export type NotificationIde = { genre: "fini" | "attente" | "echec" | "info"; titre: string; texte: string; dossier?: string };

/** Détail de l'événement « ide-notification » (contrat commun aux lots). */
export function notificationAgent(nom: string, dossier: string, s: Suivi, message?: string | null): NotificationIde {
  if (s.etat === "attend") return { genre: "attente", titre: `${nom} attend`, texte: message || "L'agent attend une réponse.", dossier };
  if (s.etat === "fini") return { genre: "fini", titre: `${nom} a fini`, texte: "Le processus s'est terminé.", dossier };
  if (s.etat === "echec") {
    return { genre: "echec", titre: `${nom} s'est arrêté`, texte: s.codeSortie === null ? "Le processus a été arrêté." : `Le processus s'est terminé avec le code ${s.codeSortie}.`, dossier };
  }
  return { genre: "info", titre: nom, texte: libelleEtat(s), dossier };
}

/** Émet la notification pour l'IDE (le lot des agents l'affiche). */
export function emettreNotification(n: NotificationIde): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ide-notification", { detail: n }));
}

/** Invites du catalogue compilées (une expression invalide est ignorée). */
export function compilerInvites(motifs: string[] | undefined): RegExp[] {
  const sortie: RegExp[] = [];
  for (const m of motifs ?? []) {
    try {
      sortie.push(new RegExp(m));
    } catch {
      /* motif invalide : ignoré */
    }
  }
  return sortie;
}
