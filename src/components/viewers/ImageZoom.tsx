// axe:viewers — zoomable image: fit / 1:1 / steps, Ctrl+wheel zoom, drag to
// pan when zoomed. Used for raster images and the SVG preview.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";

const STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

type Props = {
  src: string;
  alt: string;
  /** Checkerboard behind transparent images (SVG, PNG with alpha). */
  checker?: boolean;
  /** Overlay content (file name / size badge…). */
  meta?: ReactNode;
  /** Shown instead of the image when it cannot be decoded. */
  fallback?: ReactNode;
};

export function ZoomableImage({ src, alt, checker = false, meta, fallback }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [failed, setFailed] = useState(false);

  // A new source (live SVG edit) keeps the zoom; only the error is cleared.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [failed]);

  const fit = natural
    ? Math.min(1, Math.max(0.01, (box.w - 48) / natural.w), Math.max(0.01, (box.h - 48) / natural.h))
    : 1;
  const scale = zoom === "fit" ? fit : zoom;
  const zoomRef = useRef(scale);
  zoomRef.current = scale;

  const stepZoom = (direction: 1 | -1) => {
    const now = zoomRef.current;
    const next =
      direction > 0 ? STEPS.find((s) => s > now * 1.01) : [...STEPS].reverse().find((s) => s < now / 1.01);
    if (next) setZoom(next);
  };
  const stepRef = useRef(stepZoom);
  stepRef.current = stepZoom;

  // Ctrl+wheel zoom needs a non-passive native listener to cancel scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      stepRef.current(event.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [failed]);

  const startPan = (event: React.MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || event.button !== 0 || zoom === "fit") return;
    const start = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    const move = (e: MouseEvent) => {
      el.scrollLeft = start.left - (e.clientX - start.x);
      el.scrollTop = start.top - (e.clientY - start.y);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (failed) return <>{fallback ?? null}</>;
  return (
    <div className="xv-image" data-checker={checker ? "true" : "false"}>
      <div
        ref={scrollRef}
        className="xv-image__scroll"
        data-pan={zoom === "fit" ? "false" : "true"}
        onMouseDown={startPan}
        onDoubleClick={() => setZoom((z) => (z === "fit" ? 1 : "fit"))}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={natural ? { width: natural.w * scale, height: natural.h * scale } : { maxWidth: "100%", maxHeight: "100%" }}
          onLoad={(event) => {
            const img = event.currentTarget;
            // SVGs without intrinsic size report 0: give them a sane canvas.
            setNatural({ w: img.naturalWidth || 512, h: img.naturalHeight || 512 });
          }}
          onError={() => setFailed(true)}
        />
      </div>
      <div className="xv-image__zoom">
        <button type="button" className="xv-btn" onClick={() => stepZoom(-1)} title="Dézoomer (Ctrl + molette)">
          <Icon icon="solar:minus-circle-linear" width={14} height={14} />
        </button>
        <span className="xv-image__pct">{Math.round(scale * 100)} %</span>
        <button type="button" className="xv-btn" onClick={() => stepZoom(1)} title="Zoomer (Ctrl + molette)">
          <Icon icon="solar:add-circle-linear" width={14} height={14} />
        </button>
        <button type="button" className="xv-btn xv-btn--text" data-active={zoom === "fit" ? "true" : "false"} onClick={() => setZoom("fit")}>
          Ajuster
        </button>
        <button type="button" className="xv-btn xv-btn--text" data-active={zoom === 1 ? "true" : "false"} onClick={() => setZoom(1)}>
          1:1
        </button>
      </div>
      {meta}
    </div>
  );
}
