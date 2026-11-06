import type { RecentWorkspace } from "../types";

const RECENTS_KEY = "axecode.recentWorkspaces";
const LAST_KEY = "axecode.lastWorkspace";
// historique des dossiers récents (l'accueil les affiche tous, en liste qui défile).
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

/** retire un dossier de l'historique (le dossier lui-même n'est jamais touché). */
export function removeRecent(path: string): RecentWorkspace[] {
  const next = loadRecents().filter((r) => r.path !== path);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
  return next;
}

// Ordre stable des dossiers numérotés (Ctrl+1…9, barre du haut, cartes de l'accueil) :
// figé à la première ouverture d'un dossier, il ne bouge plus tant qu'on ne revient pas
// à l'accueil (depuis le dossier 2, Ctrl+1 ramène au dossier 1). Il se met à jour au retour
// à l'accueil, ou quand on ouvre un dossier qui n'est pas parmi les 9 numérotés.
// En mémoire, par fenêtre : l'appli démarre toujours sur l'accueil.
export const NB_NUMEROTES = 9;
let ordreFige: string[] | null = null;
const abonnesOrdre = new Set<() => void>();
let versionOrdre = 0;
function prevenirOrdre(): void {
  versionOrdre++;
  for (const f of [...abonnesOrdre]) f();
}
/** Abonnement (barre des dossiers). */
export function ecouterOrdre(f: () => void): () => void {
  abonnesOrdre.add(f);
  return () => abonnesOrdre.delete(f);
}
export function versionOrdreDossiers(): number {
  return versionOrdre;
}

/** Dossiers récents dans l'ordre des numéros (figé pendant le travail, sinon le plus récent d'abord). */
export function dossiersNumerotes(): RecentWorkspace[] {
  const recents = loadRecents();
  if (!ordreFige) return recents;
  const parChemin = new Map(recents.map((r) => [r.path, r]));
  const figes = ordreFige.map((p) => parChemin.get(p)).filter((r): r is RecentWorkspace => Boolean(r));
  const vus = new Set(figes.map((r) => r.path));
  return [...figes, ...recents.filter((r) => !vus.has(r.path))];
}

/** Ouverture d'un dossier : l'historique est noté, l'ordre des numéros ne bouge pas
 *  (sauf dossier hors des 9 numérotés : l'ordre se met à jour, il devient le 1). */
export function noterOuverture(path: string, name: string): void {
  if (!ordreFige) ordreFige = loadRecents().map((r) => r.path);
  const numerote = ordreFige.slice(0, NB_NUMEROTES).includes(path);
  recordRecent(path, name);
  if (!numerote) ordreFige = loadRecents().map((r) => r.path);
  prevenirOrdre();
}

/** Retour à l'accueil : l'ordre suit de nouveau l'historique (le plus récent d'abord). */
export function libererOrdre(): void {
  if (ordreFige === null) return;
  ordreFige = null;
  prevenirOrdre();
}

/**
 * n-ième dossier numéroté (1 = le premier), dans l'ordre de
 * dossiersNumerotes au moment de l'appui (Ctrl+1…9). null s'il n'y en a pas autant.
 */
export function dossierRecentNumero(n: number): RecentWorkspace | null {
  if (!Number.isInteger(n) || n < 1) return null;
  return dossiersNumerotes()[n - 1] ?? null;
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
