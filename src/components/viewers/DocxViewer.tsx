// axe:viewers — Word (.docx) viewer: mammoth converts the document to clean
// semantic HTML (headings, lists, tables, images inlined as data URIs), shown
// in the sandboxed document frame. Layout (columns, headers/footers, exact
// fonts) is intentionally not reproduced.

import { useEffect, useState } from "react";
import { readAllBytes } from "./bytes";
import { ViewerError, ViewerLoading } from "./common";
import { DocumentFrame } from "./DocumentFrame";

const MAX_DOCX_BYTES = 150 * 1024 * 1024;

export default function DocxViewer({ path, size, name }: { path: string; size: number; name: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    (async () => {
      const [bytes, mammoth] = await Promise.all([
        readAllBytes(path, size, MAX_DOCX_BYTES),
        import("mammoth"),
      ]);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
      if (cancelled) return;
      setWarnings(result.messages.filter((m) => m.type === "warning").length);
      setHtml(result.value || "<p><em>Document vide.</em></p>");
    })().catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, [path, size]);

  if (error) return <ViewerError icon="solar:document-text-linear" title="Impossible de lire ce document Word." detail={error} />;
  if (html === null) return <ViewerLoading label="Conversion du document…" />;
  return (
    <DocumentFrame
      html={html}
      title={name}
      toolbar={
        <span className="xv-toolbar__hint" title="Mise en page simplifiée : le contenu est fidèle, pas la mise en forme exacte.">
          Aperçu lisible · mise en page simplifiée
          {warnings ? ` · ${warnings} élément${warnings > 1 ? "s" : ""} non converti${warnings > 1 ? "s" : ""}` : ""}
        </span>
      }
    />
  );
}
