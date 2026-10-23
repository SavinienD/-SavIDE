// axe:viewers — SVG preview. The live editor buffer (or the file on disk when
// it is too large for Monaco) is shown through an <img>, a context where SVG
// scripts and external resources never run.

import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatBytes } from "./bytes";
import { ViewerError } from "./common";
import { ZoomableImage } from "./ImageZoom";

export default function SvgViewer({
  path,
  name,
  size,
  text,
}: {
  path: string;
  name: string;
  size: number;
  text: string | null;
}) {
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(timer);
  }, [text]);

  const src = useMemo(() => {
    if (debounced === null) return convertFileSrc(path);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(debounced)}`;
  }, [debounced, path]);

  return (
    <ZoomableImage
      src={src}
      alt={name}
      checker
      meta={
        <div className="xv-image__meta">
          <span>{name}</span>
          <span>{formatBytes(text === null ? size : new Blob([text]).size)}</span>
        </div>
      }
      fallback={<ViewerError icon="solar:gallery-wide-linear" title="Ce SVG ne peut pas être affiché (syntaxe invalide ?)." />}
    />
  );
}
