// axe:viewers — collapsible JSON tree. Only expanded nodes render their
// children and long arrays/objects are paged, so large documents stay fast.
// The source stays editable in Monaco ("Code"); the tree follows the buffer.

import { memo, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { readAllBytes } from "./bytes";
import { ViewerError, ViewerLoading } from "./common";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const PAGE = 200;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function preview(value: Json): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).length}}`;
  return "";
}

type NodeProps = {
  name: string | number | null;
  value: Json;
  path: string;
  depth: number;
  openDepth: number;
  overrides: Map<string, boolean>;
  toggle: (path: string, open: boolean) => void;
  selected: string | null;
  onSelect: (path: string, value: Json) => void;
};

const JsonNode = memo(function JsonNode(props: NodeProps) {
  const { name, value, path, depth, openDepth, overrides, toggle, selected, onSelect } = props;
  const [shown, setShown] = useState(PAGE);
  const container = value !== null && typeof value === "object";
  const open = container && (overrides.get(path) ?? depth < openDepth);
  const entries: [string | number, Json][] = !open
    ? []
    : Array.isArray(value)
      ? value.map((item, i) => [i, item])
      : Object.entries(value as Record<string, Json>);

  return (
    <div className="xv-json__node">
      <div
        className="xv-json__row"
        data-selected={selected === path ? "true" : undefined}
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => {
          onSelect(path, value);
          if (container) toggle(path, !open);
        }}
      >
        <span className="xv-json__caret">
          {container && <Icon icon={open ? "solar:alt-arrow-down-linear" : "solar:alt-arrow-right-linear"} width={11} height={11} />}
        </span>
        {name !== null && <span className={typeof name === "number" ? "xv-json__index" : "xv-json__key"}>{name}</span>}
        {name !== null && <span className="xv-json__colon">:</span>}
        {container ? (
          <span className="xv-json__meta">
            {Array.isArray(value) ? "Tableau" : "Objet"} {preview(value)}
          </span>
        ) : (
          <span className={`xv-json__value xv-json__value--${value === null ? "null" : typeof value}`}>
            {typeof value === "string" ? JSON.stringify(value) : String(value)}
          </span>
        )}
      </div>
      {open &&
        entries.slice(0, shown).map(([key, child]) => (
          <JsonNode key={String(key)} {...props} name={key} value={child} path={childPath(path, key)} depth={depth + 1} />
        ))}
      {open && entries.length > shown && (
        <button type="button" className="xv-json__more" style={{ marginLeft: 26 + (depth + 1) * 16 }} onClick={() => setShown((n) => n + PAGE * 5)}>
          Afficher {Math.min(PAGE * 5, entries.length - shown)} de plus ({entries.length - shown} restants)
        </button>
      )}
    </div>
  );
});

function useJson(path: string, size: number, text: string | null) {
  const [source, setSource] = useState<string | null>(text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (text !== null) {
      const timer = setTimeout(() => setSource(text), 250);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    readAllBytes(path, size, MAX_JSON_BYTES)
      .then((bytes) => !cancelled && setSource(new TextDecoder().decode(bytes)))
      .catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, [path, size, text]);
  const parsed = useMemo(() => {
    if (source === null) return null;
    try {
      return { value: JSON.parse(source.replace(/^\uFEFF/, "")) as Json, error: null };
    } catch (err) {
      return { value: null, error: String((err as Error).message) };
    }
  }, [source]);
  return { parsed, error };
}

export default function JsonViewer({ path, size, text }: { path: string; size: number; name: string; text: string | null }) {
  const { parsed, error } = useJson(path, size, text);
  const [openDepth, setOpenDepth] = useState(2);
  const [overrides, setOverrides] = useState(() => new Map<string, boolean>());
  const [selected, setSelected] = useState<{ path: string; value: Json } | null>(null);

  useEffect(() => setOverrides(new Map()), [openDepth]);
  const toggle = useMemo(
    () => (nodePath: string, open: boolean) =>
      setOverrides((prev) => new Map(prev).set(nodePath, open)),
    [],
  );
  const onSelect = useMemo(() => (nodePath: string, value: Json) => setSelected({ path: nodePath, value }), []);

  if (error) return <ViewerError title="Impossible de lire ce fichier JSON." detail={error} />;
  if (!parsed) return <ViewerLoading label="Lecture du JSON…" />;
  if (parsed.error) {
    return <ViewerError icon="solar:code-square-linear" title="JSON invalide : l’arbre ne peut pas être affiché." detail={parsed.error} />;
  }
  const summary = selected && selected.value !== null && typeof selected.value === "object" ? preview(selected.value) : "";
  return (
    <div className="xv-json">
      <div className="xv-toolbar">
        <span className="xv-toolbar__value" title={selected?.path}>
          {selected ? `${selected.path} ${summary}` : "$"}
        </span>
        {selected && (
          <button type="button" className="xv-btn" title="Copier le chemin" onClick={() => void navigator.clipboard.writeText(selected.path)}>
            <Icon icon="solar:copy-linear" width={14} height={14} />
          </button>
        )}
        <button type="button" className="xv-btn xv-btn--text" onClick={() => setOpenDepth(1)}>
          Tout replier
        </button>
        <button type="button" className="xv-btn xv-btn--text" onClick={() => setOpenDepth((d) => Math.min(d + 2, 64))}>
          Déplier plus
        </button>
      </div>
      <div className="xv-json__tree">
        <JsonNode
          name={null}
          value={parsed.value}
          path="$"
          depth={0}
          openDepth={openDepth}
          overrides={overrides}
          toggle={toggle}
          selected={selected?.path ?? null}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}
