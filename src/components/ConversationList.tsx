import { useRef, useState } from "react";
import { titreAffiche } from "../lib/titres";
import { Icon } from "@iconify/react";
import type { ConversationSummary } from "../types";

type Props = {
  conversations: ConversationSummary[];
  activeId: string | null;
  streamingIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  // axe:e3 — archivage. Fourni seulement quand l'espace sait archiver (le
  // service) : en local, la liste garde son bouton de suppression. Le chemin de
  // l'archive n'est jamais transmis — le parent ne le connaît pas non plus.
  onArchive?: (id: string) => void;
  archived?: ConversationSummary[];
  onRestoreArchived?: (id: string) => void;
  onDeleteArchived?: (id: string) => void;
  /** axe:0.1.71 — ouvre une session d'arrière-plan (journal, comme la vue Agents). */
  onOpenBackground?: (id: string, title: string) => void;
};

// Renders only the body of the conversations list. The parent owns the
// `sidebar__section` shell and the head (now shared with the Git tab),
// so this component focuses on the actual list of rows.
export function ConversationList({
  conversations,
  activeId,
  streamingIds,
  onSelect,
  onRename,
  onDelete,
  onArchive,
  archived,
  onRestoreArchived,
  onDeleteArchived,
  onOpenBackground,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const editRef = useRef<HTMLSpanElement | null>(null);

  const commitRename = (id: string) => {
    const value = editRef.current?.textContent?.trim() ?? "";
    setEditingId(null);
    if (value) {
      onRename(id, value);
    }
  };

  const archivedCount = archived?.length ?? 0;

  return (
    <div className="sidebar__body">
      <div className="conv-list">
        {conversations.length === 0 && (
          <div className="conv-empty">Aucune conversation pour le moment.</div>
        )}
        {conversations.map((conv) => {
          const isEditing = editingId === conv.id;
          const isActive = activeId === conv.id;
          const isStreaming = streamingIds.has(conv.id);
          return (
            <div
              key={conv.id}
              className="conv-row"
              data-active={isActive ? "true" : "false"}
              data-streaming={isStreaming ? "true" : "false"}
              onClick={() => !isEditing && onSelect(conv.id)}
            >
              <span className="conv-row__icon">
                {isStreaming ? (
                  <span className="conv-row__spinner" aria-label="Réponse en cours" />
                ) : (
                  <Icon
                    icon={
                      isActive
                        ? "solar:chat-round-dots-bold"
                        : "solar:chat-round-dots-linear"
                    }
                    width={15}
                    height={15}
                  />
                )}
              </span>
              <span
                ref={isEditing ? editRef : undefined}
                className="conv-row__title"
                contentEditable={isEditing}
                suppressContentEditableWarning
                onKeyDown={(event) => {
                  if (!isEditing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename(conv.id);
                  } else if (event.key === "Escape") {
                    setEditingId(null);
                  }
                }}
                onBlur={() => {
                  if (isEditing) commitRename(conv.id);
                }}
              >
                {titreAffiche(conv.title)}
              </span>
              {conv.arrierePlan?.length ? (
                <button
                  type="button"
                  className="conv-row__bg"
                  data-en-cours={conv.arrierePlan.some((b) => b.enCours) ? "true" : "false"}
                  title={`Travail en arrière-plan : ${conv.arrierePlan.map((b) => b.title).join(", ")} (ouvrir)`}
                  aria-label="Ouvrir le travail en arrière-plan"
                  onClick={(event) => {
                    event.stopPropagation();
                    const b = conv.arrierePlan![0];
                    onOpenBackground?.(b.id, b.title);
                  }}
                >
                  <Icon icon="solar:layers-minimalistic-linear" width={12} height={12} />
                  {conv.arrierePlan.length > 1 ? <span>{conv.arrierePlan.length}</span> : null}
                </button>
              ) : null}
              <span className="conv-row__actions">
                <button
                  className="conv-row__btn"
                  title="Renommer"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingId(conv.id);
                    queueMicrotask(() => {
                      const node = editRef.current;
                      if (node) {
                        node.focus();
                        const sel = window.getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(node);
                        sel?.removeAllRanges();
                        sel?.addRange(range);
                      }
                    });
                  }}
                >
                  <Icon icon="solar:pen-linear" width={13} height={13} />
                </button>
                {onArchive ? (
                  <button
                    className="conv-row__btn"
                    title="Archiver"
                    onClick={(event) => {
                      event.stopPropagation();
                      onArchive(conv.id);
                    }}
                  >
                    <Icon icon="solar:archive-linear" width={13} height={13} />
                  </button>
                ) : (
                  <button
                    className="conv-row__btn conv-row__btn--danger"
                    title="Supprimer"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (confirm("Supprimer cette conversation ?")) {
                        onDelete(conv.id);
                      }
                    }}
                  >
                    <Icon
                      icon="solar:trash-bin-minimalistic-linear"
                      width={13}
                      height={13}
                    />
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {archived && archivedCount > 0 ? (
          <div className="conv-archive">
            <button
              className="conv-archive__head"
              aria-expanded={archivesOpen}
              onClick={() => setArchivesOpen((open) => !open)}
            >
              <Icon
                icon={
                  archivesOpen
                    ? "solar:alt-arrow-down-linear"
                    : "solar:alt-arrow-right-linear"
                }
                width={13}
                height={13}
              />
              <span>Archives ({archivedCount})</span>
            </button>
            {archivesOpen
              ? archived.map((conv) => (
                  <div key={conv.id} className="conv-row conv-row--archived">
                    <span className="conv-row__icon">
                      <Icon icon="solar:archive-linear" width={15} height={15} />
                    </span>
                    <span className="conv-row__title">
                      {titreAffiche(conv.title)}
                    </span>
                    <span className="conv-row__actions">
                      {onRestoreArchived ? (
                        <button
                          className="conv-row__btn"
                          title="Rétablir"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRestoreArchived(conv.id);
                          }}
                        >
                          <Icon
                            icon="solar:refresh-linear"
                            width={13}
                            height={13}
                          />
                        </button>
                      ) : null}
                      {onDeleteArchived ? (
                        <button
                          className="conv-row__btn conv-row__btn--danger"
                          title="Supprimer définitivement"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (
                              confirm(
                                "Supprimer définitivement cette conversation archivée ?",
                              )
                            ) {
                              onDeleteArchived(conv.id);
                            }
                          }}
                        >
                          <Icon
                            icon="solar:trash-bin-minimalistic-linear"
                            width={13}
                            height={13}
                          />
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
