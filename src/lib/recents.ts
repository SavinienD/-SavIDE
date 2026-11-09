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
  const pins = loadPins();
  const tous = loadRecents();
  const parChemin = new Map(tous.map((r) => [r.path, r]));
  const tete: RecentWorkspace[] = pins.map((p) => ({
    path: p.path,
    name: p.name || parChemin.get(p.path)?.name || deriveName(p.path),
    lastOpenedMs: parChemin.get(p.path)?.lastOpenedMs ?? 0,
    epingle: true,
    ...(p.absent ? { absent: true } : {}),
  }));
  const epingles = new Set(pins.map((p) => p.path));
  const recents = tous.filter((r) => !epingles.has(r.path));
  if (!ordreFige) return [...tete, ...recents];
  const figes = ordreFige.map((p) => parChemin.get(p)).filter((r): r is RecentWorkspace => Boolean(r) && !epingles.has(r!.path));
  const vus = new Set(figes.map((r) => r.path));
  return [...tete, ...figes, ...recents.filter((r) => !vus.has(r.path))];
}

/** Ouverture d'un dossier : l'historique est noté, l'ordre des numéros ne bouge pas
 *  (sauf dossier hors des 9 numérotés : l'ordre se met à jour, il devient le 1). */
export function noterOuverture(path: string, name: string): void {
  if (!ordreFige) ordreFige = loadRecents().map((r) => r.path);
  const pins = loadPins();
  const epingles = new Set(pins.map((p) => p.path));
  const places = Math.max(0, NB_NUMEROTES - pins.length);
  const numerote = epingles.has(path) || ordreFige.filter((p) => !epingles.has(p)).slice(0, places).includes(path);
  recordRecent(path, name);
  if (epingles.has(path)) marquerEpingleAbsent(path, false);
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

// Dossiers épinglés : toujours en tête de la liste des récents, dans l'ordre d'épinglage
// (réordonnable), donc toujours sur les mêmes Ctrl+1…9. Jamais retirés par la limite des
// récents ni par l'ouverture d'un autre dossier. Un épinglé introuvable reste affiché (grisé).
const PINS_KEY = "axecode.pinnedWorkspaces";
export type DossierEpingle = { path: string; name: string; absent?: boolean };

export function loadPins(): DossierEpingle[] {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    const vus = new Set<string>();
    return parsed.filter((p): p is DossierEpingle => {
      if (!p || typeof p.path !== "string" || !p.path || vus.has(p.path)) return false;
      vus.add(p.path);
      return true;
    });
  } catch {
    return [];
  }
}

function savePins(pins: DossierEpingle[]): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // ignore quota errors
  }
  prevenirOrdre();
}

export function estEpingle(path: string): boolean {
  return loadPins().some((p) => p.path === path);
}

/** Épingle un dossier : il prend la place suivant les épinglés existants. */
export function epingler(path: string, name?: string): DossierEpingle[] {
  const pins = loadPins();
  if (pins.some((p) => p.path === path)) return pins;
  const nom = name || loadRecents().find((r) => r.path === path)?.name || deriveName(path);
  const next = [...pins, { path, name: nom }];
  savePins(next);
  return next;
}

export function desepingler(path: string): DossierEpingle[] {
  const next = loadPins().filter((p) => p.path !== path);
  savePins(next);
  return next;
}

export function basculerEpingle(path: string, name?: string): boolean {
  if (estEpingle(path)) {
    desepingler(path);
    return false;
  }
  epingler(path, name);
  return true;
}

/** Déplace un épinglé à la position `index` (0 = premier, Ctrl+1). */
export function deplacerEpingle(path: string, index: number): DossierEpingle[] {
  const pins = loadPins();
  const i = pins.findIndex((p) => p.path === path);
  if (i < 0) return pins;
  const [p] = pins.splice(i, 1);
  pins.splice(Math.max(0, Math.min(index, pins.length)), 0, p);
  savePins(pins);
  return pins;
}

/** Marque un épinglé introuvable (ou de nouveau présent). */
export function marquerEpingleAbsent(path: string, absent: boolean): void {
  const pins = loadPins();
  const p = pins.find((x) => x.path === path);
  if (!p || Boolean(p.absent) === absent) return;
  if (absent) p.absent = true;
  else delete p.absent;
  savePins(pins);
}

/** Dossier déplacé ou renommé : l'épinglé garde sa place sous le nouveau chemin. */
export function remplacerCheminEpingle(ancien: string, nouveau: string, nom?: string): void {
  const pins = loadPins();
  const i = pins.findIndex((p) => p.path === ancien);
  if (i < 0) return;
  const next = pins
    .map((p, j) => (j === i ? { path: nouveau, name: nom || deriveName(nouveau) } : p))
    .filter((p, j) => j === i || p.path !== nouveau);
  savePins(next);
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
