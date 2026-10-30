import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import {
  Terminal,
  type IBufferRange,
  type ILink,
  type ILinkProvider,
} from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/ipc";
import { GitPanel, GitMark } from "./GitPanel"; // axe:git-onglet
import { GIT_TAB_ID, cycleTab, isExecutablePathTitle, resolveActiveTab } from "./terminalTabs"; // axe:terminal-onglets
import { onThemeChange } from "../axe/theme"; // axe:theme
import { xtermTheme } from "../axe/themeTargets"; // axe:theme
import { MONO_BASE_PX } from "../axe/zoom"; // axe:zoom — taille fixe (e19 : le reglage ne concerne que le chat et les documents)
import type { TerminalDataPayload, TerminalExitPayload } from "../types";

type TerminalStatus = "idle" | "starting" | "running" | "exited" | "error";

type TerminalSession = {
  id: string;
  index: number;
  title: string;
  /** Name given by the user; wins over the title sent by the shell. */
  customTitle?: string;
  status: TerminalStatus;
  shell?: string;
};

type Props = {
  active: boolean;
  fullHeight: boolean;
  workspacePath: string;
  onClose: () => void;
  onCloseLastSession: () => void;
  onToggleFullHeight: () => void;
  /**
   * Invoked when the user cmd/ctrl+clicks a file path detected in the
   * terminal buffer. The parent decides how to open it (workspace tab,
   * external read-only tab, file-tree reveal, ...).
   */
  onOpenTerminalPath?: (rawPath: string) => void;
};

const SAVED_LINES = 3000;
const SAVE_DELAY_MS = 5000;
const terminalBuffers = new Map<string, Terminal>();
const pendingSaves = new Map<string, number>();
function terminalBufferKey(workspacePath: string, sessionId: string) { return `axecode:terminal-buffer:${workspacePath}:${sessionId}`; }
function saveBuffer(key: string, terminal: Terminal) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - SAVED_LINES);
  const lines = Array.from({ length: buffer.length - start }, (_, offset) => buffer.getLine(start + offset)?.translateToString(true) ?? "");
  try { localStorage.setItem(key, JSON.stringify(lines)); } catch { /* storage can be disabled/full */ }
}
function persistTerminalBuffer(workspacePath: string, sessionId: string) {
  const key = terminalBufferKey(workspacePath, sessionId);
  window.clearTimeout(pendingSaves.get(key));
  pendingSaves.delete(key);
  const terminal = terminalBuffers.get(key);
  if (terminal) saveBuffer(key, terminal);
}
/** Saves at most once per SAVE_DELAY_MS while output keeps coming. */
function scheduleTerminalBufferSave(workspacePath: string, sessionId: string) {
  const key = terminalBufferKey(workspacePath, sessionId);
  if (pendingSaves.has(key)) return;
  pendingSaves.set(key, window.setTimeout(() => persistTerminalBuffer(workspacePath, sessionId), SAVE_DELAY_MS));
}
function persistAllTerminalBuffers() {
  for (const [key, terminal] of terminalBuffers) saveBuffer(key, terminal);
}
window.addEventListener("beforeunload", persistAllTerminalBuffers);
window.addEventListener("pagehide", persistAllTerminalBuffers);

type Disposable = {
  dispose: () => void;
};

export function TerminalPanel({
  active,
  fullHeight,
  workspacePath,
  onClose,
  onCloseLastSession,
  onToggleFullHeight,
  onOpenTerminalPath,
}: Props) {
  const [sessions, setSessions] = useState<TerminalSession[]>(() => loadTerminalSessions(workspacePath));
  const [activeId, setActiveId] = useState(() => loadTerminalSessions(workspacePath)[0]?.id ?? "terminal-1");
  // axe:git-tabs - branche git du dossier affichee dans chaque onglet.
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.gitSnapshot(workspacePath)
        .then((snap) => { if (alive) { setGitBranch(snap.isRepository ? snap.currentBranch ?? null : null); setGitDirty(snap.dirtyCount ?? 0); } })
        .catch(() => { if (alive) setGitBranch(null); });
    };
    tick();
    const id = window.setInterval(tick, 15000);
    return () => { alive = false; window.clearInterval(id); };
  }, [workspacePath]);
  const nextSessionIndex = useRef(1 + Math.max(0, ...loadTerminalSessions(workspacePath).map((session) => session.index)));

  useEffect(() => {
    try { localStorage.setItem(terminalStorageKey(workspacePath), JSON.stringify(sessions.map(({ id, status, ...session }) => session))); } catch { /* storage can be disabled/full */ }
  }, [sessions, workspacePath]);

  // Cycle terminal tabs without intercepting shortcuts while typing in inputs.
  // xterm's own input is a textarea: it lets Ctrl+Tab through (see
  // attachCustomKeyEventHandler) so the shortcut also works from the terminal.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!active || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "tab" || sessions.length < 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]") && !target.closest(".xterm")) return;
      event.preventDefault();
      setActiveId(cycleTab(activeId, sessions.map((session) => session.id), event.shiftKey ? -1 : 1));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, activeId, sessions]);

  // axe:terminal-onglets - id d'onglet reellement affiche (jamais orphelin) ; Git est un onglet a part.
  const shownId = resolveActiveTab(activeId, sessions.map((session) => session.id));
  const activeSession =
    sessions.find((session) => session.id === shownId) ?? sessions[0];

  const patchSession = useCallback(
    (id: string, patch: Partial<TerminalSession>) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === id ? { ...session, ...patch } : session,
        ),
      );
    },
    [],
  );

  const addSession = useCallback(() => {
    const session = createSession(nextSessionIndex.current++);
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      persistTerminalBuffer(workspacePath, id);
      if (sessions.length <= 1) {
        onCloseLastSession();
        return;
      }
      const index = sessions.findIndex((session) => session.id === id);
      const next = sessions.filter((session) => session.id !== id);
      setSessions(next);
      setActiveId((current) => {
        if (current !== id) return current;
        return next[Math.max(0, Math.min(index, next.length - 1))].id;
      });
    },
    [onCloseLastSession, sessions, workspacePath],
  );

  const closeAllSessions = useCallback(() => {
    for (const session of sessions) persistTerminalBuffer(workspacePath, session.id);
    onCloseLastSession();
  }, [onCloseLastSession, sessions, workspacePath]);

  // axe:git-onglet - onglet Git epingle (comme dans CloudTerminalPanel).
  const gitActive = shownId === GIT_TAB_ID;

  if (!activeSession) return null;

  return (
    <section className="terminal-panel">
      <div className="terminal-tabs">
        <div className="terminal-tabs__list">
          <div
            role="tab"
            aria-selected={gitActive}
            className="terminal-tab"
            data-tab="git"
            data-active={gitActive ? "true" : "false"}
            onClick={() => setActiveId(GIT_TAB_ID)}
            title={gitBranch ? `Git · ${gitBranch}` : "Git"}
          >
            <GitMark size={13} />
            <span className="terminal-tab__label">Git</span>
            {gitBranch ? (
              <span className="terminal-tab__git" title={`Branche git : ${gitBranch}${gitDirty ? ` (${gitDirty} modif.)` : ""}`}>
                {gitBranch}{gitDirty ? "*" : ""}
              </span>
            ) : null}
          </div>
          {sessions.map((session) => (
            <div
              key={session.id}
              role="tab"
              aria-selected={session.id === shownId}
              className="terminal-tab"
              data-shell={session.shell}
              data-active={session.id === shownId ? "true" : "false"}
              onClick={() => setActiveId(session.id)}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => {
                // Clic molette : fermer l'onglet.
                if (event.button === 1) { event.preventDefault(); event.stopPropagation(); closeSession(session.id); }
              }}
              title={session.customTitle ?? session.title}
              onContextMenu={(event) => {
                event.preventDefault();
                const choice = window.prompt("Choisir le shell : powershell ou bash", session.shell ?? "powershell");
                const shell = choice?.trim().toLowerCase();
                if (shell === "bash" || shell === "powershell") patchSession(session.id, { shell });
              }}
            >
              <Icon icon="solar:command-linear" width={13} height={13} />
              <span className="terminal-tab__label">{session.customTitle ?? session.title}</span>
              <button
                type="button"
                className="terminal-tab__rename"
                title="Renommer le terminal (vide = nom donné par le shell)"
                aria-label={`Renommer ${session.customTitle ?? session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  const name = window.prompt("Nom du terminal", session.customTitle ?? session.title);
                  if (name === null) return;
                  patchSession(session.id, { customTitle: name.trim().slice(0, 48) || undefined });
                }}
              ><Icon icon="solar:pen-linear" width={12} height={12} /></button>
              <span
                className="terminal-tab__status"
                data-status={session.status}
              />
              <span
                className="terminal-tab__close"
                role="button"
                tabIndex={-1}
                title="Fermer le terminal"
                onClick={(event) => {
                  event.stopPropagation();
                  closeSession(session.id);
                }}
              >
                <Icon icon="solar:close-circle-linear" width={13} height={13} />
              </span>
            </div>
          ))}
        </div>
        <div className="terminal-tabs__actions">
          <button
            type="button"
            className="terminal-action"
            onClick={addSession}
            title="Nouveau terminal"
          >
            <Icon icon="solar:add-circle-linear" width={14} height={14} />
          </button>
          <button
            type="button"
            className="terminal-action"
            onClick={closeAllSessions}
            title="Fermer tous les terminaux"
            aria-label="Fermer tous les terminaux"
          >
            <Icon icon="solar:trash-bin-trash-linear" width={14} height={14} />
          </button>
          <button
            type="button"
            className="terminal-action"
            data-active={fullHeight ? "true" : "false"}
            onClick={onToggleFullHeight}
            title={fullHeight ? "Hauteur normale du terminal" : "Pleine hauteur"}
          >
            <Icon
              icon={
                fullHeight
                  ? "solar:quit-full-screen-square-linear"
                  : "solar:full-screen-square-linear"
              }
              width={14}
              height={14}
            />
          </button>
          <button
            type="button"
            className="terminal-action"
            onClick={onClose}
            title="Masquer le terminal"
          >
            <Icon
              icon="solar:square-alt-arrow-down-linear"
              width={14}
              height={14}
            />
          </button>
        </div>
      </div>

      <div className="terminal-views">
        {gitActive ? (
          <div className="terminal-viewport terminal-viewport--git" data-active="true">
            <GitPanel workspacePath={workspacePath} active={active} hasStreamingConversation={false} onSwitchWorkspace={async () => undefined} />
          </div>
        ) : null}
        {sessions.map((session) => (
          <TerminalSurface
            key={session.id}
            session={session}
            active={active && session.id === shownId}
            workspacePath={workspacePath}
            onStatus={(status) => patchSession(session.id, { status })}
            onTitle={(title) => patchSession(session.id, { title })}
            onOpenTerminalPath={onOpenTerminalPath}
          />
        ))}
      </div>
    </section>
  );
}

function TerminalSurface({
  session,
  active,
  workspacePath,
  onStatus,
  onTitle,
  onOpenTerminalPath,
}: {
  session: TerminalSession;
  active: boolean;
  workspacePath: string;
  onStatus: (status: TerminalStatus) => void;
  onTitle: (title: string) => void;
  onOpenTerminalPath?: (rawPath: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const tokenRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const disposablesRef = useRef<Disposable[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disposedRef = useRef(false);
  // Latest path-click handler kept in a ref so the link provider sees
  // updates without having to re-register every time the parent re-renders.
  const onOpenTerminalPathRef = useRef(onOpenTerminalPath);
  onOpenTerminalPathRef.current = onOpenTerminalPath;
  // axe:terminal-onglets - valeur courante de `active` pour les observateurs
  // crees une seule fois (le ResizeObserver gardait la valeur du demarrage).
  const activeRef = useRef(active);
  activeRef.current = active;

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    const token = tokenRef.current;
    if (!terminal || !fit || !container) return;

    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    try {
      fit.fit();
    } catch {
      // xterm cannot measure while the panel is hidden.
      return;
    }

    if (token) {
      void api.resizeTerminal(
        session.id,
        token,
        terminal.cols,
        terminal.rows,
        Math.max(0, Math.round(rect.width)),
        Math.max(0, Math.round(rect.height)),
      );
    }
  }, [session.id]);

  const startTerminal = useCallback(() => {
    const container = containerRef.current;
    if (!container || terminalRef.current) return;
    // axe:terminal-onglets - ne jamais ouvrir xterm dans un conteneur invisible
    // ou de taille 0 (onglet Git affiche, panneau en cours de mise en page) :
    // le rendu resterait vide. On attend qu'il ait une taille.
    const firstRect = container.getBoundingClientRect();
    if (firstRect.width <= 0 || firstRect.height <= 0) {
      if (!resizeObserverRef.current) {
        const waiter = new ResizeObserver(() => {
          const r = container.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && activeRef.current) {
            waiter.disconnect();
            if (resizeObserverRef.current === waiter) resizeObserverRef.current = null;
            startTerminalRef.current?.();
          }
        });
        waiter.observe(container);
        resizeObserverRef.current = waiter;
      }
      return;
    }
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;

    disposedRef.current = false;
    const token = createTerminalToken(session.id);
    tokenRef.current = token;
    onStatus("starting");

    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    const fontFamily = cssVar(
      "--font-mono",
      '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    );
    // axe:zoom — `--fs-mono` is a calc() expression now: scale the base
    // ourselves so xterm keeps exact cell metrics.
    // axe:e19 — le terminal ne suit plus le reglage « taille du texte » : seuls le
    // chat et les documents s'agrandissent.
    const fontSize = MONO_BASE_PX;

    const terminal = new Terminal({
      // Required for `unicode11` and a few other addons we register below.
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily,
      fontSize,
      letterSpacing: 0,
      // VS Code-style line height: keeps cells flush so WebGL redraws
      // don't leave half-pixel artefacts when TUIs repaint full-screen.
      lineHeight: 1.0,
      macOptionIsMeta: true,
      scrollback: 50_000,
      // Smooth pasted text in apps that don't enable bracketed paste.
      convertEol: false,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon((event, uri) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      void api.openExternalUrl(uri);
    });
    const unicode11 = new Unicode11Addon();
    const clipboard = new ClipboardAddon();

    terminal.loadAddon(fit);
    terminal.onWriteParsed(() => scheduleTerminalBufferSave(workspacePath, session.id));
    // Ctrl+Tab / Ctrl+Shift+Tab switch terminals: not sent to the shell.
    terminal.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.key === "Tab"));
    terminal.loadAddon(webLinks);
    terminal.loadAddon(unicode11);
    terminal.loadAddon(clipboard);
    try {
      terminal.unicode.activeVersion = "11";
    } catch {
      // Older xterm versions or proposed API disabled: silently ignore.
    }
    terminal.open(container);
    terminalBuffers.set(terminalBufferKey(workspacePath, session.id), terminal);
    try {
      const saved = localStorage.getItem(terminalBufferKey(workspacePath, session.id));
      if (saved) {
        const lines = JSON.parse(saved) as string[];
        terminal.write(`\x1b[2m--- historique enregistré (session précédente) ---\x1b[0m\r\n${lines.join("\r\n")}\r\n`);
      }
    } catch { /* no stored scrollback */ }

    // GPU renderer with graceful fallback to the built-in DOM renderer.
    // We try WebGL first (closest to VS Code), and if the context is
    // ever lost or the addon refuses to load we just dispose it -- xterm
    // automatically falls back to the DOM renderer.
    const tryEnableWebgl = () => {
      if (webglRef.current) return;
      // axe:terminal-onglets - sous Windows (WebView2) le canvas WebGL de xterm
      // peut rester vide alors que le shell tourne : rendu DOM, toujours fiable.
      if (/windows/i.test(navigator.userAgent)) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // Lost the GPU context (suspend / driver crash / tab background):
          // dispose the addon so xterm falls back to the DOM renderer.
          addon.dispose();
          webglRef.current = null;
        });
        terminal.loadAddon(addon);
        webglRef.current = addon;
      } catch (err) {
        // WebGL is unavailable or initialisation failed: stay on the
        // DOM renderer, which is slower but always works.
        console.warn("WebGL renderer unavailable, falling back to DOM", err);
      }
    };
    tryEnableWebgl();

    // Register the path link provider *after* the addons are loaded.
    // The provider opens files in the editor on cmd/ctrl+click; plain
    // hover decoration is handled by xterm.js for free.
    const linkProvider = createPathLinkProvider(terminal, () =>
      onOpenTerminalPathRef.current,
    );
    const linkProviderDisposable = terminal.registerLinkProvider(linkProvider);

    terminalRef.current = terminal;
    fitRef.current = fit;

    disposablesRef.current = [
      linkProviderDisposable,
      terminal.onData((data) => {
        const currentToken = tokenRef.current;
        if (!currentToken) return;
        void api.writeTerminal(session.id, currentToken, data);
      }),
      terminal.onResize(({ cols, rows }) => {
        const currentToken = tokenRef.current;
        if (!currentToken) return;
        const rect = containerRef.current?.getBoundingClientRect();
        void api.resizeTerminal(
          session.id,
          currentToken,
          cols,
          rows,
          Math.max(0, Math.round(rect?.width ?? 0)),
          Math.max(0, Math.round(rect?.height ?? 0)),
        );
      }),
      terminal.onTitleChange((title) => {
        const trimmed = title.trim();
        // pwsh annonce le chemin de son exe (« C:\\Program Files\\... ») : on garde « Terminal N ».
        if (trimmed && !isExecutablePathTitle(trimmed)) onTitle(trimmed);
      }),
    ];

    resizeObserverRef.current = new ResizeObserver(() => {
      if (activeRef.current) fitTerminal();
    });
    resizeObserverRef.current.observe(container);

    const dataListener = listen<TerminalDataPayload>(
      "terminal-data",
      (event) => {
        const payload = event.payload;
        if (payload.sessionId !== session.id || payload.token !== token) return;
        terminal.write(payload.data);
      },
    );

    const exitListener = listen<TerminalExitPayload>(
      "terminal-exit",
      (event) => {
        const payload = event.payload;
        if (payload.sessionId !== session.id || payload.token !== token) return;
        tokenRef.current = null;
        onStatus(payload.exitCode === 0 ? "exited" : "error");
        terminal.write("\r\n\x1b[2m[processus terminé]\x1b[0m\r\n");
      },
    );

    void Promise.all([dataListener, exitListener]).then((unlisteners) => {
      for (const unlisten of unlisteners) {
        if (disposedRef.current) {
          unlisten();
        } else {
          unlistenersRef.current.push(unlisten);
        }
      }

      requestAnimationFrame(() => {
        if (disposedRef.current) return;
        try {
          fit.fit();
        } catch {
          // panel may still be measuring; spawn with current cols/rows anyway.
        }
        const rect = container.getBoundingClientRect();
        void api
          .spawnTerminal(
            workspacePath,
            session.id,
            token,
            Math.max(terminal.cols, 20),
            Math.max(terminal.rows, 4),
            Math.max(0, Math.round(rect.width)),
            Math.max(0, Math.round(rect.height)),
            session.shell,
          )
          .then(() => {
            if (disposedRef.current || tokenRef.current !== token) return;
            onStatus("running");
            if (active) terminal.focus();
          })
          .catch((err) => {
            if (disposedRef.current) return;
            tokenRef.current = null;
            onStatus("error");
            terminal.write(`\r\n\x1b[31m${stripAnsi(String(err))}\x1b[0m\r\n`);
          });
      });
    }).catch((err) => {
      if (disposedRef.current) return;
      tokenRef.current = null;
      onStatus("error");
      terminal.write(`\r\n\x1b[31m${stripAnsi(String(err))}\x1b[0m\r\n`);
    });
  }, [active, fitTerminal, onStatus, onTitle, session.id, workspacePath]);
  const startTerminalRef = useRef(startTerminal);
  startTerminalRef.current = startTerminal;

  useEffect(() => {
    if (active) startTerminal();
  }, [active, startTerminal]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitTerminal();
      // Retour depuis l'onglet Git (display:none) : redessiner tout l'ecran.
      const terminal = terminalRef.current;
      if (terminal) terminal.refresh(0, Math.max(0, terminal.rows - 1));
      terminal?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, fitTerminal]);

  // axe:theme — follow the background colour picked in Settings > Apparence.
  useEffect(
    () =>
      onThemeChange(() => {
        const terminal = terminalRef.current;
        if (terminal) terminal.options.theme = terminalTheme();
      }),
    [],
  );

  // axe:e19 — le reglage « taille du texte » ne concerne plus le terminal : son
  // texte garde 12 px, quelle que soit la valeur choisie pour le chat et les documents.

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      const token = tokenRef.current;
      tokenRef.current = null;
      if (token) {
        void api.killTerminal(session.id, token);
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      for (const dispose of disposablesRef.current) dispose.dispose();
      disposablesRef.current = [];
      for (const unlisten of unlistenersRef.current) unlisten();
      unlistenersRef.current = [];
      // WebGL must be disposed before the parent terminal so its GPU
      // resources are released cleanly.
      try {
        webglRef.current?.dispose();
      } catch {
        // ignore
      }
      webglRef.current = null;
      persistTerminalBuffer(workspacePath, session.id);
      terminalBuffers.delete(terminalBufferKey(workspacePath, session.id));
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [session.id, workspacePath]);

  return (
    <div
      ref={containerRef}
      className="terminal-viewport"
      data-active={active ? "true" : "false"}
      // No global onMouseDown focus -- it would steal the mouse
      // selection. Click on the empty area still focuses thanks to
      // xterm's own handlers.
    />
  );
}

function terminalStorageKey(workspacePath: string): string {
  return `axecode:terminals:${workspacePath}`;
}

function loadTerminalSessions(workspacePath: string): TerminalSession[] {
  try {
    const raw = localStorage.getItem(terminalStorageKey(workspacePath));
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ index?: number; title?: string; customTitle?: string; shell?: string }>;
      const sessions = parsed.filter((item) => Number.isInteger(item.index) && typeof item.title === "string").map((item) => ({
        id: `terminal-${item.index}`,
        index: item.index!,
        // "Prime Agent" was the old default name of the first tab: it only ever ran PowerShell.
        // axe:terminal-onglets - ancien titre = chemin de pwsh.exe : on revient a « Terminal N ».
        title: item.title === "Prime Agent" || isExecutablePathTitle(item.title!) ? `Terminal ${item.index}` : item.title!,
        customTitle: typeof item.customTitle === "string" && item.customTitle ? item.customTitle : undefined,
        shell: item.shell === "bash" ? "bash" : "powershell",
        status: "idle" as TerminalStatus,
      }));
      if (sessions.length) return sessions;
    }
  } catch { /* use defaults */ }
  return [createSession(1)];
}

function createSession(index: number): TerminalSession {
  return {
    id: `terminal-${index}`,
    index,
    title: `Terminal ${index}`,
    status: "idle",
    shell: "powershell",
  };
}

function createTerminalToken(sessionId: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${sessionId}-${crypto.randomUUID()}`;
  }
  return `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// axe:theme — derived from the Axe theme so light backgrounds get a light terminal.
function terminalTheme() {
  return xtermTheme();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// ---------------------------------------------------------------------------
// Path link provider
// ---------------------------------------------------------------------------
//
// VS Code-style cmd/ctrl+click on file paths printed in the terminal.
// Detects the most common path shapes emitted by CLIs (compilers, AI
// coding agents, grep/rg, ...):
//
//   foo.tsx                 (bare filename with known-ish extension)
//   src/foo/bar.ts          (relative path with at least one slash)
//   ./foo.ts, ../foo.ts     (explicitly relative)
//   /Users/.../foo.ts       (absolute POSIX)
//   ~/.config/foo.ts        (home-relative)
//   foo.tsx:42, foo.tsx:42:5
//
// URLs (http/https/...) are deliberately ignored -- the WebLinksAddon
// handles those.

const PATH_LINK_REGEX =
  // 1) (~ or ./ or ../)?/... or 2) bare path with slash or 3) bare filename
  //    .ext, all with an optional :line[:col] suffix.
  /(?:(?:~|\.{1,2})?\/[A-Za-z0-9_.+\-@~/]+|[A-Za-z0-9_.+\-@]+(?:\/[A-Za-z0-9_.+\-@]+)+|[A-Za-z0-9_.+\-@]+\.[A-Za-z][A-Za-z0-9]{0,6})(?::\d+(?::\d+)?)?/g;

const URL_LIKE_PREFIX = /^(?:https?:|ftp:|ssh:|file:|mailto:|git\+|tel:)/i;

function createPathLinkProvider(
  terminal: Terminal,
  getHandler: () => ((rawPath: string) => void) | undefined,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const text = readLogicalLine(terminal, bufferLineNumber);
      if (!text) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      // `lastIndex` cursor handles overlapping potential matches.
      PATH_LINK_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PATH_LINK_REGEX.exec(text)) !== null) {
        const raw = match[0];
        if (!raw || URL_LIKE_PREFIX.test(raw)) continue;
        // Strip trailing punctuation that the regex may have eaten
        // ("see foo.ts." or "(foo.ts)").
        const trimmed = raw.replace(/[),.;:\]]+$/g, (tail) => {
          // Keep `:N` and `:N:M` line/col suffixes.
          if (/^:\d+(?::\d+)?$/.test(tail)) return tail;
          // Drop other trailing punctuation only if it isn't part of a
          // line/col suffix.
          return tail.replace(/[),.;\]]+$/g, "");
        });
        if (!trimmed) continue;

        const startIndex = match.index;
        const endIndex = startIndex + trimmed.length;
        const range = logicalRangeToBufferRange(
          terminal,
          bufferLineNumber,
          startIndex,
          endIndex,
        );
        if (!range) continue;

        links.push({
          range,
          text: trimmed,
          activate(event) {
            // VS Code semantics: cmd/ctrl+click only.
            if (!event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            event.stopPropagation();
            getHandler()?.(trimmed);
          },
          hover() {
            // xterm.js applies the default link styling automatically.
          },
          leave() {
            // no-op
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * xterm represents wrapped lines as multiple buffer rows. For accurate
 * path matching we collapse the wrapped slice back into a single logical
 * string starting at `bufferLineNumber`.
 */
function readLogicalLine(terminal: Terminal, bufferLineNumber: number): string {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(bufferLineNumber);
  if (!line) return "";
  // Walk back to the start of a wrapped logical line so the regex sees
  // the full text. We then stitch all wrapped rows forward.
  let start = bufferLineNumber;
  while (start > 0) {
    const prev = buffer.getLine(start - 1);
    if (!prev || !buffer.getLine(start)?.isWrapped) break;
    start -= 1;
  }
  const parts: string[] = [];
  let cursor = start;
  while (true) {
    const current = buffer.getLine(cursor);
    if (!current) break;
    parts.push(current.translateToString(true));
    const next = buffer.getLine(cursor + 1);
    if (!next || !next.isWrapped) break;
    cursor += 1;
  }
  return parts.join("");
}

/**
 * Convert a [start,end] offset inside the *logical* (unwrapped) line
 * starting at `bufferLineNumber` to xterm's wrapped-buffer coordinates.
 */
function logicalRangeToBufferRange(
  terminal: Terminal,
  bufferLineNumber: number,
  startIndex: number,
  endIndex: number,
): IBufferRange | null {
  const cols = terminal.cols;
  if (cols <= 0) return null;
  // Find the first row of the wrapped logical line.
  const buffer = terminal.buffer.active;
  let firstRow = bufferLineNumber;
  while (firstRow > 0) {
    if (!buffer.getLine(firstRow)?.isWrapped) break;
    firstRow -= 1;
  }
  const startRowOffset = Math.floor(startIndex / cols);
  const startCol = startIndex - startRowOffset * cols;
  const endRowOffset = Math.floor(Math.max(0, endIndex - 1) / cols);
  const endCol = (endIndex - 1) - endRowOffset * cols;
  return {
    // xterm.js link ranges are 1-based.
    start: { x: startCol + 1, y: firstRow + startRowOffset + 1 },
    end: { x: endCol + 1, y: firstRow + endRowOffset + 1 },
  };
}
