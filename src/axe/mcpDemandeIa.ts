// Serveurs MCP : demande à l'IA au lieu d'une commande à taper soi-même.
// Quand un serveur se lance par une commande sur ce poste (npx, uvx, programme
// installé…), la page des réglages ne demande pas à l'utilisateur d'ouvrir un
// terminal : elle prépare, dans la saisie de la conversation, une demande en
// français clair (commande exacte, système, prérequis, erreur éventuelle). Le texte
// n'est jamais envoyé tout seul : l'utilisateur le relit puis l'envoie.
// Module sans React (testé par node).
import { redactCommand } from "./mcpCatalog";
import { masquerSecrets } from "./mcpGuide";
import { estMac, estWindows } from "../lib/plateforme";
import type { McpServerConfig } from "../types";

export type SystemeMcp = "macOS" | "Windows" | "Linux";

/** Système de ce poste, tel qu'il est écrit dans la demande. */
export function systemeCourant(): SystemeMcp {
  if (estMac()) return "macOS";
  if (estWindows()) return "Windows";
  return "Linux";
}

type ServeurDemande = Pick<McpServerConfig, "name" | "command" | "args"> & {
  url?: string | null;
  env?: { key: string }[];
};

/** Vrai quand le serveur se lance par une commande sur ce poste (pas un serveur distant). */
export function serveurLocal(serveur: Pick<McpServerConfig, "command"> & { url?: string | null }): boolean {
  return !serveur.url?.trim() && Boolean(serveur.command?.trim());
}

const citer = (morceau: string) => (/[\s"']/.test(morceau) ? `"${morceau.replace(/"/g, '\\"')}"` : morceau);

/** Ligne de commande exacte, secrets masqués, arguments avec espaces entre guillemets. */
export function commandeServeur(serveur: Pick<McpServerConfig, "command" | "args">): string {
  return redactCommand([serveur.command, ...serveur.args].filter((m) => m !== "").map(citer));
}

/** Programme qui fournit la commande (npx -> Node.js, uvx -> uv), sinon null. */
export function prerequisCommande(commande: string): string | null {
  const nom = commande.trim().split(/[\\/]/).pop()?.replace(/\.(cmd|exe|bat)$/i, "").toLowerCase() ?? "";
  if (nom === "npx" || nom === "node" || nom === "npm") return "Node.js (il fournit npx)";
  if (nom === "uvx" || nom === "uv") return "uv (il fournit uvx)";
  if (nom === "docker") return "Docker";
  if (nom === "python" || nom === "python3") return "Python 3";
  return null;
}

/** Valeurs encore à remplacer dans les arguments : « <dossier> », « CHEMIN_DU_COFFRE ». */
export function valeursARemplacer(args: string[]): string[] {
  return args.filter((a) => /^<[^>]+>$/.test(a) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(a));
}

export type ContexteDemande = {
  systeme: SystemeMcp;
  /** Remarque du catalogue (addon à activer, connexion à faire une fois…). */
  note?: string | null;
  /** Erreur du dernier test : titre expliqué et journal brut (masqué ici). */
  erreur?: { titre: string; journal?: string | null } | null;
};

const JOURNAL_MAX = 600;

/** Demande à l'IA pour installer, configurer et vérifier un serveur MCP local. */
export function demandeInstallationMcp(serveur: ServeurDemande, ctx: ContexteDemande): string {
  const nom = serveur.name.trim() || "sans nom";
  const commande = commandeServeur(serveur);
  const prerequis = prerequisCommande(serveur.command);
  const aRemplacer = valeursARemplacer(serveur.args);
  const variables = (serveur.env ?? []).map((v) => v.key).filter(Boolean);
  const lignes: string[] = [];

  if (ctx.erreur) {
    lignes.push(`Le serveur MCP « ${nom} » ne fonctionne pas sur ce poste (${ctx.systeme}) : ${ctx.erreur.titre}.`);
  } else {
    lignes.push(`Installe et configure le serveur MCP « ${nom} » sur ce poste (${ctx.systeme}).`);
  }
  lignes.push(`Il est lancé par la commande : ${commande}`);
  lignes.push(`Il est déjà enregistré dans Réglages → MCP sous le nom « ${nom} ».`);
  if (variables.length) {
    lignes.push(`Variables déjà enregistrées (valeurs non recopiées ici) : ${variables.join(", ")}.`);
  }
  if (ctx.note?.trim()) lignes.push(`Remarque : ${ctx.note.trim()}`);
  const journal = ctx.erreur?.journal ? masquerSecrets(ctx.erreur.journal).trim() : "";
  if (journal) {
    const court = journal.length > JOURNAL_MAX ? `…${journal.slice(-JOURNAL_MAX)}` : journal;
    lignes.push("", "Journal du test :", "```", court, "```");
  }

  lignes.push("");
  let n = 0;
  const etape = (texte: string) => lignes.push(`${++n}. ${texte}`);
  if (prerequis) etape(`Vérifie que ${prerequis} est installé et trouvé par l'application ; sinon installe-le pour ${ctx.systeme}.`);
  else etape(`Vérifie que le programme « ${serveur.command.trim()} » est installé et trouvé par l'application ; sinon installe-le pour ${ctx.systeme}.`);
  if (aRemplacer.length) etape(`Demande-moi les valeurs à mettre à la place de ${aRemplacer.join(", ")}.`);
  if (ctx.erreur) etape("Trouve la cause de l'erreur et corrige-la.");
  etape("Lance la commande une fois pour vérifier qu'elle démarre sans erreur (elle attend ensuite des messages MCP : arrête-la après quelques secondes).");
  etape("Vérifie que le serveur répond et liste ses outils.");
  return lignes.join("\n");
}

// ---- Livraison dans le chat ----------------------------------------------------

export const EVENEMENT_DEMANDE_IA = "axecode:demande-ia";

export type DemandeIa = { texte: string };

/**
 * Prépare `texte` dans la saisie de la conversation active (jamais envoyé seul).
 * L'espace qui affiche les réglages les ferme et montre la conversation.
 */
export function confierALIa(texte: string, cible: EventTarget | null = typeof window === "undefined" ? null : window): void {
  const propre = texte.trim();
  if (!propre || !cible) return;
  cible.dispatchEvent(new CustomEvent<DemandeIa>(EVENEMENT_DEMANDE_IA, { detail: { texte: propre } }));
}

/** Espace : reçoit les demandes (retirer : la fonction rendue). */
export function ecouterDemandesIa(
  recevoir: (texte: string) => void,
  cible: EventTarget | null = typeof window === "undefined" ? null : window,
): () => void {
  if (!cible) return () => undefined;
  const f = (e: Event) => {
    const texte = (e as CustomEvent<DemandeIa>).detail?.texte;
    if (texte) recevoir(texte);
  };
  cible.addEventListener(EVENEMENT_DEMANDE_IA, f);
  return () => cible.removeEventListener(EVENEMENT_DEMANDE_IA, f);
}
