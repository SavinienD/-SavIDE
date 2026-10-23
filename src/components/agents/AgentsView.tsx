import { comparerAgents } from "./agentOrder"; // axe:agents-ordre
import { useCallback, useEffect, useMemo, useState } from "react";
import { SessionTree } from "./SessionTree";
import { ExternalAgents } from "./ExternalAgents"; // axe:agents — agents externes du service
import { STATUS_LABEL, agentsApi, type SessionMeta as BaseMeta } from "./agentsApi";
import { connectionsApi, LOCAL_CONNECTION, useActiveConnection } from "../settings/connectionsApi"; // axe:remote
import { useModelChoices } from "./useModelChoices"; // axe:sub-m
import "./agents.css";

type Props = {
  workspacePath: string;
  /** Open a session's conversation in the chat (session id = conversation id). */
  onOpenConversation?: (sessionId: string) => void;
  /** axe:freechat — open a free conversation (free conversation view). */
  onOpenFreeConversation?: (sessionId: string) => void;
  /** axe:sub-m — open a session's journal read-only in the chat column (sub-agents). */
  onOpenJournal?: (sessionId: string, connectionId: string, title: string) => void;
};

// axe:remote — each session remembers the connection (machine) it lives on.
type SessionMeta = BaseMeta & { conn: string; connName: string };
const key = (s: { conn: string; id: string }) => `${s.conn}:${s.id}`;

type TreeNode = { meta: SessionMeta; children: TreeNode[] };

function buildTree(sessions: SessionMeta[]): TreeNode[] {
  const nodes = new Map(sessions.map((s) => [key(s), { meta: s, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const s of sessions) {
    const node = nodes.get(key(s))!;
    const parent = s.parentId ? nodes.get(`${s.conn}:${s.parentId}`) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    // axe:agents-ordre - ceux qui travaillent (orange) en tête, puis ceux qui attendent, puis les terminés.
    list.forEach((n) => sort(n.children));
    list.sort(comparerAgents);
  };
  sort(roots);
  return roots;
}

function countRunning(node: TreeNode): number {
  return (node.meta.status === "running" ? 1 : 0) + node.children.reduce((n, c) => n + countRunning(c), 0);
}

/** Agents view: every session of the workspace as a tree (parents → sub-agents),
 *  plus the free conversations (axe:freechat). */
export function AgentsView({ workspacePath, onOpenConversation, onOpenFreeConversation, onOpenJournal }: Props) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState("");
  const [asPeer, setAsPeer] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // axe:remote
  const active = useActiveConnection();
  const [allMachines, setAllMachines] = useState(false);
  // axe:sub-m — task (1st line of the first user message) of each sub-agent, by key.
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const modelChoices = useModelChoices();

  const load = useCallback(async () => {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    let targets: { id: string; name: string }[] = [{ id: active, name: active === LOCAL_CONNECTION ? "Local" : active }];
    try {
      const registry = await connectionsApi.list();
      const named = registry.connections.map((c) => ({ id: c.id, name: c.name }));
      targets = allMachines ? named : named.filter((c) => c.id === active);
      if (!targets.length) targets = [{ id: LOCAL_CONNECTION, name: "Local" }];
    } catch {
      /* registry unavailable: active only */
    }
    const errors: string[] = [];
    const lists = await Promise.all(
      targets.map(async (t) => {
        try {
          const all = await agentsApi.list(t.id);
          // Local sessions are scoped to the open project (+ free conversations,
          // axe:freechat); remote ones live in remote folders.
          const scoped =
            t.id === LOCAL_CONNECTION
              ? all.filter((s) => s.scratch || norm(s.workspaceId) === norm(workspacePath))
              : all;
          return scoped.map((s) => ({ ...s, conn: t.id, connName: t.name }));
        } catch (e) {
          errors.push(`${t.name} : ${String(e)}`);
          return [];
        }
      }),
    );
    setSessions(lists.flat());
    setError(errors.length ? `Service indisponible — ${errors.join(" · ")}` : null);
  }, [workspacePath, active, allMachines]);
  // axe:remote end

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    void agentsApi
      .onEvent((event) => {
        if (event.event === "status" || event.event === "daemon") void load();
      })
      .then((fn) => (unlisten = fn));
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [load]);

  const visibleSessions = useMemo(
    () => sessions.filter((s) => showArchived || !s.archived),
    [sessions, showArchived],
  );
  const forest = useMemo(() => buildTree(visibleSessions), [visibleSessions]);
  // axe:remote — roots grouped by machine
  const machines = useMemo(() => {
    const groups = new Map<string, { name: string; nodes: TreeNode[] }>();
    for (const node of forest) {
      const g = groups.get(node.meta.conn) ?? { name: node.meta.connName, nodes: [] };
      g.nodes.push(node);
      groups.set(node.meta.conn, g);
    }
    return [...groups.entries()];
  }, [forest]);
  const selected = sessions.find((s) => key(s) === selectedId) ?? null;

  // axe:sub-m — fetch each sub-agent's task once (first user message of its journal).
  useEffect(() => {
    const missing = sessions.filter((s) => s.parentId && !(key(s) in tasks));
    if (!missing.length) return;
    let alive = true;
    void Promise.all(
      missing.map(async (s) => {
        try {
          const tree = await agentsApi.tree(s.id, s.conn);
          const first = (tree.entries ?? []).find((e) => {
            const m = e.message as { role?: string } | undefined;
            return e.kind === "message" && m?.role === "user";
          });
          const msg = first?.message as { parts?: { text?: string }[] } | undefined;
          const text = (msg?.parts ?? []).map((p) => p.text ?? "").join(" ");
          const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
          return [key(s), line] as const;
        } catch {
          return [key(s), ""] as const;
        }
      }),
    ).then((pairs) => {
      if (alive) setTasks((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      alive = false;
    };
  }, [sessions, tasks]);
  const counts = useMemo(() => {
    const c = { running: 0, idle: 0, inactive: 0 };
    for (const s of visibleSessions) c[s.status] += 1;
    return c;
  }, [visibleSessions]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // axe:freechat — a free conversation opens in the free conversation view.
  const openSession = (meta: SessionMeta) => {
    // axe:sub-m — sub-agents (and remote sessions) open as a read-only journal.
    if (onOpenJournal && (meta.parentId || meta.conn !== LOCAL_CONNECTION)) {
      onOpenJournal(meta.id, meta.conn, meta.name || meta.id.slice(0, 8));
      return;
    }
    if (meta.conn !== LOCAL_CONNECTION) return;
    if (meta.scratch && onOpenFreeConversation) onOpenFreeConversation(meta.id);
    else onOpenConversation?.(meta.id);
  };
  const canOpen = (meta: SessionMeta) =>
    (Boolean(onOpenJournal) && (Boolean(meta.parentId) || meta.conn !== LOCAL_CONNECTION)) ||
    (meta.conn === LOCAL_CONNECTION &&
    Boolean(meta.scratch ? onOpenFreeConversation ?? onOpenConversation : onOpenConversation));

  // axe:sub-m — change the model of an idle session (sessions.set_model).
  const changeModel = async (meta: SessionMeta, value: string) => {
    const slash = value.indexOf("/");
    if (slash < 0) return;
    try {
      await agentsApi.setModel(meta.id, { provider: value.slice(0, slash), name: value.slice(slash + 1) }, meta.conn);
      setStatus(`Modèle changé : ${value}`);
      void load();
    } catch (e) {
      setError(String(e));
    }
  };
  /** Project roots first, then the free conversations under their own heading. */
  const renderRoots = (nodes: TreeNode[]) => {
    const free = nodes.filter((n) => n.meta.scratch);
    return (
      <>
        {nodes.filter((n) => !n.meta.scratch).map((node) => renderNode(node, 0))}
        {free.length ? (
          <li>
            <div className="axe-agents__machine">Conversations libres</div>
            <ul>{free.map((node) => renderNode(node, 0))}</ul>
          </li>
        ) : null}
      </>
    );
  };
  // axe:freechat end

  const send = async () => {
    if (!selected || !draft.trim()) return;
    try {
      if (asPeer) await agentsApi.message(selected.id, draft.trim(), selected.conn);
      else await agentsApi.send(selected.id, draft.trim(), selected.conn);
      setDraft("");
      setStatus(asPeer ? "Message mis en file (livré au prochain tour)." : "Message envoyé.");
      void load();
    } catch (e) {
      setError(String(e));
    }
  };

  const stop = async () => {
    if (!selected) return;
    try {
      await agentsApi.stop(selected.id, selected.conn);
      setStatus("Arrêt demandé.");
      void load();
    } catch (e) {
      setError(String(e));
    }
  };

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    const { meta } = node;
    const isCollapsed = collapsed.has(key(meta));
    const running = countRunning(node);
    return (
      <li key={key(meta)}>
        <div
          className="axe-agents__row"
          data-active={key(meta) === selectedId ? "true" : "false"}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            setSelectedId(key(meta));
            if (meta.parentId) openSession(meta); // axe:sub-m — one click opens a sub-agent
          }}
          onDoubleClick={() => openSession(meta)}
        >
          {node.children.length ? (
            <button
              type="button"
              className="axe-agents__twisty"
              aria-label={isCollapsed ? "Déplier" : "Replier"}
              onClick={(e) => {
                e.stopPropagation();
                toggle(key(meta));
              }}
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="axe-agents__twisty" />
          )}
          <span className="axe-agents__dot" data-status={meta.status} title={STATUS_LABEL[meta.status]} />
          <span className="axe-agents__label">
            <span className="axe-agents__name" title={meta.name || meta.id}>{meta.name || meta.id.slice(0, 8)}</span>
            {meta.parentId && tasks[key(meta)] ? (
              <span className="axe-agents__task" title={tasks[key(meta)]}>{tasks[key(meta)]}</span>
            ) : null}
          </span>
          {node.children.length ? (
            <span className="axe-agents__muted">
              {node.children.length} sous-agent(s){isCollapsed && running ? ` · ${running} en cours` : ""}
            </span>
          ) : null}
          <span className="axe-agents__model" title={`${meta.model.provider}/${meta.model.name}`}>{meta.model.name}</span>
        </div>
        {node.children.length && !isCollapsed ? (
          <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="axe-agents">
      {/* axe:agents-ui - entete compacte pour la barre laterale etroite */}
      <header className="axe-agents__head axe-agents__head--compact">
        <span className="axe-agents__counts" title={`${counts.running} en cours, ${counts.idle} inactif(s), ${counts.inactive} déchargé(s)`}>
          <span className="axe-agents__dot" data-status="running" /> {counts.running}
          <span className="axe-agents__dot" data-status="idle" /> {counts.idle}
          <span className="axe-agents__dot" data-status="inactive" /> {counts.inactive}
        </span>
        <details className="axe-agents__filters">
          <summary title="Filtres">Filtres</summary>
          <label><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archivées</label>
          <label><input type="checkbox" checked={allMachines} onChange={(e) => setAllMachines(e.target.checked)} /> toutes les machines</label>
        </details>
        <button type="button" className="axe-agents__refresh" title="Rafraîchir" onClick={() => void load()}>↻</button>
      </header>
      {error ? <p className="axe-agents__error">{error}</p> : null}
      {status ? <p className="axe-agents__status">{status}</p> : null}

      {/* axe:agents — external agent CLIs launched by the service */}

      <ul className="axe-agents__list">
        {forest.length === 0 ? <li className="axe-agents__muted">Aucune session pour ce projet.</li> : null}
        {machines.length > 1 || (machines[0] && machines[0][0] !== LOCAL_CONNECTION)
          ? machines.map(([conn, g]) => (
              <li key={conn}>
                <div className="axe-agents__machine">{g.name}</div>
                <ul>{renderRoots(g.nodes)}</ul>
              </li>
            ))
          : renderRoots(forest)}
      </ul>

      <details className="axe-agents__external">
        <summary>Agents externes (CLI)</summary>
        <ExternalAgents workspacePath={workspacePath} />
      </details>

      {selected ? (
        <section className="axe-agents__detail">
          <div className="axe-agents__detail-head">
            <span className="axe-agents__dot" data-status={selected.status} />
            <strong title={selected.name}>{selected.name}</strong>
            <span className="axe-agents__muted">
              {STATUS_LABEL[selected.status]} · {selected.model.provider}/{selected.model.name} ·{" "}
              {selected.entryCount} entrées
            </span>
          </div>
          <div className="axe-agents__actions">
            {canOpen(selected) ? (
              <button type="button" onClick={() => openSession(selected)}>
                Ouvrir la conversation
              </button>
            ) : null}
            <button type="button" onClick={() => setShowTree((v) => !v)}>
              {showTree ? "Masquer l'arbre" : "/tree"}
            </button>
            {selected.parentId && selected.status !== "running" ? (
              <select
                title="Modèle de ce sous-agent (session inactive)"
                value={`${selected.model.provider}/${selected.model.name}`}
                onChange={(e) => void changeModel(selected, e.target.value)}
              >
                {modelChoices.some((m) => m.value === `${selected.model.provider}/${selected.model.name}`) ? null : (
                  <option value={`${selected.model.provider}/${selected.model.name}`}>
                    {selected.model.provider}/{selected.model.name}
                  </option>
                )}
                {modelChoices.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            ) : null}
            {selected.status === "running" ? (
              <button type="button" onClick={() => void stop()}>
                Arrêter
              </button>
            ) : null}
          </div>
          <textarea
            className="axe-agents__input"
            placeholder={asPeer ? "Message (livré au début de son prochain tour)…" : "Message ou /commande…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="axe-agents__actions">
            <label className="axe-agents__muted">
              <input type="checkbox" checked={asPeer} onChange={(e) => setAsPeer(e.target.checked)} /> en file
              (message entre sessions)
            </label>
            <button type="button" disabled={!draft.trim()} onClick={() => void send()}>
              Envoyer
            </button>
          </div>
          {showTree ? <SessionTree sessionId={selected.id} connectionId={selected.conn} onClose={() => setShowTree(false)} /> : null}
        </section>
      ) : null}
    </div>
  );
}
