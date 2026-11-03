import type { RecentWorkspace } from "../types";

const RECENTS_KEY = "axecode.recentWorkspaces";
const LAST_KEY = "axecode.lastWorkspace";
// axe:recents-180 — historique des dossiers récents (l'accueil les affiche tous, en liste qui défile).
const MAX_RECENTS = 30;

export function loadRecents(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentWorkspace[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.path === "string")
      .sort((a, b) => b.lastOpenedMs - a.lastOpenedMs);
  } catch {
    return [];
  }
}

export function recordRecent(path: string, name: string): RecentWorkspace[] {
  const now = Date.now();
  const existing = loadRecents().filter((r) => r.path !== path);
  const next: RecentWorkspace[] = [
    { path, name, lastOpenedMs: now },
    ...existing,
  ].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    localStorage.setItem(LAST_KEY, path);
  } catch {
    // ignore quota errors
  }
  return next;
}

/** axe:recents-180 — retire un dossier de l'historique (le dossier lui-même n'est jamais touché). */
export function removeRecent(path: string): RecentWorkspace[] {
  const next = loadRecents().filter((r) => r.path !== path);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
  return next;
}

export function loadLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function deriveName(path: string): string {
  const trimmed = path.replace(/\/$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}
