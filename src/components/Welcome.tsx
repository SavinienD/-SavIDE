// axe:freechat — home screen: « Nouvelle conversation » or « Ouvrir un
// dossier », plus recent free conversations and recent folders.
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import { loadRecents } from "../lib/recents";
import { api, cloudRpc } from "../lib/ipc";
import { CloudLoginButton, useCloudState } from "./cloud/CloudLoginButton";
import { CLOUD_CONNECTION } from "./cloud/cloudApi";
import type {
  ActiveTurnSummary,
  ActiveTurnsChangedPayload,
  RecentWorkspace,
} from "../types";
import { AxeLogo } from "../axe/Logo";
import { WindowControls, isWindowsPlatform } from "./WindowControls";
import {
  conversationTitle,
  displayPath,
  freechatApi,
  relativeTime,
  samePath,
  type FreechatRow,
} from "./freechat/freechatApi";
import "./freechat/freechat.css";

type Props = {
  /** Opens a project folder in the IDE view. */
  onPick: (path: string) => void;
  /** Opens the free conversation view (new or existing conversation). */
  onFreeChat: (options: { conversationId?: string; fresh?: boolean }) => void;
  /** axe:accueil-3-choix - ouvre l'IDE sur un dossier de l'espace cloud partage. */
  onCloudFolder?: (folder: string) => void;
  error: string | null;
  deriveName: (path: string) => string;
};

const MAX_VISIBLE_RECENTS = 5;
const IS_WINDOWS = isWindowsPlatform();

/// Workspaces and conversations with an in-flight agent turn (reported
/// globally, across every window).
function activeSets(turns: ActiveTurnSummary[]) {
  return {
    workspaces: new Set(turns.map((turn) => turn.workspaceId)),
    conversations: new Set(turns.map((turn) => turn.conversationId)),
  };
}

export function Welcome({ onPick, onFreeChat, onCloudFolder, error, deriveName }: Props) {
  // axe:accueil-3-choix - dossiers a la racine de l'espace cloud partage (fs.list).
  const cloud = useCloudState();
  const [cloudDirs, setCloudDirs] = useState<string[] | null>(null);
  const [cloudErr, setCloudErr] = useState<string | null>(null);
  useEffect(() => {
    if (!cloud?.connected) { setCloudDirs(null); return; }
    let annule = false;
    cloudRpc<{ name: string; kind: string }[]>(cloud.connectionId || CLOUD_CONNECTION, "fs.list", { path: "" })
      .then((l) => { if (!annule) setCloudDirs((l ?? []).filter((e) => e.kind === "directory" && !e.name.startsWith(".")).map((e) => e.name)); })
      .catch((e) => { if (!annule) setCloudErr(String(e)); });
    return () => { annule = true; };
  }, [cloud?.connected, cloud?.connectionId]);
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [chats, setChats] = useState<FreechatRow[]>([]);
  const [picking, setPicking] = useState(false);
  const [active, setActive] = useState(() => activeSets([]));

  useEffect(() => {
    setRecents(loadRecents());
    let cancelled = false;
    freechatApi
      .index()
      .then((index) => {
        if (cancelled) return;
        setChats(
          index.conversations.filter(
            (row) => row.messageCount > 0 && samePath(row.workspaceId, index.scratchRoot),
          ),
        );
      })
      .catch(() => {
        // Non-fatal: the list simply stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Running agent turns: seeded from `list_active_turns`, then kept in sync
  // with the `active-turns-changed` event.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void api
      .listActiveTurns()
      .then((turns) => {
        if (!cancelled) setActive(activeSets(turns));
      })
      .catch(() => {});
    (async () => {
      const u = await listen<ActiveTurnsChangedPayload>("active-turns-changed", (event) => {
        setActive(activeSets(event.payload.activeTurns));
      });
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const pickFolder = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") onPick(selected);
    } catch {
      // user cancelled or platform error
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="welcome">
      {IS_WINDOWS && (
        <div className="welcome__titlebar" data-tauri-drag-region>
          <WindowControls />
        </div>
      )}
      <main className="welcome__stage axe-home">
        <header className="welcome__head">
          <span className="welcome__mark-dot" aria-hidden="true">
            <span className="welcome__mark-inner">
              <AxeLogo variant="mark" size={26} className="welcome__mark-glyph" />
            </span>
          </span>
          <h1 className="welcome__title">
            SavIDE<span className="welcome__title-dot">.</span>
          </h1>
          <p className="welcome__tag">Discutez librement, ou ouvrez un dossier pour travailler dans vos fichiers.</p>
        </header>

        <div className="axe-home__ctas">
          <button className="welcome__cta" onClick={pickFolder} disabled={picking}>
            <span className="welcome__cta-icon">
              <Icon icon="solar:folder-with-files-bold-duotone" width={22} height={22} />
            </span>
            <span className="welcome__cta-body">
              <span className="welcome__cta-title">Dossier local</span>
              <span className="welcome__cta-sub">
                {picking ? "Ouverture…" : "Éditeur, fichiers, terminal et agent"}
              </span>
            </span>
            <span className="welcome__cta-chev">
              <Icon icon="solar:alt-arrow-right-linear" width={16} height={16} />
            </span>
          </button>
          {onCloudFolder ? (<div className="welcome__cta" style={{ flexDirection: "column", alignItems: "stretch", cursor: "default" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="welcome__cta-icon"><Icon icon="solar:cloud-bold-duotone" width={22} height={22} /></span>
              <span className="welcome__cta-body">
                <span className="welcome__cta-title">Dossier du cloud partagé</span>
                <span className="welcome__cta-sub">{cloud?.connected ? "Ouvre l'IDE sur l'espace partagé de la VM" : "Connectez-vous pour voir l'espace partagé"}</span>
              </span>
            </span>
            {!cloud?.connected ? (
              <CloudLoginButton className="axc-btn" />
            ) : cloudErr ? (
              <span className="welcome__cta-sub">Liste impossible : {cloudErr}</span>
            ) : cloudDirs === null ? (
              <span className="welcome__cta-sub">Chargement…</span>
            ) : (
              <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                <button className="axc-btn" onClick={() => onCloudFolder?.("")}>Racine de l'espace</button>
                {cloudDirs.map((d) => (
                  <button key={d} className="axc-btn" onClick={() => onCloudFolder?.(d)}>{d}</button>
                ))}
              </span>
            )}
          </div>) : null}
          <button className="welcome__cta" onClick={() => onFreeChat({ fresh: true })}>
            <span className="welcome__cta-icon axe-home__cta-icon--accent">
              <Icon icon="solar:chat-round-line-bold-duotone" width={22} height={22} />
            </span>
            <span className="welcome__cta-body">
              <span className="welcome__cta-title">Conversation sans dossier</span>
              <span className="welcome__cta-sub">Discuter sans dossier, comme sur ChatGPT</span>
            </span>
            <span className="welcome__cta-chev">
              <Icon icon="solar:alt-arrow-right-linear" width={16} height={16} />
            </span>
          </button>
        </div>

        {error && <div className="welcome__error">{error}</div>}

        <div className="axe-home__lists">
          <section className="welcome__section">
            <h2 className="welcome__section-heading">Conversations récentes</h2>
            {chats.length > 0 ? (
              <div className="welcome__recents">
                {chats.slice(0, MAX_VISIBLE_RECENTS).map((chat) => {
                  const isActive = active.conversations.has(chat.id);
                  return (
                    <button
                      key={chat.id}
                      className="welcome__recent"
                      data-active={isActive ? "true" : "false"}
                      onClick={() => onFreeChat({ conversationId: chat.id })}
                    >
                      <span className="welcome__recent-icon">
                        {isActive ? (
                          <span className="welcome__recent-spinner" role="status" aria-label="Agent en cours" />
                        ) : (
                          <Icon icon="solar:chat-round-dots-linear" width={18} height={18} />
                        )}
                      </span>
                      <span className="welcome__recent-body">
                        <span className="welcome__recent-name">{conversationTitle(chat.title)}</span>
                        <span className="axe-home__meta">{relativeTime(chat.updatedAtMs)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="welcome__empty">Aucune conversation libre pour l'instant.</div>
            )}
          </section>

          <section className="welcome__section">
            <h2 className="welcome__section-heading">Dossiers récents</h2>
            {recents.length > 0 ? (
              <div className="welcome__recents">
                {recents.slice(0, MAX_VISIBLE_RECENTS).map((recent) => {
                  const isActive = [...active.workspaces].some((id) => samePath(id, recent.path));
                  return (
                    <button
                      key={recent.path}
                      className="welcome__recent"
                      data-active={isActive ? "true" : "false"}
                      onClick={() => onPick(recent.path)}
                    >
                      <span className="welcome__recent-icon">
                        {isActive ? (
                          <span className="welcome__recent-spinner" role="status" aria-label="Agent en cours" />
                        ) : (
                          <Icon icon="solar:folder-bold-duotone" width={18} height={18} />
                        )}
                      </span>
                      <span className="welcome__recent-body">
                        <span className="welcome__recent-name">
                          {recent.name || deriveName(recent.path)}
                        </span>
                        <span className="welcome__recent-path">{displayPath(recent.path)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="welcome__empty">Aucun dossier ouvert récemment.</div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
