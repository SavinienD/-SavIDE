// Vue « Tableau » de l'onglet Agents : chaque conversation et chaque
// sous-agent dans une colonne selon son état. Même source que le rond d'activité (0.1.84) pour
// « Travaille » (sessions.list du service + événements « status » + tours de la fenêtre) ;
// « Attend votre réponse », « Fini, non lu » et « Échec » viennent du centre des notifications
// (src-tauri/src/notifications.rs). Module pur (tests/agentsTableau.test.cjs).

export type ColonneTableau = "attente" | "travaille" | "fini" | "echec" | "repos";

export const COLONNES_TABLEAU: { id: ColonneTableau; titre: string }[] = [
  { id: "attente", titre: "Attend votre réponse" },
  { id: "travaille", titre: "Travaille" },
  { id: "fini", titre: "Fini, non lu" },
  { id: "echec", titre: "Échec" },
  { id: "repos", titre: "Au repos" },
];

export type EtatTableau = { genre: string; depuis: number; texte?: string; lu?: boolean };

type SessionTableau = { id: string; status: string; updatedAtMs: number };

/** Colonne d'une session : son statut réel d'abord, puis l'état noté par le centre. */
export function colonneDe(statut: string, etat?: EtatTableau | null): ColonneTableau {
  if (statut === "running") return "travaille";
  if (etat?.genre === "attente") return "attente";
  if (etat?.genre === "echec" && !etat.lu) return "echec";
  if (etat?.genre === "fini" && !etat.lu) return "fini";
  return "repos";
}

/** Sessions réparties par colonne, la plus récente d'abord. */
export function repartir<T extends SessionTableau>(
  sessions: T[],
  statuts: Map<string, string>,
  etats: Record<string, EtatTableau | undefined>,
): Record<ColonneTableau, T[]> {
  const sortie: Record<ColonneTableau, T[]> = { attente: [], travaille: [], fini: [], echec: [], repos: [] };
  for (const s of sessions) sortie[colonneDe(statuts.get(s.id) ?? s.status, etats[s.id])].push(s);
  const quand = (s: T) => Math.max(s.updatedAtMs || 0, etats[s.id]?.depuis || 0);
  for (const liste of Object.values(sortie)) liste.sort((a, b) => quand(b) - quand(a));
  return sortie;
}

/** La session demande de l'attention (montrée même si elle serait archivée). */
export function demandeAttention(etat?: EtatTableau | null): boolean {
  return etat?.genre === "attente" || (etat?.genre === "echec" && !etat.lu);
}

/** « il y a 3 min », « il y a 2 h », « hier »… (court, pour les cartes). */
export function depuisQuand(ms: number, maintenant: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((maintenant - ms) / 1000));
  if (s < 60) return "à l'instant";
  const min = Math.round(s / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.round(h / 24);
  return j === 1 ? "hier" : `il y a ${j} j`;
}

/** Nom court d'un dossier (dernier segment), pour les cartes de « tous les dossiers ». */
export function nomDossier(chemin: string | undefined): string {
  const propre = String(chemin ?? "").replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  return propre.split(/[\\/]/).pop() || propre;
}

export const CLE_VUE = "axe:agents:vue";
export const CLE_PORTEE = "axe:agents:tous-dossiers";

export function lireVue(stockage: Pick<Storage, "getItem"> | null | undefined): "arbre" | "tableau" {
  try {
    return stockage?.getItem(CLE_VUE) === "tableau" ? "tableau" : "arbre";
  } catch {
    return "arbre";
  }
}
