// axe:remote — typed wrappers over the connection registry IPC and the
// active connection shared by the sidebar, the Agents view and Settings > Service.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ConnectionKind = "local" | "remote" | "ssh";

export type SshTarget = {
  user: string;
  host: string;
  port: number;
  remotePort: number;
  identityFile?: string | null;
  startService: boolean;
  remoteCommand?: string | null;
};

export type Connection = {
  id: string;
  name: string;
  kind: ConnectionKind;
  url?: string;
  username?: string;
  ssh?: SshTarget | null;
  hasPassword?: boolean;
  hasToken?: boolean;
};

export type ConnectionsList = { active: string; connections: Connection[] };

export type ServiceStatus = {
  running?: boolean;
  version?: string;
  pid?: number;
  latencyMs?: number;
  listen?: string | null;
  sessions?: { total: number; running: number; idle: number; inactive: number };
};

export const LOCAL_CONNECTION = "local";

export const connectionsApi = {
  list: () => invoke<ConnectionsList>("connections_list"),
  save: (connection: Connection, secrets: { password?: string; token?: string } = {}) =>
    invoke<Connection>("connections_save", { input: { connection, ...secrets } }),
  remove: (id: string) => invoke<void>("connections_delete", { input: { id } }),
  setActive: (id: string) => invoke<void>("connections_set_active", { input: { id } }),
  test: (id: string) => invoke<ServiceStatus>("connections_test", { input: { id } }),
  state: () => invoke<Record<string, "connected" | "disconnected">>("connections_state"),
  onActiveChange: (handler: (active: string) => void): Promise<UnlistenFn> =>
    listen<{ active: string }>("axe://connection-active", (e) => handler(e.payload.active)),
};

/** Connection id argument for daemon IPC (`undefined` = local pipe). */
export const connectionArg = (id: string | undefined) =>
  id && id !== LOCAL_CONNECTION ? id : undefined;

export function describeConnection(c: Connection): string {
  if (c.kind === "local") return "Service de cette machine";
  if (c.kind === "ssh" && c.ssh) {
    const user = c.ssh.user ? `${c.ssh.user}@` : "";
    return `SSH ${user}${c.ssh.host}:${c.ssh.port}`;
  }
  return c.url ?? "";
}

/** Shared active-connection hook state (module-level so all views agree). */
let activeCache = LOCAL_CONNECTION;
const subscribers = new Set<(id: string) => void>();
let started = false;

function ensureStarted() {
  if (started) return;
  started = true;
  void connectionsApi
    .list()
    .then((l) => publish(l.active))
    .catch(() => undefined);
  void connectionsApi.onActiveChange(publish);
}

function publish(id: string) {
  activeCache = id || LOCAL_CONNECTION;
  subscribers.forEach((fn) => fn(activeCache));
}

export function subscribeActiveConnection(fn: (id: string) => void): () => void {
  ensureStarted();
  subscribers.add(fn);
  fn(activeCache);
  return () => subscribers.delete(fn);
}

export function getActiveConnection(): string {
  ensureStarted();
  return activeCache;
}

/** React hook: id of the active connection (updates on change). */
export function useActiveConnection(): string {
  const [id, setId] = useState(getActiveConnection);
  useEffect(() => {
    const off = subscribeActiveConnection(setId);
    return () => {
      off();
    };
  }, []);
  return id;
}