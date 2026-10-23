import { useCallback, useEffect, useMemo, useState } from "react";
import { agentsApi, describeEntry, type JournalEntry, type JournalTree } from "./agentsApi";
import "./agents.css";

type Props = {
  sessionId: string;
  /** axe:remote — machine the session lives on (default: local). */
  connectionId?: string;
  onClose?: () => void;
};

type Node = { entry: JournalEntry; children: Node[] };

function buildForest(entries: JournalEntry[]): Node[] {
  const nodes = new Map<string, Node>();
  for (const entry of entries) nodes.set(entry.id, { entry, children: [] });
  const roots: Node[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    const parent = entry.parent ? nodes.get(entry.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Hidden bookkeeping kinds that clutter the tree. */
const HIDDEN = new Set(["pointer", "peer_delivered", "meta"]);

/** `/tree`: journal of a session as a tree; jump back to any point or fork from it. */
export function SessionTree({ sessionId, connectionId = "local", onClose }: Props) {
  const [tree, setTree] = useState<JournalTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTree(await agentsApi.tree(sessionId, connectionId));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, connectionId]);

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    void agentsApi
      .onEvent((event) => {
        if (event.sessionId === sessionId && (event.connectionId ?? "local") === connectionId && event.event === "entry") void load();
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [load, sessionId]);

  const visible = useMemo(
    () => (tree?.entries ?? []).filter((e) => !HIDDEN.has(e.kind)),
    [tree],
  );
  const forest = useMemo(() => {
    // Re-parent entries whose parent is hidden onto the nearest visible ancestor.
    const byId = new Map((tree?.entries ?? []).map((e) => [e.id, e]));
    const shown = new Set(visible.map((e) => e.id));
    const fixed = visible.map((e) => {
      let parent = e.parent;
      while (parent && !shown.has(parent)) parent = byId.get(parent)?.parent;
      return { ...e, parent };
    });
    return buildForest(fixed);
  }, [tree, visible]);

  const onPath = useMemo(() => {
    const set = new Set<string>();
    const byId = new Map((tree?.entries ?? []).map((e) => [e.id, e]));
    let cursor = tree?.leaf;
    while (cursor) {
      set.add(cursor);
      cursor = byId.get(cursor)?.parent;
    }
    return set;
  }, [tree]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const renderNode = (node: Node, depth: number): JSX.Element => {
    const { entry } = node;
    const active = onPath.has(entry.id);
    const isLeaf = tree?.leaf === entry.id;
    return (
      <li key={entry.id}>
        <div className="axe-tree__row" data-active={active ? "true" : "false"} style={{ paddingLeft: depth * 12 }}>
          <span className="axe-tree__time">
            {new Date(entry.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </span>
          <span className="axe-tree__label">{describeEntry(entry)}</span>
          {isLeaf ? <span className="axe-tree__pill">position actuelle</span> : null}
          {!isLeaf ? (
            <button
              type="button"
              disabled={busy}
              title="Revenir à ce point (la suite reste dans le journal comme branche)"
              onClick={() => void act(() => agentsApi.moveLeaf(sessionId, entry.id, "/tree", connectionId))}
            >
              Revenir ici
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            title="Créer une nouvelle session à partir de ce point"
            onClick={() => void act(() => agentsApi.fork(sessionId, entry.id, undefined, connectionId))}
          >
            Bifurquer
          </button>
        </div>
        {node.children.length ? (
          <ul>{node.children.map((child) => renderNode(child, node.children.length > 1 ? depth + 1 : depth))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="axe-tree">
      <header className="axe-tree__head">
        <strong>Arbre de la session</strong>
        <span className="axe-agents__muted">
          {visible.length} entrées · {tree?.branches.length ?? 0} branche(s)
        </span>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        ) : null}
      </header>
      {error ? <p className="axe-agents__error">{error}</p> : null}
      <ul className="axe-tree__list">{forest.map((node) => renderNode(node, 0))}</ul>
    </div>
  );
}
