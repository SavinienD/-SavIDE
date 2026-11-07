// freechat — home screen: « Nouvelle conversation » or « Ouvrir un
// dossier », plus recent free conversations and recent folders.
import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import { dossiersNumerotes, libererOrdre, removeRecent } from "../lib/recents";
import { api, cloudRpc } from "../lib/ipc";
import { CloudLoginButton, useCloudState } from "./cloud/CloudLoginButton";
import { CLOUD_CONNECTION } from "./cloud/cloudApi";
import type {
  ActiveTurnSummary,
  ActiveTurnsChangedPayload,
  RecentWorkspace,
} from "../types";
import { AxeLogo } from "../axe/Logo";
import { infoBulleNumero } from "../axe/raccourcis";
import { agentsApi } from "./agents/agentsApi";
import { dossierAuTravail, majSessionsEnCours, sessionsEnCours } from "../lib/toursActifs";
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
  /** accueil-3-choix - ouvre l'IDE sur un dossier de l'espace cloud partage. */
  onCloudFolder?: (folder: string) => void;
  error: string | null;
  /** Carte affichée sous les choix (ex. « Dossier introuvable »). */
  avis?: ReactNode;
  deriveName: (path: string) => string;
};

const IS_WINDOWS = isWindowsPlatform();

/// Workspaces and conversations with an in-flight agent turn (reported
/// globally, across every window).
function activeSets(turns: ActiveTurnSummary[]) {
  return {
    workspaces: new Set(turns.map((turn) => turn.workspaceId)),
    conversations: new Set(turns.map((turn) => turn.conversationId)),
  };
}

export function Welcome({ onPick, onFreeChat, onCloudFolder, error, avis, deriveName }: Props) {
  // accueil-3-choix - dossiers a la racine de l'espace cloud partage (fs.list).
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
  // dossier des conversations sans dossier (pour « Supprimer » = archiver, comme dans l'appli),
  // conversation dont la croix attend la confirmation, message d'échec.
  const [scratchRoot, setScratchRoot] = useState<string | null>(null);
  const [aConfirmer, setAConfirmer] = useState<string | null>(null);
  const [avisChats, setAvisChats] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [active, setActive] = useState(() => activeSets([]));
  // Sessions « running » du service local (sous-agents et tours relancés par le service
  // compris), lues au montage puis tenues à jour par ses événements « status ».
  const [service, setService] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    // Retour à l'accueil : l'ordre des numéros suit de nouveau l'historique (le plus récent d'abord) ;
    // même ordre que Ctrl+1…9 et la barre du haut.
    libererOrdre();
    setRecents(dossiersNumerotes());
    let cancelled = false;
    freechatApi
      .index()
      .then((index) => {
        if (cancelled) return;
        setScratchRoot(index.scratchRoot);
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

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    const relire = () => {
      void agentsApi
        .list("local")
        .then((sessions) => {
          if (!cancelled) setService(sessionsEnCours(sessions));
        })
        .catch(() => {});
    };
    relire();
    // Filet : un service relancé (nouvelle connexion) n'a pas rejoué les « status » manqués.
    const minuterie = window.setInterval(relire, 30_000);
    (async () => {
      const u = await agentsApi.onEvent((event) => {
        if (!event.connectionId && event.event === "daemon") {
          setService(new Map()); // service arrêté : plus rien ne tourne
          return;
        }
        setService((avant) => majSessionsEnCours(avant, event) ?? avant);
      });
      if (cancelled) u();
      else unlisten = u;
    })();
    return () => {
      cancelled = true;
      window.clearInterval(minuterie);
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

  // « Supprimer » une conversation sans dossier depuis l'accueil : même action que dans
  // l'appli (archiver dans le dossier des conversations libres) ; refusé pendant une réponse.
  const supprimerChat = async (id: string, enCours: boolean) => {
    if (enCours) {
      setAvisChats("Suppression impossible : la conversation travaille encore. Arrêtez-la puis réessayez.");
      return;
    }
    if (!scratchRoot) return;
    try {
      await api.archiveConversation(scratchRoot, id);
      setChats((liste) => liste.filter((c) => c.id !== id));
    } catch (err) {
      setAvisChats(`Suppression impossible : ${String(err)}`);
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

        {avis}
        {error && <div className="welcome__error">{error}</div>}

        <div className="axe-home__lists">
          <section className="welcome__section">
            <h2 className="welcome__section-heading">Conversations récentes</h2>
            {avisChats && <div className="welcome__error" role="status">{avisChats}</div>}
            {chats.length > 0 ? (
              <div className="welcome__recents" data-liste="conversations">
                {chats.map((chat) => {
                  const isActive = active.conversations.has(chat.id);
                  const titre = conversationTitle(chat.title);
                  const confirmer = aConfirmer === chat.id;
                  return (
                    <div key={chat.id} className="welcome__recent-item" data-confirm={confirmer ? "true" : undefined}>
                    <button
                      className="welcome__recent"
                      data-active={isActive ? "true" : "false"}
                      title={titre}
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
                        <span className="welcome__recent-name">{titre}</span>
                        <span className="axe-home__meta">{relativeTime(chat.updatedAtMs)}</span>
                      </span>
                    </button>
                    {/* croix « Supprimer » : 1er clic = « Supprimer ? », 2e clic = même action que
                        « Supprimer » dans l'appli (la conversation est archivée, restaurable depuis l'archive). */}
                    <button
                      type="button"
                      className="welcome__recent-retirer"
                      data-confirm={confirmer ? "true" : "false"}
                      title={confirmer ? "Cliquer encore pour supprimer (la conversation va dans l'archive)" : "Supprimer cette conversation"}
                      aria-label={confirmer ? `Confirmer la suppression de ${titre}` : `Supprimer ${titre}`}
                      onBlur={() => setAConfirmer((c) => (c === chat.id ? null : c))}
                      onKeyDown={(e) => { if (e.key === "Escape") setAConfirmer(null); }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!confirmer) { setAConfirmer(chat.id); setAvisChats(null); return; }
                        setAConfirmer(null);
                        void supprimerChat(chat.id, isActive);
                      }}
                    >
                      {confirmer ? <span>Supprimer ?</span> : <Icon icon="solar:close-circle-linear" width={16} height={16} />}
                    </button>
                    </div>
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
              <div className="welcome__recents" data-liste="dossiers">
                {recents.map((recent, i) => {
                  const isActive = dossierAuTravail(recent.path, active.workspaces, service);
                  const nom = recent.name || deriveName(recent.path);
                  // les 9 premiers : numéro de Ctrl+1…9 (⌘1…9) sur la carte et dans l'info-bulle.
                  const numero = i < 9 ? i + 1 : null;
                  return (
                    <div key={recent.path} className="welcome__recent-item">
                    <button
                      className="welcome__recent"
                      data-active={isActive ? "true" : "false"}
                      data-numero={numero ?? undefined}
                      title={numero ? infoBulleNumero(`Ouvrir ${nom}`, "dossierRecent", numero) : undefined}
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
                          {nom}
                        </span>
                        <span className="welcome__recent-path">{displayPath(recent.path)}</span>
                      </span>
                      {numero && (
                        <span className="welcome__recent-num" aria-hidden="true">
                          {numero}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="welcome__recent-retirer"
                      title="Retirer de la liste (le dossier n'est pas supprimé)"
                      aria-label={`Retirer ${nom} de la liste`}
                      onClick={(e) => { e.stopPropagation(); setRecents(removeRecent(recent.path)); }}
                    >
                      <Icon icon="solar:close-circle-linear" width={16} height={16} />
                    </button>
                    </div>
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
