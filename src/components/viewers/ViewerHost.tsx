// axe:viewers — entry point used by EditorPane. Each viewer lives in its own
// lazily imported chunk, so SheetJS / pdf.js / mammoth are only downloaded
// when a file of that family is opened.

import { lazy, Suspense } from "react";
import type { FileDocument } from "../../types";
import type { ViewerSpec } from "./registry";
import { fileExtension } from "./registry";
import { OpenWithDefaultApp, ViewerError, ViewerLoading } from "./common";
import "./viewers.css";

const SpreadsheetViewer = lazy(() => import("./SpreadsheetViewer"));
const HtmlPreview = lazy(() => import("./HtmlPreview"));
const PdfViewer = lazy(() => import("./pdf/PdfViewer"));
const DocxViewer = lazy(() => import("./DocxViewer"));
const PptxViewer = lazy(() => import("./PptxViewer"));
const EpubViewer = lazy(() => import("./EpubViewer"));
const MediaViewer = lazy(() => import("./MediaViewer"));
const SqliteViewer = lazy(() => import("./SqliteViewer"));
const ZipViewer = lazy(() => import("./ZipViewer"));
const FontViewer = lazy(() => import("./FontViewer"));
const JsonViewer = lazy(() => import("./JsonViewer"));
const NotebookViewer = lazy(() => import("./NotebookViewer"));
const SvgViewer = lazy(() => import("./SvgViewer"));
const FallbackViewer = lazy(() => import("./FallbackViewer"));

/** Hex / paged-text view for files no other viewer (nor Monaco) can show. */
export function FallbackHost({ doc }: { doc: FileDocument }) {
  return (
    <Suspense fallback={<ViewerLoading label="Chargement de la visionneuse…" />}>
      <FallbackViewer path={doc.absolutePath} size={doc.size} name={doc.name} reason={doc.reason} />
    </Suspense>
  );
}

export { viewerForPath } from "./registry";
export type { ViewerSpec } from "./registry";

/** True when the viewer must replace Monaco (binary or undisplayable text). */
export function usesFileViewer(spec: ViewerSpec | null, doc: FileDocument): boolean {
  if (!spec?.fromFile) return false;
  return Boolean(spec.alwaysFile) || doc.content === null;
}

function separatorFor(path: string): string | undefined {
  const ext = fileExtension(path);
  return ext === "tsv" || ext === "tab" ? "\t" : undefined;
}

const LEGACY_HINTS: Record<string, string> = {
  doc: "Le format Word 97-2003 (.doc) n’est pas lisible ici. Ouvrez-le avec Word ou LibreOffice, ou enregistrez-le en .docx.",
  dot: "Les modèles Word 97-2003 (.dot) ne sont pas lisibles ici. Enregistrez-le en .docx pour l’afficher.",
  ppt: "Le format PowerPoint 97-2003 (.ppt) n’est pas lisible ici. Enregistrez-le en .pptx pour l’afficher.",
  pps: "Le format PowerPoint 97-2003 (.pps) n’est pas lisible ici. Enregistrez-le en .pptx pour l’afficher.",
  pot: "Les modèles PowerPoint 97-2003 (.pot) ne sont pas lisibles ici. Enregistrez-le en .pptx pour l’afficher.",
};

type Props = {
  spec: ViewerSpec;
  doc: FileDocument;
  /** Live editor buffer for overlay viewers; null renders from the file. */
  text: string | null;
  /** Opens a workspace file in a tab (links inside documents). */
  onOpenFile?: (path: string) => void;
};

export function ViewerHost(props: Props) {
  return (
    <Suspense fallback={<ViewerLoading label="Chargement de la visionneuse…" />}>
      {renderViewer(props)}
    </Suspense>
  );
}

function renderViewer({ spec, doc, text, onOpenFile }: Props) {
  const path = doc.absolutePath;
  const file = { path, size: doc.size, name: doc.name };
  switch (spec.kind) {
    case "spreadsheet":
      return <SpreadsheetViewer source={{ kind: "file", path, size: doc.size }} />;
    case "delimited":
      return text === null ? (
        <SpreadsheetViewer
          source={{ kind: "file", path, size: doc.size, delimited: true, separator: separatorFor(doc.relativePath) }}
        />
      ) : (
        <SpreadsheetViewer source={{ kind: "text", text, separator: separatorFor(doc.relativePath) }} />
      );
    case "html":
      return <HtmlPreview html={text ?? ""} absolutePath={path} />;
    case "pdf":
      return <PdfViewer path={path} size={doc.size} />;
    case "docx":
      return <DocxViewer {...file} />;
    case "pptx":
      return <PptxViewer {...file} />;
    case "epub":
      return <EpubViewer {...file} />;
    case "media-audio":
    case "media-video":
      return <MediaViewer {...file} video={spec.kind === "media-video"} />;
    case "sqlite":
      return <SqliteViewer path={path} />;
    case "zip":
      return <ZipViewer path={path} />;
    case "font":
      return <FontViewer {...file} />;
    case "json":
      return <JsonViewer {...file} text={text} />;
    case "notebook":
      return <NotebookViewer {...file} text={text} onOpenFile={onOpenFile} />;
    case "svg":
      return <SvgViewer {...file} text={text} />;
    case "legacy-office": {
      const ext = fileExtension(doc.name);
      return (
        <ViewerError
          icon="solar:document-text-linear"
          title={
            LEGACY_HINTS[ext] ??
            `L’aperçu des fichiers .${ext} n’est pas disponible. Ouvrez-le avec l’application associée.`
          }
        >
          <OpenWithDefaultApp path={path} />
        </ViewerError>
      );
    }
    default:
      return null;
  }
}
