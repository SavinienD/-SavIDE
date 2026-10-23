import { useMemo, useState } from "react";
import type { SessionMeta } from "./api";
import { relativeTime, workspaceLabel } from "./items";

const STATUS_LABEL = { running: "en cours", idle: "inactive", inactive: "inactive" } as const;

type Props = {
  sessions: SessionMeta[];
  activeId: string | null;
  onOpen: (id: string) => void;
};

/** axe:freechat — project filter value of free conversations. */
const FREE = "__free__";

/** Root conversations (sub-agents live in the Agents view). */
export function ConversationList({ sessions, activeId, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const projects = useMemo(
    () =>
      Array.from(new Set(sessions.filter((s) => !s.scratch).map((s) => s.workspaceId))).sort((a, b) =>
        workspaceLabel(a).localeCompare(workspaceLabel(b)),
      ),
    [sessions],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter((s) => !s.parentId)
      .filter((s) => showArchived || !s.archived)
      .filter((s) => !project || (project === FREE ? s.scratch : !s.scratch && s.workspaceId === project))
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }, [sessions, query, project, showArchived]);

  // axe:freechat — free conversations first, under their own heading.
  const free = visible.filter((s) => s.scratch);
  const others = visible.filter((s) => !s.scratch);

  const row = (s: SessionMeta) => {
    const state = s.archived ? "archivée" : STATUS_LABEL[s.status];
    const where = s.scratch ? "Conversation libre" : workspaceLabel(s.workspaceId);
    return (
      <li key={s.id}>
        <button
          type="button"
          className="convs__item"
          data-active={s.id === activeId}
          onClick={() => onOpen(s.id)}
          title={s.scratch ? "Conversation libre" : s.workspaceId}
        >
          <span className="dot" data-status={s.archived ? "archived" : s.status} />
          <span className="convs__main">
            <span className="convs__name">{s.name || "Sans titre"}</span>
            <span className="convs__meta">
              {where} · {state} · {relativeTime(s.updatedAtMs)}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="convs">
      <div className="convs__filters">
        <input
          type="search"
          placeholder="Rechercher par titre…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Rechercher"
        />
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Projet">
          <option value="">Tous les projets</option>
          <option value={FREE}>Conversations libres</option>
          {projects.map((p) => (
            <option key={p} value={p} title={p}>
              {workspaceLabel(p)}
            </option>
          ))}
        </select>
        <label className="convs__toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Archivées
        </label>
      </div>
      <ul className="convs__list">
        {free.length > 0 && (
          <>
            <li className="convs__group">Conversations libres</li>
            {free.map(row)}
            {others.length > 0 && <li className="convs__group">Projets</li>}
          </>
        )}
        {others.map(row)}
        {visible.length === 0 && <li className="muted convs__empty">Aucune conversation.</li>}
      </ul>
    </div>
  );
}
