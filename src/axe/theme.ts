// Axe theme: a single user-picked background colour drives every surface,
// border and text tone (derived by luminance). Semantic colours (errors,
// success, diff, syntax) switch to a light or dark palette so they stay
// readable on any background. The accent stays the fixed Axe orange.
// Persisted in localStorage so it applies before React mounts.

export const AXE_DEFAULT_BG = "#0b0b0d";
export const AXE_ACCENT = "#fc610b";

/** Curated starting points, taken from the SavIDE site palette. */
export const AXE_PRESETS: { id: string; name: string; bg: string }[] = [
  { id: "nuit", name: "Nuit", bg: "#0b0b0d" },
  { id: "graphite", name: "Graphite", bg: "#1a1a1d" },
  { id: "marine", name: "Marine", bg: "#0f1724" },
  { id: "papier", name: "Papier", bg: "#f6f6f4" },
  { id: "sable", name: "Sable", bg: "#eeeeeb" },
  { id: "blanc", name: "Blanc", bg: "#ffffff" },
];

const STORAGE_KEY = "axe.theme.bg";
const CHANGE_EVENT = "axe-theme-change";

type Rgb = [number, number, number];
export type ThemeVars = Record<string, string>;

function parseHex(input: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a) ?? [0, 0, 0]);
  const lb = luminance(parseHex(b) ?? [0, 0, 0]);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function normalizeBg(input: string | null | undefined): string {
  const rgb = input ? parseHex(input) : null;
  return rgb ? toHex(rgb) : AXE_DEFAULT_BG;
}

export function isDarkBg(bgHex: string): boolean {
  return luminance(parseHex(bgHex) ?? [0, 0, 0]) < 0.35;
}

/** Semantic colours tuned per scheme (light values are darker, for contrast). */
const SEMANTIC = {
  dark: {
    "--danger": "#f5737f",
    "--ok": "#22c55e",
    "--warn": "#f4c95d",
    "--accent-2": "#c4b5fd",
    "--accent-2-soft": "rgba(196, 181, 253, 0.14)",
    "--signal": "#c4b5fd",
    "--tone-thinking": "#f5a683",
    "--tone-grep": "#86efac",
    "--tone-read": "#9fc2ff",
    "--tone-edit": "#c4b5fd",
    "--diff-add-bg": "rgba(34, 197, 94, 0.14)",
    "--diff-add-fg": "#86efac",
    "--diff-rem-bg": "rgba(245, 115, 127, 0.14)",
    "--diff-rem-fg": "#f5a1ab",
    "--accent-text": "#ff7a2e",
    "--shadow-ambient": "0 0 16px rgba(0, 0, 0, 0.35), 0 0 8px rgba(0, 0, 0, 0.18)",
    "--shadow-focus": "0 4px 14px rgba(0, 0, 0, 0.45)",
  },
  light: {
    "--danger": "#c42b3c",
    "--ok": "#15803d",
    "--warn": "#a16207",
    "--accent-2": "#6d28d9",
    "--accent-2-soft": "rgba(109, 40, 217, 0.10)",
    "--signal": "#6d28d9",
    "--tone-thinking": "#b45309",
    "--tone-grep": "#15803d",
    "--tone-read": "#1d4ed8",
    "--tone-edit": "#6d28d9",
    "--diff-add-bg": "rgba(21, 128, 61, 0.12)",
    "--diff-add-fg": "#166534",
    "--diff-rem-bg": "rgba(196, 43, 60, 0.10)",
    "--diff-rem-fg": "#9f1239",
    // Axe "orange ink": the bright accent fails contrast as text on light grounds.
    "--accent-text": "#c24b07",
    "--shadow-ambient": "0 0 16px rgba(0, 0, 0, 0.08), 0 0 6px rgba(0, 0, 0, 0.06)",
    "--shadow-focus": "0 4px 14px rgba(0, 0, 0, 0.12)",
  },
} as const;

/** Compute every CSS variable derived from the background colour. */
export function deriveThemeVars(bgHex: string): ThemeVars {
  const bg = parseHex(bgHex) ?? (parseHex(AXE_DEFAULT_BG) as Rgb);
  const dark = luminance(bg) < 0.35;
  // Foreground pole: cool cream on dark backgrounds, Axe ink on light ones.
  const fg: Rgb = dark ? [232, 233, 236] : [26, 26, 29];
  // Opposite pole, used for the editor surface (one shade "deeper").
  const deep: Rgb = dark ? [0, 0, 0] : [255, 255, 255];
  const accent = parseHex(AXE_ACCENT) as Rgb;
  const surf = (t: number) => toHex(mix(bg, fg, t));
  const text = (t: number) => toHex(mix(fg, bg, t));
  const line = (a: number) => `rgba(${fg[0]}, ${fg[1]}, ${fg[2]}, ${a})`;
  // Light grounds need a little more separation between surfaces.
  const k = dark ? 1 : 1.25;
  return {
    "--axe-bg": toHex(bg),
    "--axe-scheme": dark ? "dark" : "light",
    "--bg-canvas": toHex(bg),
    "--bg-0": toHex(bg),
    "--bg-1": surf(0.03 * k),
    "--bg-2": surf(0.055 * k),
    "--bg-3": surf(0.085 * k),
    "--bg-4": surf(0.12 * k),
    "--bg-5": surf(0.155 * k),
    "--bg-hi": surf(0.055 * k),
    "--bg-pure": toHex(deep),
    "--editor-bg": toHex(mix(bg, deep, 0.3)),
    "--editor-bg-2": surf(0.03 * k),
    "--editor-bg-3": surf(0.055 * k),
    "--editor-fg": toHex(fg),
    "--editor-fg-dim": text(0.36),
    "--editor-selection": toHex(mix(bg, accent, dark ? 0.28 : 0.2)),
    "--line-soft": line(dark ? 0.05 : 0.06),
    "--line": line(dark ? 0.09 : 0.11),
    "--line-strong": line(dark ? 0.15 : 0.18),
    "--line-bold": line(0.32),
    "--divider": line(dark ? 0.09 : 0.11),
    "--text-0": toHex(fg),
    "--text-1": text(0.1),
    "--text-2": text(0.34),
    "--text-3": text(0.5),
    "--text-muted": text(0.6),
    "--text-faint": text(0.72),
    ...SEMANTIC[dark ? "dark" : "light"],
  };
}

/** Variables for the theme currently persisted (or the default). */
export function currentThemeVars(): ThemeVars {
  return deriveThemeVars(loadThemeBg());
}

/** Apply the theme to the document root. */
export function applyTheme(bgHex: string): void {
  const vars = deriveThemeVars(bgHex);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    if (key === "--axe-scheme") continue;
    root.style.setProperty(key, value);
  }
  root.dataset.axeScheme = vars["--axe-scheme"];
  root.style.colorScheme = vars["--axe-scheme"];
}

export function loadThemeBg(): string {
  try {
    return normalizeBg(localStorage.getItem(STORAGE_KEY));
  } catch {
    return AXE_DEFAULT_BG;
  }
}

/** Persist + apply. Passing `null` resets to the Axe default. */
export function setThemeBg(bgHex: string | null): string {
  const value = normalizeBg(bgHex);
  try {
    if (bgHex === null || value === AXE_DEFAULT_BG) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* storage unavailable: still apply for this session */
  }
  applyTheme(value);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }));
  return value;
}

export function onThemeChange(cb: (bg: string) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

/** Call once at startup, before rendering. */
export function initTheme(): void {
  applyTheme(loadThemeBg());
}
