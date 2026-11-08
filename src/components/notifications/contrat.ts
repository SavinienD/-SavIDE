// CONTRAT COMMUN : prévenir l'utilisateur depuis n'importe quel écran (fin d'une
// tâche de fond, validation demandée, erreur…). Les autres écrans ÉMETTENT :
//
//   window.dispatchEvent(new CustomEvent("ide-notification", {
//     detail: { genre: "fini" | "attente" | "echec" | "info", titre, texte, dossier?, sessionId? },
//   }));
//
// (ou `notifier({ … })` ci-dessous, même chose avec les types).
// - genre : « fini » (tâche terminée), « attente » (l'utilisateur doit répondre ou valider),
//   « echec » (erreur), « info » (le reste). Inconnu : « info ».
// - titre, texte : courts, en français (texte peut être vide). Sans titre ni texte : ignoré.
// - dossier : chemin du dossier concerné ; sessionId : conversation ouverte au clic.
// Le centre des notifications l'ÉCOUTE (useServiceNotifications, monté par App.tsx) et le traite comme une
// fin de tour : cloche (non lu), badge de l'icône, notification du système et son selon
// Réglages > Notifications — seulement si la fenêtre n'a pas le focus ou si la conversation
// n'est pas affichée. Avec un sessionId et le genre « attente », « fini » ou « echec », la
// conversation passe dans la colonne correspondante de la vue « Tableau » de l'onglet Agents.
// Tests : tests/notificationsContrat.test.cjs.
import type { GenreNotification, SignalementNotif } from "./notificationsApi";

export const EVENEMENT_IDE_NOTIFICATION = "ide-notification";

export type DetailIdeNotification = {
  genre: GenreNotification;
  titre: string;
  texte?: string;
  dossier?: string;
  sessionId?: string;
};

const GENRES: GenreNotification[] = ["fini", "attente", "echec", "info"];

/** Émet l'événement du contrat (pour les autres écrans). */
export function notifier(detail: DetailIdeNotification, cible: EventTarget = window): void {
  cible.dispatchEvent(new CustomEvent(EVENEMENT_IDE_NOTIFICATION, { detail }));
}

let compteur = 0;

/** Signalement pour le centre à partir du détail reçu (null : inutilisable). */
export function signalementDe(detail: unknown, maintenant: number): SignalementNotif | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const texteDe = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const titre = texteDe(d.titre);
  const texte = texteDe(d.texte);
  if (!titre && !texte) return null;
  const genre = GENRES.includes(d.genre as GenreNotification) ? (d.genre as GenreNotification) : "info";
  compteur += 1;
  return {
    cle: `ide:${maintenant}:${compteur}`,
    genre,
    titre: titre || texte,
    texte: titre ? texte : "",
    dossier: texteDe(d.dossier) || undefined,
    sessionId: texteDe(d.sessionId) || undefined,
    ts: maintenant,
    alerter: true,
  };
}

/** Écoute le contrat sur `cible` ; rend la fonction qui arrête l'écoute. */
export function ecouterIdeNotifications(
  cible: EventTarget,
  signaler: (s: SignalementNotif) => void,
  horloge: () => number = () => Date.now(),
): () => void {
  const surEvenement = (e: Event) => {
    const s = signalementDe((e as CustomEvent).detail, horloge());
    if (s) signaler(s);
  };
  cible.addEventListener(EVENEMENT_IDE_NOTIFICATION, surEvenement);
  return () => cible.removeEventListener(EVENEMENT_IDE_NOTIFICATION, surEvenement);
}
