// Agents en ligne de commande dans le banc : catalogue réel (fichier de données du Rust),
// détection simulée (Claude Code, Codex et OpenCode installés), réglages gardés en mémoire,
// terminal d'agent simulé (sortie d'un agent, puis attente, fin ou rien selon la scène).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { emit } from "@tauri-apps/api/event";
import catalogue from "../../../crates/axecode-agents/catalogue-cli.json";

const INSTALLES: Record<string, string> = {
  claude: "C:\\Users\\moi\\.local\\bin\\claude.exe",
  codex: "C:\\Users\\moi\\AppData\\Roaming\\npm\\codex.cmd",
  opencode: "C:\\Users\\moi\\.opencode\\bin\\opencode.exe",
};

const SORTIE_AGENT = [
  "\x1b[1m✻ Claude Code\x1b[0m  ·  dossier : axecode\r\n\r\n",
  "> Corrige l'alignement des onglets du terminal à 800 px\r\n\r\n",
  "● Je lis src/components/TerminalPanel.tsx et src/styles.css…\r\n",
  "● Update(src/styles.css)\r\n  ⎿  2 lignes modifiées\r\n\r\n",
].join("");

/** Options de scène : « agentsCliAutonomie » (ids en autonomie complète), « agentCli » :
 *  "attend" (BEL après la sortie), "fini" (code 0), "echec" (code 1) ; sinon il travaille. */
export function simulationAgentsCli(scene: Record<string, unknown>) {
  const reglages: Record<string, any> = {};
  for (const id of (scene.agentsCliAutonomie as string[] | undefined) ?? []) reglages[id] = { autonomie: true };
  const etat = () =>
    (catalogue as any).agents.map((a: any) => ({
      alias: [], args: [], autonomie: [], autonomieEnv: {}, invites: [], ...a,
      installe: a.id in INSTALLES,
      chemin: INSTALLES[a.id] ?? null,
      reglage: { autonomie: false, ...(reglages[a.id] ?? {}) },
    }));
  const terminalAgent = (a: any) => {
    const sessionId = String(a?.sessionId ?? "");
    const token = String(a?.token ?? "");
    const envoyer = (data: string, delai: number) =>
      window.setTimeout(() => void emit("terminal-data", { sessionId, token, data }), delai);
    envoyer(SORTIE_AGENT, 60);
    if (scene.agentCli === "attend") envoyer("\r\n? pour les raccourcis\x07", 160);
    if (scene.agentCli === "fini" || scene.agentCli === "echec") {
      window.setTimeout(() => void emit("terminal-exit", { sessionId, token, exitCode: scene.agentCli === "fini" ? 0 : 1, signal: null }), 200);
    }
    return { sessionId };
  };
  return {
    agents_cli_etat: () => etat(),
    agents_cli_enregistrer: (a: any) => {
      for (const k of Object.keys(reglages)) delete reglages[k];
      Object.assign(reglages, a?.reglages?.agents ?? {});
      return etat();
    },
    spawn_agent_terminal: (a: any) => terminalAgent(a),
    git_create_worktree_command: (a: any) => ({
      worktreePath: `${String(a?.workspacePath ?? "C:\\banc")}-${String(a?.branchName ?? "agent").replace(/[^a-z0-9]+/gi, "-")}`,
      branch: String(a?.branchName ?? "agent"), pushed: false, message: "Arbre de travail créé.", warning: null,
    }),
  } as Record<string, (a: any, brut: any) => unknown>;
}
