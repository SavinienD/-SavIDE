// Serveurs MCP de la page Réglages : état d'une ligne, sonde d'un serveur, serveurs internes d'un outil.
import type { McpServerConfig, McpServerProbe } from "../types";

export type TonServeur = "ok" | "off" | "pending" | "error" | "auth";

/** Sonde d'un serveur : par identifiant, sinon par nom (l'identifiant peut avoir été recalculé). */
export function sondeDuServeur(
  sondes: McpServerProbe[],
  serveur: Pick<McpServerConfig, "id" | "name">,
): McpServerProbe | null {
  return sondes.find((s) => s.serverId === serveur.id) ?? sondes.find((s) => s.serverName === serveur.name) ?? null;
}

const n = (k: number) => `${k} outil${k > 1 ? "s" : ""}`;

/** Libellé court de la ligne : « 4 outils », « Désactivé », « Erreur », « À connecter »… */
export function etatLigne(
  serveur: Pick<McpServerConfig, "enabled">,
  sonde: McpServerProbe | null,
  verification: boolean,
  connus?: number,
): { ton: TonServeur; libelle: string } {
  // Une sonde « Tester » d'un serveur désactivé reste affichée (outils listés), ton « off ».
  if (!serveur.enabled) {
    const outils = sonde?.ok && sonde.enabled ? sonde.tools.length : connus;
    return { ton: "off", libelle: outils != null ? `Désactivé · ${n(outils)}` : "Désactivé" };
  }
  if (!sonde) return { ton: "pending", libelle: verification ? "Vérification…" : "Non testé" };
  if (sonde.ok) return { ton: "ok", libelle: n(sonde.tools.length) };
  if (sonde.authRequired) return { ton: "auth", libelle: "À connecter" };
  return { ton: "error", libelle: "Erreur" };
}

const CODEX = /[\\/](?:OpenAI[\\/]Codex|\.codex)[\\/]/i;

/** Serveur qui n'appartient qu'à un autre outil (runtime de Codex) : texte court, sinon null. */
export function serveurInterne(serveur: { command?: string | null; args?: string[] }): string | null {
  const morceaux = [serveur.command ?? "", ...(serveur.args ?? [])];
  const trouve = morceaux.find((m) => CODEX.test(m) && /runtimes|node_repl/i.test(m));
  return trouve ? "outil interne de Codex" : null;
}
