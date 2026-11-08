import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Welcome } from "./components/Welcome";
import { Workspace } from "./components/Workspace";
import { useServiceNotifications } from "./components/notifications/useServiceNotifications";
import { UpdateBadge } from "./components/UpdateBadge";
import { noterOuverture, libererOrdre, deriveName, dossierRecentNumero, loadRecents, removeRecent } from "./lib/recents";
import { open as choisirDossier } from "@tauri-apps/plugin-dialog";
import { dependancesTauri, deplacerEtOuvrir, nomDe, noterDossiersRecents, ouvrirDossier, parentDe, type Dependances, type Ouverture } from "./lib/dossierDeplace";
import { DossierIntrouvable } from "./components/DossierIntrouvable";
import { ecouterOuvertureDossier } from "./components/pr/versAgent"; // panneau Git : « Travailler dessus » (issue)
import { ecouterRaccourcis, fournirActions, numeroTouche, versionRaccourcis } from "./axe/raccourcis";
import { samePath } from "./components/freechat/freechatApi";
import { demarrerRepriseAuto } from "./axe/reprise/surveillanceReprise"; // reprise après une limite d'abonnement
import { api } from "./lib/ipc";
import { freechatApi } from "./components/freechat/freechatApi"; // freechat
import { CloudLogin } from "./components/cloud/CloudLogin"; // cloud
import { CloudLoginButton } from "./components/cloud/CloudLoginButton"; // connexion-google
import { isWindowsPlatform } from "./components/WindowControls"; // accueil-compte
import { ConnectedScreen } from "./components/cloud/ConnectedScreen"; // v2-l1
import { CLOUD_CONNECTION, cloudApi, saveMode, type CloudState } from "./components/cloud/cloudApi"; // cloud
import { LOCAL_CONNECTION, connectionsApi } from "./components/settings/connectionsApi"; // v2-l2.3
import "./components/cloud/cloud.css"; // cloud
import "./components/cloud/connected-screen.css"; // v2-l1
import { EDITION_LOCALE } from "./lib/edition";
import type { WorkspaceBootstrap } from "./types";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  demarrerBattement,
  ecranARouvrir,
  estUnRechargement,
  journaliserErreurs,
  mesurer,
  noterEcran,
  type Ecran,
} from "./lib/gardienPage"; // écran noir, reprise après rechargement

/** Nom de la fenêtre (une reprise par fenêtre). */
function nomFenetre(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

type AppState =
  | { kind: "boot" }
  // cloud — cloud mode (default): sign-in screen, then the cloud shell.
  | { kind: "cloud_login"; notice: string | null }
  | { kind: "cloud"; cloud: CloudState }
  | { kind: "welcome" }
  // freechat — `chat` is the free conversation view (no project folder).
  | { kind: "workspace"; bootstrap: WorkspaceBootstrap; layout: "ide" | "chat" };


type CarteIntrouvable = { chemin: string; nom: string; conversationId?: string; recherche: boolean; erreur?: string | null };

/** Nom affiché d'un dossier : celui des récents, sinon le dernier segment du chemin. */
function nomDossier(chemin: string): string {
  return loadRecents().find((r) => r.path === chemin)?.name || nomDe(chemin);
}

export default function App() {
  const [state, setState] = useState<AppState>({ kind: "boot" });
  const [bootError, setBootError] = useState<string | null>(null);
  // Raccourci changé dans les Réglages : toute l'interface se redessine (info-bulles à jour).
  useSyncExternalStore(ecouterRaccourcis, versionRaccourcis);
  // Dossier qui n'est plus à son chemin : recherche en cours, puis carte « Dossier introuvable ».
  const [introuvable, setIntrouvable] = useState<CarteIntrouvable | null>(null);
  const [versionAccueil, setVersionAccueil] = useState(0);

  // Résultat d'une ouverture (dossier retrouvé ou choisi à la main compris).
  const appliquerOuverture = useCallback(async (r: Ouverture, chemin: string, conversationId?: string) => {
    if (r.kind === "introuvable") {
      void api.resetWindowTitle().catch(() => undefined);
      setIntrouvable({ chemin, nom: nomDossier(chemin), conversationId, recherche: false });
      setState({ kind: "welcome" });
      return;
    }
    if (r.kind === "erreur") {
      setIntrouvable((c) => (c && c.chemin === chemin ? { ...c, recherche: false, erreur: r.message } : c));
      setBootError(r.message);
      return;
    }
    let bootstrap = r.bootstrap;
    // freechat — land on a given conversation (free conversation
    // opened in a folder, project conversation picked in the sidebar).
    if (conversationId && bootstrap.activeConversation.id !== conversationId) {
      try {
        const conversation = await api.loadConversation(bootstrap.workspace.path, conversationId);
        bootstrap = { ...bootstrap, activeConversation: conversation };
      } catch {
        // keep the default conversation
      }
    }
    noterOuverture(bootstrap.workspace.path, bootstrap.workspace.name); // ordre des numéros figé jusqu'à l'accueil
    setIntrouvable(null);
    setState({ kind: "workspace", bootstrap, layout: "ide" });
  }, []);

  // Dépendances réelles ; la recherche affiche la carte « Recherche… » sur l'accueil.
  const dependances = useCallback(
    (conversationId?: string): Dependances => ({
      ouvrir: (chemin) => api.openWorkspace(chemin),
      deplacer: dependancesTauri.deplacer,
      retrouver: (chemin, racines) => {
        void api.resetWindowTitle().catch(() => undefined);
        setIntrouvable({ chemin, nom: nomDossier(chemin), conversationId, recherche: true });
        setState({ kind: "welcome" });
        return dependancesTauri.retrouver(chemin, racines);
      },
    }),
    [],
  );

  const openWorkspace = useCallback(async (path: string, conversationId?: string) => {
    setBootError(null);
    // v2-e12d — un dossier du poste se travaille dans l'espace local :
    // une connexion cloud restee active ne doit pas s'inviter dans l'interface.
    await connectionsApi.setActive(LOCAL_CONNECTION).catch(() => undefined);
    // Dossier renommé ou déplacé : retrouvé, chemin mis à jour partout, puis rouvert.
    const r = await ouvrirDossier(path, dependances(conversationId));
    await appliquerOuverture(r, path, conversationId);
  }, [appliquerOuverture, dependances]);

  // Panneau Git : une issue ouvre son worktree sur la conversation créée pour elle.
  useEffect(() => ecouterOuvertureDossier((dossier, conversationId) => void openWorkspace(dossier, conversationId)), [openWorkspace]);

  // Actions de la carte « Dossier introuvable ».
  const choisirNouvelEmplacement = useCallback(async () => {
    const carte = introuvable;
    if (!carte) return;
    let choisi: string | string[] | null = null;
    try {
      choisi = await choisirDossier({ directory: true, multiple: false, defaultPath: parentDe(carte.chemin) ?? undefined });
    } catch {
      return; // sélecteur fermé ou indisponible
    }
    if (typeof choisi !== "string") return;
    setIntrouvable({ ...carte, recherche: true, erreur: null });
    const r = await deplacerEtOuvrir(carte.chemin, choisi, dependances(carte.conversationId));
    await appliquerOuverture(r, carte.chemin, carte.conversationId);
  }, [introuvable, dependances, appliquerOuverture]);

  const retirerIntrouvable = useCallback(() => {
    if (introuvable) removeRecent(introuvable.chemin);
    setIntrouvable(null);
    setBootError(null);
    setVersionAccueil((v) => v + 1); // l'accueil relit ses dossiers récents
  }, [introuvable]);

  // Ctrl+1…9 (⌘1…9) : n-ième dossier récent de l'accueil, lu au moment
  // de l'appui, ouvert comme un clic sur sa carte (accueil, dossier ouvert, vue libre).
  // Le dossier déjà ouvert ne se rouvre pas ; un appui pendant une ouverture est ignoré.
  const stateRef = useRef(state);
  stateRef.current = state;
  const ouvertureNumeroRef = useRef(false);
  useEffect(
    () =>
      fournirActions({
        dossierRecent: (e) => {
          const n = numeroTouche(e);
          const cible = n ? dossierRecentNumero(n) : null;
          if (!cible || ouvertureNumeroRef.current) return;
          const s = stateRef.current;
          if (s.kind === "workspace" && s.layout === "ide" && samePath(s.bootstrap.workspace.path, cible.path)) return;
          ouvertureNumeroRef.current = true;
          void openWorkspace(cible.path).finally(() => {
            ouvertureNumeroRef.current = false;
          });
        },
      }),
    [openWorkspace],
  );

  // Ordre des dossiers numérotés : il se met à jour à chaque retour à l'accueil (l'accueil
  // le relit aussi en s'affichant : ses effets passent avant celui-ci).
  useEffect(() => {
    if (state.kind === "welcome") libererOrdre();
  }, [state.kind]);

  // Reprise automatique des conversations arrêtées par une limite d'abonnement.
  useEffect(() => demarrerRepriseAuto(), []);

  // freechat — free conversation view.
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
  // Fins de tour notifiées ; ouvreur de secours (depuis l'accueil).
  useServiceNotifications({ ouvrirDossier: (chemin, id) => void openWorkspace(chemin, id), ouvrirLibre: (id) => void openFreeChat({ conversationId: id }) });

  // Démarrage : directement l'accueil. Les mises à jour ne sont plus forcées
  // (demande utilisateur) : <UpdateBadge /> affiche « Mise à jour X
  // disponible » en haut à droite et n'installe que sur clic.
  useEffect(() => {
    let cancelled = false;
    noterDossiersRecents();

    (async () => {
      // 2. Accueil. v2-e12d — l'application s'ouvre toujours sur
      //    l'interface classique du poste (dossiers recents, conversations
      //    libres, ouvrir un dossier). L'espace cloud n'est plus l'ecran
      //    d'arrivee : il reste a un clic (« Revenir au cloud »), et une
      //    session cloud ouverte n'est jamais imposee au demarrage.
      if (cancelled) return;
      // la page vient d'être rechargée (rendu de WebView2 mort ou figé, F5) :
      // on rouvre le même écran au lieu de l'accueil. Les colonnes et onglets de
      // conversations se relisent seuls (stockage local du dossier).
      const repriseDemandee = await invoke<boolean>("page_reprise_demandee").catch(() => false);
      const ecran = ecranARouvrir(window.localStorage, nomFenetre(), {
        repriseDemandee: repriseDemandee === true,
        rechargement: estUnRechargement(window.performance),
      });
      if (cancelled) return;
      setState({ kind: "welcome" });
      if (ecran?.kind === "dossier") void openWorkspaceRef.current(ecran.chemin, ecran.conversationId);
      else if (ecran?.kind === "libre") void openFreeChatRef.current(ecran.conversationId ? { conversationId: ecran.conversationId } : {});
      else if (ecran?.kind === "cloud") void openCloudFolderRef.current(ecran.dossier ?? "");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // écran noté à chaque changement, pour la reprise après un rechargement.
  const dossierCloudRef = useRef<string>("");
  const openWorkspaceRef = useRef(openWorkspace);
  const openFreeChatRef = useRef(openFreeChat);
  const openCloudFolderRef = useRef<(folder: string) => Promise<void>>(async () => undefined);
  useEffect(() => {
    let ecran: Ecran | null = null;
    if (state.kind === "welcome") ecran = { kind: "accueil" };
    else if (state.kind === "workspace") {
      const chemin = state.bootstrap.workspace.path;
      const conversationId = state.bootstrap.activeConversation.id;
      ecran =
        state.layout === "chat"
          ? { kind: "libre", conversationId }
          : chemin.startsWith("axe-cloud://")
            ? { kind: "cloud", dossier: dossierCloudRef.current, conversationId }
            : { kind: "dossier", chemin, conversationId };
    }
    if (ecran) noterEcran(window.localStorage, nomFenetre(), ecran);
  }, [state]);
  // battement (la page répond ; mémoire JS notée dans page.log) et erreurs JS.
  useEffect(() => {
    const arreterBattement = demarrerBattement({
      envoyer: () => void invoke("page_battement", mesurer(window.performance, document)).catch(() => undefined),
      document,
      fenetre: window,
    });
    const arreterJournal = journaliserErreurs(window, (texte) => void invoke("page_journal", { texte }).catch(() => undefined));
    return () => {
      arreterBattement();
      arreterJournal();
    };
  }, []);

  const backToWelcome = useCallback(() => {
    void api.resetWindowTitle().catch(() => {
      // best-effort; leaving the previous title is harmless
    });
    setState({ kind: "welcome" });
  }, []);

  // cloud — session changes coming from Rust (401 = expired/revoked).
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void cloudApi
      .onState((cloud) => {
        setState((current) => {
          // v2-l2.3 — session cloud perdue pendant qu'on travaillait sur l'espace cloud.
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

  // v2-e12d — depuis l'accueil classique, « Revenir au cloud » ouvre
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
      setBootError("Retour au cloud : " + String(err)); // retour-cloud
      try {
        const cloud = await cloudApi.state();
        setState(cloud.connected ? { kind: "cloud", cloud } : { kind: "cloud_login", notice: null });
      } catch {
        setState({ kind: "cloud_login", notice: null });
      }
    }
  }, []);

  // accueil-3-choix - un seul espace : ouvre l'IDE sur l'espace cloud (pas d'ecran separe).
  const openCloudFolder = async (folder: string) => {
    setBootError(null);
    dossierCloudRef.current = folder; // rouvert après un rechargement
    try {
      try { await connectionsApi.setActive(CLOUD_CONNECTION); } catch { /* non bloquant */ }
      const bootstrap = await api.openCloudWorkspace(CLOUD_CONNECTION, folder || undefined);
      setState({ kind: "workspace", bootstrap, layout: "ide" });
    } catch (err) {
      setBootError("Ouverture du dossier cloud : " + String(err));
    }
  };

  openWorkspaceRef.current = openWorkspace;
  openFreeChatRef.current = openFreeChat;
  openCloudFolderRef.current = openCloudFolder;

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
        onOpenPortal={() => cloudApi.openWeb("/prime/").then(() => undefined)}
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
          key={versionAccueil}
          avis={
            introuvable && (
              <DossierIntrouvable
                chemin={introuvable.chemin}
                nom={introuvable.nom}
                recherche={introuvable.recherche}
                erreur={introuvable.erreur}
                onRechercher={() => void openWorkspace(introuvable.chemin, introuvable.conversationId)}
                onChoisir={() => void choisirNouvelEmplacement()}
                onRetirer={retirerIntrouvable}
                onFermer={() => setIntrouvable(null)}
              />
            )
          }
          onPick={openWorkspace}
          onFreeChat={(options) => void openFreeChat(options)}
          onCloudFolder={EDITION_LOCALE ? undefined : (folder) => void openCloudFolder(folder)}
          error={introuvable ? null : bootError}
          deriveName={deriveName}
        />
        {/* cloud — way back to the cloud mode from the local home screen. */}
        {/* un-seul-espace - plus de « Revenir au cloud » : un seul espace, sur la VM. */}
        {/* accueil-compte - sous Windows, à gauche des boutons Réduire/Agrandir/Fermer (138 px) : il était posé dessus. */}
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
