// axe:zoom — taille du TEXTE LU : chat et documents seulement (axe:e19). La valeur
// vit dans `--content-scale` (styles.css), que seuls `.chat-col` et `.editor-host`
// relisent ; le reste de l'interface ne bouge pas d'un pixel.
// Persisted in localStorage (same key as the old whole-webview zoom: saved
// values carry over as a text scale) and applied at startup so it survives
// restarts and the home screen. Réglée dans Settings > Apparence (les Ctrl +/-/0
// pilotent le zoom de toute l'interface, plus bas).

import { fournirActions } from "./raccourcis"; // axe:raccourcis

const STORAGE_KEY = "axecode:zoom";
const CHANGE_EVENT = "axe:zoom-changed";
export const TEXT_SCALE_MIN = 0.8;
export const TEXT_SCALE_MAX = 2;
export const TEXT_SCALE_STEP = 0.1;

/** Base font size of monospace text (editor, terminal), before scaling.
 *  Mirrors `--fs-mono` in styles.css. */
export const MONO_BASE_PX = 12;
export const MONO_LINE_BASE_PX = 18;

function clampTextScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(
    TEXT_SCALE_MIN,
    Math.min(TEXT_SCALE_MAX, Math.round(value * 100) / 100),
  );
}

export function loadTextScale(): number {
  try {
    return clampTextScale(Number(localStorage.getItem(STORAGE_KEY) ?? 1));
  } catch {
    return 1;
  }
}

function applyTextScale(scale: number): void {
  // axe:e19 — deux variables, une seule intention : `--content-scale` porte la
  // valeur du reglage et n'est lu que par le chat et la zone du document ;
  // `--text-scale` reste a 1 pour que la barre de titre, les listes, les boutons
  // et les reglages gardent EXACTEMENT leur taille. Sinon le glisser deforme
  // toute l'interface (retour de l'utilisateur).
  document.documentElement.style.setProperty("--content-scale", String(scale));
  document.documentElement.style.setProperty("--text-scale", "1");
}

/** Persist + apply. */
export function setTextScale(value: number): number {
  const scale = clampTextScale(value);
  try {
    localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    /* storage unavailable: still apply for this session */
  }
  applyTextScale(scale);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: scale }));
  return scale;
}

export function onTextScaleChange(cb: (scale: number) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<number>).detail);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// axe:zoom-origine — le zoom D'ORIGINE de SavIDE : toute la webview grandit
// (getCurrentWebview().setZoom), comme avant aca8e81/e19. Réglé par Ctrl +/−/0
// (registre axe/raccourcis.ts) et par le curseur de Settings > Apparence.
// Clé distincte de la taille du texte (`axecode:zoom`, reprise par e19).
const UI_ZOOM_KEY = "axecode:ui-zoom";
const UI_ZOOM_EVENT = "axe:ui-zoom-changed";
export const UI_ZOOM_MIN = 0.5;
export const UI_ZOOM_MAX = 2;
export const UI_ZOOM_STEP = 0.1;

function clampUiZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  // Paliers de 10 % (50..200) : jamais de valeur intermédiaire.
  const stepped = Math.round(value * 10) / 10;
  return Math.max(UI_ZOOM_MIN, Math.min(UI_ZOOM_MAX, stepped));
}

export function loadUiZoom(): number {
  try {
    return clampUiZoom(Number(localStorage.getItem(UI_ZOOM_KEY) ?? 1));
  } catch {
    return 1;
  }
}

// Zoom NATIF de la webview uniquement (jamais de CSS zoom/transform : ça casse
// xterm, Monaco et les volets). Appels sérialisés : seule la dernière valeur
// demandée est appliquée, pas de rafale.
let appliedZoom = 1;
let pendingZoom: number | null = null;
let applying = false;
function applyUiZoom(zoom: number): void {
  pendingZoom = zoom;
  if (applying) return;
  applying = true;
  void (async () => {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      while (pendingZoom !== null) {
        const next = pendingZoom;
        pendingZoom = null;
        if (next === appliedZoom) continue;
        await getCurrentWebview().setZoom(next);
        appliedZoom = next;
      }
    } catch (err) {
      console.warn("Unable to set app zoom", err);
    } finally {
      applying = false;
    }
  })();
}

/** Fonction UNIQUE partagée par Ctrl +/−/0 et le curseur de Settings. */
export function setUiZoom(value: number): number {
  const zoom = clampUiZoom(value);
  try {
    localStorage.setItem(UI_ZOOM_KEY, String(zoom));
  } catch {
    /* stockage indisponible : appliqué pour la session */
  }
  applyUiZoom(zoom);
  window.dispatchEvent(new CustomEvent(UI_ZOOM_EVENT, { detail: zoom }));
  return zoom;
}

export function onUiZoomChange(cb: (zoom: number) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<number>).detail);
  window.addEventListener(UI_ZOOM_EVENT, handler);
  return () => window.removeEventListener(UI_ZOOM_EVENT, handler);
}

/** Call once at startup, before rendering. */
export function initTextScale(): void {
  applyTextScale(loadTextScale());
  const zoom = loadUiZoom();
  if (zoom !== 1) applyUiZoom(zoom);
  else appliedZoom = 1;
  // Fournisseur de base (aussi actif sur l'écran d'accueil).
  fournirActions({
    zoomPlus: () => setUiZoom(loadUiZoom() + UI_ZOOM_STEP),
    zoomMoins: () => setUiZoom(loadUiZoom() - UI_ZOOM_STEP),
    zoomReset: () => setUiZoom(1),
  });
}
