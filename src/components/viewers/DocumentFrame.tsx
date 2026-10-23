// axe:viewers — shell shared by document viewers rendered as HTML (docx,
// epub): toolbar with in-document search, optional side panel, SafeFrame.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { highlightDocument, SafeFrame } from "./SafeFrame";

type Props = {
  html: string;
  title: string;
  /** Extra toolbar content (left side). */
  toolbar?: ReactNode;
  /** Optional side panel (table of contents…). */
  side?: ReactNode;
  onDocument?: (doc: Document) => void;
};

export function DocumentFrame({ html, title, toolbar, side, onDocument }: Props) {
  const docRef = useRef<Document | null>(null);
  const marksRef = useRef<HTMLElement[]>([]);
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [index, setIndex] = useState(0);

  const focusMark = useCallback((next: number) => {
    const marks = marksRef.current;
    marks.forEach((mark, i) => mark.toggleAttribute("data-current", i === next));
    marks[next]?.setAttribute("data-current", "true");
    marks[next]?.scrollIntoView({ block: "center" });
    setIndex(next);
  }, []);

  const search = useCallback(
    (value: string) => {
      const doc = docRef.current;
      if (!doc) return;
      const lowered = value.trim().toLowerCase();
      setNeedle(lowered);
      marksRef.current = highlightDocument(doc, lowered);
      setCount(lowered ? marksRef.current.length : null);
      if (marksRef.current.length) focusMark(0);
    },
    [focusMark],
  );

  const step = (delta: number) => {
    const total = marksRef.current.length;
    if (total) focusMark((index + delta + total) % total);
  };

  return (
    <div className="xv-doc">
      <div className="xv-toolbar">
        {toolbar}
        <span className="xv-toolbar__spacer" />
        <div className="xv-search">
          <Icon icon="solar:magnifer-linear" width={13} height={13} />
          <input
            value={query}
            placeholder="Rechercher"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                search("");
              }
              if (e.key !== "Enter") return;
              if (query.trim().toLowerCase() === needle && count) step(e.shiftKey ? -1 : 1);
              else search(query);
            }}
          />
          {count != null && (
            <span className="xv-search__count">{count ? `${index + 1}/${count}` : "0"}</span>
          )}
          <button type="button" onClick={() => step(-1)} disabled={!count} title="Précédent">
            <Icon icon="solar:alt-arrow-up-linear" width={13} height={13} />
          </button>
          <button type="button" onClick={() => step(1)} disabled={!count} title="Suivant">
            <Icon icon="solar:alt-arrow-down-linear" width={13} height={13} />
          </button>
        </div>
      </div>
      <div className="xv-doc__body">
        {side && <div className="xv-split__side">{side}</div>}
        <SafeFrame
          html={html}
          title={title}
          onReady={(doc) => {
            docRef.current = doc;
            marksRef.current = [];
            setCount(null);
            onDocument?.(doc);
          }}
        />
      </div>
    </div>
  );
}
