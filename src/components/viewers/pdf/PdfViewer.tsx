// axe:viewers — PDF viewer: virtualized pages, pagination, zoom, full-text
// search and thumbnails. Pages are streamed from Rust by byte ranges.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { countMatches, openPdf, type PDFDocumentProxy } from "./pdfDoc";
import { PDF_TO_CSS, PdfPageView, PdfThumb } from "./PdfPage";

const GAP = 14;
const PAD = 20;
const THUMB_W = 112;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

type Size = { w: number; h: number };

export default function PdfViewer({ path, size }: { path: string; size: number }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [scale, setScale] = useState<number | "fit">("fit");
  const [thumbs, setThumbs] = useState(false);
  const [view, setView] = useState({ top: 0, height: 800, width: 800 });
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [hits, setHits] = useState<{ page: number; count: number }[] | null>(null);
  const [hitIndex, setHitIndex] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textCache = useRef(new Map<number, string>());

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    textCache.current.clear();
    openPdf(path, size)
      .then(async (pdf) => {
        loaded = pdf;
        if (cancelled) return void pdf.destroy();
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        const estimate = { w: first.width, h: first.height };
        setSizes(Array.from({ length: pdf.numPages }, () => estimate));
        setDoc(pdf);
        // Refine page sizes in the background (mixed formats / rotations).
        for (let n = 2; n <= pdf.numPages && !cancelled; n += 1) {
          const vp = (await pdf.getPage(n)).getViewport({ scale: 1 });
          if (vp.width !== estimate.w || vp.height !== estimate.h) {
            setSizes((prev) => prev.map((s, i) => (i === n - 1 ? { w: vp.width, h: vp.height } : s)));
          }
        }
      })
      .catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [path, size]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setView({ top: el.scrollTop, height: el.clientHeight, width: el.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  const maxWidth = useMemo(() => sizes.reduce((m, s) => Math.max(m, s.w), 1), [sizes]);
  const cssScale =
    scale === "fit" ? Math.max(0.25, (view.width - PAD * 2) / (maxWidth * PDF_TO_CSS)) : scale;
  const layout = useMemo(() => {
    let y = PAD;
    return sizes.map((s) => {
      const box = { top: y, w: s.w * PDF_TO_CSS * cssScale, h: s.h * PDF_TO_CSS * cssScale };
      y += box.h + GAP;
      return box;
    });
  }, [sizes, cssScale]);
  const totalHeight = layout.length ? layout[layout.length - 1].top + layout[layout.length - 1].h + PAD : 0;

  const center = view.top + view.height / 3;
  let currentPage = 1;
  for (let i = 0; i < layout.length; i += 1) if (layout[i].top <= center) currentPage = i + 1;
  useEffect(() => setPageInput(String(currentPage)), [currentPage]);

  const goTo = useCallback(
    (page: number) => {
      const box = layout[Math.min(Math.max(page, 1), layout.length) - 1];
      if (box && scrollRef.current) scrollRef.current.scrollTop = box.top - PAD / 2;
    },
    [layout],
  );

  // Keep the reading position when the zoom changes.
  const anchorRef = useRef({ page: 1, ratio: 0 });
  useEffect(() => {
    const { page, ratio } = anchorRef.current;
    const box = layout[page - 1];
    if (box && scrollRef.current) scrollRef.current.scrollTop = box.top + ratio * box.h - view.height / 3;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cssScale]);
  const box = layout[currentPage - 1];
  if (box) anchorRef.current = { page: currentPage, ratio: (center - box.top) / Math.max(1, box.h) };

  const runSearch = useCallback(async () => {
    const value = query.trim().toLowerCase();
    setNeedle(value);
    if (!doc || !value) return setHits(null);
    const found: { page: number; count: number }[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      let text = textCache.current.get(n);
      if (text == null) {
        const content = await (await doc.getPage(n)).getTextContent();
        text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
        textCache.current.set(n, text);
      }
      const count = countMatches(text, value);
      if (count) found.push({ page: n, count });
    }
    setHits(found);
    setHitIndex(0);
    if (found.length) goTo(found[0].page);
  }, [doc, query, goTo]);

  const stepHit = (delta: number) => {
    if (!hits?.length) return;
    const next = (hitIndex + delta + hits.length) % hits.length;
    setHitIndex(next);
    goTo(hits[next].page);
  };

  const zoomBy = (direction: 1 | -1) => {
    const now = cssScale;
    const next = direction > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
    if (next) setScale(next);
  };

  if (error) {
    return (
      <div className="xv-state">
        <Icon icon="solar:danger-triangle-linear" width={18} height={18} />
        <span>Impossible d&rsquo;ouvrir ce PDF.</span>
        <code>{error}</code>
      </div>
    );
  }

  const totalHits = hits?.reduce((sum, h) => sum + h.count, 0) ?? 0;
  const margin = view.height;
  return (
    <div className="xv-pdf">
      <div className="xv-toolbar">
        <button type="button" className="xv-btn" data-active={thumbs ? "true" : "false"} onClick={() => setThumbs((v) => !v)} title="Miniatures">
          <Icon icon="solar:sidebar-minimalistic-linear" width={14} height={14} />
        </button>
        <span className="xv-pager">
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && goTo(Number(pageInput) || 1)}
          />
          <span>/ {doc?.numPages ?? "…"}</span>
        </span>
        <span className="xv-toolbar__spacer" />
        <button type="button" className="xv-btn" onClick={() => zoomBy(-1)} title="Dézoomer">
          <Icon icon="solar:minus-circle-linear" width={14} height={14} />
        </button>
        <button type="button" className="xv-btn xv-btn--text" onClick={() => setScale("fit")} title="Ajuster à la largeur">
          {Math.round(cssScale * 100)} %
        </button>
        <button type="button" className="xv-btn" onClick={() => zoomBy(1)} title="Zoomer">
          <Icon icon="solar:add-circle-linear" width={14} height={14} />
        </button>
        <div className="xv-search">
          <Icon icon="solar:magnifer-linear" width={13} height={13} />
          <input
            value={query}
            placeholder="Rechercher dans le PDF"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (query.trim().toLowerCase() === needle && hits) stepHit(e.shiftKey ? -1 : 1);
              else void runSearch();
            }}
          />
          {hits && <span className="xv-search__count">{hits.length ? `${totalHits} (p. ${hits[hitIndex]?.page})` : "0"}</span>}
          <button type="button" onClick={() => stepHit(-1)} disabled={!hits?.length} title="Précédent">
            <Icon icon="solar:alt-arrow-up-linear" width={13} height={13} />
          </button>
          <button type="button" onClick={() => stepHit(1)} disabled={!hits?.length} title="Suivant">
            <Icon icon="solar:alt-arrow-down-linear" width={13} height={13} />
          </button>
        </div>
      </div>
      <div className="xv-pdf__body">
        {thumbs && doc && (
          <div className="xv-pdf__thumbs">
            {sizes.map((s, i) => (
              <PdfThumb key={i} doc={doc} pageNumber={i + 1} width={THUMB_W} height={(THUMB_W * s.h) / s.w} active={currentPage === i + 1} onSelect={goTo} />
            ))}
          </div>
        )}
        <div
          ref={scrollRef}
          className="xv-pdf__scroll"
          onScroll={(e) => {
            const el = e.currentTarget;
            setView((prev) => ({ ...prev, top: el.scrollTop }));
          }}
        >
          {!doc ? (
            <div className="xv-state"><span className="xv-spinner" /><span>Ouverture du PDF…</span></div>
          ) : (
            <div className="xv-pdf__canvas" style={{ height: totalHeight }}>
              {layout.map((b, i) =>
                b.top + b.h < view.top - margin || b.top > view.top + view.height + margin ? null : (
                  <div key={i} className="xv-pdf__slot" style={{ top: b.top, width: b.w, height: b.h }}>
                    <PdfPageView doc={doc} pageNumber={i + 1} scale={cssScale} width={b.w} height={b.h} query={needle} />
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
