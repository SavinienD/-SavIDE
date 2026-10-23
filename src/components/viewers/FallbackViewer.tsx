// axe:viewers — fallback for files Monaco cannot take (binary, or text over
// the editor limit). The first bytes are sniffed: text files open in a paged
// read-only text view, everything else in the hex dump; both are reachable
// from the toolbar. Nothing is read beyond the page on screen.

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { formatBytes, readBytes } from "./bytes";
import { OpenWithDefaultApp, ViewerLoading } from "./common";
import HexViewer from "./HexViewer";

const SNIFF_BYTES = 8 * 1024;
const PAGE_BYTES = 512 * 1024;

/**
 * Heuristic: no NUL byte and almost no control characters. Binary and
 * compressed data fail both tests within a few KiB; legacy 8-bit encodings
 * (Windows-1252) pass and are decoded as such.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return true;
  let control = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / bytes.length <= 0.02;
}

function decodePage(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    // `stream` tolerates a character cut at the page boundary.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Paged read-only view of a large text file, cut on line boundaries. */
function LargeTextViewer({ path, size, onHex }: { path: string; size: number; onHex: () => void }) {
  const [copied, setCopied] = useState(false);
  const [starts, setStarts] = useState<number[]>([0]);
  const [page, setPage] = useState<{ text: string; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = starts[starts.length - 1];

  useEffect(() => {
    let cancelled = false;
    setPage(null);
    readBytes(path, start, PAGE_BYTES)
      .then((bytes) => {
        if (cancelled) return;
        let cut = bytes.length;
        if (start + bytes.length < size) {
          const newline = bytes.lastIndexOf(0x0a);
          if (newline > 0) cut = newline + 1;
        }
        setPage({ text: decodePage(bytes.subarray(0, cut)), end: start + cut });
      })
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [path, size, start]);

  const goEnd = async () => {
    const from = Math.max(0, size - PAGE_BYTES);
    if (from === 0) return setStarts([0]);
    // Start the last page right after a line break.
    const head = await readBytes(path, from, Math.min(64 * 1024, size - from));
    const newline = head.indexOf(0x0a);
    setStarts((prev) => [...prev, newline >= 0 ? from + newline + 1 : from]);
  };

  const percent = size ? Math.round(((page?.end ?? start) / size) * 100) : 100;
  return (
    <div className="xv-bigtext">
      <div className="xv-toolbar">
        <button type="button" className="xv-btn" disabled={start === 0} onClick={() => setStarts([0])} title="Début du fichier">
          <Icon icon="solar:double-alt-arrow-up-linear" width={14} height={14} />
        </button>
        <button type="button" className="xv-btn" disabled={starts.length < 2} onClick={() => setStarts((s) => s.slice(0, -1))} title="Page précédente">
          <Icon icon="solar:alt-arrow-up-linear" width={14} height={14} />
        </button>
        <button
          type="button"
          className="xv-btn"
          disabled={!page || page.end >= size}
          onClick={() => page && setStarts((s) => [...s, page.end])}
          title="Page suivante"
        >
          <Icon icon="solar:alt-arrow-down-linear" width={14} height={14} />
        </button>
        <button type="button" className="xv-btn" disabled={!!page && page.end >= size} onClick={() => void goEnd()} title="Fin du fichier">
          <Icon icon="solar:double-alt-arrow-down-linear" width={14} height={14} />
        </button>
        <span className="xv-toolbar__hint">
          octets {formatBytes(start)} – {formatBytes(page?.end ?? start)} sur {formatBytes(size)} ({percent} %) · trop volumineux pour l’éditeur, lecture seule par pages
        </span>
        <span className="xv-toolbar__spacer" />
        <button type="button" className="xv-btn xv-btn--text" onClick={onHex}>
          Hexadécimal
        </button>
        <button type="button" className="xv-btn xv-btn--text" onClick={() => {
          const selection = window.getSelection()?.toString();
          void navigator.clipboard.writeText(selection || page?.text || "").then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
        }}>{copied ? "Copié" : "Copier"}</button>
        <OpenWithDefaultApp path={path} />
      </div>
      {error ? (
        <div className="xv-hex__error">Lecture impossible : {error}</div>
      ) : !page ? (
        <ViewerLoading label="Lecture…" />
      ) : (
        <pre key={start} className="xv-bigtext__page">
          {page.text}
        </pre>
      )}
    </div>
  );
}

export default function FallbackViewer({
  path,
  size,
  name,
  reason,
}: {
  path: string;
  size: number;
  name: string;
  reason?: string | null;
}) {
  const [mode, setMode] = useState<"text" | "hex" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMode(null);
    readBytes(path, 0, SNIFF_BYTES)
      .then((head) => !cancelled && setMode(looksLikeText(head) ? "text" : "hex"))
      .catch(() => !cancelled && setMode("hex"));
    return () => {
      cancelled = true;
    };
  }, [path, size]);

  if (!mode) return <ViewerLoading label="Analyse du fichier…" />;
  if (mode === "text") return <LargeTextViewer path={path} size={size} onHex={() => setMode("hex")} />;
  return <HexViewer path={path} size={size} name={name} reason={reason} onText={() => setMode("text")} />;
}
