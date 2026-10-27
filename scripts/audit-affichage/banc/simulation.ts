// Simulation du backend Tauri pour le banc d'affichage (IPC, fenetres, evenements).
// Chaque commande inconnue renvoie null et est notee dans window.__bancInconnues.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mockIPC, mockWindows, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import * as D from "./donnees";
import { simulationCollegue } from "./collegue";

export type Scene = {
  /** Un fournisseur de modeles est connecte (sinon « Connect a provider »). */
  fournisseur?: boolean;
  /** Tour en cours sur la conversation active. */
  tour?: "aucun" | "en_cours" | "erreur";
  /** Sous-agents au travail sous la conversation active. */
  sousAgents?: number;
  /** Historique compacte (resume + marqueur). */
  compaction?: boolean;
  /** Conversation active (par defaut c-001, titre tres long). */
  active?: string;
  [cle: string]: unknown;
};

declare global {
  interface Window {
    __BANC_SCENE__?: Scene;
    __bancAppels?: Record<string, number>;
    __bancInconnues?: Record<string, unknown>;
    __bancEmettre?: (evenement: string, charge: unknown) => Promise<void>;
  }
}

export function lireScene(): Scene {
  try {
    const brut = new URLSearchParams(window.location.search).get("s");
    if (brut) return JSON.parse(brut) as Scene;
  } catch {
    /* scene illisible : scene par defaut */
  }
  return window.__BANC_SCENE__ ?? {};
}

/** Accelere les minuteries longues de la scene (attentes de 2 a 16 s de l'appli). */
function accelerer(min: number, max: number, facteur: number): void {
  const origine = window.setTimeout.bind(window);
  (window as any).setTimeout = (fn: TimerHandler, delai?: number, ...reste: unknown[]) =>
    origine(fn, typeof delai === "number" && delai >= min && delai <= max ? Math.round(delai / facteur) : delai, ...reste);
}

function evenementsTour(scene: Scene) {
  const ev: any[] = [{ type: "turn_started" }];
  ev.push({ type: "thinking_started" }, { type: "thinking_chunk", delta: "Je relis le journal du tour précédent avant de relancer le banc. " }, { type: "thinking_finished" });
  ev.push({ type: "text_started" }, { type: "text_chunk", delta: "Je relance le banc sur les quatre largeurs et les trois mises à l'échelle." }, { type: "text_finished" });
  ev.push({ type: "tool_started", id: "toolu_live1", name: "bash" });
  ev.push({ type: "tool_ready", id: "toolu_live1", summary: "node scripts/audit-affichage/lancer.mjs", args_pretty: "{\"command\": \"node scripts/audit-affichage/lancer.mjs\"}" });
  ev.push({ type: "tool_output_delta", id: "toolu_live1", delta: "Situation 1366x768@125% : 2 défauts\n" });
  if (scene.tour === "erreur") {
    ev.push({ type: "tool_finished", id: "toolu_live1", output: "Situation 1366x768@125% : 2 défauts\n", is_error: false, file_changes: [], images: [] });
    ev.push({ type: "error", message: "stream error: error decoding response body: connection closed before message completed (os error 10054)" });
  }
  return ev.map((event, i) => ({ sequence: i + 1, event }));
}

function sessions(scene: Scene) {
  const active = scene.active ?? D.idConv(0);
  const n = scene.sousAgents ?? 0;
  const base = (id: string, name: string, parentId: string | undefined, status: string, i: number) => ({
    id, parentId, name, workspaceId: D.WS, model: { provider: "anthropic", name: "claude-opus-5-5" }, status,
    createdAtMs: D.T0 - i * 60_000, updatedAtMs: D.T0 - i * 30_000, children: [], entryCount: 40 + i, archived: false,
  });
  const out: any[] = D.conversations().map((c, i) => base(c.id, c.title, undefined, i === 0 && scene.tour === "en_cours" ? "running" : "idle", i));
  const noms = ["audit-affichage", "construction-windows-0.1.57", "tri-tickets", "verif-planche", "rapport-dmarc"];
  for (let i = 0; i < n; i += 1) out.push(base(`sa-${i + 1}`, noms[i % noms.length], active, "running", i));
  return out;
}

export function installerSimulation(scene: Scene): void {
  const appels: Record<string, number> = {};
  const inconnues: Record<string, unknown> = {};
  window.__bancAppels = appels;
  window.__bancInconnues = inconnues;
  const fournisseur = scene.fournisseur !== false;
  const active = scene.active ?? D.idConv(0);
  const tourActif = scene.tour === "en_cours" || scene.tour === "erreur";
  const cloud = scene.cloud !== false;
  if (scene.accelerer) accelerer(900, 16_001, 25);
  let mcp: any[] = ((scene.mcp as string[] | undefined) ?? []).map((nom) => ({ id: `cat_${nom}`, name: nom, command: "npx", args: ["-y", `@exemple/${nom}`], env: [], headers: [], enabled: true }));
  const statut = (connecte: boolean) => ({ connected: connecte, connectionState: connecte ? "connected" : "disconnected", email: connecte ? "utilisateur@exemple.invalid" : null, error: null });
  const h: Record<string, (a: any, brut: any) => unknown> = {
    // Scène « maj-badge » : une version disponible (badge discret, installation sur clic seulement).
    updater_check: () =>
      scene.majDispo
        ? { available: true, currentVersion: "0.1.67", version: String(scene.majDispo), notes: "Badge de mise à jour discret : plus d'installation forcée.\nCorrection de l'installeur relancé après une mise à jour réussie.", date: null }
        : { available: false, currentVersion: "0.1.57", version: null, notes: null, date: null },
    updater_current_version: () => "0.1.57",
    // API Tauri getVersion (Réglages > À propos).
    "plugin:app|version": () => "0.1.67",
    cloud_state: () =>
      cloud
        ? { connected: true, base: "https://cloud.exemple.invalid", email: "utilisateur@exemple.invalid", role: "admin", expireLe: "2026-11-21T08:00:00Z", poste: "PC-POSTE", connectionId: "cloud" }
        : { connected: false, base: "https://cloud.exemple.invalid", email: "", role: "", expireLe: "", poste: "", connectionId: "cloud" },
    daemon_call: (a) => {
      switch (a.method) {
        case "fs.list":
          return ["projets", "clients", "factures", "documentation-client", "FIC_axe", ".axecode"].map((name) => ({ name, kind: "directory" }));
        case "status":
          return { running: true, version: "0.1.57", sessions: { total: 12, running: 2, idle: 10, inactive: 0 } };
        case "agents.list":
          return { agents: [] };
        case "sessions.history":
          return [];
        // axe:commandes — indicateurs /heartbeat et /goal (scène « commandes »).
        case "sessions.commands_state":
          return scene.commandes ?? { goal: null, heartbeat: null, autonomous: null };
        case "sessions.commands_set": {
          const etat: any = { ...((scene.commandes as any) ?? {}) };
          if (a.params?.op === "heartbeat_off") etat.heartbeat = null;
          if (a.params?.op === "goal_clear") etat.goal = null;
          // axe:guet — Annuler / Tout annuler.
          if (typeof a.params?.op === "string" && a.params.op.startsWith("guet_annuler")) {
            const cible = a.params.op.split(":")[1];
            etat.guets = cible ? (etat.guets ?? []).filter((g: any) => g.id !== cible) : [];
          }
          if (a.params?.op === "goal_pause" && etat.goal) etat.goal = { ...etat.goal, status: "paused" };
          scene.commandes = etat;
          return etat;
        }
        default:
          return null;
      }
    },
    freechat_index: () => ({ scratchRoot: "C:\\Users\\utilisateur\\AppData\\Local\\ancien-editeur\\axecode\\data\\libre", conversations: D.conversations(6).map((c) => ({ ...c, workspaceId: "C:\\Users\\utilisateur\\AppData\\Local\\ancien-editeur\\axecode\\data\\libre", messageCount: 12 })) }),
    // Conversation sans dossier (layout « chat ») : même amorce qu'un espace, racine = dossier « libre ».
    freechat_open: () => ({
      workspace: { path: D.WS, name: "libre" },
      conversations: listeConversations(),
      activeConversation: D.conversationSauvee(active, { compaction: !!scene.compaction }),
      modeModelSettings: D.MODES,
    }),
    list_active_turns: () => (tourActif ? [{ workspaceId: D.WS, conversationId: active, startedAtMs: Date.now() - 95_000, latestSequence: evenementsTour(scene).length }] : []),
    replay_active_turn_events: (a) => {
      const id = a.conversationId ?? a.input?.conversationId;
      if (!tourActif || id !== active) return { active: false, workspaceId: D.WS, conversationId: id, latestSequence: 0, events: [] };
      const events = evenementsTour(scene);
      return { active: true, workspaceId: D.WS, conversationId: id, startedAtMs: Date.now() - 95_000, latestSequence: events.length, events };
    },
    connections_list: () => ({ active: "local", connections: [{ id: "local", name: "Ce PC", kind: "local" }] }),
    connections_state: () => ({ local: "connected" }),
    connections_set_active: () => null,
    open_workspace: () => ({
      workspace: { path: D.WS, name: D.NOM_WS },
      conversations: listeConversations(),
      activeConversation: D.conversationSauvee(active, { compaction: !!scene.compaction }),
      modeModelSettings: D.MODES,
    }),
    list_conversations: () => listeConversations(),
    load_conversation: (a) => {
      // Conversation supprimee ailleurs (autre poste, archive) : le chargement echoue.
      if (String(a.conversationId ?? "").startsWith("x-")) throw new Error(`conversation introuvable : ${a.conversationId}`);
      return chargerConversation(a);
    },
    _charger_conversation: (a) => D.conversationSauvee(a.conversationId ?? D.idConv(0), { compaction: !!scene.compaction && (a.conversationId ?? "") === active, long: (a.conversationId ?? "") === active }),
    estimate_context: () => D.contexte(scene.compaction ? 30_000 : 92_000),
    estimate_sub_agent_context: () => D.contexte(40_000),
    list_configured_model_providers: () => (fournisseur ? ["anthropic", "openai"] : []),
    list_openrouter_models: () => [],
    provider_settings_get: () => ({ providers: [], modelOverrides: {}, kinds: [] }),
    get_openai_provider_status: () => statut(fournisseur),
    get_anthropic_provider_status: () => statut(fournisseur),
    get_google_provider_status: () => statut(false),
    get_kimi_provider_status: () => statut(false),
    get_openrouter_provider_status: () => ({ ...statut(false), hasApiKey: false }),
    daemon_sessions: () => sessions(scene),
    list_workspace_entries_command: (a) => {
      const dossier = a.relativePath ?? a.input?.relativePath ?? "";
      const liste = D.entrees(dossier);
      // axe:html — scènes « html-* » : une page HTML à la racine de l'espace.
      if (scene.fichierHtml && !dossier) liste.push({ name: "page.html", relativePath: "page.html", absolutePath: D.WS + "\\page.html", kind: "file", hasChildren: false });
      return liste;
    },
    read_workspace_file_command: (a) => {
      const rel = a.input?.relativePath ?? a.relativePath ?? "";
      const content = rel === "page.html" ? D.PAGE_HTML : "";
      return { name: rel.split("/").pop(), relativePath: rel, absolutePath: D.WS + "\\" + rel.replace(/\//g, "\\"), editable: true, content, reason: null, size: content.length, lastModifiedMs: D.T0, imageMediaType: null, imageData: null };
    },
    list_workspace_files_command: () => D.entrees(""),
    // axe:explorateur — « Ouvrir avec… » et « Ouvrir dans l'explorateur » (comptés dans __bancAppels).
    open_workspace_entry_with_command: () => null,
    reveal_workspace_entry_command: () => null,
    git_repository_snapshot_command: () => D.git(),
    provider_quota: () => ({
      fetchedAtMs: Date.now(),
      providers: fournisseur
        ? [{ provider: "anthropic", label: "Claude", supported: true, error: null, windows: [
            { id: "five_hour", label: "5 h", utilization: 64, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), projectedExhaustionMs: null, exhaustsBeforeReset: false },
            { id: "seven_day", label: "7 j", utilization: 81, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), projectedExhaustionMs: null, exhaustsBeforeReset: false },
          ] }]
        : [],
    }),
    shared_skills_fingerprints: () => ({}),
    harness_list: () => [],
    harness_paths: () => ({ globalRoot: "C:\\Users\\utilisateur\\.axecode", projectRoot: D.WS + "\\.axecode" }),
    harness_refinements: () => [],
    // Serveurs MCP de la scène (« mcp » : noms) ; enregistrer / supprimer modifient la liste.
    list_mcp_settings: () => ({ servers: mcp.map((s) => ({ ...s })) }),
    save_mcp_settings: (a) => {
      mcp = (a.settings?.servers ?? []).map((s: any) => ({ ...s }));
      return { servers: mcp };
    },
    delete_mcp_server: (a) => {
      // Comme le moteur : par identifiant, sinon par nom.
      const cible = mcp.find((s) => s.id === a.serverId) ?? mcp.find((s) => s.name === a.serverName);
      if (!cible) throw new Error(`Serveur MCP introuvable : ${a.serverName ?? a.serverId}`);
      mcp = mcp.filter((s) => s !== cible);
      return { servers: mcp.map((s) => ({ ...s })) };
    },
    probe_mcp_tools: () =>
      mcp.map((s) => ({ serverId: s.id, serverName: s.name, enabled: s.enabled, ok: s.enabled, tools: s.enabled ? [{ toolName: "lire", description: "Lire" }] : [], transport: "stdio", authRequired: false, authenticated: false, error: null })),
    prime_term_open: () => "prime-1",
    prime_term_resize: () => null,
    prime_term_write: () => null,
    cancel_turn: () => true,
    list_tool_settings: () => ({
      tools: [{ name: "agent", description: "Sous-agents", defaultDescription: "Sous-agents", enabled: true }],
      planModePrompt: "", defaultPlanModePrompt: "", imageProvider: "gptImage2", openaiImageUseSubscription: true,
      openaiImageApiKey: "", nanoBananaApiKey: "", webSearchProvider: "classic", linkupApiKey: "",
    }),
    // axe:couleurs — skills activés de l'espace (scène « couleurs »).
    list_installed_skills_command: () =>
      ((scene.skills as string[] | undefined) ?? []).map((name) => ({
        name, description: "Skill du banc", source: "workspace", rootLabel: "Espace",
        absolutePath: `/banc/.axecode/skills/${name}/SKILL.md`, content: "", enabled: true,
      })),
    list_archived_local: () => D.conversations(3).map((c) => ({ ...c, id: "arch-" + c.id, archived: true })),
    watch_workspace_command: () => true,
    unwatch_workspace_command: () => true,
    compact_conversation: () => null,
    send_message: () => null,
    remote_get_status: () => ({ enabled: false, relayUrl: "", pcId: "pc-poste", relayConnected: false, reachable: false, pairing: null, devices: [] }),
    "plugin:window|is_maximized": () => false,
    "plugin:window|is_fullscreen": () => false,
    "plugin:window|is_focused": () => true,
    "plugin:window|scale_factor": () => window.devicePixelRatio,
    "plugin:window|inner_size": () => ({ width: window.innerWidth * window.devicePixelRatio, height: window.innerHeight * window.devicePixelRatio }),
    "plugin:window|title": () => "Axecode",
  };
  // Conversation listee mais illisible (fichier abime, moteur en erreur) : scene « colonne-introuvable ».
  function listeConversations() {
    const liste = D.conversations();
    if (scene.conversationIllisible) liste.push({ id: "x-404", title: "Ancienne conversation au fichier abîmé", updatedAtMs: D.T0 - 99 * 3_600_000 });
    return liste;
  }
  function chargerConversation(a: any) {
    return h._charger_conversation(a, a);
  }
  // Scène « fichiers » : un fichier de chaque type servi depuis /fixtures/ (preuve des visionneuses).
  if ((scene as any).fichiers) {
    const noms: string[] = (scene as any).fichiers;
    const octets = async (n: string) => new Uint8Array(await (await fetch("/fixtures/" + n)).arrayBuffer());
    const nom = (a: any) => String(a.relativePath ?? a.path ?? a.absolutePath ?? "").split(/[\\/]/).pop()!;
    const IMG: Record<string, string> = { png: "image/png" };
    Object.assign(h, {
      list_workspace_entries_command: () => noms.map((n) => ({ name: n, relativePath: n, absolutePath: D.WS + "\\" + n, kind: "file", hasChildren: false })),
      list_workspace_files_command: () => noms.map((n) => ({ name: n, relativePath: n, absolutePath: D.WS + "\\" + n, kind: "file", hasChildren: false })),
      read_workspace_file_command: async (a: any) => {
        const n = nom(a); const b = await octets(n); const ext = n.split(".").pop()!;
        const texte = ["md", "svg", "csv", "json"].includes(ext);
        let bin = ""; if (IMG[ext]) for (const x of b) bin += String.fromCharCode(x);
        return { name: n, relativePath: n, absolutePath: D.WS + "\\" + n, editable: texte, content: texte ? new TextDecoder().decode(b) : null,
          reason: texte ? null : "binary", size: b.length, lastModifiedMs: D.T0, imageMediaType: IMG[ext] ?? null, imageData: IMG[ext] ? btoa(bin) : null };
      },
      viewer_read_bytes: async (a: any) => { const b = await octets(nom(a)); return b.slice(a.offset, a.offset + a.length).buffer; },
    });
  }
  // Scène « collegue » : espace Axe Cloud d'un collègue sans fournisseur sur son PC.
  if (scene.collegue) Object.assign(h, simulationCollegue(scene, { ...h }));
  mockWindows("main");
  mockConvertFileSrc("windows");
  mockIPC(
    (cmd, args) => {
      appels[cmd] = (appels[cmd] ?? 0) + 1;
      const a: any = (args as any)?.input ?? args ?? {};
      const f = h[cmd];
      if (f) return f(a, args);
      if (cmd.startsWith("plugin:")) return null;
      if (!(cmd in inconnues)) inconnues[cmd] = args ?? null;
      return null;
    },
    { shouldMockEvents: true },
  );
  window.__bancEmettre = (evenement, charge) => emit(evenement, charge);
}
