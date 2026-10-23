// axe:viewers — spreadsheet viewer (xlsx/xls/ods/csv/tsv) built on SheetJS.
// Binary workbooks are streamed from Rust by chunks; CSV/TSV come from the
// live Monaco buffer so the "Tableau" view always reflects unsaved edits.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { read, utils, type CellObject, type WorkBook, type WorkSheet } from "xlsx";
import { readAllBytes, formatBytes } from "./bytes";
import { buildModel, cellKey, cellText, SheetGrid, type SheetModel } from "./SheetGrid";

function buildSheetModel(ws: WorkSheet): SheetModel {
  const ref = ws["!ref"];
  const range = ref ? utils.decode_range(ref) : null;
  const data = (ws as unknown as { "!data"?: (CellObject[] | undefined)[] })["!data"] ?? [];
  const declared = (ws["!cols"] ?? []).map((info) =>
    info?.wpx ?? (info?.wch != null ? info.wch * 7 + 12 : undefined),
  );
  return buildModel(data, range ? range.e.r + 1 : 0, range ? range.e.c + 1 : 0, declared);
}

const MAX_WORKBOOK_BYTES = 120 * 1024 * 1024;
const MAX_MATCHES = 20000;

export type SpreadsheetSource =
  | { kind: "file"; path: string; size: number; delimited?: boolean; separator?: string }
  | { kind: "text"; text: string; separator?: string };

/** Decodes a CSV/TSV file: BOM-aware, UTF-8 first, Windows-1252 fallback. */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Plain-text tables keep their cells verbatim (no number/date coercion). */
function parseDelimited(text: string, separator?: string): WorkBook {
  return read(text, { type: "string", dense: true, raw: true, ...(separator ? { FS: separator } : {}) });
}

function useWorkbook(source: SpreadsheetSource) {
  const [state, setState] = useState<{
    workbook: WorkBook | null;
    error: string | null;
    progress: number | null;
  }>({ workbook: null, error: null, progress: 0 });
  const fileKey = source.kind === "file" ? `${source.path}:${source.size}` : null;
  const text = source.kind === "text" ? source.text : null;
  const separator = source.separator;

  useEffect(() => {
    let cancelled = false;
    const parse = async () => {
      try {
        let workbook: WorkBook;
        if (source.kind === "file") {
          setState({ workbook: null, error: null, progress: 0 });
          const bytes = await readAllBytes(source.path, source.size, MAX_WORKBOOK_BYTES, (n) => {
            if (!cancelled) setState((prev) => ({ ...prev, progress: n }));
          });
          if (cancelled) return;
          // Yield one frame so the "analyse" state paints before parsing.
          await new Promise((resolve) => setTimeout(resolve, 16));
          workbook = source.delimited
            ? parseDelimited(decodeText(bytes), separator)
            : read(bytes, { type: "array", dense: true, cellDates: true });
        } else {
          workbook = parseDelimited(text ?? "", separator);
        }
        if (!cancelled) setState({ workbook, error: null, progress: null });
      } catch (err) {
        if (!cancelled) {
          setState({ workbook: null, error: String((err as Error)?.message ?? err), progress: null });
        }
      }
    };
    // CSV edits are debounced so typing in Monaco stays fluid.
    const timer = setTimeout(() => void parse(), source.kind === "text" ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, text, separator]);

  return state;
}

export default function SpreadsheetViewer({ source }: { source: SpreadsheetSource }) {
  const { workbook, error, progress } = useWorkbook(source);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [freeze, setFreeze] = useState(true);

  const sheetNames = workbook?.SheetNames ?? [];
  const activeSheet = Math.min(sheetIndex, Math.max(0, sheetNames.length - 1));
  const model: SheetModel | null = useMemo(() => {
    const name = sheetNames[activeSheet];
    const ws = name ? workbook?.Sheets[name] : undefined;
    return ws ? buildSheetModel(ws) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbook, activeSheet]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim().toLowerCase()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const hits = useMemo(() => {
    const list: [number, number][] = [];
    if (!model || !debounced) return list;
    for (let r = 0; r < model.rows && list.length < MAX_MATCHES; r += 1) {
      const row = model.data[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c += 1) {
        if (cellText(row[c]).toLowerCase().includes(debounced)) list.push([r, c]);
      }
    }
    return list;
  }, [model, debounced]);
  const matchSet = useMemo(() => new Set(hits.map(([r, c]) => cellKey(r, c))), [hits]);
  useEffect(() => setMatchIndex(0), [hits]);
  useEffect(() => setSelected(null), [activeSheet, workbook]);

  const current = hits.length ? hits[Math.min(matchIndex, hits.length - 1)] : null;
  const step = (delta: number) => {
    if (!hits.length) return;
    setMatchIndex((index) => (index + delta + hits.length) % hits.length);
  };

  if (error) {
    return (
      <div className="xv-state">
        <Icon icon="solar:danger-triangle-linear" width={18} height={18} />
        <span>Impossible de lire ce classeur.</span>
        <code>{error}</code>
      </div>
    );
  }
  if (!workbook || !model) {
    return (
      <div className="xv-state">
        <span className="xv-spinner" />
        <span>
          {progress != null && source.kind === "file" && progress < source.size
            ? `Chargement… ${formatBytes(progress)} / ${formatBytes(source.size)}`
            : "Analyse du classeur…"}
        </span>
      </div>
    );
  }

  const selectedCell = selected ? model.data[selected[0]]?.[selected[1]] : undefined;
  return (
    <div className="xv-sheet">
      <div className="xv-toolbar">
        <span className="xv-toolbar__ref">
          {selected ? utils.encode_cell({ r: selected[0], c: selected[1] }) : "—"}
        </span>
        <span className="xv-toolbar__value" title={cellText(selectedCell)}>
          {selectedCell?.f ? `=${selectedCell.f}` : cellText(selectedCell)}
        </span>
        <button
          type="button"
          className="xv-btn xv-btn--text"
          data-active={freeze ? "true" : "false"}
          onClick={() => setFreeze((value) => !value)}
          title="Garder la première ligne visible pendant le défilement"
        >
          Figer la 1re ligne
        </button>
        <div className="xv-search">
          <Icon icon="solar:magnifer-linear" width={13} height={13} />
          <input
            value={query}
            placeholder="Rechercher"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") step(event.shiftKey ? -1 : 1);
              if (event.key === "Escape") setQuery("");
            }}
          />
          {debounced && (
            <span className="xv-search__count">
              {hits.length ? `${Math.min(matchIndex, hits.length - 1) + 1}/${hits.length}` : "0"}
            </span>
          )}
          <button type="button" onClick={() => step(-1)} disabled={!hits.length} title="Précédent">
            <Icon icon="solar:alt-arrow-up-linear" width={13} height={13} />
          </button>
          <button type="button" onClick={() => step(1)} disabled={!hits.length} title="Suivant">
            <Icon icon="solar:alt-arrow-down-linear" width={13} height={13} />
          </button>
        </div>
      </div>
      {model.rows === 0 ? (
        <div className="xv-state">Feuille vide.</div>
      ) : (
        <SheetGrid
          model={model}
          matches={matchSet}
          current={current}
          selected={selected}
          freezeFirstRow={freeze}
          onSelect={setSelected}
        />
      )}
      <div className="xv-sheet__footer">
        <div className="xv-sheet__tabs">
          {sheetNames.map((name, index) => (
            <button
              type="button"
              key={name}
              className="xv-sheet__tab"
              data-active={index === activeSheet ? "true" : "false"}
              onClick={() => setSheetIndex(index)}
            >
              {name}
            </button>
          ))}
        </div>
        <span className="xv-sheet__stats">
          {model.rows.toLocaleString("fr-FR")} lignes × {model.cols.toLocaleString("fr-FR")} colonnes
        </span>
      </div>
    </div>
  );
}
