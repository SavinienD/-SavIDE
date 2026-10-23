// axe:viewers — one PDF page (canvas + selectable text layer) and its
// thumbnail. Pages are only mounted while near the viewport (see PdfViewer).

import { useEffect, useRef, useState } from "react";
import { TextLayer, type PDFDocumentProxy } from "./pdfDoc";

/** pdf.js works in points (1/72 in); CSS pixels are 1/96 in. */
export const PDF_TO_CSS = 96 / 72;
/** Canvas backing stores are capped to keep memory bounded at high zoom. */
const MAX_CANVAS_PIXELS = 4096 * 4096;

type RenderTaskLike = { promise: Promise<unknown>; cancel: () => void };

function isCancel(err: unknown): boolean {
  return (err as { name?: string })?.name === "RenderingCancelledException";
}

/** Wraps every occurrence of `needle` (lower-cased) in the text layer. */
export function highlightTextLayer(container: HTMLElement, needle: string): number {
  container.querySelectorAll("mark.xv-pdf-hit").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  });
  if (!needle) return 0;
  let count = 0;
  container.querySelectorAll("span").forEach((span) => {
    if (span.childElementCount > 0) return;
    const text = span.textContent ?? "";
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    if (at < 0) return;
    const fragment = document.createDocumentFragment();
    let last = 0;
    while (at >= 0) {
      fragment.append(text.slice(last, at));
      const mark = document.createElement("mark");
      mark.className = "xv-pdf-hit";
      mark.textContent = text.slice(at, at + needle.length);
      fragment.append(mark);
      count += 1;
      last = at + needle.length;
      at = lower.indexOf(needle, last);
    }
    fragment.append(text.slice(last));
    span.replaceChildren(fragment);
  });
  return count;
}

async function paint(
  doc: PDFDocumentProxy,
  pageNumber: number,
  cssScale: number,
  canvas: HTMLCanvasElement,
  track: (task: RenderTaskLike) => void,
) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: cssScale * PDF_TO_CSS });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const area = viewport.width * viewport.height;
  const output = Math.min(ratio, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, area)));
  canvas.width = Math.max(1, Math.floor(viewport.width * output));
  canvas.height = Math.max(1, Math.floor(viewport.height * output));
  const task = page.render({
    canvas,
    viewport,
    transform: output !== 1 ? [output, 0, 0, output, 0, 0] : undefined,
  });
  track(task);
  await task.promise;
  return { page, viewport };
}

type PageProps = {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
  query: string;
};

export function PdfPageView({ doc, pageNumber, scale, width, height, query }: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!canvas || !textContainer) return;
    let cancelled = false;
    let task: RenderTaskLike | null = null;
    let textLayer: TextLayer | null = null;
    setPainted(false);
    paint(doc, pageNumber, scale, canvas, (t) => (task = t))
      .then(async ({ page, viewport }) => {
        if (cancelled) return;
        setPainted(true);
        textContainer.replaceChildren();
        textContainer.style.setProperty("--total-scale-factor", String(viewport.scale));
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textContainer,
          viewport,
        });
        await textLayer.render();
        if (!cancelled) highlightTextLayer(textContainer, queryRef.current);
      })
      .catch((err) => {
        if (!isCancel(err) && !cancelled) console.error("[pdf] page render failed", err);
      });
    return () => {
      cancelled = true;
      (task as RenderTaskLike | null)?.cancel();
      textLayer?.cancel();
    };
  }, [doc, pageNumber, scale]);

  useEffect(() => {
    if (textRef.current) highlightTextLayer(textRef.current, query);
  }, [query]);

  return (
    <div className="xv-pdf__page" style={{ width, height }} data-painted={painted ? "true" : "false"}>
      <canvas ref={canvasRef} style={{ width, height }} />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

type ThumbProps = {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  height: number;
  active: boolean;
  onSelect: (pageNumber: number) => void;
};

export function PdfThumb({ doc, pageNumber, width, height, active, onSelect }: ThumbProps) {
  const holderRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { root: holder.parentElement, rootMargin: "300px 0px" },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (active) holderRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let task: RenderTaskLike | null = null;
    let cancelled = false;
    const base = width / PDF_TO_CSS;
    doc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return;
        const cssScale = base / page.getViewport({ scale: 1 }).width;
        return paint(doc, pageNumber, cssScale, canvas, (t) => (task = t));
      })
      .catch((err) => {
        if (!isCancel(err) && !cancelled) console.error("[pdf] thumbnail failed", err);
      });
    return () => {
      cancelled = true;
      (task as RenderTaskLike | null)?.cancel();
    };
  }, [doc, pageNumber, visible, width]);

  return (
    <button
      ref={holderRef}
      type="button"
      className="xv-pdf__thumb"
      data-active={active ? "true" : "false"}
      onClick={() => onSelect(pageNumber)}
    >
      <span className="xv-pdf__thumb-img" style={{ width, height }}>
        {visible && <canvas ref={canvasRef} style={{ width, height }} />}
      </span>
      <span className="xv-pdf__thumb-num">{pageNumber}</span>
    </button>
  );
}
