// axe:freechat — IPC of free conversations (src-tauri/src/freechat.rs).
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceBootstrap } from "../../types";

/** One conversation of any folder (free or project). */
export type FreechatRow = {
  id: string;
  workspaceId: string;
  title: string;
  updatedAtMs: number;
  messageCount: number;
};

export type FreechatIndex = {
  /** IDE workspace id of free conversations (the scratch root). */
  scratchRoot: string;
  /** Every conversation, most recent first. */
  conversations: FreechatRow[];
};

export const freechatApi = {
  index() {
    return invoke<FreechatIndex>("freechat_index");
  },
  /** Opens the free conversation workspace; `fresh` starts a new one. */
  open(options: { conversationId?: string; fresh?: boolean } = {}) {
    return invoke<WorkspaceBootstrap>("freechat_open", {
      input: { conversationId: options.conversationId ?? null, fresh: !!options.fresh },
    });
  },
  /** Moves a free conversation to a project folder. */
  relocate(conversationId: string, workspacePath: string) {
    return invoke<void>("freechat_relocate", {
      input: { conversationId, workspacePath },
    });
  },
};

/** Comparable form of a path (verbatim prefix, separators, case). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Last segment of a folder path, for display. */
export function folderName(path: string): string {
  const clean = path.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) || clean : clean;
}

/** Display form of a path (without the Windows verbatim prefix). */
export function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\/, "");
}

/** "à l'instant", "il y a 5 min", "hier", "12 mars"... */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "à l'instant";
  if (diff < hour) return `il y a ${Math.floor(diff / minute)} min`;
  if (diff < day) return `il y a ${Math.floor(diff / hour)} h`;
  if (diff < 2 * day) return "hier";
  if (diff < 7 * day) return `il y a ${Math.floor(diff / day)} jours`;
  return new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export const UNTITLED = "Nouvelle conversation";

/** Title shown for a conversation (the store default is English). */
export function conversationTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed === "New conversation" || trimmed === "Untitled") return UNTITLED;
  return trimmed;
}
