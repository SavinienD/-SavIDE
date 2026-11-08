// simulation des commandes de la reprise (Claude Code, Codex…) pour le banc d'affichage :
// consignes du dossier, skills de Claude Code / Codex / adresse, serveurs MCP des autres
// outils, et actions à valider (mode « Demander avant d'agir »). Sans option de scène,
// rien n'est trouvé : aucune proposition ni carte ne s'affiche dans les autres scènes.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Scene } from "./simulation";

type Handler = (a: any, brut: any) => unknown;
const T0 = 1_793_890_000_000;

const CODE_LONG = [
  "import subprocess, pathlib",
  "# Nettoyer les sorties du banc puis relancer la construction Windows",
  "for p in pathlib.Path('/tmp').glob('banc*'):",
  "    shell.run(f'rm -rf {p}')",
  "r = shell.run('cargo xwin build --release --target x86_64-pc-windows-msvc', timeout=3600)",
  "print(r['exit_code'], r['output'][-2000:])",
].join("\n");

export function simulationInterop(scene: Scene, h: Record<string, Handler>): Record<string, Handler> {
  const actif = String(scene.active ?? "c-001");
  let defaut = scene.validationDefaut === "demander" ? "demander" : "autonome";
  const modes = new Map<string, string>();
  const demandes: any[] = scene.validation
    ? [
        { id: "d-1", sessionId: actif, racineId: actif, nomSession: "Conversation du banc", dossier: "C:\\Users\\utilisateur\\Documents\\Projets\\savide", outil: "python", callId: "toolu_1", code: CODE_LONG, creeLe: T0 },
        ...(scene.validation === "deux"
          ? [{ id: "d-2", sessionId: "sa-1", racineId: actif, parentId: actif, nomSession: "construction-windows-0.1.57", dossier: "C:\\Users\\utilisateur\\Documents\\Projets\\savide", outil: "python", callId: "toolu_2", code: "files.delete('cible/ancienne-version.zip')", creeLe: T0 + 1 }]
          : []),
      ]
    : [];
  const modeDe = (id?: string) => {
    if (!id) return { mode: defaut, defaut };
    const explicite = modes.get(id);
    return { mode: explicite ?? (scene.validation ? "demander" : defaut), explicite: explicite ?? null, defaut };
  };
  const daemonAvant = h.daemon_call;
  return {
    interop_consignes: () => ({
      plafond: 64000,
      sources: [
        { fichier: "AGENTS.md", chemin: "C:\\Users\\utilisateur\\Documents\\Projets\\savide\\AGENTS.md", caracteres: 16345, retenus: 16345, etat: "lu" },
        { fichier: "CLAUDE.md", chemin: "C:\\Users\\utilisateur\\Documents\\Projets\\savide\\CLAUDE.md", caracteres: 16345, retenus: 0, etat: "doublon", detail: "même contenu que AGENTS.md" },
        { fichier: ".claude/CLAUDE.md", chemin: "C:\\Users\\utilisateur\\Documents\\Projets\\savide\\.claude\\CLAUDE.md", caracteres: 0, retenus: 0, etat: "absent" },
      ],
    }),
    interop_skills_lister: () =>
      scene.skillsExternes
        ? [
            { chemin: "C:\\Users\\utilisateur\\.claude\\skills\\revue-pr", nom: "revue_pr", nomSource: "revue-pr", description: "Relire une pull request avant fusion : diff, tests, risques, et une liste de remarques classées.", outil: "claude_code", portee: "global", racine: "~/.claude/skills", fichiers: 3, octets: 5400, empreinte: "a", etat: "nouveau" },
            { chemin: "C:\\Users\\utilisateur\\.claude\\skills\\frontend-design", nom: "frontend_design", nomSource: "frontend-design", description: "Interfaces soignées et sobres.", outil: "claude_code", portee: "global", racine: "~/.claude/skills", fichiers: 1, octets: 4100, empreinte: "b", etat: "importe", idHarnais: "frontend_design" },
            { chemin: "C:\\Users\\utilisateur\\.codex\\skills\\deploiement", nom: "deploiement", nomSource: "deploiement", description: "Publier une version : construction, signature, notes.", outil: "codex", portee: "global", racine: "~/.codex/skills", fichiers: 2, octets: 2048, empreinte: "c", etat: "mise_a_jour", idHarnais: "deploiement" },
            { chemin: "C:\\Users\\utilisateur\\.agents\\skills\\qcm", nom: "qcm", nomSource: "qcm", description: "Questions à cocher dans un fichier .md.", outil: "agents", portee: "global", racine: "~/.agents/skills", fichiers: 1, octets: 900, empreinte: "d", etat: "conflit", idHarnais: "qcm" },
          ]
        : [],
    interop_skills_importer: (a: any) => ({ faits: (a?.chemins ?? []).map((c: string) => c.split("\\").pop()), erreurs: [] }),
    interop_skills_url_apercu: (a: any) => ({
      jeton: "j1", url: a?.url ?? "", genre: "git", version: "4f2a9c1e7b3d",
      skills: [
        { sousDossier: "document-skills/pdf", nom: "pdf", nomSource: "pdf", description: "Lire, remplir et fusionner des PDF avec pypdf.", version: "1.2", fichiers: ["SKILL.md", "reference.md", "scripts/remplir.py"], octets: 18400, extrait: "---\nname: pdf\ndescription: Lire, remplir et fusionner des PDF avec pypdf.\n---\n\n# PDF\n\nUtiliser pypdf pour lire le texte, remplir les champs et fusionner.", etat: "nouveau" },
        { sousDossier: "document-skills/xlsx", nom: "xlsx", nomSource: "xlsx", description: "Classeurs Excel : lire, résumer, écrire des formules.", fichiers: ["SKILL.md"], octets: 9000, extrait: "# XLSX", etat: "mise_a_jour", idHarnais: "xlsx", versionInstallee: "1a2b3c4d5e6f" },
      ],
    }),
    interop_skills_url_installer: () => ({ faits: ["pdf"], erreurs: [] }),
    interop_skills_url_installes: () =>
      scene.skillsExternes ? [{ id: "xlsx", scope: "global", url: "https://github.com/anthropics/skills/tree/main/document-skills/xlsx", sousDossier: "document-skills/xlsx", version: "1a2b3c4d5e6f", importeLe: T0 }] : [],
    interop_skills_desinstaller: () => null,
    interop_mcp_scanner: () =>
      scene.mcpExternes
        ? [
            { cle: "claude_code|~/.claude.json|github", nom: "github", outil: "claude_code", fichier: "~/.claude.json", transport: "stdio", commande: "npx -y @modelcontextprotocol/server-github", variables: ["GITHUB_PERSONAL_ACCESS_TOKEN"], entetes: [], nomPris: false },
            { cle: "claude_code|.mcp.json|sentry", nom: "sentry", outil: "claude_code", fichier: ".mcp.json", transport: "http", commande: "", url: "https://mcp.sentry.dev/mcp?token=••••", variables: [], entetes: ["Authorization"], nomPris: false },
            { cle: "codex|~/.codex/config.toml|context7", nom: "context7", outil: "codex", fichier: "~/.codex/config.toml", transport: "stdio", commande: "npx -y @upstash/context7-mcp --api-key ••••", variables: [], entetes: [], nomPris: false, avertissement: "désactivé dans Codex" },
            { cle: "cursor|~/.cursor/mcp.json|github", nom: "github", outil: "cursor", fichier: "~/.cursor/mcp.json", transport: "stdio", commande: "npx -y @modelcontextprotocol/server-github", variables: [], entetes: [], nomPris: false, doublon: "même serveur que « github » (Claude Code)" },
            { cle: "cursor|~/.cursor/mcp.json|fetch", nom: "fetch", outil: "cursor", fichier: "~/.cursor/mcp.json", transport: "stdio", commande: "uvx mcp-server-fetch", variables: [], entetes: [], nomPris: true, doublon: "déjà configuré (« fetch »)" },
            { cle: "vscode|.vscode/mcp.json|playwright", nom: "playwright", outil: "vscode", fichier: ".vscode/mcp.json", transport: "stdio", commande: "npx @playwright/mcp@latest --output-dir C:\\Users\\utilisateur\\Documents\\Projets\\savide\\sorties", variables: ["CLE"], entetes: [], nomPris: false, avertissement: "valeur demandée par VS Code (${input:…}) : à saisir dans Réglages > MCP" },
          ]
        : [],
    interop_mcp_importer: (a: any) => ({ importes: (a?.cles ?? []).map((c: string) => c.split("|").pop()), erreurs: [] }),
    daemon_call: (a: any, brut: any) => {
      switch (a?.method) {
        case "approbation.liste":
          return demandes;
        case "approbation.repondre": {
          const i = demandes.findIndex((d) => d.id === a.params?.id);
          if (i >= 0) demandes.splice(i, 1);
          return { ok: true };
        }
        case "approbation.mode":
          return modeDe(a.params?.sessionId);
        case "approbation.regler":
          if (a.params?.sessionId) modes.set(a.params.sessionId, a.params.mode ?? defaut);
          else defaut = a.params?.mode ?? "autonome";
          return modeDe(a.params?.sessionId);
        default:
          return daemonAvant ? daemonAvant(a, brut) : null;
      }
    },
  };
}
