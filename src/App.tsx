import { useCallback, useEffect, useState } from "react";
import { Welcome } from "./components/Welcome";
import { Workspace } from "./components/Workspace";
import { UpdaterLockScreen } from "./components/UpdaterLockScreen";
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
import { EDITION_LOCALE, MAJ_AUTO } from "./lib/edition";
import type { UpdateInfo, WorkspaceBootstrap } from "./types";

type AppState =
  | { kind: "boot" }
  | { kind: "update_required"; info: UpdateInfo; autoInstall: boolean }
  // axe:cloud — cloud mode (default): sign-in screen, then the cloud shell.
  | { kind: "cloud_login"; notice: string | null }
  | { kind: "cloud"; cloud: CloudState }
  | { kind: "welcome" }
  // axe:freechat — `chat` is the free conversation view (no project folder).
  | { kind: "workspace"; bootstrap: WorkspaceBootstrap; layout: "ide" | "chat" };


/// Maximum time we wait on the boot updater check before falling through to
/// the normal flow. Keeps the app responsive on flaky networks — if the
/// update endpoint is unreachable we don't trap the user on a black canvas.
const BOOT_CHECK_TIMEOUT_MS = 4000;

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

  // Boot sequence, in order:
  //   1. Updater gate — race the check against a short timeout. If an
  //      update is available we render <UpdaterLockScreen /> and stop;
  //      the user can only install or quit (no "Later", no "Skip").
  //   2. Home screen (axe:freechat): the last folder is no longer reopened
  //      automatically; the user picks a free conversation or a folder.
  // The whole thing runs once at mount; the in-session <UpdateBadge />
  // still handles mid-session checks via its own 30 min interval.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1. Updater gate (coupée dans l'édition locale).
      if (MAJ_AUTO) try {
        const info = await Promise.race<UpdateInfo | null>([
          api.checkForUpdate(),
          new Promise<null>((resolve) =>
            window.setTimeout(() => resolve(null), BOOT_CHECK_TIMEOUT_MS),
          ),
        ]);
        if (cancelled) return;
        if (info && info.available && info.version) {
          // Au démarrage rien ne tourne encore : installation automatique.
          setState({ kind: "update_required", info, autoInstall: true });
          return;
        }
      } catch {
        // Silent: a failed check (offline, server down, manifest 5xx)
        // shouldn't prevent the app from booting. The mid-session badge
        // will retry later, and the next launch will re-gate cleanly.
      }

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

  // Mid-session escalation: when the <UpdateBadge /> in Workspace fires
  // "axecode:install-update" (user clicked "Install & restart" in the
  // popover), we swap the whole window to the lock screen with
  // `autoInstall` enabled. From there the screen runs the same download
  // → install → auto-restart flow as the boot gate. This means the
  // policy is identical regardless of entry point: once the user
  // commits to installing, SavIDE becomes uninteractive until the update
  // is applied or they quit.
  useEffect(() => {
    const handler = (event: WindowEventMap["axecode:install-update"]) => {
      const info = event.detail?.info;
      if (!info || !info.available || !info.version) return;
      setState({ kind: "update_required", info, autoInstall: true });
    };
    window.addEventListener("axecode:install-update", handler);
    return () => window.removeEventListener("axecode:install-update", handler);
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

  if (state.kind === "update_required") {
    return (
      <UpdaterLockScreen info={state.info} autoInstall={state.autoInstall} />
    );
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
