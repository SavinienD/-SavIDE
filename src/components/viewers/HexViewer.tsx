// axe:viewers — read-only hex dump for unknown / binary files. Rows are
// virtualized and the bytes are fetched from Rust by 64 KiB pages, so even
// multi-gigabyte files open instantly and only the visible part is read.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { formatBytes, readBytes } from "./bytes";
import { OpenWithDefaultApp } from "./common";

const ROW_BYTES = 16;
const ROW_H = 20;
const PAGE_BYTES = 64 * 1024;
const MAX_PAGES = 64;
/** Browsers cap element heights (~33M px in Chromium): scale beyond that. */
const MAX_CANVAS_PX = 16_000_000;
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function printable(byte: number): string {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
}

/** Small LRU of fetched pages keyed by page index. */
function usePages(path: string, size: number) {
  const cache = useRef(new Map<number, Uint8Array>());
  const pending = useRef(new Set<number>());
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cache.current.clear();
    pending.current.clear();
    setError(null);
    setVersion((v) => v + 1);
  }, [path, size]);

  const byteAt = useCallback(
    (offset: number): number | undefined => {
      const page = Math.floor(offset / PAGE_BYTES);
      const data = cache.current.get(page);
      if (data) return data[offset - page * PAGE_BYTES];
      if (!pending.current.has(page) && page * PAGE_BYTES < size) {
        pending.current.add(page);
        readBytes(path, page * PAGE_BYTES, PAGE_BYTES)
          .then((bytes) => {
            cache.current.set(page, bytes);
            if (cache.current.size > MAX_PAGES) {
              const oldest = cache.current.keys().next().value as number;
              cache.current.delete(oldest);
            }
            setVersion((v) => v + 1);
          })
          .catch((err) => setError(String(err)))
          .finally(() => pending.current.delete(page));
      }
      return undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, size, version],
  );
  return { byteAt, error, version };
}

export default function HexViewer({
  path,
  size,
  name,
  reason,
  onText,
}: {
  path: string;
  size: number;
  name: string;
  reason?: string | null;
  /** Switches to the paged text view (offered for any file). */
  onText?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [goto, setGoto] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const { byteAt, error } = usePages(path, size);

  const rows = Math.ceil(size / ROW_BYTES);
  // Content height in "virtual" pixels (one row = ROW_H). Beyond what a
  // browser element can hold, the scroll range maps linearly onto it.
  const contentH = rows * ROW_H + ROW_H;
  const canvasH = Math.min(contentH, MAX_CANVAS_PX);
  const maxScroll = Math.max(1, canvasH - view.height);
  const maxVirtual = Math.max(0, contentH - view.height);
  const scale = contentH > MAX_CANVAS_PX ? maxScroll / Math.max(1, maxVirtual) : 1;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const virtualTop = view.top / scale;
  const firstRow = Math.floor(virtualTop / ROW_H);
  const frac = virtualTop - firstRow * ROW_H;
  const lastRow = Math.min(rows - 1, firstRow + Math.ceil(view.height / ROW_H) + 1);

  const jump = () => {
    const raw = goto.trim().toLowerCase();
    const offset = raw.startsWith("0x") ? parseInt(raw.slice(2), 16) : /[a-f]/.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
    if (!Number.isFinite(offset) || offset < 0 || offset >= size) return;
    const row = Math.floor(offset / ROW_BYTES);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = Math.max(0, (row * ROW_H - view.height / 3) * scale);
    }
    setSelected(offset);
  };

  const lines = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const base = row * ROW_BYTES;
    const hex: JSX.Element[] = [];
    const ascii: JSX.Element[] = [];
    for (let i = 0; i < ROW_BYTES; i += 1) {
      const offset = base + i;
      if (offset >= size) break;
      const byte = byteAt(offset);
      const active = selected === offset ? "true" : undefined;
      hex.push(
        <span key={i} data-active={active} data-gap={i === 8 ? "true" : undefined} onMouseDown={() => setSelected(offset)}>
          {byte === undefined ? "··" : HEX[byte]}
        </span>,
      );
      ascii.push(
        <span key={i} data-active={active} onMouseDown={() => setSelected(offset)}>
          {byte === undefined ? " " : printable(byte)}
        </span>,
      );
    }
    lines.push(
      <div key={row} className="xv-hex__row" style={{ top: (row - firstRow) * ROW_H - frac }}>
        <span className="xv-hex__offset">{base.toString(16).padStart(8, "0")}</span>
        <span className="xv-hex__bytes">{hex}</span>
        <span className="xv-hex__ascii">{ascii}</span>
      </div>,
    );
  }

  const selectedByte = selected !== null ? byteAt(selected) : undefined;
  return (
    <div className="xv-hex">
      <div className="xv-toolbar">
        <Icon icon="solar:code-file-linear" width={14} height={14} />
        <span className="xv-toolbar__hint" title={reason ?? undefined}>
          {name} · {formatBytes(size)} · vue hexadécimale en lecture seule
        </span>
        <span className="xv-toolbar__spacer" />
        {selected !== null && (
          <span className="xv-search__count">
            0x{selected.toString(16)} ({selected}) = {selectedByte === undefined ? "…" : `0x${HEX[selectedByte]} · ${selectedByte}`}
          </span>
        )}
        <div className="xv-search">
          <Icon icon="solar:map-arrow-right-linear" width={13} height={13} />
          <input
            value={goto}
            placeholder="Aller à l’offset (0x…)"
            onChange={(e) => setGoto(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && jump()}
          />
        </div>
        {onText && (
          <button type="button" className="xv-btn xv-btn--text" onClick={onText} title="Afficher comme texte">
            Texte
          </button>
        )}
        <OpenWithDefaultApp path={path} />
      </div>
      {error && <div className="xv-hex__error">Lecture impossible : {error}</div>}
      {size === 0 ? (
        <div className="xv-state">Fichier vide.</div>
      ) : (
        <div
          ref={scrollRef}
          className="xv-hex__scroll"
          onScroll={(e) => {
            const el = e.currentTarget;
            setView((prev) => ({ ...prev, top: el.scrollTop }));
          }}
        >
          <div className="xv-hex__canvas" style={{ height: canvasH }}>
            {/* Sticky window: rows are laid out relative to the viewport. */}
            <div className="xv-hex__window" style={{ height: Math.min(view.height, canvasH) }}>
              {lines}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
