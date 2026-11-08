// IPC de la reprise : consignes du dossier, skills et serveurs
// MCP repris de Claude Code / Codex / Cursor / VS Code, validation des actions.
import { invoke } from "@tauri-apps/api/core";
import type { EtatDesConsignes } from "./consignes";
import type { ApercuUrl, RapportImport, SkillExterne, SkillInstalle } from "./skillsExternes";
import type { RapportMcp, ServeurTrouve } from "./importMcp";

export const interopApi = {
  consignes: (workspacePath: string) =>
    invoke<EtatDesConsignes>("interop_consignes", { input: { workspacePath } }),
  skillsLister: (workspacePath: string) =>
    invoke<SkillExterne[]>("interop_skills_lister", { input: { workspacePath } }),
  skillsImporter: (workspacePath: string, chemins: string[]) =>
    invoke<RapportImport>("interop_skills_importer", { input: { workspacePath, chemins } }),
  skillsUrlApercu: (workspacePath: string, url: string) =>
    invoke<ApercuUrl>("interop_skills_url_apercu", { input: { workspacePath, url } }),
  skillsUrlInstaller: (workspacePath: string, jeton: string, sousDossiers: string[], portee: "global" | "project") =>
    invoke<RapportImport>("interop_skills_url_installer", { input: { workspacePath, jeton, sousDossiers, portee } }),
  skillsUrlInstalles: (workspacePath: string) =>
    invoke<SkillInstalle[]>("interop_skills_url_installes", { input: { workspacePath } }),
  skillsDesinstaller: (workspacePath: string, id: string) =>
    invoke<null>("interop_skills_desinstaller", { input: { workspacePath, id } }),
  mcpScanner: (workspacePath?: string | null) =>
    invoke<ServeurTrouve[]>("interop_mcp_scanner", { input: { workspacePath: workspacePath ?? null } }),
  mcpImporter: (workspacePath: string | null | undefined, cles: string[]) =>
    invoke<RapportMcp>("interop_mcp_importer", { input: { workspacePath: workspacePath ?? null, cles } }),
};
