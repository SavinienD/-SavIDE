// axe:cloud L4 — espace commun (perso -> commun).
// Les chemins restent confinés au service ; l'appli ne connaît que kind/name.
import { invoke } from "@tauri-apps/api/core";

export const SHARE_KINDS = ["skills", "recettes", "conversations", "harness"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export type SharedItem = {
  kind: string;
  name: string;
  directory: boolean;
  bytes: number;
  modifiedMs: number;
};

export type SharedList = { path: string; items: SharedItem[] };
export type SharedFiles = { kind: string; name: string; files: { path: string; bytes: number }[] };
export type SharedRead = { kind: string; name: string; path: string; content: string };
export type SharedResult = { kind: string; name: string; files?: number; bytes?: number; output: string };
export type SharedLogEntry = { commit: string; author: string; date: string; subject: string };

export const shareApi = {
  list(connectionId: string) {
    return invoke<SharedList>("remote_share_list", { input: { connectionId } });
  },
  files(connectionId: string, kind: string, name: string) {
    return invoke<SharedFiles>("remote_share_files", { input: { connectionId, kind, name } });
  },
  read(connectionId: string, kind: string, name: string, relativePath: string) {
    return invoke<SharedRead>("remote_share_read", {
      input: { connectionId, kind, name, relativePath },
    });
  },
  publish(connectionId: string, kind: string, name: string, author?: string) {
    return invoke<SharedResult>("remote_share_publish", {
      input: { connectionId, kind, name, author: author ?? null },
    });
  },
  unpublish(connectionId: string, kind: string, name: string) {
    return invoke<SharedResult>("remote_share_unpublish", {
      input: { connectionId, kind, name, author: null },
    });
  },
  log(connectionId: string) {
    return invoke<{ entries: SharedLogEntry[] }>("remote_share_log", { input: { connectionId } });
  },
};
