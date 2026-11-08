// Agents en ligne de commande (Claude Code, Codex, Gemini CLI…) : types, appels à
// l'appli et petites fonctions pures (testées par tests/agentsCli.test.cjs).
// Le catalogue lui-même est un fichier de données lu côté Rust
// (crates/axecode-agents/catalogue-cli.json).
import { invoke } from "@tauri-apps/api/core";

export type ReglageAgentCli = {
  /** Arguments de lancement (une ligne, guillemets acceptés) ; absent : ceux du catalogue. */
  args?: string;
  /** Autonomie complète : l'agent agit sans demander. */
  autonomie: boolean;
  /** Exécutable choisi à la main, s'il n'est pas sur le PATH. */
  chemin?: string;
};

export type AgentCli = {
  id: string;
  nom: string;
  commande: string;
  alias: string[];
  args: string[];
  autonomie: string[];
  autonomieLot?: string[] | null;
  autonomieEnv: Record<string, string>;
  reprise?: string[] | null;
  nonInteractif?: string[] | null;
  modele?: string[] | null;
  installation: string;
  invites: string[];
  installe: boolean;
  chemin?: string | null;
  reglage: ReglageAgentCli;
};

export type ReglagesAgentsCli = { agents: Record<string, ReglageAgentCli> };

/** Catalogue, détection (PATH) et réglages de chaque agent. */
export function lireAgentsCli(): Promise<AgentCli[]> {
  return invoke<AgentCli[]>("agents_cli_etat");
}

/** Enregistre les réglages ; renvoie l'état relu (détection comprise). */
export function enregistrerAgentsCli(reglages: ReglagesAgentsCli): Promise<AgentCli[]> {
  return invoke<AgentCli[]>("agents_cli_enregistrer", { input: { reglages } });
}

/** Découpe une ligne d'arguments comme un shell simple (même règle que le Rust). */
export function decouperArgs(ligne: string): string[] {
  const args: string[] = [];
  let courant = "";
  let guillemet: string | null = null;
  let present = false;
  for (const c of ligne) {
    if (guillemet) {
      if (c === guillemet) guillemet = null;
      else courant += c;
    } else if (c === '"' || c === "'") {
      guillemet = c;
      present = true;
    } else if (/\s/.test(c)) {
      if (present) {
        args.push(courant);
        courant = "";
        present = false;
      }
    } else {
      courant += c;
      present = true;
    }
  }
  if (present) args.push(courant);
  return args;
}

/** Arguments d'un terminal d'agent : reprise, arguments de lancement, autonomie. */
export function argsInteractifs(agent: Pick<AgentCli, "args" | "autonomie" | "reprise">, reglage: ReglageAgentCli, reprendre = false): string[] {
  const args: string[] = [];
  if (reprendre && agent.reprise) args.push(...agent.reprise);
  args.push(...(reglage.args !== undefined ? decouperArgs(reglage.args) : agent.args));
  if (reglage.autonomie) args.push(...agent.autonomie);
  return args;
}

/** Ligne de commande lisible (aperçu) : les arguments à espaces entre guillemets. */
export function ligneAffichee(commande: string, args: string[]): string {
  const cite = (a: string) => (a === "" || /[\s"'$`]/.test(a) ? `"${a.replace(/(["\\$`])/g, "\\$1")}"` : a);
  return [commande, ...args].map(cite).join(" ");
}

/** Autonomie complète : drapeaux ou variables connus pour cet agent. */
export function autonomieDisponible(agent: Pick<AgentCli, "autonomie" | "autonomieEnv">): boolean {
  return agent.autonomie.length > 0 || Object.keys(agent.autonomieEnv ?? {}).length > 0;
}

/** Réglages à enregistrer : seuls ceux qui diffèrent du défaut. */
export function reglagesDepuis(agents: Pick<AgentCli, "id" | "reglage">[]): ReglagesAgentsCli {
  const sortie: ReglagesAgentsCli = { agents: {} };
  for (const a of agents) {
    const r = a.reglage;
    const propre: ReglageAgentCli = { autonomie: !!r.autonomie };
    if (r.args !== undefined) propre.args = r.args;
    if (r.chemin && r.chemin.trim()) propre.chemin = r.chemin.trim();
    if (propre.autonomie || propre.args !== undefined || propre.chemin) sortie.agents[a.id] = propre;
  }
  return sortie;
}

/** Titre d'un onglet d'agent : « Claude Code · mon-projet ». */
export function titreAgent(nom: string, dossier: string): string {
  const morceaux = dossier.replace(/[\\/]+$/, "").split(/[\\/]/);
  return `${nom} · ${morceaux[morceaux.length - 1] || dossier}`;
}

/** Branche d'un nouvel arbre de travail pour un agent : « agent/claude-20261108-143005 ». */
export function brancheAgent(id: string, date: Date): string {
  const d = (n: number) => String(n).padStart(2, "0");
  const horodatage = `${date.getFullYear()}${d(date.getMonth() + 1)}${d(date.getDate())}-${d(date.getHours())}${d(date.getMinutes())}${d(date.getSeconds())}`;
  return `agent/${id.replace(/[^a-z0-9-]/gi, "")}-${horodatage}`;
}

/** Lance un agent dans un terminal (pseudo-terminal) : son programme, pas un shell. */
export function lancerTerminalAgent(p: {
  dossier: string;
  cli: string;
  reprendre: boolean;
  sessionId: string;
  token: string;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}): Promise<{ sessionId: string }> {
  return invoke<{ sessionId: string }>("spawn_agent_terminal", { input: p });
}
