// axe:viewers — zip archive browser (also used for jar/apk/nupkg…): folder
// tree of the entries, sizes, single-file extraction through a save dialog.
// Listing and extraction run in Rust; nothing is decompressed in the webview.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Icon } from "@iconify/react";
import { fileIcon } from "../../lib/fileIcon";
import { formatBytes } from "./bytes";

type Entry = {
  name: string;
  size: number;
  compressedSize: number;
  isDir: boolean;
  encrypted: boolean;
  modified: string | null;
};
type Listing = { entries: Entry[]; total: number; truncated: boolean };

type Row = { path: string; label: string; depth: number; dir: boolean; entry?: Entry };

/** Flattens the entry names into a sorted tree (folders first). */
function buildRows(entries: Entry[], collapsed: Set<string>): Row[] {
  type Node = { children: Map<string, Node>; entry?: Entry; dir: boolean };
  const root: Node = { children: new Map(), dir: true };
  for (const entry of entries) {
    const parts = entry.name.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), dir: !last || entry.isDir };
        node.children.set(part, child);
      }
      if (last) {
        child.entry = entry;
        child.dir = child.dir || entry.isDir;
      }
      node = child;
    });
  }
  const rows: Row[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    const items = [...node.children.entries()].sort(([a, x], [b, y]) =>
      x.dir === y.dir ? a.localeCompare(b) : x.dir ? -1 : 1,
    );
    for (const [label, child] of items) {
      const path = prefix + label;
      rows.push({ path, label, depth, dir: child.dir, entry: child.entry });
      if (child.dir && !collapsed.has(path)) walk(child, `${path}/`, depth + 1);
    }
  };
  walk(root, "", 0);
  return rows;
}

export default function ZipViewer({ path }: { path: string }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setListing(null);
    setError(null);
    invoke<Listing>("viewer_zip_list", { input: { path } })
      .then(setListing)
      .catch((err) => setError(String(err)));
  }, [path]);

  const rows = useMemo(() => {
    if (!listing) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return buildRows(listing.entries, collapsed);
    return listing.entries
      .filter((entry) => !entry.isDir && entry.name.toLowerCase().includes(needle))
      .map((entry) => ({ path: entry.name, label: entry.name, depth: 0, dir: false, entry }));
  }, [listing, collapsed, filter]);

  const extract = async (entry: Entry) => {
    const name = entry.name.split("/").filter(Boolean).pop() ?? "fichier";
    const destination = await save({ defaultPath: name });
    if (!destination) return;
    try {
      const written = await invoke<number>("viewer_zip_extract", {
        input: { path, entry: entry.name, destination },
      });
      setNotice(`${name} extrait (${formatBytes(written)}).`);
    } catch (err) {
      setNotice(`Échec de l’extraction : ${String(err)}`);
    }
  };

  if (error) {
    return (
      <div className="xv-state">
        <Icon icon="solar:archive-linear" width={18} height={18} />
        <span>Impossible de lire cette archive.</span>
        <code>{error}</code>
      </div>
    );
  }
  if (!listing) {
    return (
      <div className="xv-state">
        <span className="xv-spinner" />
        <span>Lecture de l&rsquo;archive…</span>
      </div>
    );
  }

  const files = listing.entries.filter((entry) => !entry.isDir);
  const unpacked = files.reduce((sum, entry) => sum + entry.size, 0);
  return (
    <div className="xv-zip">
      <div className="xv-toolbar">
        <span>
          {listing.total.toLocaleString("fr-FR")} entrées · {formatBytes(unpacked)} décompressés
          {listing.truncated ? " · liste tronquée" : ""}
        </span>
        <span className="xv-toolbar__spacer" />
        {notice && <span className="xv-zip__notice">{notice}</span>}
        <div className="xv-search">
          <Icon icon="solar:magnifer-linear" width={13} height={13} />
          <input value={filter} placeholder="Filtrer" onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <div className="xv-zip__list">
        {rows.map((row) => (
          <div
            key={row.path}
            className="xv-zip__row"
            style={{ paddingLeft: 12 + row.depth * 16 }}
            onClick={() => {
              if (!row.dir) return;
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(row.path)) next.delete(row.path);
                else next.add(row.path);
                return next;
              });
            }}
            data-dir={row.dir ? "true" : "false"}
          >
            <Icon
              icon={row.dir ? (collapsed.has(row.path) ? "solar:folder-linear" : "solar:folder-open-linear") : fileIcon(row.label)}
              width={14}
              height={14}
            />
            <span className="xv-zip__name">{row.label}</span>
            {row.entry?.encrypted && <Icon icon="solar:lock-keyhole-linear" width={12} height={12} />}
            {!row.dir && row.entry && (
              <>
                <span className="xv-zip__meta">{row.entry.modified ?? ""}</span>
                <span className="xv-zip__meta xv-zip__size">{formatBytes(row.entry.size)}</span>
                <button
                  type="button"
                  className="xv-btn"
                  title="Extraire ce fichier…"
                  onClick={(event) => {
                    event.stopPropagation();
                    void extract(row.entry as Entry);
                  }}
                >
                  <Icon icon="solar:download-minimalistic-linear" width={14} height={14} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
