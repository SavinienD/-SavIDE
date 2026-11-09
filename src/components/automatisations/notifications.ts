// automatisations — fin d'une exécution -> notification de l'IDE (contrat commun
// `ide-notification`, affichée par la vue des agents) ; au démarrage de l'appli, un mot
// sur les exécutions faites pendant qu'elle était fermée. Fonctions pures (testées).
import type { Automatisation, Execution, StatutExecution } from "./automatisationsApi";
import { STATUTS } from "./horaires";
import { texteNotification } from "../notifications/texteNotif";

export type DetailNotification = {
  genre: "fini" | "attente" | "echec" | "info";
  titre: string;
  texte: string;
  dossier?: string;
  sessionId?: string;
};

/** Dernier moment où l'IDE a vu les résultats des automatisations (ms). */
export const CLE_VU = "axecode.automatisations.vu";

const GENRES: Partial<Record<StatutExecution, DetailNotification["genre"]>> = {
  reussie: "fini",
  echouee: "echec",
  arretee: "info",
};

function court(texte: string, max = 140): string {
  const t = texte.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Événement `automatisations` `{type: "fin"}` du service -> notification (null : rien à dire). */
export function notificationDeFin(data: unknown): DetailNotification | null {
  const d = data as { type?: string; automatisation?: { nom?: string; dossier?: string }; execution?: Execution } | null;
  if (!d || d.type !== "fin" || !d.execution) return null;
  const genre = GENRES[d.execution.statut];
  // Sautée ou manquée : visibles dans l'historique, sans notification.
  if (!genre) return null;
  const nom = d.automatisation?.nom?.trim() || "Automatisation";
  return {
    genre,
    titre: texteNotification(`${nom} : ${STATUTS[d.execution.statut].toLowerCase()}`),
    texte: texteNotification(court(d.execution.resume ?? "")),
    dossier: d.automatisation?.dossier,
    sessionId: d.execution.sessionId,
  };
}

/** Exécutions finies après `depuisMs` (appli fermée) -> une seule notification qui les résume. */
export function resumeAbsence(liste: Automatisation[], depuisMs: number): DetailNotification | null {
  let reussies = 0;
  let echouees = 0;
  let arretees = 0;
  for (const a of liste) {
    for (const x of a.historique ?? []) {
      if (!x.finMs || x.finMs <= depuisMs) continue;
      if (x.statut === "reussie") reussies += 1;
      else if (x.statut === "echouee") echouees += 1;
      else if (x.statut === "arretee") arretees += 1;
    }
  }
  const total = reussies + echouees + arretees;
  if (!total) return null;
  const s = (n: number) => (n > 1 ? "s" : "");
  const parties = [
    reussies ? `${reussies} réussie${s(reussies)}` : "",
    echouees ? `${echouees} échouée${s(echouees)}` : "",
    arretees ? `${arretees} arrêtée${s(arretees)}` : "",
  ].filter(Boolean);
  return {
    genre: echouees ? "echec" : "fini",
    titre: "Automatisations",
    texte: `${total} exécution${s(total)} pendant que l'appli était fermée : ${parties.join(", ")}.`,
  };
}

export function emettre(detail: DetailNotification): void {
  window.dispatchEvent(new CustomEvent("ide-notification", { detail }));
}

