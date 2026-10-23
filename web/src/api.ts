// axe:webui — HTTP (login) + WebSocket client of the session service.
// The WebSocket speaks the daemon JSON-lines protocol: one frame = one line.

export type SessionStatus = "running" | "idle" | "inactive";

export type ModelRef = { provider: string; name: string; effort?: string };

export type SessionMeta = {
  id: string;
  parentId?: string;
  name: string;
  workspaceId: string;
  model: ModelRef;
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

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_call_id: string; content: string; is_error?: boolean };

export type ChatMessage = { role: "user" | "assistant"; parts: Part[] };

export type JournalEntry = {
  id: string;
  parent?: string;
  ts: number;
  kind: string;
  [key: string]: unknown;
};

export type JournalTree = {
  sessionId: string;
  leaf?: string;
  entries: JournalEntry[];
};

export type ServerEvent = {
  event: "status" | "entry" | "stream" | "daemon";
  sessionId?: string;
  data?: any;
};

export type AuthState = {
  authenticated: boolean;
  loginRequired: boolean;
  user?: string | null;
  version?: string;
};

const CSRF = { "X-SavIDE": "1" };

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? CSRF : { ...CSRF, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
  return data as T;
}

export const auth = {
  state: () => http<AuthState>("GET", "/api/auth/state"),
  login: (username: string, password: string) =>
    http<{ ok: boolean }>("POST", "/api/auth/login", { username, password }),
  logout: () => http<{ ok: boolean }>("POST", "/api/auth/logout", {}),
};

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Reconnecting WebSocket client of the service protocol. */
export class ServiceClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: ServerEvent) => void>();
  private stateListeners = new Set<(connected: boolean) => void>();
  private closed = false;
  private retry = 500;
  private ready: Promise<void> | null = null;
  connected = false;

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 500;
        this.setConnected(true);
        this.call("hello", { client: `web: ${navigator.userAgent.slice(0, 60)}` }).catch(() => {});
        resolve();
      };
      ws.onmessage = (msg) => this.onLine(String(msg.data));
      ws.onerror = () => reject(new Error("connexion au service impossible"));
      ws.onclose = () => {
        this.setConnected(false);
        this.ready = null;
        for (const p of this.pending.values()) p.reject(new Error("connexion perdue"));
        this.pending.clear();
        if (!this.closed) {
          setTimeout(() => void this.connect().catch(() => {}), this.retry);
          this.retry = Math.min(this.retry * 2, 10_000);
        }
      };
    });
    return this.ready;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  private setConnected(value: boolean) {
    this.connected = value;
    for (const l of this.stateListeners) l(value);
  }

  private onLine(line: string) {
    let value: any;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof value.id === "number" && !value.event) {
      const p = this.pending.get(value.id);
      if (!p) return;
      this.pending.delete(value.id);
      if (value.error) p.reject(new Error(value.error));
      else p.resolve(value.result);
      return;
    }
    if (value.event) for (const l of this.listeners) l(value as ServerEvent);
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(handler: (e: ServerEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onState(handler: (connected: boolean) => void): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  // ---- typed helpers ---------------------------------------------------
  list = () => this.call<SessionMeta[]>("sessions.list");
  tree = (sessionId: string) => this.call<JournalTree>("sessions.tree", { sessionId });
  attach = (sessionId: string) => this.call("sessions.attach", { sessionId });
  detach = (sessionId: string) => this.call("sessions.detach", { sessionId });
  send = (sessionId: string, message: ChatMessage) =>
    this.call<{ entryId: string }>("sessions.send", { sessionId, message });
  stop = (sessionId: string) => this.call("sessions.stop", { sessionId });
  setModel = (sessionId: string, model: ModelRef) =>
    this.call("sessions.set_model", { sessionId, model });
  create = (request: { name: string; workspaceId: string; model: ModelRef; initialMessage?: string }) =>
    this.call<SessionMeta>("sessions.create", request);
  // axe:freechat — a free conversation: no folder, the service gives it a
  // private scratch folder. Named after its first message (like the IDE).
  createFree = (model: ModelRef, initialMessage?: string) =>
    this.create({ name: sessionName(initialMessage ?? ""), workspaceId: "", model, initialMessage });
}

export const service = new ServiceClient();

/** axe:freechat — first words of a message (same rule as the IDE). */
function sessionName(text: string): string {
  const clean = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = Array.from(clean);
  if (!chars.length) return "Nouvelle conversation";
  return chars.length <= 48 ? clean : `${chars.slice(0, 45).join("")}...`;
}
