// Typed wrappers over the session service (daemon) IPC for the Agents view and /tree.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cloudRpc } from "../../lib/ipc";
import { connectionArg, getActiveConnection } from "../settings/connectionsApi"; // axe:remote

export type SessionStatus = "running" | "idle" | "inactive";

// axe:agents — external agents of the service (`agents.*` RPC). The tasks live
// on the service under <workspace>/.axecode/agents; statuses are the service's.
export type ServiceAgentStatus = "en_attente" | "en_cours" | "termine" | "erreur" | "arrete";

export type ServiceAgent = {
  id: string;
  label: string;
  commande: string;
  modele: string;
  statut: ServiceAgentStatus;
  debutMs?: number | null;
  finMs?: number | null;
  codeSortie?: number | null;
  resume?: string | null;
  journalTaille?: number;
};

export type ServiceAgentDetail = {
  id: string;
  label: string;
  statut: ServiceAgentStatus;
  debutMs?: number | null;
  finMs?: number | null;
  codeSortie?: number | null;
  journal?: string;
};

export type ServiceAgentResult = {
  id: string;
  present: boolean;
  resultat?: string | null;
};

export type ServiceAgentSpawn = {
  brief: string;
  label?: string;
  commande: string;
  modele?: string;
};

export type SessionMeta = {
  id: string;
  parentId?: string;
  name: string;
  workspaceId: string;
  model: { provider: string; name: string };
  status: SessionStatus;
  createdAtMs: number;
  updatedAtMs: number;
  children: string[];
  leaf?: string;
  entryCount: number;
  archived?: boolean;
  /** axe:freechat — free conversation (private scratch folder, no project). */
  scratch?: boolean;
};

export type JournalEntry = {
  id: string;
  parent?: string;
  ts: number;
  /** Entry kind (flattened payload fields live on the entry itself). */
  kind: string;
  [key: string]: unknown;
};

export type JournalTree = {
  sessionId: string;
  leaf?: string;
  entries: JournalEntry[];
  branches: { leaf: string; label?: string; ts: number }[];
};

export type DaemonEvent = {
  event: "status" | "entry" | "stream" | "daemon" | "connection";
  sessionId?: string;
  data?: unknown;
  /** axe:remote — set for events of a remote connection (absent = local). */
  connectionId?: string;
};

// axe:remote — every call targets the active connection unless `connection` is given.
const call = <T,>(method: string, params: Record<string, unknown> = {}, connection?: string) =>
  invoke<T>("daemon_call", {
    input: { method, params, connection: connectionArg(connection ?? getActiveConnection()) },
  });

export const agentsApi = {
  list: (connection?: string) =>
    invoke<SessionMeta[]>("daemon_sessions", { connection: connectionArg(connection ?? getActiveConnection()) }),
  history: (sessionId: string, connection?: string) =>
    call<unknown[]>("sessions.history", { sessionId }, connection),
  create: (name: string, workspaceId: string, model: { provider: string; name: string }, connection?: string) =>
    call<SessionMeta>("sessions.create", { name, workspaceId, model }, connection),
  call,
  tree: (sessionId: string, connection?: string) => call<JournalTree>("sessions.tree", { sessionId }, connection),
  send: (sessionId: string, text: string, connection?: string) =>
    call<{ entryId: string }>("sessions.send", { sessionId, text }, connection),
  message: (sessionId: string, text: string, connection?: string) =>
    call<{ entryId: string }>("sessions.message", { sessionId, text, from: "user" }, connection),
  stop: (sessionId: string, connection?: string) => call<{ ok: boolean }>("sessions.stop", { sessionId }, connection),
  moveLeaf: (sessionId: string, entryId: string, label?: string, connection?: string) =>
    call<{ entryId: string }>("sessions.move_leaf", { sessionId, entryId, label }, connection),
  // axe:sub-m — change the model of an idle session.
  setModel: (sessionId: string, model: { provider: string; name: string }, connection?: string) =>
    call<{ ok: boolean }>("sessions.set_model", { sessionId, model }, connection),
  // axe:arriere-plan — parentId : parent du clone (défaut côté service : le parent de la source).
  fork: (sessionId: string, entryId?: string, name?: string, connection?: string, parentId?: string) =>
    call<SessionMeta>("sessions.fork", { sessionId, entryId, name, parentId }, connection),
  get: (sessionId: string, connection?: string) =>
    call<SessionMeta>("sessions.get", { sessionId }, connection),
  onEvent: (handler: (event: DaemonEvent) => void): Promise<UnlistenFn> =>
    listen<DaemonEvent>("axe://daemon", (e) => handler(e.payload)),
};

// axe:agents — external agents (CLI launched by the service, `.axecode/agents`).
// These methods only exist on the service: callers pass the cloud connection.
export const serviceAgentsApi = {
  list: (connection: string) =>
    cloudRpc<{ agents?: ServiceAgent[] } | ServiceAgent[]>(connection, "agents.list", {}).then(
      (r) => (Array.isArray(r) ? r : r?.agents ?? []),
    ),
  spawn: (input: ServiceAgentSpawn, connection: string) =>
    cloudRpc<{ id: string; statut: ServiceAgentStatus }>(connection, "agents.spawn", input),
  status: (id: string, connection: string) =>
    cloudRpc<ServiceAgentDetail>(connection, "agents.status", { id }),
  stop: (id: string, connection: string) =>
    cloudRpc<{ id: string; statut: ServiceAgentStatus }>(connection, "agents.stop", { id }),
  result: (id: string, connection: string) =>
    cloudRpc<ServiceAgentResult>(connection, "agents.result", { id }),
};

/** French label of a service agent status (never the raw enum). */
export const SERVICE_AGENT_LABEL: Record<ServiceAgentStatus, string> = {
  en_attente: "en attente",
  en_cours: "en cours",
  termine: "terminé",
  erreur: "échec",
  arrete: "arrêté",
};

/** The service's own message, cleaned of plumbing; never a raw "Error 500". */
export function agentErrorText(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).replace(/^Error:\s*/i, "").trim();
  if (!raw) return "Le service n'a pas pu répondre.";
  if (/^protocol error:\s*unknown method agents\./i.test(raw)) {
    return "Les agents externes ne sont pas encore disponibles sur ce service.";
  }
  if (
    /\bHTTP (500|502|503|504)\b/i.test(raw) ||
    /^(error\s*)?(500|502|503|504)$/i.test(raw) ||
    /daemon connection closed|timed out|not connected/i.test(raw)
  ) {
    return "Service injoignable pour l'instant : réessayez dans un instant.";
  }
  // Keep the service's own refusal (unknown command, cap reached…), only drop
  // the technical prefixes and capitalise the sentence.
  const cleaned = raw
    .replace(/^protocol error:\s*/i, "")
    .replace(/^agents:\s*/i, "")
    .trim();
  if (!cleaned) return raw;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "en cours",
  idle: "inactif",
  inactive: "déchargé",
};

/** One-line human summary of a journal entry. */
export function describeEntry(entry: JournalEntry): string {
  const k = entry;
  const clip = (s: unknown, n = 90) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  switch (k.kind) {
    case "message": {
      const msg = k.message as { role?: string; parts?: { type?: string; text?: string }[] } | undefined;
      const text = (msg?.parts ?? []).map((p) => p.text ?? "").join(" ");
      return `${msg?.role === "assistant" ? "Agent" : "Vous"} : ${clip(text) || "(outil)"}`;
    }
    case "repl_call":
      return `python : ${clip(String(k.code ?? "").split("\n")[0], 70)}`;
    case "repl_result":
      return `${k.is_error ? "erreur" : "résultat"} : ${clip(k.output, 70)}`;
    case "compaction":
      return `compactage : ${clip(k.summary, 70)}`;
    case "model_switch":
      return "changement de modèle";
    case "refinement":
      return `affinage ${String(k.refinement_id ?? "")}`;
    case "peer_message":
      return `message de ${String(k.from_session ?? "?")} : ${clip(k.text, 60)}`;
    case "extension":
      return `${String(k.name ?? "extension")}`;
    case "pointer":
      return `retour à un point${k.label ? ` (${String(k.label)})` : ""}`;
    case "session_created":
      return "création de la session";
    case "fork":
      return "bifurcation";
    default:
      return k.kind;
  }
}
