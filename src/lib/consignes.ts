// consignes du dossier (AGENTS.md, CLAUDE.md, .claude/CLAUDE.md) :
// libellés de l'état de chaque fichier, affichés dans Réglages > Harnais.
// Module pur (testé par tests/interopConsignes.test.cjs).

export type EtatConsignes =
  | "lu"
  | "tronque"
  | "plafond"
  | "doublon"
  | "vide"
  | "ancien_modele"
  | "illisible"
  | "absent";

export type SourceConsignes = {
  fichier: string;
  chemin: string;
  caracteres: number;
  retenus: number;
  etat: EtatConsignes;
  detail?: string | null;
};

export type EtatDesConsignes = { sources: SourceConsignes[]; plafond: number };

const nombre = (n: number) => n.toLocaleString("fr-FR");

/** Texte court de l'état d'un fichier (« lu · 12 400 caractères »). */
export function libelleSource(s: SourceConsignes): string {
  switch (s.etat) {
    case "lu":
      return `lu · ${nombre(s.caracteres)} caractères`;
    case "tronque":
      return `coupé · ${nombre(s.retenus)} sur ${nombre(s.caracteres)} caractères`;
    case "plafond":
      return "non lu · plafond atteint";
    case "doublon":
      return `ignoré · ${s.detail ?? "répète un fichier lu"}`;
    case "vide":
      return "ignoré · vide";
    case "ancien_modele":
      return "ignoré · ancien texte par défaut";
    case "illisible":
      return `illisible${s.detail ? ` · ${s.detail}` : ""}`;
    default:
      return "absent";
  }
}

/** Fichiers réellement envoyés à l'agent (en entier ou coupés). */
export function fichiersLus(etat: EtatDesConsignes | null): string[] {
  return (etat?.sources ?? []).filter((s) => s.etat === "lu" || s.etat === "tronque").map((s) => s.fichier);
}

/** Résumé d'une ligne pour l'en-tête du bloc. */
export function resumeConsignes(etat: EtatDesConsignes | null): string {
  const lus = fichiersLus(etat);
  if (!etat) return "Consignes du dossier";
  if (lus.length === 0) return "Consignes du dossier : aucun fichier";
  const coupe = etat.sources.some((s) => s.etat === "tronque" || s.etat === "plafond");
  return `Consignes du dossier : ${lus.join(", ")}${coupe ? " (coupé)" : ""}`;
}
