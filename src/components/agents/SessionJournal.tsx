// axe:sub-m — read-only journal of a session (sub-agents included, even inactive):
// messages, tool calls and results along the current branch, shown in the chat column.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentsApi, describeEntry, type JournalEntry, type JournalTree } from "./agentsApi";
import "./agents.css";

type Props = {
  sessionId: string;
  connectionId?: string;
  title?: string;
  onClose: () => void;
};

const SKIP = new Set(["pointer", "peer_delivered", "meta"]);

function messageText(entry: JournalEntry): { role: string; text: string } {
  const msg = entry.message as
    | { role?: string; parts?: { type?: string; text?: string; name?: string }[] }
    | undefined;
  const text = (msg?.parts ?? [])
    .map((p) => p.text ?? (p.name ? `[${p.type ?? "outil"} ${p.name}]` : ""))
    .filter(Boolean)
    .join("\n");
  return { role: msg?.role ?? "user", text };
}

export function SessionJournal({ sessionId, connectionId = "local", title, onClose }: Props) {
  const [tree, setTree] = useState<JournalTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  // axe:journal-bas - le journal d'un agent s'ouvre sur son dernier message et suit les nouveaux,
  // sauf si l'utilisateur est remonté lire plus haut.
  const corpsRef = useRef<HTMLDivElement | null>(null);
  const collerEnBas = useRef(true);
  useEffect(() => {
    collerEnBas.current = true;
  }, [sessionId, connectionId]);
  const surDefilement = useCallback(() => {
    const el = corpsRef.current;
    if (el) collerEnBas.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const load = useCallback(async () => {
    try {
      setTree(await agentsApi.tree(sessionId, connectionId));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, connectionId]);

  useEffect(() => {
    setTree(null);
    void load();
    let unlisten: (() => void) | undefined;
    void agentsApi
      .onEvent((event) => {
        if (event.sessionId === sessionId && (event.connectionId ?? "local") === connectionId) void load();
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [load, sessionId, connectionId]);

  /** Entries from the root to the current leaf (falls back to every entry). */
  const path = useMemo(() => {
    const entries = tree?.entries ?? [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const out: JournalEntry[] = [];
    let cursor = tree?.leaf;
    while (cursor) {
      const e = byId.get(cursor);
      if (!e) break;
      out.push(e);
      cursor = e.parent;
    }
    const list = out.length ? out.reverse() : entries;
    return list.filter((e) => !SKIP.has(e.kind));
  }, [tree]);
  useLayoutEffect(() => {
    const el = corpsRef.current;
    if (el && collerEnBas.current) el.scrollTop = el.scrollHeight;
  }, [path]);

  return (
    <div className="axe-journal">
      <header className="axe-journal__head">
        <strong title={title}>{title ?? sessionId.slice(0, 8)}</strong>
        <span className="axe-agents__muted">lecture seule · {path.length} entrées</span>
        <button type="button" onClick={() => void load()} title="Rafraîchir">↻</button>
        <button type="button" onClick={onClose} aria-label="Fermer">×</button>
      </header>
      {error ? <p className="axe-agents__error">{error}</p> : null}
      {!tree && !error ? <p className="axe-agents__muted">Chargement du journal…</p> : null}
      <div className="axe-journal__body" ref={corpsRef} onScroll={surDefilement}>
        {path.map((entry) => {
          const time = new Date(entry.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
          if (entry.kind === "message") {
            const { role, text } = messageText(entry);
            return (
              <div key={entry.id} className="axe-journal__msg" data-role={role}>
                <div className="axe-journal__meta">{role === "assistant" ? "Agent" : role === "user" ? "Tâche / utilisateur" : role} · {time}</div>
                <div className="axe-journal__text">{text || "(vide)"}</div>
              </div>
            );
          }
          if (entry.kind === "repl_call") {
            return (
              <details key={entry.id} className="axe-journal__tool">
                <summary>python · {time} — {String(entry.code ?? "").split("\n")[0].slice(0, 90)}</summary>
                <pre>{String(entry.code ?? "")}</pre>
              </details>
            );
          }
          if (entry.kind === "repl_result") {
            return (
              <details key={entry.id} className="axe-journal__tool" data-error={entry.is_error ? "true" : "false"}>
                <summary>{entry.is_error ? "erreur" : "résultat"} · {time}</summary>
                <pre>{String(entry.output ?? "")}</pre>
              </details>
            );
          }
          return (
            <div key={entry.id} className="axe-journal__event">
              {time} · {describeEntry(entry)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
