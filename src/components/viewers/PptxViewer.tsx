// axe:viewers — PowerPoint (.pptx) viewer. Slides are rebuilt from the XML
// (positioned text, pictures, tables) and scaled to the available width; a
// "Texte" mode lists every slide with its text. The rendering is
// approximate and the toolbar says so.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon } from "@iconify/react";
import { bytesToDataUrl, imageMime, listZip, readZipEntry } from "./bytes";
import { ViewerError, ViewerLoading } from "./common";
import { parsePptx, type PptxDeck, type PptxShape, type PptxSlide } from "./pptx";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Lazily turns zip image entries into data URLs, shared by all slides. */
function useImageLoader(path: string) {
  const cache = useRef(new Map<string, Promise<string | null>>());
  useEffect(() => cache.current.clear(), [path]);
  return useCallback(
    (target: string) => {
      let pending = cache.current.get(target);
      if (!pending) {
        const mime = imageMime(target);
        pending = mime
          ? readZipEntry(path, target)
              .then((bytes) => (bytes.length <= MAX_IMAGE_BYTES ? bytesToDataUrl(bytes, mime) : null))
              .catch(() => null)
          : Promise.resolve(null);
        cache.current.set(target, pending);
      }
      return pending;
    },
    [path],
  );
}

function ZipImage({ target, load }: { target: string | null; load: (t: string) => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!target) return setFailed(true);
    load(target).then((url) => {
      if (cancelled) return;
      if (url) setSrc(url);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [target, load]);
  if (failed) return <span className="xv-pptx__missing">Image non affichable</span>;
  return src ? <img src={src} alt="" draggable={false} /> : null;
}

function boxStyle(shape: PptxShape): CSSProperties {
  const { x, y, w, h, rot } = shape.box;
  return {
    left: x,
    top: y,
    width: w,
    height: h,
    transform: rot ? `rotate(${rot}deg)` : undefined,
  };
}

const ANCHOR: Record<string, CSSProperties["justifyContent"]> = { t: "flex-start", ctr: "center", b: "flex-end" };

function ShapeView({ shape, load }: { shape: PptxShape; load: (t: string) => Promise<string | null> }) {
  if (shape.kind === "image") {
    return (
      <div className="xv-pptx__shape xv-pptx__image" style={boxStyle(shape)}>
        <ZipImage target={shape.target} load={load} />
      </div>
    );
  }
  if (shape.kind === "table") {
    return (
      <div className="xv-pptx__shape xv-pptx__table" style={boxStyle(shape)}>
        <table>
          <tbody>
            {shape.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (shape.kind === "other") {
    return (
      <div className="xv-pptx__shape xv-pptx__other" style={boxStyle(shape)}>
        {shape.label} (non affiché)
      </div>
    );
  }
  return (
    <div
      className="xv-pptx__shape xv-pptx__text"
      style={{
        ...boxStyle(shape),
        background: shape.fill,
        border: shape.border ? `1px solid ${shape.border}` : undefined,
        borderRadius: shape.radius,
        justifyContent: ANCHOR[shape.anchor ?? "t"] ?? "flex-start",
      }}
    >
      {shape.paragraphs.map((p, i) => (
        <p
          key={i}
          style={{
            textAlign: p.align,
            marginLeft: p.level * 18 + (p.bullet ? 14 : 0),
            fontSize: p.runs[0]?.size ?? p.emptySize,
          }}
          data-bullet={p.bullet && p.runs.some((r) => r.text.trim()) ? "true" : undefined}
        >
          {p.runs.length === 0
            ? "\u00a0"
            : p.runs.map((run, j) => (
                <span
                  key={j}
                  style={{
                    fontSize: run.size,
                    fontWeight: run.bold ? 700 : undefined,
                    fontStyle: run.italic ? "italic" : undefined,
                    textDecoration: run.underline ? "underline" : undefined,
                    color: run.color,
                  }}
                >
                  {run.text}
                </span>
              ))}
        </p>
      ))}
    </div>
  );
}

function SlideView({ deck, slide, scale, load }: { deck: PptxDeck; slide: PptxSlide; scale: number; load: (t: string) => Promise<string | null> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(slide.number <= 2);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div className="xv-pptx__slide-wrap">
      <div className="xv-pptx__num">
        {slide.number}
        {slide.hidden ? " · masquée" : ""}
      </div>
      <div ref={ref} className="xv-pptx__frame" style={{ width: deck.width * scale, height: deck.height * scale }}>
        {visible && (
          <div
            className="xv-pptx__slide"
            style={{ width: deck.width, height: deck.height, background: slide.background, transform: `scale(${scale})` }}
          >
            {slide.shapes.map((shape, i) => (
              <ShapeView key={i} shape={shape} load={load} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PptxViewer({ path, size, name }: { path: string; size: number; name: string }) {
  const [deck, setDeck] = useState<PptxDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"slides" | "text">("slides");
  const [width, setWidth] = useState(800);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const load = useImageLoader(path);

  useEffect(() => {
    let cancelled = false;
    setDeck(null);
    setError(null);
    listZip(path)
      .then((listing) => parsePptx(path, new Set(listing.entries.map((e) => e.name))))
      .then((parsed) => !cancelled && setDeck(parsed))
      .catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, [path, size]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [deck, mode]);

  const scale = useMemo(() => (deck ? Math.min(1.6, Math.max(0.2, (width - 64) / deck.width)) : 1), [deck, width]);

  if (error) return <ViewerError icon="solar:presentation-graph-linear" title="Impossible de lire cette présentation." detail={error} />;
  if (!deck) return <ViewerLoading label="Lecture des diapositives…" />;
  return (
    <div className="xv-pptx">
      <div className="xv-toolbar">
        <button type="button" className="xv-btn xv-btn--text" data-active={mode === "slides" ? "true" : "false"} onClick={() => setMode("slides")}>
          <Icon icon="solar:presentation-graph-linear" width={14} height={14} /> Diapositives
        </button>
        <button type="button" className="xv-btn xv-btn--text" data-active={mode === "text" ? "true" : "false"} onClick={() => setMode("text")}>
          <Icon icon="solar:document-text-linear" width={14} height={14} /> Texte
        </button>
        <span
          className="xv-toolbar__hint"
          title="Les polices du thème, effets, graphiques, SmartArt et animations ne sont pas reproduits."
        >
          {deck.slides.length} diapositive{deck.slides.length > 1 ? "s" : ""} · rendu approximatif (texte, images, tableaux)
        </span>
      </div>
      <div ref={scrollRef} className="xv-pptx__scroll" aria-label={name}>
        {mode === "slides"
          ? deck.slides.map((slide) => <SlideView key={slide.number} deck={deck} slide={slide} scale={scale} load={load} />)
          : deck.slides.map((slide) => (
              <section key={slide.number} className="xv-pptx__outline">
                <h3>
                  <span>{slide.number}</span>
                  {slide.title || "Sans titre"}
                  {slide.hidden ? " (masquée)" : ""}
                </h3>
                {slide.lines.length ? (
                  <ul>
                    {slide.lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="xv-pptx__empty">Pas de texte.</p>
                )}
              </section>
            ))}
      </div>
    </div>
  );
}
