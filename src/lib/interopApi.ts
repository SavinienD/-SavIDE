// IPC de la reprise : consignes du dossier, skills et serveurs
// MCP repris de Claude Code / Codex / Cursor / VS Code, validation des actions.
import { invoke } from "@tauri-apps/api/core";
import type { EtatDesConsignes } from "./consignes";

export const interopApi = {
  consignes: (workspacePath: string) =>
    invoke<EtatDesConsignes>("interop_consignes", { input: { workspacePath } }),
};
