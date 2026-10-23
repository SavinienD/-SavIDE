// axe:viewers — read-only SQLite browser: tables/views list, first rows of
// the selected table in the virtualized grid. All queries run in Rust with a
// read-only, query_only connection.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@iconify/react";
import type { CellObject } from "xlsx";
import { buildModel, SheetGrid } from "./SheetGrid";

const PAGE_ROWS = 200;

type Table = { name: string; kind: string; columns: string[] };
type Rows = { columns: string[]; rows: unknown[][]; total: number | null };

function toCell(value: unknown): CellObject | undefined {
  if (value === null || value === undefined) return { t: "z", w: "NULL" } as CellObject;
  if (typeof value === "number") return { t: "n", v: value, w: String(value) };
  return { t: "s", v: String(value), w: String(value) };
}

export default function SqliteViewer({ path }: { path: string }) {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Rows | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<[number, number] | null>(null);

  useEffect(() => {
    setTables(null);
    setError(null);
    invoke<Table[]>("viewer_sqlite_tables", { input: { path } })
      .then((list) => {
        setTables(list);
        setActive(list[0]?.name ?? null);
      })
      .catch((err) => setError(String(err)));
  }, [path]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setRows(null);
    setRowsError(null);
    setSelected(null);
    invoke<Rows>("viewer_sqlite_rows", {
      input: { path, table: active, limit: PAGE_ROWS, offset: page * PAGE_ROWS },
    })
      .then((result) => !cancelled && setRows(result))
      .catch((err) => !cancelled && setRowsError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [path, active, page]);

  const model = useMemo(() => {
    if (!rows) return null;
    const data = rows.rows.map((row) => row.map(toCell) as CellObject[]);
    return buildModel(data, data.length, rows.columns.length, [], rows.columns);
  }, [rows]);

  if (error) {
    return (
      <div className="xv-state">
        <Icon icon="solar:database-linear" width={18} height={18} />
        <span>Impossible d&rsquo;ouvrir cette base.</span>
        <code>{error}</code>
      </div>
    );
  }
  if (!tables) {
    return (
      <div className="xv-state">
        <span className="xv-spinner" />
        <span>Lecture de la base…</span>
      </div>
    );
  }

  const total = rows?.total ?? null;
  const pages = total != null ? Math.max(1, Math.ceil(total / PAGE_ROWS)) : null;
  const value = selected && rows ? rows.rows[selected[0]]?.[selected[1]] : undefined;
  return (
    <div className="xv-split">
      <div className="xv-split__side">
        <div className="xv-split__title">
          {tables.length} table{tables.length > 1 ? "s" : ""} · lecture seule
        </div>
        {tables.map((table) => (
          <button
            type="button"
            key={table.name}
            className="xv-split__item"
            data-active={table.name === active ? "true" : "false"}
            onClick={() => {
              setActive(table.name);
              setPage(0);
            }}
            title={table.columns.join(", ")}
          >
            <Icon
              icon={table.kind === "view" ? "solar:eye-linear" : "solar:database-linear"}
              width={13}
              height={13}
            />
            <span>{table.name}</span>
          </button>
        ))}
        {tables.length === 0 && <div className="xv-split__empty">Aucune table.</div>}
      </div>
      <div className="xv-split__main">
        <div className="xv-toolbar">
          <span className="xv-toolbar__value" title={value == null ? "" : String(value)}>
            {selected && rows ? `${rows.columns[selected[1]]} = ${value == null ? "NULL" : String(value)}` : active ?? ""}
          </span>
          {total != null && (
            <span className="xv-search__count">{total.toLocaleString("fr-FR")} lignes</span>
          )}
          {pages != null && pages > 1 && (
            <>
              <button type="button" className="xv-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)} title="Page précédente">
                <Icon icon="solar:alt-arrow-left-linear" width={14} height={14} />
              </button>
              <span className="xv-search__count">
                {page + 1} / {pages}
              </span>
              <button type="button" className="xv-btn" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} title="Page suivante">
                <Icon icon="solar:alt-arrow-right-linear" width={14} height={14} />
              </button>
            </>
          )}
        </div>
        {rowsError ? (
          <div className="xv-state">
            <code>{rowsError}</code>
          </div>
        ) : !model ? (
          <div className="xv-state">
            <span className="xv-spinner" />
          </div>
        ) : model.rows === 0 ? (
          <div className="xv-state">Table vide.</div>
        ) : (
          <SheetGrid
            model={model}
            matches={new Set()}
            current={null}
            selected={selected}
            freezeFirstRow={false}
            onSelect={setSelected}
            rowOffset={page * PAGE_ROWS}
          />
        )}
      </div>
    </div>
  );
}
