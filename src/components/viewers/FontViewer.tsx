// axe:viewers — font preview (ttf/otf/woff/woff2): the file is loaded as a
// FontFace from its bytes (no install), then shown with an editable sample,
// a size waterfall and a glyph grid of common character ranges. Name and
// metadata come from the OpenType `name` table when readable.

import { useEffect, useMemo, useState } from "react";
import { readAllBytes, formatBytes } from "./bytes";
import { ViewerError, ViewerLoading } from "./common";

const MAX_FONT_BYTES = 40 * 1024 * 1024;
const SIZES = [12, 16, 24, 36, 48, 72];
const RANGES: [string, number, number][] = [
  ["Latin de base", 0x21, 0x7e],
  ["Latin-1", 0xa1, 0xff],
  ["Latin étendu A", 0x100, 0x17f],
  ["Ponctuation et symboles", 0x2010, 0x2044],
  ["Grec", 0x391, 0x3c9],
  ["Cyrillique", 0x410, 0x44f],
];

/** Reads family / style / version from an uncompressed sfnt `name` table. */
function readNames(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === "wOFF" || tag === "wOF2" || bytes.length < 12) return {};
  const tables = view.getUint16(4);
  for (let i = 0; i < tables; i += 1) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.length) break;
    if (String.fromCharCode(...bytes.subarray(rec, rec + 4)) !== "name") continue;
    const base = view.getUint32(rec + 8);
    const count = view.getUint16(base + 2);
    const strings = base + view.getUint16(base + 4);
    const out: Record<string, string> = {};
    const wanted: Record<number, string> = { 0: "copyright", 1: "family", 2: "style", 4: "full", 5: "version", 9: "designer" };
    for (let n = 0; n < count; n += 1) {
      const r = base + 6 + n * 12;
      const platform = view.getUint16(r);
      const id = view.getUint16(r + 6);
      const key = wanted[id];
      if (!key || out[key]) continue;
      const length = view.getUint16(r + 8);
      const start = strings + view.getUint16(r + 10);
      const raw = bytes.subarray(start, start + length);
      out[key] =
        platform === 3 || platform === 0
          ? new TextDecoder("utf-16be").decode(raw)
          : new TextDecoder("latin1").decode(raw);
    }
    return out;
  }
  return {};
}

export default function FontViewer({ path, size, name }: { path: string; size: number; name: string }) {
  const [family, setFamily] = useState<string | null>(null);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState("Portez ce vieux whisky au juge blond qui fume — 0123456789");

  useEffect(() => {
    let cancelled = false;
    let face: FontFace | null = null;
    setFamily(null);
    setError(null);
    (async () => {
      const bytes = await readAllBytes(path, size, MAX_FONT_BYTES);
      const id = `axe-font-${Math.random().toString(36).slice(2)}`;
      face = new FontFace(id, bytes as Uint8Array<ArrayBuffer>);
      await face.load();
      if (cancelled) return;
      document.fonts.add(face);
      setMeta((() => {
        try {
          return readNames(bytes);
        } catch {
          return {}; // malformed name table: the preview still works
        }
      })());
      setFamily(id);
    })().catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
      if (face) document.fonts.delete(face);
    };
  }, [path, size]);

  const ranges = useMemo(
    () =>
      RANGES.map(([label, from, to]) => ({
        label,
        chars: Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)),
      })),
    [],
  );

  if (error) return <ViewerError icon="solar:text-bold-linear" title="Impossible de charger cette police." detail={error} />;
  if (!family) return <ViewerLoading label="Chargement de la police…" />;
  const fontFamily = `"${family}", "Adobe NotDef", sans-serif`;
  return (
    <div className="xv-font">
      <div className="xv-toolbar">
        <span className="xv-toolbar__value">
          {meta.full || meta.family || name}
          {meta.style ? ` · ${meta.style}` : ""}
        </span>
        <span className="xv-toolbar__hint">
          {meta.version ? `${meta.version} · ` : ""}
          {formatBytes(size)}
        </span>
      </div>
      <div className="xv-font__body">
        <input
          className="xv-font__sample-input"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder="Texte d’exemple"
          aria-label="Texte d’exemple"
        />
        <div className="xv-font__hero" style={{ fontFamily }}>
          Aa Bb Cc
        </div>
        {SIZES.map((px) => (
          <div key={px} className="xv-font__line">
            <span className="xv-font__size">{px}</span>
            <span style={{ fontFamily, fontSize: px }}>{sample || "\u00a0"}</span>
          </div>
        ))}
        {ranges.map((range) => (
          <section key={range.label} className="xv-font__range">
            <h4>{range.label}</h4>
            <div className="xv-font__grid" style={{ fontFamily }}>
              {range.chars.map((ch) => (
                <span key={ch} title={`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`}>
                  {ch}
                </span>
              ))}
            </div>
          </section>
        ))}
        {(meta.designer || meta.copyright) && (
          <p className="xv-font__credits">{[meta.designer, meta.copyright].filter(Boolean).join(" · ")}</p>
        )}
      </div>
    </div>
  );
}
