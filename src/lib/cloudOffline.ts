import { invoke } from "@tauri-apps/api/core";
import type { FileDocument, WorkspaceEntry } from "../types";

/// axe:v2-l6 (tranche 2) — travail hors ligne sur une copie locale (miroir) d'un
/// espace cloud. Ce module porte l'etat du miroir par espace, les appels aux
/// commandes Tauri `offline_*` et la mise en attente des modifications.
///
/// Les ecritures restent silencieuses : aucune bannière, aucun compteur. Seuls
/// subsistent un point discret sur l'onglet des fichiers modifies, un journal
/// consultable, et — quand le meme fichier a change des deux cotes — une
/// demande de choix en francais courant (« Garder ma version »,
/// « Garder celle de l'espace », « Garder les deux »).

export type OfflineStatus = {
  connection: string;
  mirrorReady: boolean;
  files: number;
  dirty: number;
  bytes: number;
  lastSyncAtMs: number | null;
};

export type OfflineConflict = {
  path: string;
  kind: string;
  localHash: string | null;
  serverHash: string | null;
};

export type OfflineSyncResult = {
  applied: string[];
  conflicts: OfflineConflict[];
  failed: { path: string; error: string }[];
};

type OfflineJournalEntry = {
  path: string;
  kind: string;
  newPath?: string | null;
  atMs: number;
  hash?: string | null;
};

type OfflineWriteResult = { path?: string; dirty?: boolean; hash?: string };

/// Instantane lisible par React (jamais mute par l'appelant).
export type OfflineView = {
  ready: boolean;
  pendingCount: number;
  dirtyPaths: ReadonlySet<string>;
  conflicts: OfflineConflict[];
  /** Modifications qui n'ont vraiment pas pu partir au dernier essai (rare). */
  stuckPaths: readonly string[];
};

type OfflineState = {
  ready: boolean;
  preparing: boolean;
  syncing: boolean;
  pending: Set<string>;
  pendingCount: number;
  conflicts: OfflineConflict[];
  stuck: string[];
  lastSyncAtMs: number | null;
};

const OFFLINE_STATES = new Map<string, OfflineState>();
const LISTENERS = new Map<string, Set<() => void>>();

function stateFor(workspacePath: string): OfflineState {
  let state = OFFLINE_STATES.get(workspacePath);
  if (!state) {
    state = {
      ready: false,
      preparing: false,
      syncing: false,
      pending: new Set(),
      pendingCount: 0,
      conflicts: [],
      stuck: [],
      lastSyncAtMs: null,
    };
    OFFLINE_STATES.set(workspacePath, state);
  }
  return state;
}

function notify(workspacePath: string): void {
  const listeners = LISTENERS.get(workspacePath);
  if (!listeners) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // un abonne fautif ne doit pas casser le miroir.
    }
  }
}

export function getOfflineView(workspacePath: string): OfflineView {
  const state = stateFor(workspacePath);
  return {
    ready: state.ready,
    pendingCount: state.pending.size > 0 ? state.pending.size : state.pendingCount,
    dirtyPaths: state.pending,
    conflicts: state.conflicts,
    stuckPaths: state.stuck,
  };
}

export function subscribeOffline(
  workspacePath: string,
  listener: () => void,
): () => void {
  let listeners = LISTENERS.get(workspacePath);
  if (!listeners) {
    listeners = new Set();
    LISTENERS.set(workspacePath, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) LISTENERS.delete(workspacePath);
  };
}

// ── Helpers de chemin ────────────────────────────────────────────────────

function cleanRelative(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function baseName(path: string): string {
  const clean = cleanRelative(path);
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function parentRelative(path: string): string {
  const clean = cleanRelative(path);
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(0, idx) : "";
}

function joinRelative(parent: string | null | undefined, name: string): string {
  const cleanName = cleanRelative(name);
  const cleanParent = cleanRelative(parent ?? "");
  return cleanParent ? `${cleanParent}/${cleanName}` : cleanName;
}

function absolutePath(workspacePath: string, relativePath: string): string {
  return `${workspacePath.replace(/\/+$/, "")}/${cleanRelative(relativePath)}`;
}

function entryFor(
  workspacePath: string,
  relativePath: string,
  kind: WorkspaceEntry["kind"],
): WorkspaceEntry {
  return {
    name: baseName(relativePath),
    relativePath: cleanRelative(relativePath),
    absolutePath: absolutePath(workspacePath, relativePath),
    kind,
    hasChildren: false,
  };
}

function documentFor(
  workspacePath: string,
  relativePath: string,
  content: string,
  lastModifiedMs: number | null,
): FileDocument {
  return {
    name: baseName(relativePath),
    relativePath: cleanRelative(relativePath),
    absolutePath: absolutePath(workspacePath, relativePath),
    editable: true,
    content,
    reason: null,
    size: content.length,
    lastModifiedMs,
    imageMediaType: null,
    imageData: null,
  };
}

// ── Etat du miroir ───────────────────────────────────────────────────────

function markPending(workspacePath: string, path: string): void {
  const state = stateFor(workspacePath);
  const clean = cleanRelative(path);
  if (clean) state.pending.add(clean);
  state.pendingCount = state.pending.size;
  notify(workspacePath);
}

/// Relit l'etat du miroir (preparation, nombre en attente, journal) sans jamais
/// faire remonter d'erreur : le service peut etre injoignable.
export async function refreshOfflineState(workspacePath: string): Promise<void> {
  const state = stateFor(workspacePath);
  try {
    const status = await invoke<OfflineStatus>("offline_status", { workspacePath });
    state.ready = Boolean(status?.mirrorReady);
    state.lastSyncAtMs = status?.lastSyncAtMs ?? null;
    const dirty = Number(status?.dirty ?? 0);
    if (dirty >= 0) state.pendingCount = dirty;
  } catch {
    // miroir illisible : on conserve l'etat connu.
  }
  try {
    const journal = await invoke<OfflineJournalEntry[]>("offline_journal", {
      workspacePath,
    });
    state.pending = new Set(
      (journal ?? [])
        .map((entry) => cleanRelative(entry.newPath || entry.path))
        .filter(Boolean),
    );
    state.pendingCount = state.pending.size;
  } catch {
    // pas de journal accessible : on conserve l'estimation precedente.
  }
  notify(workspacePath);
}

/// Prepare le miroir en tache de fond. Sans effet si un miroir existe deja ou
/// si une preparation est en cours. Un echec reste silencieux.
export async function ensureOfflineMirror(workspacePath: string): Promise<void> {
  const state = stateFor(workspacePath);
  if (state.ready || state.preparing) return;
  state.preparing = true;
  try {
    await invoke("offline_prepare", { workspacePath });
    state.ready = true;
  } catch {
    // echec silencieux : la barre de titre reste le seul temoin.
  } finally {
    state.preparing = false;
    notify(workspacePath);
  }
  void refreshOfflineState(workspacePath);
}

/// Envoie les modifications en attente au retour du reseau.
export async function syncOffline(
  workspacePath: string,
): Promise<OfflineSyncResult | null> {
  const state = stateFor(workspacePath);
  if (state.syncing) return null;
  if (state.pending.size === 0 && state.pendingCount === 0 && state.conflicts.length === 0) {
    return null;
  }
  state.syncing = true;
  try {
    const result = await invoke<OfflineSyncResult>("offline_sync", { workspacePath });
    const applied = (result?.applied ?? []).map(cleanRelative);
    state.conflicts = result?.conflicts ?? [];
    // Ce qui n'a pas pu partir reste dans le journal : on le signale d'un mot,
    // sans jamais bloquer ni compter les ecritures en attente.
    state.stuck = (result?.failed ?? [])
      .map((entry) => cleanRelative(entry.path))
      .filter((path) => !applied.includes(path));
    for (const path of applied) state.pending.delete(path);
    state.pendingCount = state.pending.size;
    notify(workspacePath);
    void refreshOfflineState(workspacePath);
    return result;
  } catch {
    // service encore instable : les modifications restent en attente.
    return null;
  } finally {
    state.syncing = false;
  }
}

/// Tranche un conflit : `keep` = "local" (ma version), "server" (celle de
/// l'espace) ou "both" (l'espace garde la sienne, la mienne devient un voisin).
export async function resolveOfflineConflict(
  workspacePath: string,
  path: string,
  keep: "local" | "server" | "both",
): Promise<void> {
  await invoke("offline_resolve", { workspacePath, path, keep });
  const state = stateFor(workspacePath);
  state.conflicts = state.conflicts.filter((conflict) => conflict.path !== path);
  if (keep !== "local") {
    state.pending.delete(cleanRelative(path));
    state.pendingCount = state.pending.size;
  }
  notify(workspacePath);
  void refreshOfflineState(workspacePath);
}

/// Oublie le miroir (et ses modifications en attente) pour cet espace.
export async function forgetOfflineMirror(workspacePath: string): Promise<void> {
  await invoke("offline_forget", { workspacePath });
  const state = stateFor(workspacePath);
  state.pending.clear();
  state.pendingCount = 0;
  state.conflicts = [];
  state.stuck = [];
  state.ready = false;
  notify(workspacePath);
}

// ── Lectures depuis le miroir ────────────────────────────────────────────

export async function listOfflineIndex(
  workspacePath: string,
): Promise<WorkspaceEntry[]> {
  const entries = await invoke<WorkspaceEntry[]>("offline_list", { workspacePath });
  return (entries ?? []).map((entry) => ({
    ...entry,
    relativePath: cleanRelative(entry.relativePath),
    absolutePath: entry.absolutePath || absolutePath(workspacePath, entry.relativePath),
    kind: entry.kind === "directory" ? "directory" : "file",
    hasChildren: Boolean(entry.hasChildren),
  }));
}

/// Reconstitue la liste des enfants directs d'un dossier depuis l'index plat du
/// miroir (les miroirs peuvent ne contenir que des fichiers : les dossiers
/// intermediaires sont alors deduits du chemin).
export async function listOfflineEntries(
  workspacePath: string,
  relativePath?: string,
): Promise<WorkspaceEntry[]> {
  const all = await listOfflineIndex(workspacePath);
  return offlineChildren(workspacePath, all, relativePath ?? "");
}

function offlineChildren(
  workspacePath: string,
  all: WorkspaceEntry[],
  parent: string,
): WorkspaceEntry[] {
  const prefix = cleanRelative(parent);
  const map = new Map<string, WorkspaceEntry["kind"]>();
  for (const entry of all) {
    const rel = cleanRelative(entry.relativePath);
    if (!rel) continue;
    if (prefix && !rel.startsWith(`${prefix}/`)) continue;
    const rest = prefix ? rel.slice(prefix.length + 1) : rel;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      map.set(rel, entry.kind === "directory" ? "directory" : "file");
    } else {
      const directory = prefix ? `${prefix}/${rest.slice(0, slash)}` : rest.slice(0, slash);
      if (!map.has(directory)) map.set(directory, "directory");
    }
  }
  const directories: WorkspaceEntry[] = [];
  const files: WorkspaceEntry[] = [];
  for (const [rel, kind] of map) {
    const entry = entryFor(workspacePath, rel, kind);
    if (kind === "directory") {
      entry.hasChildren = all.some((candidate) =>
        cleanRelative(candidate.relativePath).startsWith(`${rel}/`),
      );
      directories.push(entry);
    } else {
      files.push(entry);
    }
  }
  const byName = (left: WorkspaceEntry, right: WorkspaceEntry) =>
    left.name.localeCompare(right.name);
  directories.sort(byName);
  files.sort(byName);
  return [...directories, ...files];
}

export async function readOfflineFile(
  workspacePath: string,
  relativePath: string,
): Promise<FileDocument> {
  const result = await invoke<{
    path?: string;
    content?: string | null;
    mirroredAtMs?: number | null;
  }>("offline_read", { workspacePath, path: relativePath });
  return documentFor(
    workspacePath,
    result?.path || relativePath,
    result?.content ?? "",
    result?.mirroredAtMs ?? null,
  );
}

// ── Ecritures sur le miroir ──────────────────────────────────────────────

export async function writeOfflineFile(
  workspacePath: string,
  relativePath: string,
  content: string,
): Promise<FileDocument> {
  const result = await invoke<OfflineWriteResult>("offline_write", {
    workspacePath,
    path: relativePath,
    content,
  });
  markPending(workspacePath, result?.path || relativePath);
  return documentFor(workspacePath, relativePath, content, Date.now());
}

export async function createOfflineFile(
  workspacePath: string,
  targetRelativePath: string | null,
  name: string,
): Promise<WorkspaceEntry> {
  const path = joinRelative(targetRelativePath, name);
  const result = await invoke<OfflineWriteResult>("offline_create_file", {
    workspacePath,
    path,
  });
  markPending(workspacePath, result?.path || path);
  return entryFor(workspacePath, path, "file");
}

export async function createOfflineDirectory(
  workspacePath: string,
  targetRelativePath: string | null,
  name: string,
): Promise<WorkspaceEntry> {
  const path = joinRelative(targetRelativePath, name);
  const result = await invoke<OfflineWriteResult>("offline_create_dir", {
    workspacePath,
    path,
  });
  markPending(workspacePath, result?.path || path);
  return entryFor(workspacePath, path, "directory");
}

export async function deleteOfflineEntry(
  workspacePath: string,
  relativePath: string,
): Promise<void> {
  const result = await invoke<OfflineWriteResult>("offline_delete", {
    workspacePath,
    path: relativePath,
  });
  markPending(workspacePath, result?.path || relativePath);
}

export async function renameOfflineEntry(
  workspacePath: string,
  relativePath: string,
  newName: string,
): Promise<WorkspaceEntry> {
  const to = joinRelative(parentRelative(relativePath), newName);
  const result = await invoke<{ from?: string; to?: string }>("offline_rename", {
    workspacePath,
    from: relativePath,
    to,
  });
  const target = result?.to || to;
  markPending(workspacePath, target);
  let kind: WorkspaceEntry["kind"] = "file";
  try {
    const all = await listOfflineIndex(workspacePath);
    const existing = all.find(
      (entry) => cleanRelative(entry.relativePath) === cleanRelative(target),
    );
    if (existing) kind = existing.kind;
  } catch {
    // index indisponible : on suppose un fichier (l'arbre se rafraichira).
  }
  return entryFor(workspacePath, target, kind);
}
