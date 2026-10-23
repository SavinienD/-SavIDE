// axe:viewers — Jupyter notebook (.ipynb) renderer: markdown cells through
// the chat Markdown component, code cells with their execution count and
// outputs (text streams, errors, images, sanitized HTML, JSON). Rendering
// only: nothing is executed. The JSON source stays editable in "Code".

import { useEffect, useMemo, useState } from "react";
import { readAllBytes } from "./bytes";
import { ViewerError, ViewerLoading } from "./common";
import { Markdown } from "../chat/Markdown";
import { SafeFrame } from "./SafeFrame";

const MAX_NOTEBOOK_BYTES = 80 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;

type MultiLine = string | string[];
type Output = {
  output_type: string;
  name?: string;
  text?: MultiLine;
  data?: Record<string, MultiLine | object>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
};
type Cell = {
  cell_type: "markdown" | "code" | "raw";
  source: MultiLine;
  execution_count?: number | null;
  outputs?: Output[];
};
type Notebook = { cells: Cell[]; metadata?: { kernelspec?: { display_name?: string }; language_info?: { name?: string } } };

const join = (value: MultiLine | undefined) => (Array.isArray(value) ? value.join("") : value ?? "");
/** Strips ANSI colour codes from tracebacks and streams. */
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
const clip = (text: string) =>
  text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} caractères masqués)` : text;

function OutputView({ output, onOpenFile }: { output: Output; onOpenFile: (path: string) => void }) {
  if (output.output_type === "stream") {
    return <pre className="xv-nb__stream" data-stderr={output.name === "stderr" ? "true" : undefined}>{clip(stripAnsi(join(output.text)))}</pre>;
  }
  if (output.output_type === "error") {
    return <pre className="xv-nb__stream" data-stderr="true">{clip(stripAnsi((output.traceback ?? [`${output.ename}: ${output.evalue}`]).join("\n")))}</pre>;
  }
  const data = output.data ?? {};
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    if (data[mime]) return <img className="xv-nb__image" alt="" src={`data:${mime};base64,${join(data[mime] as MultiLine).replace(/\s/g, "")}`} />;
  }
  if (data["image/svg+xml"]) {
    const svg = join(data["image/svg+xml"] as MultiLine);
    return <img className="xv-nb__image" alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />;
  }
  if (data["text/html"]) {
    return <NotebookHtml html={join(data["text/html"] as MultiLine)} />;
  }
  if (data["text/markdown"]) {
    return <div className="xv-nb__md"><Markdown text={join(data["text/markdown"] as MultiLine)} onOpenFile={onOpenFile} /></div>;
  }
  if (data["application/json"]) {
    return <pre className="xv-nb__stream">{clip(JSON.stringify(data["application/json"], null, 2))}</pre>;
  }
  if (data["text/plain"]) {
    return <pre className="xv-nb__stream">{clip(stripAnsi(join(data["text/plain"] as MultiLine)))}</pre>;
  }
  return <div className="xv-nb__unsupported">Sortie non affichable ({Object.keys(data).join(", ") || output.output_type})</div>;
}

/** Rich HTML outputs (pandas tables…) in an auto-sized sandboxed frame. */
function NotebookHtml({ html }: { html: string }) {
  const [height, setHeight] = useState(60);
  return (
    <div className="xv-nb__html" style={{ height }}>
      <SafeFrame
        html={html}
        title="Sortie HTML"
        extraCss="body { padding: 8px 4px; max-width: none; margin: 0; font-size: 12.5px; }"
        onReady={(doc) => setHeight(Math.min(900, doc.documentElement.scrollHeight + 4))}
      />
    </div>
  );
}

export default function NotebookViewer({
  path,
  size,
  text,
  onOpenFile,
}: {
  path: string;
  size: number;
  name: string;
  text: string | null;
  onOpenFile?: (path: string) => void;
}) {
  const [source, setSource] = useState<string | null>(text);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (text !== null) {
      const timer = setTimeout(() => setSource(text), 300);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    readAllBytes(path, size, MAX_NOTEBOOK_BYTES)
      .then((bytes) => !cancelled && setSource(new TextDecoder().decode(bytes)))
      .catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, [path, size, text]);

  const parsed = useMemo(() => {
    if (source === null) return null;
    try {
      const notebook = JSON.parse(source) as Notebook;
      if (!Array.isArray(notebook.cells)) throw new Error("Pas de cellules (format nbformat 4 attendu).");
      return { notebook, error: null };
    } catch (err) {
      return { notebook: null, error: String((err as Error).message) };
    }
  }, [source]);

  const openFile = onOpenFile ?? (() => undefined);
  if (error) return <ViewerError title="Impossible de lire ce notebook." detail={error} />;
  if (!parsed) return <ViewerLoading label="Lecture du notebook…" />;
  if (!parsed.notebook) return <ViewerError title="Notebook invalide." detail={parsed.error} />;
  const { notebook } = parsed;
  const language = notebook.metadata?.language_info?.name ?? "python";
  return (
    <div className="xv-nb">
      <div className="xv-toolbar">
        <span className="xv-toolbar__hint">
          {notebook.cells.length} cellules · {notebook.metadata?.kernelspec?.display_name ?? language} · lecture seule (rien n’est exécuté)
        </span>
      </div>
      <div className="xv-nb__scroll">
        {notebook.cells.map((cell, i) => (
          <div key={i} className="xv-nb__cell" data-type={cell.cell_type}>
            {cell.cell_type === "markdown" ? (
              <div className="xv-nb__md">
                <Markdown text={join(cell.source)} onOpenFile={openFile} />
              </div>
            ) : (
              <>
                <div className="xv-nb__input">
                  <span className="xv-nb__prompt">{cell.cell_type === "code" ? `[${cell.execution_count ?? " "}]` : ""}</span>
                  <div className="xv-nb__code">
                    <Markdown text={`\`\`\`${cell.cell_type === "code" ? language : "text"}\n${join(cell.source)}\n\`\`\``} onOpenFile={openFile} />
                  </div>
                </div>
                {(cell.outputs ?? []).map((output, j) => (
                  <div key={j} className="xv-nb__output">
                    <span className="xv-nb__prompt">
                      {output.output_type === "execute_result" ? `[${cell.execution_count ?? " "}]` : ""}
                    </span>
                    <div className="xv-nb__output-body">
                      <OutputView output={output} onOpenFile={openFile} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
