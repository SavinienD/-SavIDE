// axe:viewers — virtualized spreadsheet grid with frozen row/column headers.
// Only the cells inside the viewport (plus a small overscan) are rendered, so
// sheets with hundreds of thousands of rows scroll smoothly.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CellObject } from "xlsx";

export const ROW_H = 24;
const HEAD_H = 26;
const OVERSCAN = 6;
const MIN_COL_W = 56;
const MAX_COL_W = 360;

export type SheetModel = {
  rows: number;
  cols: number;
  data: (CellObject[] | undefined)[];
  widths: number[];
  lefts: number[];
  totalWidth: number;
  rowHeadWidth: number;
  /** Column header labels; spreadsheet letters (A, B…) when absent. */
  labels?: string[];
};

/** Spreadsheet column name: 0 -> A, 25 -> Z, 26 -> AA. */
export function encodeCol(col: number): string {
  let name = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

export function cellText(cell: CellObject | undefined): string {
  if (!cell) return "";
  if (cell.w != null) return cell.w;
  if (cell.v == null) return "";
  return cell.v instanceof Date ? cell.v.toLocaleString("fr-FR") : String(cell.v);
}

export function cellKey(row: number, col: number): number {
  return row * 20000 + col;
}

const NUMERIC = /^\s*[-+]?(\d[\d\s\u00a0\u202f.,]*)(e[-+]?\d+)?\s*%?\s*$/i;

/** Numbers (and numeric-looking CSV text) are right-aligned. */
function isNumeric(cell: CellObject | undefined): boolean {
  if (!cell) return false;
  if (cell.t === "n") return true;
  return cell.t === "s" && typeof cell.v === "string" && NUMERIC.test(cell.v);
}

/** Grid model from dense rows. `declared` holds known pixel widths. */
export function buildModel(
  data: (CellObject[] | undefined)[],
  rows: number,
  cols: number,
  declared: (number | undefined)[] = [],
  labels?: string[],
): SheetModel {
  const widths: number[] = [];
  const sampleRows = Math.min(rows, 300);
  for (let c = 0; c < cols; c += 1) {
    let width = declared[c] ?? 0;
    if (!width) {
      let longest = labels?.[c]?.length ?? 0;
      for (let r = 0; r < sampleRows; r += 1) {
        const len = cellText(data[r]?.[c]).length;
        if (len > longest) longest = len;
      }
      width = longest * 7 + 18;
    }
    widths.push(Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, width))));
  }
  const lefts: number[] = [];
  let x = 0;
  for (const width of widths) {
    lefts.push(x);
    x += width;
  }
  const rowHeadWidth = Math.max(44, String(rows).length * 8 + 20);
  return { rows, cols, data, widths, lefts, totalWidth: x, rowHeadWidth, labels };
}

function firstColumnAt(lefts: number[], x: number): number {
  let lo = 0;
  let hi = lefts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lefts[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

type Props = {
  model: SheetModel;
  matches: Set<number>;
  current: [number, number] | null;
  selected: [number, number] | null;
  /** Keep the first row (table header) visible while scrolling. */
  freezeFirstRow: boolean;
  onSelect: (cell: [number, number]) => void;
  /** Added to the displayed row numbers (paged data). */
  rowOffset?: number;
};

export function SheetGrid({
  model,
  matches,
  current,
  selected,
  freezeFirstRow,
  onSelect,
  rowOffset = 0,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, left: 0, width: 800, height: 600 });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () =>
      setView({
        top: el.scrollTop,
        left: el.scrollLeft,
        width: el.clientWidth,
        height: el.clientHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bring the current search hit into view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !current) return;
    const [row, col] = current;
    const top = row * ROW_H;
    const frozen = freezeFirstRow ? ROW_H : 0;
    if (top < el.scrollTop + frozen || top + ROW_H > el.scrollTop + el.clientHeight - HEAD_H) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
    const left = model.lefts[col] ?? 0;
    const right = left + (model.widths[col] ?? 0);
    const visibleWidth = el.clientWidth - model.rowHeadWidth;
    if (left < el.scrollLeft || right > el.scrollLeft + visibleWidth) {
      el.scrollLeft = Math.max(0, left - visibleWidth / 3);
    }
  }, [current, model, freezeFirstRow]);

  const firstRow = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const lastRow = Math.min(
    model.rows - 1,
    Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN,
  );
  const firstCol = model.cols ? Math.max(0, firstColumnAt(model.lefts, view.left) - 1) : 0;
  const lastCol = model.cols
    ? Math.min(model.cols - 1, firstColumnAt(model.lefts, view.left + view.width) + 1)
    : -1;

  const columns = useMemo(() => {
    const out: number[] = [];
    for (let c = firstCol; c <= lastCol; c += 1) out.push(c);
    return out;
  }, [firstCol, lastCol]);

  const rowItems: number[] = [];
  for (let r = firstRow; r <= lastRow; r += 1) rowItems.push(r);
  const frozen = freezeFirstRow && model.rows > 1;

  const renderCell = (r: number, c: number, top: number) => {
    const cell = model.data[r]?.[c];
    const key = cellKey(r, c);
    return (
      <div
        key={key}
        className="xv-grid__cell"
        data-num={isNumeric(cell) ? "true" : undefined}
        data-match={matches.has(key) ? "true" : undefined}
        data-current={current && current[0] === r && current[1] === c ? "true" : undefined}
        data-selected={selected && selected[0] === r && selected[1] === c ? "true" : undefined}
        style={{ top, left: model.lefts[c], width: model.widths[c], height: ROW_H }}
        onMouseDown={() => onSelect([r, c])}
      >
        {cellText(cell)}
      </div>
    );
  };

  const bodyHeight = model.rows * ROW_H;
  return (
    <div
      ref={scrollRef}
      className="xv-grid"
      onScroll={(event) => {
        const el = event.currentTarget;
        setView((prev) => ({ ...prev, top: el.scrollTop, left: el.scrollLeft }));
      }}
    >
      <div
        className="xv-grid__canvas"
        style={{
          width: model.rowHeadWidth + model.totalWidth,
          height: HEAD_H + bodyHeight,
        }}
      >
        <div className="xv-grid__colheads" style={{ height: HEAD_H }}>
          <div className="xv-grid__corner" style={{ width: model.rowHeadWidth }}>
            {frozen && (
              <div className="xv-grid__rowhead xv-grid__frozenhead" style={{ top: HEAD_H, height: ROW_H }}>
                1
              </div>
            )}
          </div>
          {columns.map((c) => (
            <div
              key={c}
              className="xv-grid__colhead"
              data-active={selected?.[1] === c ? "true" : undefined}
              style={{ left: model.rowHeadWidth + model.lefts[c], width: model.widths[c] }}
            >
              {model.labels?.[c] ?? encodeCol(c)}
            </div>
          ))}
          {frozen && (
            <div
              className="xv-grid__frozen"
              style={{ top: HEAD_H, left: model.rowHeadWidth, width: model.totalWidth, height: ROW_H }}
            >
              {columns.map((c) => renderCell(0, c, 0))}
            </div>
          )}
        </div>
        <div className="xv-grid__rowheads" style={{ width: model.rowHeadWidth, height: bodyHeight }}>
          {rowItems.map((r) => (
            <div
              key={r}
              className="xv-grid__rowhead"
              data-active={selected?.[0] === r ? "true" : undefined}
              style={{ top: r * ROW_H, height: ROW_H }}
            >
              {r + 1 + rowOffset}
            </div>
          ))}
        </div>
        <div
          className="xv-grid__body"
          style={{ top: HEAD_H, left: model.rowHeadWidth, width: model.totalWidth, height: bodyHeight }}
        >
          {rowItems.map((r) => columns.map((c) => renderCell(r, c, r * ROW_H)))}
        </div>
      </div>
    </div>
  );
}
