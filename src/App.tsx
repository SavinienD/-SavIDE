import { useCallback, useEffect, useState } from "react";
import { Welcome } from "./components/Welcome";
import { Workspace } from "./components/Workspace";
import { UpdateBadge } from "./components/UpdateBadge";
import { recordRecent, deriveName } from "./lib/recents";
import { api } from "./lib/ipc";
import { freechatApi } from "./components/freechat/freechatApi"; // axe:freechat
import { CloudLogin } from "./components/cloud/CloudLogin"; // axe:cloud
import { CloudLoginButton } from "./components/cloud/CloudLoginButton"; // axe:connexion-google
import { isWindowsPlatform } from "./components/WindowControls"; // axe:accueil-compte
import { ConnectedScreen } from "./components/cloud/ConnectedScreen"; // axe:v2-l1
import { CLOUD_CONNECTION, cloudApi, saveMode, type CloudState } from "./components/cloud/cloudApi"; // axe:cloud
import { LOCAL_CONNECTION, connectionsApi } from "./components/settings/connectionsApi"; // axe:v2-l2.3
import "./components/cloud/cloud.css"; // axe:cloud
import "./components/cloud/connected-screen.css"; // axe:v2-l1
import { EDITION_LOCALE } from "./lib/edition";
import type { WorkspaceBootstrap } from "./types";

type AppState =
  | { kind: "boot" }
  // axe:cloud — cloud mode (default): sign-in screen, then the cloud shell.
  | { kind: "cloud_login"; notice: string | null }
  | { kind: "cloud"; cloud: CloudState }
  | { kind: "welcome" }
  // axe:freechat — `chat` is the free conversation view (no project folder).
  | { kind: "workspace"; bootstrap: WorkspaceBootstrap; layout: "ide" | "chat" };


export default function App() {
  const [state, setState] = useState<AppState>({ kind: "boot" });
  const [bootError, setBootError] = useState<string | null>(null);

  const openWorkspace = useCallback(async (path: string, conversationId?: string) => {
    setBootError(null);
    // axe:v2-e12d — un dossier du poste se travaille dans l'espace local :
    // une connexion cloud restee active ne doit pas s'inviter dans l'interface.
    await connectionsApi.setActive(LOCAL_CONNECTION).catch(() => undefined);
    try {
      let bootstrap = await api.openWorkspace(path);
      // axe:freechat — land on a given conversation (free conversation
      // opened in a folder, project conversation picked in the sidebar).
      if (conversationId && bootstrap.activeConversation.id !== conversationId) {
        try {
          const conversation = await api.loadConversation(bootstrap.workspace.path, conversationId);
          bootstrap = { ...bootstrap, activeConversation: conversation };
        } catch {
          // keep the default conversation
        }
      }
      recordRecent(bootstrap.workspace.path, bootstrap.workspace.name);
      setState({ kind: "workspace", bootstrap, layout: "ide" });
    } catch (err) {
      setBootError(String(err));
    }
  }, []);

  // axe:freechat — free conversation view.
  const openFreeChat = useCallback(
    async (options: { conversationId?: string; fresh?: boolean }) => {
      setBootError(null);
      await connectionsApi.setActive(LOCAL_CONNECTION).catch(() => undefined);
      try {
        const bootstrap = await freechatApi.open(options);
        setState({ kind: "workspace", bootstrap, layout: "chat" });
      } catch (err) {
        setBootError(String(err));
      }
    },
    [],
  );

  // Démarrage : directement l'accueil. Les mises à jour ne sont plus forcées
  // (demande de Savinien, 23/10) : <UpdateBadge /> affiche « Mise à jour X
  // disponible » en haut à droite et n'installe que sur clic.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 2. Accueil. axe:v2-e12d — l'application s'ouvre toujours sur
      //    l'interface classique du poste (dossiers recents, conversations
      //    libres, ouvrir un dossier). L'espace Axe Cloud n'est plus l'ecran
      //    d'arrivee : il reste a un clic (« Revenir a Axe Cloud »), et une
      //    session cloud ouverte n'est jamais imposee au demarrage.
      if (cancelled) return;
      setState({ kind: "welcome" });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const backToWelcome = useCallback(() => {
    void api.resetWindowTitle().catch(() => {
      // best-effort; leaving the previous title is harmless
    });
    setState({ kind: "welcome" });
  }, []);

  // axe:cloud — session changes coming from Rust (401 = expired/revoked).
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void cloudApi
      .onState((cloud) => {
        setState((current) => {
          // axe:v2-l2.3 — session cloud perdue pendant qu'on travaillait sur l'espace cloud.
          if (
            current.kind === "workspace" &&
            current.bootstrap.workspace.path.startsWith("axe-cloud://") &&
            !cloud.connected
          ) {
            return {
              kind: "cloud_login",
              notice: cloud.expired
                ? "Votre session a expiré ou a été fermée. Reconnectez-vous."
                : null,
            };
          }
          if (current.kind === "cloud" && !cloud.connected) {
            return {
              kind: "cloud_login",
              notice: cloud.expired ? "Votre session a expiré ou a été fermée. Reconnectez-vous." : null,
            };
          }
          if (current.kind === "cloud" && cloud.connected) return { kind: "cloud", cloud };
          return current;
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else off = fn;
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const enterLocalMode = useCallback(() => {
    saveMode("local");
    setState({ kind: "welcome" });
  }, []);

  // axe:v2-e12d — depuis l'accueil classique, « Revenir a Axe Cloud » ouvre
  // directement l'IDE sur l'espace quand la session est deja ouverte (comme au
  // demarrage en L2.3) ; sinon on passe par l'ecran de connexion.
  const enterCloudMode = useCallback(async () => {
    saveMode("cloud");
    setBootError(null);
    try {
      const cloud = await cloudApi.state();
      if (!cloud.connected) {
        setState({ kind: "cloud_login", notice: null });
        return;
      }
      try {
        await connectionsApi.setActive(CLOUD_CONNECTION);
      } catch {
        // non bloquant : la connexion cloud s'enregistre elle-meme
      }
      const bootstrap = await api.openCloudWorkspace(CLOUD_CONNECTION);
      setState({ kind: "workspace", bootstrap, layout: "ide" });
    } catch (err) {
      setBootError("Retour à Axe Cloud : " + String(err)); // axe:retour-cloud
      try {
        const cloud = await cloudApi.state();
        setState(cloud.connected ? { kind: "cloud", cloud } : { kind: "cloud_login", notice: null });
      } catch {
        setState({ kind: "cloud_login", notice: null });
      }
    }
  }, []);

  // axe:accueil-3-choix - un seul espace : ouvre l'IDE sur l'espace cloud (pas d'ecran separe).
  const openCloudFolder = async (folder: string) => {
    setBootError(null);
    try {
      try { await connectionsApi.setActive(CLOUD_CONNECTION); } catch { /* non bloquant */ }
      const bootstrap = await api.openCloudWorkspace(CLOUD_CONNECTION, folder || undefined);
      setState({ kind: "workspace", bootstrap, layout: "ide" });
    } catch (err) {
      setBootError("Ouverture du dossier cloud : " + String(err));
    }
  };

  if (state.kind === "cloud_login") {
    return (
      <CloudLogin
        notice={state.notice}
        onConnected={(cloud) => setState({ kind: "cloud", cloud })}
      />
    );
  }

  if (state.kind === "cloud") {
    return (
      <ConnectedScreen
        cloud={state.cloud}
        onOpenPrime={() => cloudApi.openWeb("/prime/").then(() => undefined)}
        onEnterWorkspace={enterCloudMode}
        onLogout={async () => { await cloudApi.logout(); setState({ kind: "cloud_login", notice: null }); }}
      />
    );
  }

  if (state.kind === "boot") {
    // Minimal splash while the updater check resolves. Pure canvas — the
    // real updater UI (or Welcome) takes over within a few hundred ms on
    // a healthy network, ~4s worst case before the timeout fires.
    return <div className="app-boot" aria-hidden="true" />;
  }

  if (state.kind === "welcome") {
    return (
      <>
        <Welcome
          onPick={openWorkspace}
          onFreeChat={(options) => void openFreeChat(options)}
          onCloudFolder={EDITION_LOCALE ? undefined : (folder) => void openCloudFolder(folder)}
          error={bootError}
          deriveName={deriveName}
        />
        {/* axe:cloud — way back to the cloud mode from the local home screen. */}
        {/* axe:un-seul-espace - plus de « Revenir a Axe Cloud » : un seul espace, sur la VM. */}
        {/* axe:accueil-compte - sous Windows, à gauche des boutons Réduire/Agrandir/Fermer (138 px) : il était posé dessus. */}
        {/* Mise à jour disponible : badge discret en haut à droite (rien si MAJ_AUTO est coupé). */}
        <div className="welcome__maj" style={{ position: "fixed", top: EDITION_LOCALE ? 12 : 52, right: isWindowsPlatform() ? 150 : 16, zIndex: 50 }}>
          <UpdateBadge />
        </div>
        {EDITION_LOCALE ? null : (
          <>
            <CloudLoginButton className="axc-btn" style={{ position: "fixed", top: 12, right: isWindowsPlatform() ? 150 : 16, zIndex: 50 }} />
            <a className="axc-back-cloud" href="https://cloud.exemple.invalid" target="_blank" rel="noreferrer">
              cloud.exemple.invalid
            </a>
          </>
        )}
      </>
    );
  }

  return (
    <>
      <Workspace
        key={state.layout}
        bootstrap={state.bootstrap}
        layout={state.layout}
        onSwitchWorkspace={backToWelcome}
        onOpenFolder={(path, conversationId) => void openWorkspace(path, conversationId)}
        onOpenFreeChat={(conversationId) => void openFreeChat({ conversationId })}
        onBootstrapReplace={(b) =>
          setState((current) => ({
            kind: "workspace",
            bootstrap: b,
            layout: current.kind === "workspace" ? current.layout : "ide",
          }))
        }
      />
    </>
  );
}
