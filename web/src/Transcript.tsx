import { useState } from "react";
import { Markdown } from "./Markdown";
import type { Item, ReplItem } from "./items";

function firstLine(code: string): string {
  const line = code.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
  return (line ?? code.split(/\r?\n/)[0] ?? "").trim() || "python";
}

function duration(ms?: number): string | null {
  if (ms === undefined || ms === 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1).replace(".", ",")} s` : `${ms} ms`;
}

/** Condensed, expandable card of one `python(code)` execution. */
export function ReplCard({ item }: { item: ReplItem }) {
  const [open, setOpen] = useState(false);
  const output = item.output ?? item.live ?? "";
  const summary = item.running
    ? "exécution…"
    : output.split(/\r?\n/).find((l) => l.trim()) || "(aucune sortie)";
  return (
    <div className="repl" data-error={Boolean(item.isError)} data-running={item.running}>
      <button type="button" className="repl__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="repl__chevron">{open ? "▾" : "▸"}</span>
        <code className="repl__code">{firstLine(item.code)}</code>
        <span className="repl__summary">{summary}</span>
        {duration(item.durationMs) && <span className="repl__time">{duration(item.durationMs)}</span>}
      </button>
      {open && (
        <div className="repl__body">
          <pre className="repl__src">{item.code}</pre>
          {output && <pre className="repl__out">{output}</pre>}
          {item.fileChanges && item.fileChanges.length > 0 && (
            <ul className="repl__files">
              {item.fileChanges.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "▾" : "▸"} Réflexion{streaming ? "…" : ""}
      </button>
      {open && <pre>{text}</pre>}
    </div>
  );
}

export function TranscriptItem({ item }: { item: Item }) {
  switch (item.type) {
    case "user":
      return (
        <div className="msg msg--user">
          {item.images.map((src, i) => (
            <img key={i} src={src} alt="pièce jointe" className="msg__image" />
          ))}
          {item.text && <div className="msg__bubble">{item.text}</div>}
        </div>
      );
    case "assistant":
      return (
        <div className="msg msg--assistant">
          {item.thinking && <Thinking text={item.thinking} streaming={item.streaming} />}
          {item.text && <Markdown text={item.text} />}
        </div>
      );
    case "repl":
      return <ReplCard item={item} />;
    case "note":
      return <div className={`note ${item.tone === "error" ? "note--error" : ""}`}>{item.text}</div>;
  }
}
