import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/// Returns true when the webview is running on Windows.
///
/// Uses the modern `userAgentData.platform` when available (Chromium-based
/// WebView2) and falls back to the legacy user-agent sniff. Designed to be
/// safe to call during module evaluation and SSR.
export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData;
  const platform =
    uaData?.platform ?? navigator.platform ?? navigator.userAgent ?? "";
  return /win/i.test(platform);
}

/// Native-feel custom window controls (minimize / maximize / close) that we
/// render inside the titlebar when the OS chrome is hidden — currently only
/// on Windows, where `decorations: false` removes the system caption.
///
/// On any other platform we return `null` so the macOS traffic lights and
/// Linux WM controls keep handling the window themselves.
export function WindowControls() {
  const [enabled] = useState<boolean>(() => isWindowsPlatform());
  const [maximized, setMaximized] = useState<boolean>(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    const win = getCurrentWindow();

    const sync = async () => {
      try {
        const m = await win.isMaximized();
        if (!cancelled) setMaximized(m);
      } catch {
        // Window APIs can briefly fail during transitions; ignore.
      }
    };

    void sync();
    void win
      .onResized(() => {
        void sync();
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        /* listener wiring failure — controls still operate manually */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled]);

  if (!enabled) return null;

  const win = getCurrentWindow();
  const onMinimize = () => {
    void win.minimize().catch(() => {});
  };
  const onToggleMaximize = () => {
    void win.toggleMaximize().catch(() => {});
  };
  const onClose = () => {
    void win.close().catch(() => {});
  };

  return (
    <div
      className="titlebar__window-controls"
      data-tauri-drag-region="false"
      aria-label="Commandes de la fenêtre"
    >
      <button
        type="button"
        className="titlebar__window-control"
        onClick={onMinimize}
        title="Réduire"
        aria-label="Réduire"
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="titlebar__window-control"
        onClick={onToggleMaximize}
        title={maximized ? "Restaurer" : "Agrandir"}
        aria-label={maximized ? "Restaurer" : "Agrandir"}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        className="titlebar__window-control titlebar__window-control--close"
        onClick={onClose}
        title="Fermer"
        aria-label="Fermer"
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

/* ── Glyphs ───────────────────────────────────────────────────────────── */
/* 10×10 Fluent-style strokes drawn with currentColor so the buttons can */
/* keep their hover color via CSS without touching SVG attrs.            */

function MinimizeGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path d="M1 5h8" stroke="currentColor" strokeWidth="1" strokeLinecap="square" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      {/* Back square */}
      <path
        d="M2.5 2.5V1h7v7H8"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
      />
      {/* Front square */}
      <rect
        x="0.5"
        y="2.5"
        width="7"
        height="7"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1 1l8 8M9 1l-8 8"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="square"
      />
    </svg>
  );
}
