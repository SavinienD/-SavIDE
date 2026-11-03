// v2-e12 — onglet « Agent » epingle : on s'attache a la session de l'agent qui tourne
// deja en production. Le portail la garde ouverte en permanence ; on ne la relance pas (une
// seconde instance travaillerait sur le meme etat et casserait la production).
//
// L'application ouvre le WebSocket du portail cote Rust — un WebSocket de page ne peut pas
// porter l'en-tete d'autorisation — puis pousse les octets ici par evenements.
import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../lib/ipc";
import { reprendreTaille } from "./repriseTaille";

type Props = { connectionId: string };

export function AgentTerminal({ connectionId }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [etat, setEtat] = useState("Connexion à l'agent…");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* le panneau se mesure encore */
    }

    const session = { id: null as string | null };
    let vivant = true;
    const offs: UnlistenFn[] = [];

    const brancher = async () => {
      const donnees = await listen<{ id: string; data: string }>("agent-term-data", (e) => {
        if (session.id && e.payload.id === session.id) term.write(e.payload.data);
      });
      const sortie = await listen<{ id: string; raison: string }>("agent-term-exit", (e) => {
        if (!session.id || e.payload.id !== session.id) return;
        session.id = null;
        setEtat(e.payload.raison ? `Session terminée — ${e.payload.raison}` : "Session terminée");
      });
      if (!vivant) {
        donnees();
        sortie();
        return;
      }
      offs.push(donnees, sortie);
      try {
        const nouvelle = await api.agentTermOpen(connectionId);
        if (!vivant) {
          void api.agentTermClose(nouvelle).catch(() => undefined);
          return;
        }
        session.id = nouvelle;
        setEtat("Session de production de l'agent");
        void api.agentTermResize(nouvelle, term.cols, term.rows).catch(() => undefined);
        term.focus();
      } catch (e) {
        setEtat(String(e).replace(/^Error:\s*/i, ""));
      }
    };

    const onData = term.onData((d) => {
      if (!session.id) return;
      void api.agentTermWrite(session.id, d).catch(() => undefined);
    });
    // La session tmux est partagée (portail, SSH) : on renvoie toujours notre taille,
    // même quand xterm n'a pas changé de colonnes (voir repriseTaille.ts).
    const envoyerTaille = () => {
      if (!session.id || el.clientWidth < 40 || el.clientHeight < 20) return;
      void api.agentTermResize(session.id, term.cols, term.rows).catch(() => undefined);
    };
    const onResize = term.onResize(({ cols, rows }) => {
      if (!session.id) return;
      void api.agentTermResize(session.id, cols, rows).catch(() => undefined);
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* en cours de mesure */
      }
      envoyerTaille();
    });
    ro.observe(el);
    const offReprise = reprendreTaille(el, envoyerTaille);
    void brancher();

    return () => {
      vivant = false;
      onData.dispose();
      onResize.dispose();
      ro.disconnect();
      offReprise();
      for (const off of offs) off();
      // On se detache : la session de l'agent, elle, continue de tourner.
      if (session.id) void api.agentTermClose(session.id).catch(() => undefined);
      term.dispose();
    };
  }, [connectionId]);

  return (
    <div className="cloud-term__local">
      <div className="cloud-term__status">{etat}</div>
      <div ref={host} className="cloud-term__local-host" />
    </div>
  );
}
