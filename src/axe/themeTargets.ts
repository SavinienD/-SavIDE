// Theme adapters for surfaces that do not read CSS variables themselves:
// the Monaco editor and the xterm terminal. Both are rebuilt from the same
// derived variables as the rest of the UI and re-applied on theme change.
import { AXE_ACCENT, currentThemeVars, type ThemeVars } from "./theme";

export const AXE_MONACO_THEME = "axe-theme";

const hex = (value: string) => value.replace(/^#/, "");

/** Syntax palettes per scheme (light values are darker for contrast). */
const SYNTAX = {
  dark: {
    comment: "6b6f78", keyword: "c4b5fd", string: "86efac", number: "f5a683",
    type: "e8bb6a", fn: "9fc2ff", tag: "f5a1ab",
  },
  light: {
    comment: "8a8a90", keyword: "6d28d9", string: "15803d", number: "b45309",
    type: "a16207", fn: "1d4ed8", tag: "be123c",
  },
} as const;

/** Monaco `IStandaloneThemeData` (typed loosely to avoid importing monaco here). */
export function monacoThemeData(vars: ThemeVars = currentThemeVars()) {
  const dark = vars["--axe-scheme"] === "dark";
  const s = SYNTAX[dark ? "dark" : "light"];
  const bg = vars["--editor-bg"];
  return {
    base: (dark ? "vs-dark" : "vs") as "vs-dark" | "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: s.comment, fontStyle: "italic" },
      { token: "keyword", foreground: s.keyword },
      { token: "string", foreground: s.string },
      { token: "number", foreground: s.number },
      { token: "type", foreground: s.type },
      { token: "function", foreground: s.fn },
      { token: "variable", foreground: hex(vars["--editor-fg"]) },
      { token: "constant", foreground: s.number },
      { token: "regexp", foreground: s.string },
      { token: "tag", foreground: s.tag },
      { token: "attribute.name", foreground: s.keyword },
    ],
    colors: {
      "editor.background": bg,
      "editor.foreground": vars["--editor-fg"],
      "editor.lineHighlightBackground": vars["--bg-1"],
      "editorLineNumber.foreground": vars["--text-faint"],
      "editorLineNumber.activeForeground": vars["--text-2"],
      "editorCursor.foreground": AXE_ACCENT,
      "editor.selectionBackground": vars["--editor-selection"],
      "editor.inactiveSelectionBackground": vars["--bg-2"],
      "editorIndentGuide.background1": vars["--bg-2"],
      "editorIndentGuide.activeBackground1": vars["--bg-5"],
      "editorGutter.background": bg,
      "editorWidget.background": vars["--bg-1"],
      "editorWidget.border": vars["--bg-5"],
      "editorHoverWidget.background": vars["--bg-1"],
      "editorHoverWidget.border": vars["--bg-5"],
      "editorSuggestWidget.background": vars["--bg-1"],
      "editorSuggestWidget.border": vars["--bg-5"],
      "editorSuggestWidget.selectedBackground": vars["--editor-selection"],
      "editorSuggestWidget.highlightForeground": vars["--accent-text"],
      "editorBracketMatch.background": vars["--editor-selection"],
      "editorBracketMatch.border": AXE_ACCENT,
      "scrollbarSlider.background": `${vars["--bg-5"]}cc`,
      "scrollbarSlider.hoverBackground": `${vars["--text-faint"]}99`,
      "scrollbarSlider.activeBackground": `${vars["--text-3"]}99`,
    },
  };
}

/** xterm `ITheme`. ANSI colours follow the scheme so `ls`/git output stays legible. */
export function xtermTheme(vars: ThemeVars = currentThemeVars()) {
  const dark = vars["--axe-scheme"] === "dark";
  const ansi = dark
    ? {
        black: "#111318", yellow: "#f5d36b", cyan: "#67e8f9",
        brightRed: "#ff8a94", brightGreen: "#86efac", brightYellow: "#fde68a",
        brightMagenta: "#ddd6fe", brightCyan: "#a5f3fc",
      }
    : {
        black: "#1a1a1d", yellow: "#a16207", cyan: "#0e7490",
        brightRed: "#be123c", brightGreen: "#166534", brightYellow: "#854d0e",
        brightMagenta: "#5b21b6", brightCyan: "#155e75",
      };
  return {
    background: vars["--bg-0"],
    foreground: vars["--editor-fg"],
    cursor: AXE_ACCENT,
    cursorAccent: vars["--bg-0"],
    selectionBackground: vars["--editor-selection"],
    red: vars["--danger"],
    green: vars["--ok"],
    blue: dark ? "#9fc2ff" : "#1d4ed8",
    magenta: vars["--accent-2"],
    white: vars["--text-1"],
    brightBlack: vars["--text-3"],
    brightBlue: dark ? "#bcd4ff" : "#1e40af",
    brightWhite: vars["--text-0"],
    ...ansi,
  };
}
