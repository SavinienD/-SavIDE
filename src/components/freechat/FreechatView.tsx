// axe:freechat — full-screen free conversation view (ChatGPT style): every
// conversation in a sidebar (free ones first, then per project, search),
// a wide centered chat (the regular ChatPane), no editor / tree / terminal.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "@iconify/react";
import type { ConversationSummary, SavedConversation } from "../../types";
import { ConversationList } from "../ConversationList";
import { NouvelleConversation } from "../NouvelleConversation"; // axe:e13
import { AxeLogo } from "../../axe/Logo";
import { QuotaIndicator } from "../../axe/QuotaIndicator";
import { UpdateBadge } from "../UpdateBadge";
import { WindowControls, isWindowsPlatform } from "../WindowControls";
import {
  conversationTitle,
  displayPath,
  folderName,
  freechatApi,
  samePath,
  type FreechatRow,
} from "./freechatApi";
import "./freechat.css";

type Props = {
  /** IDE workspace of free conversations (the scratch root). */
  scratchRoot: string;
  conversations: ConversationSummary[];
  activeConversation: SavedConversation;
  streamingIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  // axe:e13 — la creation demande le nom (recherche dans les archives).
  onCreate: (title: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Back to the home screen. */
  onHome: () => void;
  /** Opens a project folder in the IDE view, optionally on a conversation. */
  onOpenFolder: (path: string, conversationId?: string) => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  settingsView: ReactNode;
  /** The ChatPane of the active conversation. */
  chat: ReactNode;
};

const SIDEBAR_WIDTH = 280;
// axe:savide-accueil — la barre d'actions est un conteneur (container: inline-size,
// overflow: hidden) : sans bord droit sa largeur valait 0 et Accueil / Ouvrir un dossier /
// Réglages étaient rognés, donc invisibles. Bord droit = quota + boutons de fenêtre.
const BORD_DROIT_BARRE = isWindowsPlatform() ? 260 : 120;
const GROUP_PREVIEW = 5;
const IS_WINDOWS = isWindowsPlatform();

type ProjectGroup = { path: string; rows: FreechatRow[] };

export function FreechatView(props: Props) {
  const { scratchRoot, conversations, activeConversation, streamingIds } = props;
  const [query, setQuery] = useState("");
  const [projectRows, setProjectRows] = useState<FreechatRow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  // Project conversations come from the index (refreshed with the list).
  useEffect(() => {
    let cancelled = false;
    freechatApi
      .index()
      .then((index) => {
        if (cancelled) return;
        setProjectRows(
          index.conversations.filter(
            (row) => row.messageCount > 0 && !samePath(row.workspaceId, scratchRoot),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scratchRoot, conversations]);

  const needle = query.trim().toLowerCase();
  const matches = (title: string) =>
    !needle || conversationTitle(title).toLowerCase().includes(needle);

  const freeList = useMemo(
    () =>
      conversations
        .filter((c) => matches(c.title))
        .map((c) => ({ ...c, title: conversationTitle(c.title) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations, needle],
  );

  const groups = useMemo(() => {
    const byPath = new Map<string, ProjectGroup>();
    for (const row of projectRows) {
      if (!matches(row.title)) continue;
      const group = byPath.get(row.workspaceId) ?? { path: row.workspaceId, rows: [] };
      group.rows.push(row);
      byPath.set(row.workspaceId, group);
    }
    return [...byPath.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRows, needle]);

  const streaming = streamingIds.has(activeConversation.id);

  const [creating, setCreating] = useState(false);

  const createConversation = () => {
    setError(null);
    // An empty conversation is already a new one.
    if (activeConversation.history.length === 0) return;
    setCreating(true);
  };

  const openFolderForConversation = async () => {
    setError(null);
    if (streaming) {
      setError("Une réponse est en cours : arrêtez-la avant d'ouvrir un dossier.");
      return;
    }
    let selected: string | string[] | null = null;
    try {
      selected = await open({ directory: true, multiple: false });
    } catch {
      return;
    }
    if (typeof selected !== "string") return;
    try {
      await freechatApi.relocate(activeConversation.id, selected);
      props.onOpenFolder(selected, activeConversation.id);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="workspace axe-freechat">
      <div className="titlebar" data-tauri-drag-region data-platform={IS_WINDOWS ? "windows" : undefined}>
        <div className="titlebar__actions" data-tauri-drag-region style={{ left: SIDEBAR_WIDTH + 12, right: BORD_DROIT_BARRE }}>
          <button className="titlebar__btn" data-action="accueil" onClick={props.onHome} title="Revenir à l'accueil">
            <Icon icon="solar:home-2-linear" width={12} height={12} />
            <span className="titlebar__btn-label">Accueil</span>
          </button>
          <button
            className="titlebar__btn"
            onClick={() => void openFolderForConversation()}
            title="Continuer cette conversation dans un dossier de projet (éditeur, fichiers, terminal)"
          >
            <Icon icon="solar:folder-open-linear" width={12} height={12} />
            <span className="titlebar__btn-label">Ouvrir un dossier</span>
          </button>
          <button
            className="titlebar__btn"
            data-on={props.settingsOpen ? "true" : "false"}
            onClick={props.settingsOpen ? props.onCloseSettings : props.onOpenSettings}
            title="Réglages (Ctrl+,)"
          >
            <Icon icon="solar:settings-linear" width={12} height={12} />
            <span className="titlebar__btn-label">Réglages</span>
          </button>
        </div>
        <div className="titlebar__brand" data-tauri-drag-region>
          <span className="titlebar__brand-mark">
            <AxeLogo variant="wordmark" size={11} />
          </span>
          <span className="titlebar__brand-name">SavIDE</span>
        </div>
        <QuotaIndicator />
        <UpdateBadge />
        <WindowControls />
      </div>

      <div className="axe-freechat__main">
        <aside className="axe-freechat__sidebar" style={{ width: SIDEBAR_WIDTH, flex: `0 0 ${SIDEBAR_WIDTH}px` }}>
          <button type="button" className="axe-freechat__new" onClick={createConversation}>
            <Icon icon="solar:pen-new-square-linear" width={15} height={15} />
            Nouvelle conversation
          </button>
          {creating ? (
            <NouvelleConversation
              onCancel={() => setCreating(false)}
              onCreate={(titre) => {
                setCreating(false);
                props.onCreate(titre);
              }}
            />
          ) : null}
          <label className="axe-freechat__search">
            <Icon icon="solar:magnifer-linear" width={13} height={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Rechercher une conversation"
              spellCheck={false}
            />
          </label>
          <div className="axe-freechat__groups">
            <div className="axe-freechat__group-head">
              <Icon icon="solar:chat-round-line-linear" width={13} height={13} />
              <span>Conversations libres</span>
            </div>
            {freeList.length === 0 ? (
              <div className="conv-empty">
                {needle ? "Aucun résultat." : "Aucune conversation libre."}
              </div>
            ) : (
              <ConversationList
                conversations={freeList}
                activeId={activeConversation.id}
                streamingIds={streamingIds}
                onSelect={props.onSelect}
                onRename={props.onRename}
                onDelete={props.onDelete}
              />
            )}
            {groups.map((group) => {
              const open = expanded.has(group.path) || !!needle;
              const rows = open ? group.rows : group.rows.slice(0, GROUP_PREVIEW);
              return (
                <div key={group.path} className="axe-freechat__group">
                  <button
                    type="button"
                    className="axe-freechat__group-head axe-freechat__group-head--project"
                    title={`Ouvrir ${displayPath(group.path)}`}
                    onClick={() => props.onOpenFolder(group.path)}
                  >
                    <Icon icon="solar:folder-linear" width={13} height={13} />
                    <span>{folderName(group.path)}</span>
                  </button>
                  {rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="axe-freechat__row"
                      title="Ouvrir dans le dossier"
                      onClick={() => props.onOpenFolder(row.workspaceId, row.id)}
                    >
                      {conversationTitle(row.title)}
                    </button>
                  ))}
                  {!open && group.rows.length > GROUP_PREVIEW && (
                    <button
                      type="button"
                      className="axe-freechat__more"
                      onClick={() => setExpanded((prev) => new Set(prev).add(group.path))}
                    >
                      + {group.rows.length - GROUP_PREVIEW} autres
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <section className="axe-freechat__center">
          {error && (
            <div className="axe-freechat__error" onClick={() => setError(null)} title="Fermer">
              {error}
            </div>
          )}
          <div className="axe-freechat__chat">{props.chat}</div>
          {props.settingsOpen && (
            <div className="axe-freechat__settings">
              <div className="axe-freechat__settings-head">
                <span>Paramètres</span>
                <button type="button" className="titlebar__btn" onClick={props.onCloseSettings}>
                  <Icon icon="solar:close-circle-linear" width={12} height={12} />
                  Fermer
                </button>
              </div>
              <div className="axe-freechat__settings-body">{props.settingsView}</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
