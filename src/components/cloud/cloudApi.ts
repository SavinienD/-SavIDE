// axe:cloud — typed wrappers over the Axe Cloud IPC (src-tauri/src/cloud.rs)
// and the JSON API of the Prime portal (/prime/api/*) and of the porte (/app/*).
// The app token never reaches this side: Rust adds it to every call.
import { invoke } from "@tauri-apps/api/core";
import { EDITION_LOCALE } from "../../lib/edition";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type CloudState = {
  connected: boolean;
  base: string;
  email: string;
  role: string;
  expireLe: string;
  poste: string;
  connectionId: string;
  /** Set when the porte answered 401 (token expired or revoked). */
  expired?: boolean;
  revoked?: boolean;
};

export type CloudReply<T> = { status: number; ok: boolean; data: T };

/** GET /app/moi (porte). */
export type AppMoi = {
  email: string;
  nom?: string;
  role: string;
  tenant?: string;
  atelier: boolean;
  chat_techs: boolean;
  expire_le?: string;
  dossier_atelier?: string | null;
};

/** GET /prime/api/moi (portal). */
export type PrimeMoi = {
  email: string;
  role: string;
  chat: boolean;
  chat_motif?: string | null;
  terminal?: boolean;
  telechargements?: string;
};

export type ChatMessage = { role: "moi" | "prime"; texte: string; date: string };
export type ChatTask = {
  tache: string;
  etat: "en_cours" | "fini" | "erreur";
  reponse?: string;
  erreur?: string;
  debut?: string;
  fin?: string;
};
export type Ticket = {
  id: string | number;
  sujet: string;
  etat: string;
  maj: string;
  url?: string;
  derniere_action?: string;
};
export type QuickLink = { nom: string; url: string; description?: string };
export type Download = { nom: string; url: string; taille?: number; maj?: string };

/** Error raised by `getJson` / `postJson` (HTTP status kept for the UI). */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

export const CLOUD_CONNECTION = "axe-cloud";
export const CLOUD_EVENT = "axe://cloud-state";

export const cloudApi = {
  state: (): Promise<CloudState> =>
    EDITION_LOCALE
      ? Promise.resolve({ connected: false, base: "", email: "", role: "", expireLe: "", poste: "", connectionId: "" })
      : invoke<CloudState>("cloud_state"),
  /** Opens the browser; resolves once signed in (or rejects: refused, canceled, 5 min). */
  login: () => invoke<CloudState>("cloud_login"),
  cancelLogin: () => invoke<void>("cloud_login_cancel"),
  reopenLogin: () => invoke<void>("cloud_login_reopen"),
  logout: () => invoke<CloudState>("cloud_logout"),
  call: <T,>(method: "GET" | "POST", path: string, body?: unknown) =>
    invoke<CloudReply<T>>("cloud_api", { input: { method, path, body } }),
  /** Opens /prime/… or /admin/… already signed in, in the system browser. */
  openWeb: (suite: string) => invoke<{ ouvert: string }>("cloud_open_web", { input: { suite } }),
  onState: (handler: (state: CloudState) => void): Promise<UnlistenFn> =>
    EDITION_LOCALE ? Promise.resolve(() => undefined) :
    listen<CloudState>(CLOUD_EVENT, (event) => handler(event.payload)),
};

function failure(reply: CloudReply<unknown>): CloudError {
  const data = reply.data as { erreur?: unknown } | null;
  const message =
    typeof data?.erreur === "string" && data.erreur.trim()
      ? data.erreur
      : `Le service a répondu par une erreur (code ${reply.status}).`;
  return new CloudError(message, reply.status, reply.data);
}

export async function getJson<T>(path: string): Promise<T> {
  const reply = await cloudApi.call<T>("GET", path);
  if (!reply.ok) throw failure(reply);
  return reply.data;
}

export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const reply = await cloudApi.call<T>("POST", path, body);
  if (!reply.ok) throw failure(reply);
  return reply.data;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const primeApi = {
  moi: () => getJson<PrimeMoi>("/prime/api/moi"),
  appMoi: () => getJson<AppMoi>("/app/moi"),
  history: () => getJson<{ messages: ChatMessage[]; session?: string | null }>("/prime/api/chat/historique"),
  send: (message: string, nouvelle = false) =>
    postJson<{ tache: string; etat: string }>("/prime/api/chat", nouvelle ? { message, nouvelle } : { message }),
  task: (tache: string) => getJson<ChatTask>(`/prime/api/chat/${encodeURIComponent(tache)}`),
  tickets: () => getJson<{ tickets: Ticket[]; maj?: string }>("/prime/api/tickets"),
  links: () => getJson<{ liens: QuickLink[]; telechargements?: Download[] }>("/prime/api/liens"),
};

// ----- cloud / local mode (kept on this machine) ---------------------------------

export type AppMode = "cloud" | "local";
const MODE_KEY = "axe.mode";

export function loadMode(): AppMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "local" ? "local" : "cloud";
  } catch {
    return "cloud";
  }
}

export function saveMode(mode: AppMode) {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // best effort: the app falls back to the cloud mode
  }
}

export function roleLabel(role: string): string {
  if (role === "admin") return "Administrateur";
  if (role === "tech") return "Technicien";
  return role || "—";
}

export function firstName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[._-]/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : email;
}
