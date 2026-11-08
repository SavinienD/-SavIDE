// serveurs MCP de Claude Code, Codex, Cursor et VS Code repris ici.
// Module pur : groupes, sélection de départ, libellés, proposition unique
// au premier lancement. Testé par tests/interopMcp.test.cjs.

export type ServeurTrouve = {
  cle: string;
  nom: string;
  outil: "claude_code" | "codex" | "cursor" | "vscode";
  fichier: string;
  transport: "stdio" | "http";
  commande: string;
  url?: string | null;
  variables: string[];
  entetes: string[];
  doublon?: string | null;
  nomPris: boolean;
  avertissement?: string | null;
};

export type RapportMcp = { importes: string[]; erreurs: string[] };

const OUTILS: Record<string, string> = { claude_code: "Claude Code", codex: "Codex", cursor: "Cursor", vscode: "VS Code" };
export const nomOutil = (o: string): string => OUTILS[o] ?? o;

/** Ce qui se coche : tout sauf un nom déjà pris dans nos serveurs. */
export const importable = (s: ServeurTrouve): boolean => !s.nomPris;

/** Cochés au départ : importables et sans doublon. */
export function selectionDeDepart(liste: ServeurTrouve[]): Set<string> {
  return new Set(liste.filter((s) => importable(s) && !s.doublon).map((s) => s.cle));
}

/** Serveurs regroupés par fichier, dans l'ordre reçu. */
export function grouper(liste: ServeurTrouve[]): { titre: string; serveurs: ServeurTrouve[] }[] {
  const groupes: { titre: string; serveurs: ServeurTrouve[] }[] = [];
  for (const s of liste) {
    const titre = `${nomOutil(s.outil)} · ${s.fichier}`;
    let g = groupes.find((x) => x.titre === titre);
    if (!g) groupes.push((g = { titre, serveurs: [] }));
    g.serveurs.push(s);
  }
  return groupes;
}

/** Ligne de détail : commande ou adresse, puis les NOMS des variables et en-têtes. */
export function detail(s: ServeurTrouve): string {
  const quoi = s.transport === "http" ? s.url ?? "" : s.commande;
  const noms = [...s.variables, ...s.entetes];
  return noms.length ? `${quoi} · ${noms.join(", ")}` : quoi;
}

/** Outils où des serveurs importables ont été trouvés (« Claude Code et Cursor »). */
export function outilsTrouves(liste: ServeurTrouve[]): string {
  const noms = [...new Set(liste.filter((s) => importable(s) && !s.doublon).map((s) => nomOutil(s.outil)))];
  if (noms.length <= 1) return noms.join("");
  return `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}`;
}

export function resumeMcp(r: RapportMcp): string {
  const n = r.importes.length;
  const debut = n === 0 ? "Aucun serveur importé" : `${n} serveur${n > 1 ? "s" : ""} importé${n > 1 ? "s" : ""}`;
  return r.erreurs.length ? `${debut} · ${r.erreurs.join(" ; ")}` : debut;
}

// ---- proposition au premier lancement ----

export const CLE_PROPOSITION = "axecode.interop.mcp-propose";
export const EVENEMENT_IMPORT_MCP = "interop-import-mcp";
let importDemande = false;

/** La proposition a-t-elle déjà été faite (acceptée ou refusée) ? */
export function propositionFaite(stockage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return !!stockage?.getItem(CLE_PROPOSITION);
  } catch {
    return true;
  }
}

export function noterProposition(stockage: Pick<Storage, "setItem"> | null, reponse: "choisir" | "plus-tard"): void {
  try {
    stockage?.setItem(CLE_PROPOSITION, reponse);
  } catch {
    /* stockage plein ou interdit : la proposition reviendra, sans gêne */
  }
}

/** Nombre de serveurs à proposer (0 : rien à proposer). */
export const aProposer = (liste: ServeurTrouve[] | null | undefined): number =>
  (Array.isArray(liste) ? liste : []).filter((s) => importable(s) && !s.doublon).length;

/** Demande l'ouverture de la boîte d'import (Réglages > MCP), montée ou pas encore. */
export function demanderImportMcp(cible: EventTarget | null = typeof window === "undefined" ? null : window): void {
  importDemande = true;
  cible?.dispatchEvent(new CustomEvent(EVENEMENT_IMPORT_MCP));
}

/** Lue au montage du bouton : une demande arrivée avant lui. */
export function prendreDemandeImportMcp(): boolean {
  const d = importDemande;
  importDemande = false;
  return d;
}
