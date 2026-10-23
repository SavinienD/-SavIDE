// axe:v2-e12 — un terminal LOCAL : le shell du poste sur lequel tourne l'appli
// (a cote des terminaux du service, qui vivent sur la machine distante).
// Le shell reste monte tant que l'onglet existe : changer d'onglet ne le tue pas.
import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, CLOUD_WORKSPACE_PREFIX } from "../../lib/ipc";
import type { TerminalDataPayload, TerminalExitPayload } from "../../types";

type Props = { workspacePath: string; sessionId: string };

/// Un jeton par ouverture : deux onglets peuvent porter le meme nom sans melanger leurs octets.
function jeton(sessionId: string) {
  const suite =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${sessionId}-${suite}`;
}

export function LocalTerminal({ workspacePath, sessionId }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Ouverture…");
  /// Dossier de depart du shell local. Un espace cloud (`axe-cloud://…`) n'existe
  /// pas sur ce poste : on part alors du dossier personnel de l'utilisateur.
  const [cwd, setCwd] = useState<string | null>(
    workspacePath && !workspacePath.startsWith(CLOUD_WORKSPACE_PREFIX) ? workspacePath : null,
  );

  useEffect(() => {
    let alive = true;
    if (workspacePath && !workspacePath.startsWith(CLOUD_WORKSPACE_PREFIX)) {
      setCwd(workspacePath);
      return;
    }
    void homeDir()
      .then((home) => {
        if (alive) setCwd(home);
      })
      .catch(() => {
        if (alive) setStatus("Impossible de trouver le dossier personnel de ce poste.");
      });
    return () => {
      alive = false;
    };
  }, [workspacePath]);

  useEffect(() => {
    const el = host.current;
    if (!el || !cwd) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, Consolas, monospace",
      fontSize: 13,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* le panneau se mesure encore */
    }

    const token = jeton(sessionId);
    let alive = true;
    let offs: UnlistenFn[] = [];

    const brancher = async () => {
      const data = await listen<TerminalDataPayload>("terminal-data", (e) => {
        if (e.payload.sessionId === sessionId && e.payload.token === token) term.write(e.payload.data);
      });
      const exited = await listen<TerminalExitPayload>("terminal-exit", (e) => {
        if (e.payload.sessionId !== sessionId || e.payload.token !== token) return;
        setStatus(`Terminal terminé (code ${e.payload.exitCode ?? "?"})`);
      });
      if (!alive) {
        data();
        exited();
        return;
      }
      offs = [data, exited];
      const rect = el.getBoundingClientRect();
      try {
        await api.spawnTerminal(
          cwd,
          sessionId,
          token,
          Math.max(term.cols, 20),
          Math.max(term.rows, 4),
          Math.max(0, Math.round(rect.width)),
          Math.max(0, Math.round(rect.height)),
        );
        if (!alive) return;
        setStatus("Shell de ce poste");
        term.focus();
      } catch (e) {
        setStatus(`Erreur : ${String(e).replace(/^Error:\s*/i, "")}`);
      }
    };

    const onData = term.onData((d) => {
      void api.writeTerminal(sessionId, token, d).catch(() => undefined);
    });
    const onResize = term.onResize(({ cols, rows }) => {
      void api.resizeTerminal(sessionId, token, cols, rows).catch(() => undefined);
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* en cours de mesure */
      }
    });
    ro.observe(el);
    // La police chargée après coup change la hauteur des lignes sans changer la
    // taille de l'hôte : on réajuste pour que la dernière ligne reste entière.
    void document.fonts?.ready.then(() => {
      if (!alive) return;
      try {
        fit.fit();
      } catch {
        /* en cours de mesure */
      }
    });
    void brancher();

    return () => {
      alive = false;
      onData.dispose();
      onResize.dispose();
      ro.disconnect();
      for (const off of offs) off();
      // L'onglet a disparu : le shell local n'a plus de raison de tourner.
      void api.killTerminal(sessionId, token).catch(() => undefined);
      term.dispose();
    };
  }, [cwd, sessionId]);

  return (
    <div className="cloud-term__local">
      <div className="cloud-term__status">{status}</div>
      <div ref={host} className="cloud-term__local-host" />
    </div>
  );
}
