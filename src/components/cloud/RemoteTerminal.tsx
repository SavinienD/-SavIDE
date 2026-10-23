// axe:cloud L3 — terminal running inside the cloud service (PTY confined to the
// workspace root). Bytes travel base64-encoded both ways; output arrives on the
// `axe://daemon` event stream tagged with the connection id.
//
// axe:e12b — deux règles apprises du terrain :
//   1. on n'ouvre RIEN tant que le volet n'a pas une taille mesurable (un volet
//      caché ouvrait la session à 80×24, taille qu'elle gardait) ;
//   2. c'est le PTY du service qui pilote tmux : après chaque changement de
//      taille visible on renvoie `term.resize`, même si xterm estime n'avoir
//      rien changé. Sans cela, une session restait large de 12 colonnes et le
//      texte débordait à droite.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { errorText } from "./cloudApi";

type Props = { connectionId: string; cwd?: string; name?: string };

type TermEvent = {
  event: string;
  connectionId?: string;
  data?: { terminalId?: string; kind?: "output" | "exit"; data?: string | number | null };
};

const enc = new TextEncoder();
const toB64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));
const fromB64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

/** En dessous, le volet n'est pas encore posé (display:none, colonne effondrée). */
const LARGEUR_MESURABLE = 40;
const HAUTEUR_MESURABLE = 40;

export function RemoteTerminal({ connectionId, cwd, name }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<string>("Ouverture…");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 13, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let terminalId: string | null = null;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    let ouvert = false;
    let minuterie: number | null = null;

    /** Redimensionne xterm sur la place réelle ; false si le volet n'est pas mesurable. */
    const ajuster = (): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width < LARGEUR_MESURABLE || rect.height < HAUTEUR_MESURABLE) return false;
      try {
        fit.fit();
      } catch {
        return false;
      }
      return true;
    };

    /** Réaligne xterm puis le PTY du service (c'est lui qui pilote tmux). */
    const realigner = () => {
      if (minuterie !== null) window.clearTimeout(minuterie);
      minuterie = window.setTimeout(() => {
        minuterie = null;
        if (!ajuster() || !terminalId) return;
        void invoke("remote_term_resize", {
          input: { connectionId, terminalId, cols: term.cols, rows: term.rows },
        }).catch(() => undefined);
      }, 80);
    };

    const ouvrir = async () => {
      if (ouvert || disposed) return;
      // La session naît à la taille du volet : on attend qu'il soit posé.
      if (!ajuster()) return;
      ouvert = true;
      try {
        unlisten = await listen<TermEvent>("axe://daemon", (ev) => {
          const p = ev.payload;
          if (p.event !== "terminal" || p.connectionId !== connectionId || !terminalId) return;
          if (p.data?.terminalId !== terminalId) return;
          if (p.data.kind === "output" && typeof p.data.data === "string") term.write(fromB64(p.data.data));
          else if (p.data.kind === "exit") setStatus(`Terminal terminé (code ${p.data.data ?? "?"})`);
        });
        const previousId = terminalIdRef.current ?? name ?? null;
        if (previousId) {
          try {
            await invoke("remote_term_attach", { input: { connectionId, terminalId: previousId } });
            terminalId = previousId;
            await invoke("remote_term_resize", { input: { connectionId, terminalId, cols: term.cols, rows: term.rows } });
            setStatus("Session reprise."); // axe:v2-l2.3 — pas de nom technique dans l'interface
            term.focus();
            return;
          } catch {
            terminalIdRef.current = null;
          }
        }
        const r = await invoke<{ terminalId: string; tmux: boolean; cwd: string }>("remote_term_open", {
          input: { connectionId, cwd: cwd ?? "", name: name ?? null, cols: term.cols, rows: term.rows },
        });
        terminalIdRef.current = r.terminalId;
        if (disposed) return;
        terminalId = r.terminalId;
        setStatus(`${r.cwd}${r.tmux ? " · tmux (reprise possible)" : ""}`);
        term.focus();
      } catch (e) {
        ouvert = false; // on retentera au prochain passage visible
        setStatus(`Erreur : ${errorText(e)}`);
      }
    };

    const onData = term.onData((d) => {
      if (!terminalId) return;
      void invoke("remote_term_write", { input: { connectionId, terminalId, data: toB64(d) } }).catch((e) => setStatus(`Erreur : ${errorText(e)}`));
    });
    const onResize = term.onResize(({ cols, rows }) => {
      if (!terminalId) return;
      void invoke("remote_term_resize", { input: { connectionId, terminalId, cols, rows } }).catch(() => undefined);
    });
    const ro = new ResizeObserver(() => {
      // Volet caché → posé : on ouvre alors, et on réaligne dans tous les cas.
      void ouvrir();
      realigner();
    });
    ro.observe(el);
    void ouvrir();

    return () => {
      disposed = true;
      if (minuterie !== null) window.clearTimeout(minuterie);
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      if (unlisten) unlisten();
      // Close the PTY: with tmux the session survives in the service and the
      // next open with the same name re-attaches; only the view is disposed.
      // Keep the server PTY alive; a later mount attaches by terminal id.
      term.dispose();
    };
  }, [connectionId, cwd, name]);

  return (
    <div className="rw-term">
      <div className="rw-term__status rw__muted">{status}</div>
      <div className="rw-term__host" ref={host} />
    </div>
  );
}
