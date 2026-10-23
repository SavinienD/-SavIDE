import { useEffect, useMemo, useRef, useState } from "react";
import { service, type JournalEntry, type JournalTree, type SessionMeta } from "./api";
import { TranscriptItem } from "./Transcript";
import { branch, buildItems, workspaceLabel, type Item } from "./items";

type Live = {
  text: Record<number, string>;
  thinking: Record<number, string>;
  repl: Record<string, string>;
  files: Record<string, string[]>;
  busy: string | null;
};

const EMPTY_LIVE: Live = { text: {}, thinking: {}, repl: {}, files: {}, busy: null };

type Props = {
  meta: SessionMeta;
  onBack: () => void;
  composer?: React.ReactNode;
};

/** Full journal of one session, kept live from `entry` / `stream` events. */
export function Conversation({ meta, onBack, composer }: Props) {
  const [tree, setTree] = useState<JournalTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const id = meta.id;

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setLive(EMPTY_LIVE);
    setError(null);
    stick.current = true;
    const load = () =>
      service
        .tree(id)
        .then((t) => !cancelled && setTree(t))
        .catch((e) => !cancelled && setError(String(e.message ?? e)));
    void service.attach(id).catch(() => {});
    void load();
    const offState = service.onState((connected) => {
      if (connected) {
        void service.attach(id).catch(() => {});
        void load();
      }
    });
    const offEvent = service.onEvent((ev) => {
      if (ev.sessionId !== id) return;
      if (ev.event === "entry") {
        const entry = ev.data as JournalEntry;
        setTree((t) => (t ? { ...t, leaf: entry.id, entries: [...t.entries, entry] } : t));
        if (entry.kind === "message" && (entry.message as { role?: string })?.role === "assistant") {
          setLive((l) => ({ ...l, text: {}, thinking: {} }));
        }
      } else if (ev.event === "stream") {
        const e = ev.data?.event ?? {};
        setLive((l) => applyStream(l, e));
      }
    });
    return () => {
      cancelled = true;
      offState();
      offEvent();
      void service.detach(id).catch(() => {});
    };
  }, [id]);

  const items = useMemo<Item[]>(() => {
    if (!tree) return [];
    const base = buildItems(branch(tree)).map((item) =>
      item.type === "repl"
        ? { ...item, live: live.repl[item.callId], fileChanges: live.files[item.callId] ?? item.fileChanges }
        : item,
    );
    const text = Object.keys(live.text).sort().map((k) => live.text[Number(k)]).join("");
    const thinking = Object.keys(live.thinking).sort().map((k) => live.thinking[Number(k)]).join("");
    if (text || thinking) {
      base.push({ type: "assistant", key: "live", text, thinking, ts: Date.now(), streaming: true });
    }
    return base;
  }, [tree, live]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const running = meta.status === "running";

  return (
    <section className="conv">
      <header className="conv__head">
        <button type="button" className="conv__back" onClick={onBack} aria-label="Retour">
          ←
        </button>
        <div className="conv__title">
          <strong>{meta.name || "Sans titre"}</strong>
          <span className="muted">
            {meta.scratch ? "Conversation libre" : workspaceLabel(meta.workspaceId)} · {meta.model.provider} / {meta.model.name}
          </span>
        </div>
        {running && <span className="conv__running">{live.busy ?? "en cours…"}</span>}
      </header>
      <div
        className="conv__scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {error && <p className="error">{error}</p>}
        {!tree && !error && <p className="muted">Chargement…</p>}
        {items.map((item) => (
          <TranscriptItem key={item.key} item={item} />
        ))}
      </div>
      {composer}
    </section>
  );
}

function applyStream(l: Live, e: any): Live {
  switch (e.type) {
    case "text_delta":
      return { ...l, busy: "rédige…", text: { ...l.text, [e.index]: (l.text[e.index] ?? "") + e.delta } };
    case "thinking_delta":
      return { ...l, busy: "réfléchit…", thinking: { ...l.thinking, [e.index]: (l.thinking[e.index] ?? "") + e.delta } };
    case "repl_start":
      return { ...l, busy: "exécute du Python…", repl: { ...l.repl, [e.callId]: "" } };
    case "repl_stream":
      return { ...l, repl: { ...l.repl, [e.callId]: ((l.repl[e.callId] ?? "") + e.text).slice(-20_000) } };
    case "file_change":
      return { ...l, files: { ...l.files, [e.callId]: [...(l.files[e.callId] ?? []), String(e.path)] } };
    case "repl_done": {
      const changes = Array.isArray(e.fileChanges) ? e.fileChanges.map((f: { path?: string }) => String(f.path ?? f)) : [];
      return changes.length ? { ...l, files: { ...l.files, [e.callId]: changes } } : l;
    }
    case "compaction_start":
      return { ...l, busy: "compacte…" };
    // axe:reprise — stream cut, request sent again: the reply starts over.
    case "stream_retry":
      return { ...l, busy: "reprend…", text: {}, thinking: {} };
    case "turn_done":
    case "turn_error":
      return { ...l, busy: null, text: {}, thinking: {} };
    default:
      return l;
  }
}
