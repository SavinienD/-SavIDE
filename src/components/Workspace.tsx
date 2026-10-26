import { EDITION_LOCALE } from "../lib/edition";
import { OUVRIR_REGLAGES_EVENT } from "./chat/SlashCommands";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icon } from "@iconify/react";
import { api } from "../lib/ipc";
import { titreAffiche } from "../lib/titres";
import { modelRefWithThinking, thinkingFromRef } from "../lib/models";
import { Splitter } from "./Splitter";
import { fournirActions } from "../axe/raccourcis"; // axe:raccourcis
import { FileTree, type FileTreeHandle } from "./FileTree";
import { ConversationList } from "./ConversationList";
import { NouvelleConversation } from "./NouvelleConversation"; // axe:e13
import { EditorPane } from "./EditorPane";
import { SettingsPane } from "./SettingsPane";
import { TerminalPanel } from "./TerminalPanel";
import { CloudTerminalPanel } from "./cloud/CloudTerminalPanel"; // axe:e8
import { CLOUD_CONNECTION, cloudApi } from "./cloud/cloudApi"; // axe:e15
import { CloudLoginButton } from "./cloud/CloudLoginButton"; // axe:connexion-google
import { FenetreOnglet } from "./onglets/FenetreOnglet"; // axe:e14
import { OngletsChat, type OngletChat } from "./onglets/OngletsChat"; // axe:e14
import { ChatCloseButton } from "./chat/ChatCloseButton"; // axe:e17b
import { VoletRappel, VoletsFlottants, VoletOutils } from "./volets/VoletsFlottants"; // axe:e6
import { useVolets } from "./volets/volets"; // axe:e6
import "./volets/volets.css"; // axe:e6
import { cloudConnectionFromPath, cloudRpc } from "../lib/ipc"; // axe:v2-l2.3
import { preferenceModeleEspace } from "../lib/modelesEspace"; // axe:parcours-collegue
import { demanderSectionReglages } from "../lib/sectionReglages"; // axe:parcours-collegue
import {
  CloudOfflineError,
  getCloudStatus,
  isCloudOffline,
  nextCloudProbeInSeconds,
  probeCloud,
  subscribeCloudStatus,
  type CloudStatus,
} from "../lib/cloudOnline"; // axe:v2-l6
import {
  ensureOfflineMirror,
  getOfflineView,
  refreshOfflineState,
  resolveOfflineConflict,
  subscribeOffline,
  syncOffline,
  type OfflineView,
} from "../lib/cloudOffline"; // axe:v2-l6 (tranche 2)
import { RemotePanel } from "./RemotePanel";
import { SearchPane } from "./SearchPane";
import { AgentsView } from "./agents/AgentsView"; // axe:agents
import { SessionTree } from "./agents/SessionTree"; // axe:agents
import { SessionJournal } from "./agents/SessionJournal"; // axe:sub-m
// axe:remote
import { ConnectionSelector } from "./agents/ConnectionSelector";
import { RemoteConversations } from "./agents/RemoteConversations";
import { agentsApi } from "./agents/agentsApi"; // axe:e12b — creation d'une conversation sur le service
import { rememberedModel } from "./agents/remoteItems"; // axe:e12b — modele choisi plus tard, jamais demande ici
import { LOCAL_CONNECTION, useActiveConnection } from "./settings/connectionsApi";
// axe:remote end
import { ChatPane, type ExternalDropFeed } from "./chat/ChatPane";
import { createConversationActions } from "./chat/actionsConversation"; // axe:e17a
import { filesPartagees } from "./chat/fileAttente"; // axe:file-attente
import { mettreEnArrierePlan } from "./chat/arrierePlan"; // axe:arriere-plan
import {
  clore,
  clotLaDemande,
  delaiAvantForcage,
  demander,
  forcer,
  libereAuClic,
  type DemandesArret,
} from "./chat/arretForce"; // axe:stop-force
import {
  deplacer as deplacerColonne,
  fermerColonne as fermerColonneEtat, // axe:hotfix
  focaliser as focaliserColonne,
  ouvrir as ouvrirColonne,
  relire as relireColonnes,
  retirer as retirerColonne,
  suivre as suivreColonne, // axe:hotfix
  synchroniser as synchroniserColonnes, // axe:hotfix
  trouver as trouverColonne,
  MIME_ONGLET_CHAT,
  MIME_ONGLET_FICHIER,
  colonneCible,
  depasseSeuil,
  poidsColonnes as poidsColonnesChatValides, // axe:hotfix-largeurs
  redimensionner as redimensionnerPoids, // axe:hotfix-largeurs
  type EtatColonnes,
} from "./chat/colonnes"; // axe:e17b
import { FreechatView } from "./freechat/FreechatView"; // axe:freechat
import { AxeLogo } from "../axe/Logo";
import { UpdateBadge } from "./UpdateBadge";
import { declarerActivite } from "../lib/activite";
import { importerDossier } from "../lib/importDossier"; // axe:import
import { invoke } from "@tauri-apps/api/core";
import { SkillsBadge } from "../axe/E4Vues"; // axe:e4
import { SkillSync, type Empreintes } from "../axe/SkillSync"; // axe:e4
import { QuotaIndicator } from "../axe/QuotaIndicator"; // axe:providers
import { WindowControls, isWindowsPlatform } from "./WindowControls";
import type {
  ActiveTurnSummary,
  ActiveTurnsChangedPayload,
  AgentEvent,
  AgentMode,
  ConversationEventPayload,
  ConversationSummary,
  EditorRevealTarget,
  EditorTab,
  FileChange,
  MessageVisibility,
  PlanArtifact,
  PlanControl,
  RemoteStatus,
  SavedConversation,
  ServiceTier,
  ThinkingLevel,
  WorkspaceBootstrap,
  WorkspaceEntry,
  WorkspaceFileChangedPayload,
} from "../types";

type Props = {
  bootstrap: WorkspaceBootstrap;
  onSwitchWorkspace: () => void;
  onBootstrapReplace: (b: WorkspaceBootstrap) => void;
  // axe:freechat — "chat": free conversation view (no editor/tree/terminal).
  layout?: "ide" | "chat";
  /** Opens a project folder in the IDE view (optionally on a conversation). */
  onOpenFolder?: (path: string, conversationId?: string) => void;
  /** Opens a free conversation in the free conversation view. */
  onOpenFreeChat?: (conversationId: string) => void;
};

const INITIAL_LEFT = 280;
const INITIAL_RIGHT = 420;
// axe:colonnes-place — largeur minimale d'une colonne de chat (styles.css,
// .colonne-chat) et du bouton « + colonne » : le panneau de chat s'élargit pour
// que ses colonnes tiennent (avant, la 2e et la 3e sortaient de l'écran).
const LARGEUR_MIN_COLONNE_CHAT = 220;
const LARGEUR_AJOUT_COLONNE = 22;
const MIN_COL = 220;
const MAX_COL_RATIO = 0.6;
const INITIAL_SPLIT_TOP = 0.55;
const INITIAL_TERMINAL_HEIGHT = 240;
const MIN_TERMINAL_HEIGHT = 140;
const MAX_TERMINAL_RATIO = 0.92;
const TERMINAL_OPEN_EVENT = "terminal-open-requested";
const CLOSE_ACTIVE_TAB_EVENT = "editor-close-active-tab-requested";
const SEND_BUSY_RETRY_DELAYS_MS = [160, 320, 640, 1000, 1400];
const COMPACTION_CONTINUATION_PROMPT =
  "Continue from the compacted context. Do not repeat completed work. Pick up exactly where you left off and proceed with the next useful step.";
const GOAL_COMPACTION_CONTINUATION_PROMPT =
  "Continue working toward the active goal from the compacted context. Do not repeat completed work. If the goal is now truly complete, audit it and call update_goal with status complete.";
const IS_WINDOWS = isWindowsPlatform();
// axe:barre-place — feux de fenêtre macOS en haut à gauche : la barre les évite.
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

// axe:raccourcis — pousser un dossier du PC sur la VM (bouton de la barre de titre et Ctrl+Maj+U).
async function pousserDossierCloud(): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const r = await invoke<{ dossier: string; fichiers: number; octets: number }>("push_folder_cloud", { connection: "axe-cloud", dir });
    window.alert(`${r.fichiers} fichiers (${Math.round(r.octets / 1024)} Ko) envoyés sur le cloud dans ${r.dossier}.`);
  } catch (e) {
    window.alert(`Envoi impossible : ${String(e)}`);
  }
}

export function Workspace({
  bootstrap,
  onSwitchWorkspace,
  onBootstrapReplace,
  layout = "ide",
  onOpenFolder,
  onOpenFreeChat,
}: Props) {
  const workspacePath = bootstrap.workspace.path;

  const [conversations, setConversations] = useState<ConversationSummary[]>(
    bootstrap.conversations,
  );
  const [activeConv, setActiveConv] = useState<SavedConversation>(
    bootstrap.activeConversation,
  );
  const [, setGlobalModeModelSettings] = useState(
    bootstrap.modeModelSettings,
  );
  const [streamingConversationIds, setStreamingConversationIds] = useState<
    Set<string>
  >(() => new Set());
  const streamingIdsRef = useRef(streamingConversationIds); // axe:arriere-plan
  streamingIdsRef.current = streamingConversationIds;
  // Mise à jour automatique : attendre la fin des tours (et des agents) en cours.
  useEffect(() => {
    declarerActivite("workspace", streamingConversationIds.size > 0);
    return () => declarerActivite("workspace", false);
  }, [streamingConversationIds]);
  const [streamingModelsByConversation, setStreamingModelsByConversation] =
    useState<Map<string, SavedConversation["model"]>>(() => new Map());
  const lastAgentEventSequenceByConversationRef = useRef<Map<string, number>>(
    new Map(),
  );
  const replayActiveTurnEventsRef = useRef<
    (conversationId: string, afterSequence?: number) => Promise<void>
  >(async () => {});
  // axe:e3 — conversations rangées dans l'archive. L'interface ne connaît que
  // la liste donnée par le service : jamais un chemin.
  const [archivedConversations, setArchivedConversations] = useState<
    ConversationSummary[]
  >([]);
  const activeConvIdRef = useRef(bootstrap.activeConversation.id);
  const workspacePathRef = useRef(workspacePath);
  const navigationSeqRef = useRef(0);
  // Bottom-sidebar tab — "conversations" preserves the existing default.
  // Both panels stay mounted (display:none on the inactive one) so users
  // can flip between them without losing in-progress form input.
  // axe:miroir-vm - derniere copie des conversations sur la VM.
  const [miroir, setMiroir] = useState<{ ok: boolean; n: number; atMs: number; error?: string } | null>(null);
  useEffect(() => {
    let un: UnlistenFn | undefined;
    void listen<{ ok: boolean; atMs: number; error?: string }>("axe://mirror-status", (e) =>
      setMiroir((m) => ({ ok: e.payload.ok, atMs: e.payload.atMs, error: e.payload.error ?? undefined, n: (m?.n ?? 0) + (e.payload.ok ? 1 : 0) })),
    ).then((f) => { un = f; });
    return () => un?.();
  }, []);
  const [bottomTab, setBottomTab] = useState<"conversations" | "agents">( // axe:agents
    "conversations",
  );
  // axe:sub-n — le bandeau « N agent(s) au travail » du chat ouvre la vue Agents.
  useEffect(() => {
    const ouvrir = () => setBottomTab("agents");
    window.addEventListener("axe:open-agents", ouvrir);
    return () => window.removeEventListener("axe:open-agents", ouvrir);
  }, []);
  // axe:bg-c — … et ouvre la conversation de l'agent, comme un clic dans la vue Agents.
  useEffect(() => {
    const ouvrir = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; title: string; conn?: string }>).detail;
      if (d?.id) setJournalSession({ id: d.id, conn: d.conn ?? LOCAL_CONNECTION, title: d.title });
    };
    window.addEventListener("axe:open-agent-journal", ouvrir);
    return () => window.removeEventListener("axe:open-agent-journal", ouvrir);
  }, []);
  // axe:e6 — les volets remplacent le verrou du panneau bas : chaque volet se
  // detache, se duplique et se reancre ; sa place et sa taille sont gardees
  // (localStorage) et jamais perdues hors de l'ecran.
  const volets = useVolets();
  // axe:e4 — synchro des skills partagées toutes les 5 min (commande Tauri).
  const skillSync = useMemo(
    () => new SkillSync((dir) => invoke<Empreintes>("shared_skills_fingerprints", { dir })),
    [],
  );
  // axe:e14 — les conversations ouvertes, en onglets (comme un navigateur) :
  // un onglet par conversation, l'onglet actif EST la conversation active, et un
  // onglet se detache pour venir devant. La liste est gardee par espace.
  const [ongletsChat, setOngletsChat] = useState<OngletChat[]>(() => {
    try {
      const brut = window.localStorage.getItem(`axe:v2:onglets-chat:${workspacePath}`);
      const liste = brut ? (JSON.parse(brut) as OngletChat[]) : [];
      return Array.isArray(liste)
        ? liste.filter((t) => t && typeof t.id === "string" && typeof t.titre === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [chatDetache, setChatDetache] = useState<string | null>(null);
  // axe:sub-m — journal of a sub-agent shown read-only in the focused chat column.
  const [journalSession, setJournalSession] = useState<{ id: string; conn: string; title: string } | null>(null);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        `axe:v2:onglets-chat:${workspacePath}`,
        JSON.stringify(ongletsChat),
      );
    } catch {
      /* plein ou interdit : les onglets vivent le temps de la session */
    }
  }, [ongletsChat, workspacePath]);
  // La conversation active a toujours son onglet : cliquer dans la liste a
  // gauche fait apparaitre l'onglet a droite, sans geste de plus.
  useEffect(() => {
    const titre = titreAffiche(activeConv.title);
    setOngletsChat((liste) => {
      const index = liste.findIndex((t) => t.id === activeConv.id);
      if (index === -1) return [...liste, { id: activeConv.id, titre }];
      if (liste[index].titre === titre) return liste;
      const copie = liste.slice();
      copie[index] = { id: activeConv.id, titre };
      return copie;
    });
  }, [activeConv.id, activeConv.title]);
  // axe:onglets-sync — les onglets suivent la liste du bas : un onglet dont la
  // conversation n'existe plus (supprimee/archivee, ailleurs aussi) disparait,
  // et un renommage met a jour son titre. L'onglet actif est toujours garde
  // (conversation neuve pas encore listee).
  useEffect(() => {
    setOngletsChat((liste) => {
      const parId = new Map(conversations.map((c) => [c.id, c]));
      let change = false;
      const suivante: OngletChat[] = [];
      for (const t of liste) {
        const conv = parId.get(t.id);
        if (!conv) {
          if (t.id === activeConv.id) suivante.push(t);
          else change = true;
          continue;
        }
        const titre = titreAffiche(conv.title);
        if (titre !== t.titre) {
          change = true;
          suivante.push({ ...t, titre });
        } else suivante.push(t);
      }
      return change ? suivante : liste;
    });
    setChatDetache((d) =>
      d !== null && d !== activeConv.id && !conversations.some((c) => c.id === d) ? null : d,
    );
  }, [conversations, activeConv.id]);
  const activeConnection = useActiveConnection(); // axe:remote
  // axe:v2-l2.3 — espace de travail CLOUD : fichiers sur la VM, terminal distant, indicateur de synchro.
  const cloudConnection = cloudConnectionFromPath(workspacePath);
  // axe:e15 — la session Axe Cloud, vue depuis n'importe quelle interface : c'est
  // elle qui donne le terminal a onglets (Bash du service, terminal local, Prime
  // Agent epingle), meme quand on travaille sur un dossier local.
  const [cloudReady, setCloudReady] = useState<string | null>(null);
  useEffect(() => {
    let annule = false;
    const appliquer = (etat: { connected?: boolean; connectionId?: string } | null) => {
      if (annule) return;
      setCloudReady(etat?.connected ? etat.connectionId || CLOUD_CONNECTION : null);
    };
    void cloudApi
      .state()
      .then(appliquer)
      .catch(() => appliquer(null));
    let stop: (() => void) | undefined;
    void cloudApi
      .onState((etat) => appliquer(etat))
      .then((desabonner) => {
        stop = desabonner;
        if (annule) desabonner();
      })
      .catch(() => undefined);
    return () => {
      annule = true;
      stop?.();
    };
  }, []);
  // axe:v2-l6 — joignabilite du service cloud (aucun etat en mode local).
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("unknown");
  // axe:e13 — L'utilisateur aime voir l'etat du service : le badge revient.
  const [cloudProbeIn, setCloudProbeIn] = useState(15);
  // axe:v2-l6 (tranche 2) — etat du miroir local (la reprise reste silencieuse).
  const [offlineView, setOfflineView] = useState<OfflineView>(() =>
    getOfflineView(workspacePath),
  );
  // axe:e13 — creation d'une conversation : on demande le nom.
  const [creating, setCreating] = useState(false);
  // axe:e18 — le badge suit la connexion visible : dans un espace cloud c'est lui,
  // depuis l'interface classique c'est la session Axe Cloud ouverte. Avant, il
  // n'existait que dans un espace cloud — donc L'utilisateur ne le voyait jamais.
  const connexionCloud = cloudConnection ?? cloudReady;
  useEffect(() => {
    if (!connexionCloud) {
      setCloudStatus("unknown");
      return;
    }
    setCloudStatus(getCloudStatus(connexionCloud));
    void probeCloud(connexionCloud);
    return subscribeCloudStatus(connexionCloud, setCloudStatus);
  }, [connexionCloud]);
  useEffect(() => {
    if (!cloudConnection) return;
    setOfflineView(getOfflineView(workspacePath));
    return subscribeOffline(workspacePath, () =>
      setOfflineView(getOfflineView(workspacePath)),
    );
  }, [cloudConnection, workspacePath]);
  // Prepare la copie locale en tache de fond (demarrage ou premiere mise hors ligne).
  useEffect(() => {
    if (!cloudConnection) return;
    let cancelled = false;
    void (async () => {
      await refreshOfflineState(workspacePath);
      if (cancelled) return;
      const view = getOfflineView(workspacePath);
      if (!view.ready) {
        void ensureOfflineMirror(workspacePath);
      } else if (!isCloudOffline(cloudConnection) && view.pendingCount > 0) {
        void syncOffline(workspacePath);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudConnection, workspacePath]);
  // Retour en ligne : on envoie automatiquement les modifications en attente.
  const previousCloudStatusRef = useRef<CloudStatus>("unknown");
  useEffect(() => {
    const previous = previousCloudStatusRef.current;
    previousCloudStatusRef.current = cloudStatus;
    if (!cloudConnection) return;
    if (previous === "offline" && cloudStatus === "online") {
      void syncOffline(workspacePath);
    }
    if (cloudStatus === "offline") {
      void ensureOfflineMirror(workspacePath);
    }
  }, [cloudConnection, cloudStatus, workspacePath]);
  // E2 — la reprise est silencieuse : rien n'est annonce, rien n'est compte.
  // (Le journal est rejoue au retour du reseau et au demarrage ; l'interface
  // suit toute seule l'etat du miroir.)
  // axe:e13 — le badge indique de lui-meme dans combien de temps la sonde
  // retentera, sans jamais rien demander a l'utilisateur.
  useEffect(() => {
    if (!cloudConnection || cloudStatus !== "offline") return;
    const tick = () => setCloudProbeIn(nextCloudProbeInSeconds(cloudConnection));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [cloudConnection, cloudStatus]);
  // axe:agents — /tree overlay opened from the composer.
  const [treeSessionId, setTreeSessionId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId) setTreeSessionId(detail.conversationId);
    };
    window.addEventListener("axe:open-session-tree", handler);
    return () => window.removeEventListener("axe:open-session-tree", handler);
  }, []);
  // axe:agents end

  useEffect(() => {
    activeConvIdRef.current = activeConv.id;
  }, [activeConv.id]);

  useEffect(() => {
    workspacePathRef.current = workspacePath;
  }, [workspacePath]);

  useEffect(() => {
    navigationSeqRef.current += 1;
    workspacePathRef.current = bootstrap.workspace.path;
    activeConvIdRef.current = bootstrap.activeConversation.id;
    setConversations(bootstrap.conversations);
    setActiveConv(bootstrap.activeConversation);
    setGlobalModeModelSettings(bootstrap.modeModelSettings);
  }, [bootstrap]);

  useEffect(() => {
    navigationSeqRef.current += 1;
    setStreamingConversationIds(new Set());
    setStreamingModelsByConversation(new Map());
    lastAgentEventSequenceByConversationRef.current.clear();
  }, [workspacePath]);

  const markConversationStreaming = useCallback((id: string, active: boolean) => {
    if (!id) return;
    setStreamingConversationIds((prev) => {
      if (prev.has(id) === active) return prev;
      const next = new Set(prev);
      if (active) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    if (!active) {
      setStreamingModelsByConversation((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const markConversationStreamingModel = useCallback(
    (id: string, model: SavedConversation["model"], thinking: ThinkingLevel) => {
      if (!id) return;
      const selected = modelRefWithThinking(model, thinking);
      setStreamingModelsByConversation((prev) => {
        const next = new Map(prev);
        next.set(id, selected);
        return next;
      });
    },
    [],
  );

  const refreshConversationList = useCallback(async () => {
    const workspaceAtRequest = workspacePath;
    try {
      const summaries = await api.listConversations(workspaceAtRequest);
      if (workspacePathRef.current !== workspaceAtRequest) return;
      setConversations(summaries);
    } catch (err) {
      console.error(err);
    }
  }, [workspacePath]);

  const selectConversation = useCallback(
    async (id: string) => {
      if (id === activeConv.id) return;
      const seq = ++navigationSeqRef.current;
      try {
        const loaded = await api.loadConversation(workspacePath, id);
        if (seq !== navigationSeqRef.current) return;
        if (loaded.id !== id || loaded.workspaceId !== workspacePath) return;
        activeConvIdRef.current = loaded.id;
        setActiveConv(loaded);
        const last = lastAgentEventSequenceByConversationRef.current.get(id) ?? 0;
        if (streamingConversationIds.has(id)) {
          void replayActiveTurnEventsRef.current(id, last).catch((err) =>
            console.error(err),
          );
        }
      } catch (err) {
        console.error(err);
      }
    },
    [workspacePath, activeConv.id, streamingConversationIds],
  );

  const createConversation = useCallback(async (titre: string) => {
    const seq = ++navigationSeqRef.current;
    const nom = titre.trim();
    // axe:e12b — sur un espace, « nouvelle conversation » se joue en deux temps :
    // le service cree la session, on ouvre aussitot le fil a droite. Aucun modele
    // n'est demande ici : le dernier choisi part en silence (il se change dans la
    // conversation ouverte), exactement comme pour « Nouvelle recette ».
    if (cloudConnection) {
      try {
        const meta = await agentsApi.create(
          nom,
          "",
          rememberedModel(cloudConnection),
          cloudConnection,
        );
        if (seq !== navigationSeqRef.current) return;
        const [loaded, summaries] = await Promise.all([
          api.loadConversation(workspacePath, meta.id),
          api.listConversations(workspacePath),
        ]);
        if (seq !== navigationSeqRef.current) return;
        activeConvIdRef.current = loaded.id;
        setConversations(summaries);
        setActiveConv(loaded);
      } catch (err) {
        console.error(err);
      }
      return;
    }
    try {
      const next = await api.createConversation(workspacePath);
      if (seq !== navigationSeqRef.current) return;
      if (next.workspace.path !== workspacePath) return;
      // axe:e13 — le nom demande a la creation sert a retrouver la
      // conversation dans la liste et dans les archives.
      const renommees = await api.renameConversation(
        workspacePath,
        next.activeConversation.id,
        nom,
      );
      activeConvIdRef.current = next.activeConversation.id;
      setConversations(renommees);
      setActiveConv({ ...next.activeConversation, title: nom });
      setGlobalModeModelSettings(next.modeModelSettings);
    } catch (err) {
      console.error(err);
    }
  }, [workspacePath, cloudConnection]);

  // axe:e13 — « + » ouvre le champ au lieu de creer tout de suite : le nom est
  // exige, donc la creation ne part jamais sans lui.
  const startCreate = useCallback(() => {
    setCreating(true);
  }, []);

  const cancelCreate = useCallback(() => {
    setCreating(false);
  }, []);

  const confirmCreate = useCallback(
    (titre: string) => {
      setCreating(false);
      void createConversation(titre);
    },
    [createConversation],
  );

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      try {
        const next = await api.renameConversation(workspacePath, id, title);
        setConversations(next);
      } catch (err) {
        console.error(err);
      }
    },
    [workspacePath],
  );

  const refreshConversationAfterMessageStart = useCallback(
    async (workspaceAtRequest: string, conversationId: string) => {
      const [loaded, summaries] = await Promise.all([
        api.loadConversation(workspaceAtRequest, conversationId),
        api.listConversations(workspaceAtRequest),
      ]);
      if (workspacePathRef.current !== workspaceAtRequest) return;

      startTransition(() => {
        if (
          loaded.id === conversationId &&
          loaded.workspaceId === workspaceAtRequest &&
          activeConvIdRef.current === conversationId
        ) {
          setActiveConv((current) =>
            current.id === conversationId ? loaded : current,
          );
        }
        setConversations(summaries);
      });
    },
    [],
  );

  const applyOptimisticConversationTitle = useCallback(
    (conversationId: string, title: string) => {
      const updatedAtMs = Date.now();
      setActiveConv((current) =>
        current.id === conversationId ? { ...current, title } : current,
      );
      setConversations((current) =>
        sortConversationSummaries(
          current.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  title,
                  updatedAtMs: Math.max(conversation.updatedAtMs, updatedAtMs),
                }
              : conversation,
          ),
        ),
      );
    },
    [],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      setOngletsChat((t) => t.filter((o) => o.id !== id)); // axe:suppr-onglet
      setChatDetache((a) => (a === id ? null : a));
      // axe:stuck - une conversation bloquee « en marche » peut etre supprimee : on l'arrete d'abord.
      if (streamingConversationIds.has(id)) {
        try { await api.cancelTurn(workspacePath, id); } catch { /* deja arretee */ }
        markConversationStreaming(id, false);
      }
      const seq = ++navigationSeqRef.current;
      try {
        const next = await api.deleteConversation(workspacePath, id);
        if (seq !== navigationSeqRef.current) return;
        if (next.workspace.path !== workspacePath) return;
        activeConvIdRef.current = next.activeConversation.id;
        setConversations(next.conversations);
        setActiveConv(next.activeConversation);
        setGlobalModeModelSettings(next.modeModelSettings);
        onBootstrapReplace(next);
      } catch (err) {
        console.error(err);
        if (seq === navigationSeqRef.current) {
          navigationSeqRef.current += 1;
        }
      }
    },
    [workspacePath, onBootstrapReplace, streamingConversationIds, markConversationStreaming],
  );

  // axe:e3 — la liste des archives n'est demandée qu'à un espace qui sait
  // archiver : en local, il n'y a pas d'archive et on ne l'invente pas.
  // axe:archive-locale — en local aussi : l'archive vit dans la base locale.
  const refreshArchivedConversations = useCallback(async () => {
    try {
      const list = await api.listArchivedConversations(workspacePath);
      if (workspacePathRef.current !== workspacePath) return;
      setArchivedConversations(list);
    } catch (err) {
      console.error(err);
    }
  }, [workspacePath, cloudConnection]);

  useEffect(() => {
    void refreshArchivedConversations();
  }, [refreshArchivedConversations]);

  const archiveConversation = useCallback(
    async (id: string) => {
      setOngletsChat((t) => t.filter((o) => o.id !== id)); // axe:suppr-onglet
      setChatDetache((a) => (a === id ? null : a));
      if (streamingConversationIds.has(id)) return;
      try {
        const next = await api.archiveConversation(workspacePath, id);
        setConversations(next);
        void refreshArchivedConversations();
        if (activeConvIdRef.current === id) {
          const first = next[0];
          if (first) {
            void selectConversation(first.id);
          } else {
            // axe:archive-locale — plus aucune conversation active : on en ouvre une neuve.
            void createConversation("");
          }
        }
      } catch (err) {
        console.error(err);
      }
    },
    [
      workspacePath,
      streamingConversationIds,
      selectConversation,
      refreshArchivedConversations,
      createConversation,
    ],
  );

  const restoreArchivedConversation = useCallback(
    async (id: string) => {
      try {
        const archives = await api.restoreArchivedConversation(workspacePath, id);
        setArchivedConversations(archives);
        setConversations(await api.listConversations(workspacePath));
      } catch (err) {
        console.error(err);
      }
    },
    [workspacePath],
  );

  const deleteArchivedConversation = useCallback(
    async (id: string) => {
      try {
        const archives = await api.deleteArchivedConversation(workspacePath, id);
        setArchivedConversations(archives);
      } catch (err) {
        console.error(err);
      }
    },
    [workspacePath],
  );

  // ---------------- Editor tabs ----------------
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState<number>(-1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteActive, setRemoteActive] = useState(false);
  const [settingsActive, setSettingsActive] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null);
  const [fileTreeRefreshToken, setFileTreeRefreshToken] = useState(0);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [pendingRootCreate, setPendingRootCreate] = useState<
    "file" | "directory" | null
  >(null);
  const fileTreeRef = useRef<FileTreeHandle | null>(null);
  const [editorRevealTarget, setEditorRevealTarget] =
    useState<EditorRevealTarget | null>(null);
  const tabsRef = useRef(tabs);
  const toggleTerminalRef = useRef<() => void>(() => {});
  const fileTreeRefreshTimerRef = useRef<number | null>(null);
  const revealSeqRef = useRef(0);
  tabsRef.current = tabs;

  useEffect(() => {
    if (!pendingRootCreate || fileSearchOpen) return;
    const handle = fileTreeRef.current;
    if (!handle) return;
    handle.startCreateRoot(pendingRootCreate);
    setPendingRootCreate(null);
  }, [pendingRootCreate, fileSearchOpen]);

  const startRootCreate = useCallback(
    (kind: "file" | "directory") => {
      if (fileSearchOpen) {
        setFileSearchOpen(false);
        setPendingRootCreate(kind);
        return;
      }
      const handle = fileTreeRef.current;
      if (handle) {
        handle.startCreateRoot(kind);
      } else {
        setPendingRootCreate(kind);
      }
    },
    [fileSearchOpen],
  );

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const refreshFileTree = useCallback(() => {
    setFileTreeRefreshToken((value) => value + 1);
  }, []);

  const refreshFileTreeSoon = useCallback(() => {
    if (fileTreeRefreshTimerRef.current !== null) return;
    fileTreeRefreshTimerRef.current = window.setTimeout(() => {
      fileTreeRefreshTimerRef.current = null;
      refreshFileTree();
    }, 120);
  }, [refreshFileTree]);

  useEffect(() => {
    return () => {
      if (fileTreeRefreshTimerRef.current !== null) {
        window.clearTimeout(fileTreeRefreshTimerRef.current);
      }
    };
  }, []);

  const refreshOpenTabFromDisk = useCallback(async (relativePath: string) => {
    if (!relativePath) return;
    const workspaceAtRequest = workspacePathRef.current;
    if (
      !tabsRef.current.some((tab) => tab.relativePath === relativePath)
    ) {
      return;
    }

    try {
      const doc = await api.readFile(workspaceAtRequest, relativePath);
      if (workspacePathRef.current !== workspaceAtRequest) return;
      setTabs((prev) => {
        const idx = prev.findIndex((tab) => tab.relativePath === relativePath);
        if (idx < 0) return prev;
        const next = prev.slice();
        const tab = next[idx];
        next[idx] = tab.dirty
          ? { ...tab, doc }
          : {
              ...tab,
              doc,
              buffer: doc.content ?? "",
            };
        return next;
      });
    } catch (err) {
      console.error(err);
      if (workspacePathRef.current !== workspaceAtRequest) return;
      setTabs((prev) =>
        prev.filter(
          (tab) => tab.dirty || tab.relativePath !== relativePath,
        ),
      );
    }
  }, []);

  const refreshChangedFiles = useCallback(
    (changes: FileChange[]) => {
      if (changes.length === 0) return;
      refreshFileTreeSoon();
      const seen = new Set<string>();
      for (const change of changes) {
        if (!change.relativePath || seen.has(change.relativePath)) continue;
        seen.add(change.relativePath);
        void refreshOpenTabFromDisk(change.relativePath);
      }
    },
    [refreshFileTreeSoon, refreshOpenTabFromDisk],
  );

  useEffect(() => {
    let disposed = false;
    void api.watchWorkspace(workspacePath).catch((err) => {
      if (!disposed) {
        console.warn("workspace watcher unavailable", err);
      }
    });
    return () => {
      disposed = true;
      void api.unwatchWorkspace(workspacePath).catch((err) => {
        console.warn("workspace watcher cleanup failed", err);
      });
    };
  }, [workspacePath]);

  useEffect(() => {
    const onFocus = () => refreshFileTree();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshFileTree();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshFileTree]);

  const hasStreamingConversation = streamingConversationIds.size > 0;
  useEffect(() => {
    if (!hasStreamingConversation) return;
    const interval = window.setInterval(refreshFileTreeSoon, 1000);
    return () => window.clearInterval(interval);
  }, [hasStreamingConversation, refreshFileTreeSoon]);

  const openFile = useCallback(
    async (
      entry: WorkspaceEntry,
      reveal?: Omit<EditorRevealTarget, "id" | "relativePath">,
    ): Promise<boolean> => {
      if (entry.kind !== "file") return false;
      const queueReveal = () => {
        if (!reveal) return;
        setEditorRevealTarget({
          ...reveal,
          id: ++revealSeqRef.current,
          relativePath: entry.relativePath,
        });
      };
      const existing = tabs.findIndex(
        (t) => t.relativePath === entry.relativePath,
      );
      if (existing >= 0) {
        setActiveTabIndex(existing);
        setSettingsActive(false);
        setRemoteActive(false);
        queueReveal();
        return true;
      }
      try {
        const doc = await api.readFile(workspacePath, entry.relativePath);
        const newTab: EditorTab = {
          relativePath: entry.relativePath,
          doc,
          buffer: doc.content ?? "",
          dirty: false,
        };
        setTabs((prev) => {
          const existingIndex = prev.findIndex(
            (t) => t.relativePath === entry.relativePath,
          );
          if (existingIndex >= 0) {
            setActiveTabIndex(existingIndex);
            setSettingsActive(false);
            setRemoteActive(false);
            return prev;
          }
          const next = [...prev, newTab];
          setActiveTabIndex(next.length - 1);
          setSettingsActive(false);
          setRemoteActive(false);
          return next;
        });
        queueReveal();
        return true;
      } catch (err) {
        console.error(err);
        return false;
      }
    },
    [workspacePath, tabs],
  );

  const activateFileTab = useCallback((index: number) => {
    setActiveTabIndex(index);
    setSettingsActive(false);
    setRemoteActive(false);
  }, []);

  const openSettings = useCallback((section?: "providers") => {
    setRemoteActive(false);
    setSettingsOpen(true);
    setSettingsActive(true);
    // Pickup hook for SettingsPane: when the caller wants to land on a
    // specific section (e.g. the composer's "Connect a provider" CTA),
    // fan it out via a window event so the pane can react regardless of
    // whether it just mounted or was already open.
    if (section) {
      // axe:parcours-collegue — gardée aussi pour un volet pas encore monté (avant : « About »).
      demanderSectionReglages(section);
    }
  }, []);

  // axe:savide-reglages — /login et /settings ouvrent le volet (IDE et conversation sans dossier).
  useEffect(() => {
    const ouvrir = () => openSettings();
    window.addEventListener(OUVRIR_REGLAGES_EVENT, ouvrir);
    return () => window.removeEventListener(OUVRIR_REGLAGES_EVENT, ouvrir);
  }, [openSettings]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsActive(false);
  }, []);

  // Small transient feedback for actions with no obvious on-screen result
  // (chat file links: not found, opened by name lookup, external open failed).
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const pushNotice = useCallback((kind: "info" | "error", text: string) => {
    setNotice({ kind, text });
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(
      () => setNotice(null),
      kind === "error" ? 6000 : 4000,
    );
  }, []);

  // axe:freechat — no editor in the free conversation view: files produced
  // by the agent (relative to the conversation's private folder) open with
  // the default application.
  const openFreeChatFile = useCallback(
    (rawPath: string) => {
      const path = cleanChatFilePath(rawPath);
      if (!path || path.includes("://")) return;
      const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
        ? path
        : `${workspacePath}/${activeConvIdRef.current}/${path.replace(/^\.[\\/]/, "")}`;
      void api.openPathWithDefaultApp(absolute).catch((err) => {
        console.error(err);
        pushNotice("error", `Impossible d'ouvrir : ${path}`);
      });
    },
    [pushNotice, workspacePath],
  );

  // Open an arbitrary absolute path in a *read-only* Monaco tab. Used when
  // the user cmd+clicks a path in the terminal that points outside of the
  // active workspace.
  const openExternalFile = useCallback(
    async (
      absolutePath: string,
      reveal?: { lineNumber: number; columnStart: number; columnEnd: number },
    ): Promise<boolean> => {
      // `\\?\…` canonical paths (built by Rust `canonicalize`) are valid on
      // disk but read badly and differ from the same file opened via the
      // file tree; normalize before tab lookup/creation.
      absolutePath = stripVerbatimPath(absolutePath);
      const queueReveal = () => {
        if (!reveal) return;
        setEditorRevealTarget({
          ...reveal,
          id: ++revealSeqRef.current,
          relativePath: absolutePath,
          query: "",
        });
      };
      const existing = tabsRef.current.findIndex(
        (t) => t.relativePath === absolutePath,
      );
      if (existing >= 0) {
        setActiveTabIndex(existing);
        setSettingsActive(false);
        setRemoteActive(false);
        queueReveal();
        return true;
      }
      try {
        const doc = await api.readExternalFile(absolutePath);
        const newTab: EditorTab = {
          relativePath: absolutePath,
          doc,
          buffer: doc.content ?? "",
          dirty: false,
          external: true,
        };
        setTabs((prev) => {
          const existingIndex = prev.findIndex(
            (t) => t.relativePath === absolutePath,
          );
          if (existingIndex >= 0) {
            setActiveTabIndex(existingIndex);
            setSettingsActive(false);
            setRemoteActive(false);
            return prev;
          }
          const next = [...prev, newTab];
          setActiveTabIndex(next.length - 1);
          setSettingsActive(false);
          setRemoteActive(false);
          return next;
        });
        queueReveal();
        return true;
      } catch (err) {
        console.error("Unable to open external file", absolutePath, err);
        return false;
      }
    },
    [],
  );

  // Chat links often carry bare file names ("SettingsPane.tsx") or partial
  // paths that do not exist as-is at the workspace root. Look the name up in
  // the workspace file list and pick the shortest matching path.
  const findWorkspaceFileByPath = useCallback(
    async (target: string): Promise<WorkspaceEntry | null> => {
      const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "");
      const name = normalized.split("/").filter(Boolean).pop() ?? "";
      if (!name) return null;
      try {
        const entries = await api.listAllFiles(workspacePath);
        const files = entries.filter((entry) => entry.kind === "file");
        const nameKey = name.toLowerCase();
        let candidates = files.filter(
          (entry) => entry.name.toLowerCase() === nameKey,
        );
        if (candidates.length === 0) {
          const suffixKey = normalized.toLowerCase();
          candidates = files.filter((entry) =>
            entry.relativePath.replace(/\\/g, "/").toLowerCase().endsWith(suffixKey),
          );
        }
        if (candidates.length === 0) return null;
        candidates.sort(
          (left, right) => left.relativePath.length - right.relativePath.length,
        );
        return candidates[0];
      } catch (err) {
        console.error("file lookup failed", err);
        return null;
      }
    },
    [workspacePath],
  );

  // Open a file referenced from the chat. Relative paths resolve against the
  // workspace and open as an editor tab; absolute paths outside of it (and
  // canonical `\\?\…` ones) open read-only instead of doing nothing. When the
  // exact path does not exist (bare name, partial path), fall back to a
  // workspace lookup by name; any remaining failure shows a visible notice.
  const openChatFile = useCallback(
    (rawPath: string) => {
      void (async () => {
        const relativePath = chatPathToRelative(rawPath, workspacePath);
        if (relativePath) {
          const opened = await openFile({
            name: basename(relativePath),
            relativePath,
            absolutePath: `${workspacePath}/${relativePath}`,
            kind: "file",
            hasChildren: false,
          });
          if (opened) return;
          const match = await findWorkspaceFileByPath(relativePath);
          if (
            match &&
            match.relativePath !== relativePath &&
            (await openFile(match))
          ) {
            pushNotice("info", `Ouvert : ${match.relativePath}`);
            return;
          }
          pushNotice("error", `Fichier introuvable : ${relativePath}`);
          return;
        }
        const cleaned = cleanChatFilePath(rawPath).replace(/\\/g, "/");
        if (!cleaned || cleaned.includes("://")) return;
        // axe:liens — chemin absolu hors de l'espace (Windows « C:/… », réseau « //… »,
        // Linux/macOS « /… ») : ouvert en lecture dans l'éditeur.
        if (/^[a-zA-Z]:\//.test(cleaned) || cleaned.startsWith("/")) {
          if (await openExternalFile(cleaned)) return;
          const match = await findWorkspaceFileByPath(cleaned);
          if (match && (await openFile(match))) {
            pushNotice("info", `Ouvert : ${match.relativePath}`);
            return;
          }
          pushNotice("error", `Fichier introuvable : ${cleaned}`);
        }
      })();
    },
    [
      findWorkspaceFileByPath,
      openExternalFile,
      openFile,
      pushNotice,
      workspacePath,
    ],
  );

  // Dispatch a raw path picked from the terminal (cmd+click). Resolves
  // the path on the backend and routes to the right editor / file-tree
  // / Finder helper depending on whether it is a file, a directory, in
  // or out of the active workspace.
  const openTerminalPath = useCallback(
    async (rawPath: string) => {
      const trimmed = rawPath.trim();
      if (!trimmed) return;
      try {
        const resolution = await api.resolveTerminalPath(workspacePath, trimmed);
        if (resolution.kind === "missing") return;

        const buildReveal = () => {
          if (resolution.line == null) return undefined;
          const lineNumber = Math.max(1, resolution.line);
          const columnStart = Math.max(1, resolution.column ?? 1);
          return {
            lineNumber,
            columnStart,
            columnEnd: columnStart + 1,
          };
        };

        if (resolution.kind === "directory") {
          if (!resolution.isOutsideWorkspace && resolution.relativePath != null) {
            void api.revealEntry(workspacePath, resolution.relativePath);
          } else {
            void api.revealAbsolutePath(resolution.absolutePath);
          }
          return;
        }

        // kind === "file"
        if (!resolution.isOutsideWorkspace && resolution.relativePath != null) {
          const reveal = buildReveal();
          await openFile(
            {
              name: basename(resolution.relativePath),
              relativePath: resolution.relativePath,
              absolutePath: resolution.absolutePath,
              kind: "file",
              hasChildren: false,
            },
            reveal ? { ...reveal, query: "" } : undefined,
          );
        } else {
          await openExternalFile(resolution.absolutePath, buildReveal());
        }
      } catch (err) {
        console.error("Unable to resolve terminal path", rawPath, err);
      }
    },
    [openExternalFile, openFile, workspacePath],
  );

  const closeTab = useCallback((index: number) => {
    const tabCount = tabsRef.current.length;
    if (index < 0 || index >= tabCount) return;

    setTabs((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      next.splice(index, 1);
      return next;
    });
    setActiveTabIndex((active) => {
      const nextLength = tabCount - 1;
      if (nextLength <= 0) return -1;
      if (active === index) return Math.min(index, nextLength - 1);
      if (active > index) return active - 1;
      return Math.min(active, nextLength - 1);
    });
  }, []);

  const closeRemote = useCallback(() => {
    setRemoteOpen(false);
    setRemoteActive(false);
  }, []);

  const closeActiveEditorTab = useCallback(() => {
    if (remoteActive) {
      closeRemote();
      return;
    }
    if (settingsActive) {
      closeSettings();
      return;
    }
    if (activeTabIndex >= 0) closeTab(activeTabIndex);
  }, [activeTabIndex, closeRemote, closeSettings, closeTab, remoteActive, settingsActive]);

  const handleTreeEntryRenamed = useCallback(
    (oldRelativePath: string, entry: WorkspaceEntry) => {
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.external) return tab;
          const nextPath = replaceTreePath(
            tab.relativePath,
            oldRelativePath,
            entry,
          );
          if (!nextPath) return tab;
          return retargetTab(tab, nextPath, workspacePath, entry);
        }),
      );
    },
    [workspacePath],
  );

  const handleTreeEntryDeleted = useCallback((entry: WorkspaceEntry) => {
    setTabs((prev) =>
      prev.filter(
        (tab) =>
          tab.external || tab.dirty || !entryContainsPath(entry, tab.relativePath),
      ),
    );
  }, []);

  const handleTreeEntriesMoved = useCallback(
    (moves: { from: WorkspaceEntry; to: WorkspaceEntry }[]) => {
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.external) return tab;
          for (const move of moves) {
            const nextPath = replaceTreePath(
              tab.relativePath,
              move.from.relativePath,
              move.to,
            );
            if (nextPath) {
              return retargetTab(tab, nextPath, workspacePath, move.to);
            }
          }
          return tab;
        }),
      );
    },
    [workspacePath],
  );

  useEffect(() => {
    if (activeTabIndex >= tabs.length) {
      setActiveTabIndex(tabs.length - 1);
    }
  }, [tabs.length, activeTabIndex]);

  const updateBuffer = useCallback((index: number, value: string) => {
    setTabs((prev) => {
      const next = prev.slice();
      const tab = next[index];
      if (!tab) return prev;
      // External (read-only) tabs are never dirty and should never have
      // their buffer mutated by Monaco onChange events.
      if (tab.external) return prev;
      next[index] = {
        ...tab,
        buffer: value,
        dirty: value !== (tab.doc.content ?? ""),
      };
      return next;
    });
  }, []);

  const saveTab = useCallback(
    async (index: number) => {
      const tab = tabs[index];
      if (!tab || !tab.dirty || tab.external) return;
      try {
        const updated = await api.writeFile(
          workspacePath,
          tab.relativePath,
          tab.buffer,
        );
        setTabs((prev) => {
          const next = prev.slice();
          if (!next[index]) return prev;
          next[index] = {
            ...next[index],
            doc: updated,
            buffer: updated.content ?? next[index].buffer,
            dirty: false,
          };
          return next;
        });
      } catch (err) {
        console.error(err);
        // axe:v2-l6 — hors ligne : message court au lieu de l'erreur brute.
        if (err instanceof CloudOfflineError) {
          pushNotice("error", err.message);
        }
      }
    },
    [pushNotice, workspacePath, tabs],
  );

  // axe:v2-l6 (tranche 2) — tranche un conflit de synchronisation.
  const handleResolveConflict = useCallback(
    async (relativePath: string, keep: "local" | "server" | "both") => {
      try {
        await resolveOfflineConflict(workspacePath, relativePath, keep);
        refreshFileTreeSoon();
        // « les deux » : l'espace garde sa version a sa place, la mienne devient
        // un voisin — l'onglet ouvert suit donc la version de l'espace.
        if (keep !== "local") void refreshOpenTabFromDisk(relativePath);
      } catch (err) {
        console.error(err);
      }
    },
    [workspacePath, refreshFileTreeSoon, refreshOpenTabFromDisk],
  );


  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen(CLOSE_ACTIVE_TAB_EVENT, () => {
      closeActiveEditorTab();
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [closeActiveEditorTab]);

  // ---------------- Event subscriptions ----------------

  const agentSubsRef = useRef<
    Set<(conversationId: string, event: AgentEvent, sequence?: number) => void>
  >(new Set());

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    (async () => {
      const u = await listen<ConversationEventPayload>(
        "agent-event",
        (event) => {
          const payload = event.payload;
          if (
            payload.workspaceId &&
            payload.workspaceId !== workspacePathRef.current
          ) {
            return;
          }
          if (typeof payload.sequence === "number") {
            const last =
              lastAgentEventSequenceByConversationRef.current.get(
                payload.conversationId,
              ) ?? 0;
            // The backend's per-turn sequence resets to 1 when a new turn
            // registers. A strictly *lower* sequence than what we cached
            // therefore means a brand-new turn started for this
            // conversation — accept the event and forget the stale "last"
            // from the previous turn. Equal sequences are real duplicates
            // (typically a replay/live overlap) and stay filtered.
            if (payload.sequence === last && last !== 0) return;
            lastAgentEventSequenceByConversationRef.current.set(
              payload.conversationId,
              payload.sequence,
            );
          }
          for (const handler of agentSubsRef.current) {
            handler(payload.conversationId, payload.event, payload.sequence);
          }
        },
      );
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Phone-driven changes (SavIDE Remote): the backend emits
  // "conversations-changed" whenever a paired device creates or deletes a
  // conversation in this workspace. Mirror it here live so the desktop
  // never needs a workspace reopen to catch up.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    (async () => {
      const u = await listen<{ workspaceId: string }>(
        "conversations-changed",
        (event) => {
          if (event.payload.workspaceId !== workspacePathRef.current) return;
          void (async () => {
            try {
              const workspaceAtRequest = workspacePathRef.current;
              const summaries =
                await api.listConversations(workspaceAtRequest);
              if (workspacePathRef.current !== workspaceAtRequest) return;
              setConversations(summaries);
              const activeId = activeConvIdRef.current;
              if (summaries.some((summary) => summary.id === activeId)) {
                return;
              }
              // The conversation we were viewing was deleted remotely.
              if (summaries.length > 0) {
                await selectConversation(summaries[0].id);
              } else {
                // La conversation regardee a ete supprimee ailleurs : il n'y a
                // plus rien a ouvrir, on repart d'une conversation neuve (sans
                // personne a qui demander le nom).
                await createConversation("Nouvelle conversation");
              }
            } catch (err) {
              console.error(err);
            }
          })();
        },
      );
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [selectConversation, createConversation]);

  const subscribeEvents = useCallback(
    (
      handler: (
        conversationId: string,
        event: AgentEvent,
        sequence?: number,
      ) => void,
    ) => {
      agentSubsRef.current.add(handler);
      return () => {
        agentSubsRef.current.delete(handler);
      };
    },
    [],
  );

  const replayActiveTurnEvents = useCallback(
    async (conversationId: string, afterSequence = 0) => {
      const workspaceAtRequest = workspacePathRef.current;
      let replay = await api.replayActiveTurnEvents(
        workspaceAtRequest,
        conversationId,
        afterSequence,
      );
      if (workspacePathRef.current !== workspaceAtRequest) return;
      if (!replay.active) {
        markConversationStreaming(conversationId, false);
        return;
      }
      // The backend resets per-turn sequences to 1 on each register_active_turn.
      // If the server's latest sequence is *below* our cached afterSequence, the
      // turn we knew about has ended and a fresh one started — our cached
      // "last" would otherwise filter out every event of the new turn. Drop it
      // and refetch the active turn's buffer from scratch.
      if (replay.latestSequence < afterSequence) {
        lastAgentEventSequenceByConversationRef.current.delete(conversationId);
        replay = await api.replayActiveTurnEvents(
          workspaceAtRequest,
          conversationId,
          0,
        );
        if (workspacePathRef.current !== workspaceAtRequest) return;
        if (!replay.active) {
          markConversationStreaming(conversationId, false);
          return;
        }
      }
      markConversationStreaming(conversationId, true);
      const sortedEvents = [...replay.events].sort(
        (a, b) => a.sequence - b.sequence,
      );
      for (const entry of sortedEvents) {
        const last =
          lastAgentEventSequenceByConversationRef.current.get(conversationId) ?? 0;
        // Same logic as the live `agent-event` handler: only filter true
        // duplicates. A strictly *lower* sequence is impossible inside a
        // single replay batch (events are sorted), but be defensive in case
        // the backend ever interleaves turns.
        if (entry.sequence === last && last !== 0) continue;
        lastAgentEventSequenceByConversationRef.current.set(
          conversationId,
          entry.sequence,
        );
        for (const handler of agentSubsRef.current) {
          handler(conversationId, entry.event, entry.sequence);
        }
      }
    },
    [markConversationStreaming],
  );

  useEffect(() => {
    replayActiveTurnEventsRef.current = replayActiveTurnEvents;
  }, [replayActiveTurnEvents]);

  const syncActiveTurns = useCallback(
    (activeTurns: ActiveTurnSummary[]) => {
      const workspaceTurns = activeTurns.filter(
        (turn) => turn.workspaceId === workspacePathRef.current,
      );
      const activeIds = new Set(workspaceTurns.map((turn) => turn.conversationId));
      setStreamingConversationIds((prev) => {
        let changed = false;
        for (const id of prev) {
          if (!activeIds.has(id)) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          for (const id of activeIds) {
            if (!prev.has(id)) {
              changed = true;
              break;
            }
          }
        }
        return changed ? activeIds : prev;
      });
      setStreamingModelsByConversation((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const id of Array.from(next.keys())) {
          if (!activeIds.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      for (const turn of workspaceTurns) {
        let last =
          lastAgentEventSequenceByConversationRef.current.get(turn.conversationId) ?? 0;
        // A freshly-registered turn always starts at latestSequence = 0
        // (next_sequence = 1 on the backend). If our cached "last" from a
        // prior turn is higher, the per-turn counter has rolled over and
        // the cached value would otherwise filter out every live event of
        // the new turn. Drop it so the upcoming sequence=1 event is
        // accepted.
        if (turn.latestSequence < last) {
          lastAgentEventSequenceByConversationRef.current.delete(
            turn.conversationId,
          );
          last = 0;
        }
        if (turn.latestSequence > last) {
          void replayActiveTurnEvents(turn.conversationId, last).catch((err) => {
            console.error(err);
          });
        }
      }
    },
    [replayActiveTurnEvents],
  );

  useEffect(() => {
    const handler = async (conversationId: string, event: AgentEvent) => {
      const fileChanges = fileChangesFromAgentEvent(event);
      if (fileChanges.length > 0) {
        refreshChangedFiles(fileChanges);
      }

      if (event.type === "turn_started") {
        markConversationStreaming(conversationId, true);
        return;
      }
      if (event.type !== "turn_finished") {
        return;
      }
      markConversationStreaming(conversationId, false);
      const workspaceAtRequest = workspacePathRef.current;
      const shouldLoadActive = conversationId === activeConvIdRef.current;
      try {
        const summariesPromise = api.listConversations(workspaceAtRequest);
        const loadedPromise =
          shouldLoadActive
            ? api.loadConversation(workspaceAtRequest, conversationId)
            : Promise.resolve(null);
        const [loaded, summaries] = await Promise.all([
          loadedPromise,
          summariesPromise,
        ]);
        startTransition(() => {
          if (workspacePathRef.current !== workspaceAtRequest) return;
          if (
            loaded &&
            loaded.id === conversationId &&
            loaded.workspaceId === workspaceAtRequest &&
            activeConvIdRef.current === conversationId
          ) {
            setActiveConv(loaded);
          }
          setConversations(summaries);
        });
      } catch (err) {
        console.error(err);
      }
    };
    agentSubsRef.current.add(handler);
    return () => {
      agentSubsRef.current.delete(handler);
    };
  }, [markConversationStreaming, refreshChangedFiles]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listActiveTurns()
      .then((activeTurns) => {
        if (!cancelled) syncActiveTurns(activeTurns);
      })
      .catch((err) => {
        if (!cancelled) console.error(err);
      });
    return () => {
      cancelled = true;
    };
  }, [syncActiveTurns, workspacePath]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    (async () => {
      const u = await listen<ActiveTurnsChangedPayload>(
        "active-turns-changed",
        (event) => {
          syncActiveTurns(event.payload.activeTurns);
        },
      );
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [syncActiveTurns]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    (async () => {
      const u = await listen<WorkspaceFileChangedPayload>(
        "workspace-file-changed",
        async (event) => {
          const payload = event.payload;
          if (payload.workspacePath !== workspacePath) return;
          refreshFileTreeSoon();
          if (!payload.relativePath) return;
          void refreshOpenTabFromDisk(payload.relativePath);
        },
      );
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refreshFileTreeSoon, refreshOpenTabFromDisk, workspacePath]);

  const externalDropFeed = useMemo<ExternalDropFeed>(
    () => ({
      subscribe(handler) {
        dropSubsRef.current.add(handler);
        return () => {
          dropSubsRef.current.delete(handler);
        };
      },
      subscribeDrag(handler) {
        dragSubsRef.current.add(handler);
        return () => {
          dragSubsRef.current.delete(handler);
        };
      },
    }),
    [],
  );
  const dropSubsRef = useRef<
    Set<
      (attachments: { path: string; name: string; origin: "finder" }[]) => void
    >
  >(new Set());
  const dragSubsRef = useRef<Set<(active: boolean) => void>>(new Set());
  const chatDropZoneRef = useRef<HTMLDivElement | null>(null);
  // axe:e17b — les colonnes sans focus ne reçoivent pas les fichiers déposés.
  const chatDropZoneMorteRef = useRef<HTMLDivElement | null>(null);
  const fileTreeDropZoneRef = useRef<HTMLDivElement | null>(null);
  const [fileTreeDropState, setFileTreeDropState] = useState<{
    active: boolean;
    targetRelative: string | null;
  }>({ active: false, targetRelative: null });
  const [importError, setImportError] = useState<string | null>(null);

  const findFolderTargetAt = useCallback(
    (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const row = (el as Element).closest?.(
        ".tree-row[data-kind='directory']",
      ) as HTMLElement | null;
      if (!row) return null;
      return row.dataset.dropPath ?? null;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    (async () => {
      try {
        const u = await getCurrentWebview().onDragDropEvent(async (event) => {
          const type = event.payload.type;
          const position =
            "position" in event.payload ? event.payload.position : null;
          const chatRect = chatDropZoneRef.current?.getBoundingClientRect();
          const sidebarRect =
            fileTreeDropZoneRef.current?.getBoundingClientRect();
          const overChat = (() => {
            if (!chatRect || !position) return false;
            return (
              position.x >= chatRect.left &&
              position.x <= chatRect.right &&
              position.y >= chatRect.top &&
              position.y <= chatRect.bottom
            );
          })();
          const overSidebar = (() => {
            if (overChat) return false;
            if (!sidebarRect || !position) return false;
            return (
              position.x >= sidebarRect.left &&
              position.x <= sidebarRect.right &&
              position.y >= sidebarRect.top &&
              position.y <= sidebarRect.bottom
            );
          })();

          if (type === "enter" || type === "over") {
            for (const handler of dragSubsRef.current) handler(overChat);
            if (overSidebar && position) {
              const target = findFolderTargetAt(position.x, position.y);
              setFileTreeDropState({ active: true, targetRelative: target });
            } else {
              setFileTreeDropState((prev) =>
                prev.active ? { active: false, targetRelative: null } : prev,
              );
            }
            return;
          }
          if (type === "leave") {
            for (const handler of dragSubsRef.current) handler(false);
            setFileTreeDropState({ active: false, targetRelative: null });
            return;
          }
          if (type === "drop") {
            for (const handler of dragSubsRef.current) handler(false);
            setFileTreeDropState({ active: false, targetRelative: null });
            const paths = event.payload.paths ?? [];
            if (!paths.length) return;
            if (overChat) {
              const attachments = paths.map((path) => ({
                path,
                name: basename(path),
                origin: "finder" as const,
              }));
              for (const handler of dropSubsRef.current) handler(attachments);
              return;
            }
            if (overSidebar && position) {
              const target = findFolderTargetAt(position.x, position.y);
              try {
                setImportError(null);
                await api.importPaths(workspacePath, paths, target ?? undefined);
                refreshFileTree();
              } catch (err) {
                console.error(err);
                setImportError(String(err));
              }
            }
          }
        });
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      } catch (err) {
        console.warn("webview drag-drop unavailable", err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [workspacePath, findFolderTargetAt, refreshFileTree]);

  // E17a — toutes les actions prennent explicitement leur conversation. Ainsi
  // un futur ChatPane dans une autre colonne ne peut pas envoyer/arrêter le fil actif par erreur.
  const sendMessageForConversation = useCallback(
    async (
      conversation: SavedConversation,
      text: string,
      attachments: { path: string; name?: string }[],
      model: SavedConversation["model"],
      thinking: ThinkingLevel,
      mode: AgentMode,
      serviceTier?: ServiceTier | null,
      rewriteFromHistoryIndex?: number,
      planControl?: PlanControl,
      messageVisibility?: MessageVisibility,
      revertWorkspaceChanges?: boolean,
    ) => {
      const conversationId = conversation.id;
      const workspaceAtRequest = workspacePath;
      const optimisticTitle = titleFromOutgoingUserText(text);
      const shouldUpdateTitleFromUserMessage =
        messageVisibility !== "systemReminder" &&
        Boolean(optimisticTitle) &&
        (rewriteFromHistoryIndex === 0 ||
          (rewriteFromHistoryIndex === undefined && conversation.history.length === 0));

      if (shouldUpdateTitleFromUserMessage && optimisticTitle) {
        applyOptimisticConversationTitle(conversationId, optimisticTitle);
      }

      markConversationStreamingModel(conversationId, model, thinking);
      markConversationStreaming(conversationId, true);
      try {
        await sendMessageWithBusyRetry(
          workspaceAtRequest,
          conversationId,
          text,
          attachments,
          model,
          thinking,
          mode,
          serviceTier,
          rewriteFromHistoryIndex,
          planControl,
          messageVisibility,
          revertWorkspaceChanges,
        );
      } catch (err) {
        markConversationStreaming(conversationId, false);
        void refreshConversationAfterMessageStart(
          workspaceAtRequest,
          conversationId,
        ).catch((refreshErr) => console.error(refreshErr));
        throw err;
      }

      void refreshConversationAfterMessageStart(
        workspaceAtRequest,
        conversationId,
      ).catch((err) => console.error(err));
    },
    [
      workspacePath,
      applyOptimisticConversationTitle,
      markConversationStreaming,
      markConversationStreamingModel,
      refreshConversationAfterMessageStart,
    ],
  );

  const compactConversationFor = useCallback(
    async (
      conversation: SavedConversation,
      model: SavedConversation["model"],
      thinking: ThinkingLevel,
      serviceTier?: ServiceTier | null,
      options?: { continueAfter?: boolean; instruction?: string },
    ) => {
      const conversationId = conversation.id;
      const continueAfter = options?.continueAfter ?? true;
      const continuationMode = conversationContinuationMode(conversation);
      const continuationPrompt =
        continueAfter && continuationMode === "goal"
          ? GOAL_COMPACTION_CONTINUATION_PROMPT
          : COMPACTION_CONTINUATION_PROMPT;
      // axe:file-attente — la compaction finit par un « turn_finished »
      // (src-tauri/src/turns.rs:719) et Workspace remet « en cours » à faux
      // (ci-dessous) AVANT d'envoyer la relance, après deux await : la file
      // d'attente envoyait son message dans ce trou. La conversation reste
      // occupée jusqu'à ce que la relance soit partie.
      const files = filesPartagees();
      files.occuper(conversationId);
      markConversationStreamingModel(conversationId, model, thinking);
      markConversationStreaming(conversationId, true);
      try {
        await api.compactConversation(
          workspacePath,
          conversationId,
          model,
          thinking,
          serviceTier,
          options?.instruction,
        );

        markConversationStreaming(conversationId, false);

        const [loaded, summaries] = await Promise.all([
          api.loadConversation(workspacePath, conversationId),
          api.listConversations(workspacePath),
        ]);
        if (workspacePathRef.current !== workspacePath) return;

        setConversations(summaries);
        if (activeConvIdRef.current === conversationId) {
          setActiveConv(loaded);
        }

        if (!continueAfter) return;

        await sleep(0);

        markConversationStreamingModel(conversationId, model, thinking);
        markConversationStreaming(conversationId, true);
        await sendMessageWithBusyRetry(
          workspacePath,
          conversationId,
          continuationPrompt,
          [],
          model,
          thinking,
          continuationMode,
          serviceTier,
          undefined,
          undefined,
          "systemReminder",
        );

        const reloaded = await api.loadConversation(workspacePath, conversationId);
        if (
          workspacePathRef.current === workspacePath &&
          activeConvIdRef.current === conversationId
        ) {
          setActiveConv((current) =>
            current.id === conversationId ? reloaded : current,
          );
        }
      } catch (err) {
        markConversationStreaming(conversationId, false);
        throw err;
      } finally {
        files.liberer(conversationId);
      }
    },
    [workspacePath, markConversationStreaming, markConversationStreamingModel],
  );

  const changeConversationModeFor = useCallback(
    async (conversation: SavedConversation, mode: AgentMode) => {
      const conversationId = conversation.id;
      const updated = await api.setConversationMode(
        workspacePath,
        conversationId,
        mode,
      );
      const summaries = await api.listConversations(workspacePath);
      startTransition(() => {
        setActiveConv((current) =>
          current.id === conversationId ? updated : current,
        );
        setConversations(summaries);
      });
    },
    [workspacePath],
  );

  const changeConversationModelPreferenceFor = useCallback(
    async (
      conversation: SavedConversation,
      mode: AgentMode,
      model: SavedConversation["model"],
      thinking: ThinkingLevel,
    ) => {
      const conversationId = conversation.id;
      const selected = modelRefWithThinking(model, thinking);
      const local = () =>
        api.setConversationModelPreference(workspacePath, conversationId, mode, model, thinking);
      // axe:parcours-collegue — conversation d'espace inconnue du PC : modèle posé sur le service.
      const updated = cloudConnection
        ? await preferenceModeleEspace(
            local,
            () => cloudRpc(cloudConnection, "sessions.set_model", { sessionId: conversationId, model: selected }),
            selected,
          )
        : await local();
      setGlobalModeModelSettings((current) => ({
        ...current,
        [mode]: selected,
      }));
      startTransition(() => {
        setActiveConv((current) =>
          current.id === conversationId
            ? {
                ...current,
                model: selected,
                modeModelSettings: updated,
              }
            : current,
        );
      });
    },
    [workspacePath, cloudConnection],
  );

  const implementPlanFreshForConversation = useCallback(
    async (
      _conversation: SavedConversation,
      plan: PlanArtifact,
      prompt = "Implement completely this plan. Use the attached markdown plan as the source of truth.",
    ) => {
      const next = await api.createConversation(workspacePath);
      const conversationId = next.activeConversation.id;
      // Une conversation neuve reçoit le modèle global le plus récent, quel que
      // soit le fil depuis lequel l'action « implémenter » a été déclenchée.
      const seedModel = next.activeConversation.modeModelSettings.act;
      const seedThinking = thinkingFromRef(seedModel);
      const title = titleFromPlanImplementation(plan);
      const titledActiveConversation = {
        ...next.activeConversation,
        title,
      };
      const titledConversations = await api.renameConversation(
        workspacePath,
        conversationId,
        title,
      );
      activeConvIdRef.current = conversationId;
      setConversations(titledConversations);
      setActiveConv(titledActiveConversation);
      setGlobalModeModelSettings(next.modeModelSettings);
      onBootstrapReplace({
        ...next,
        conversations: titledConversations,
        activeConversation: titledActiveConversation,
      });
      markConversationStreamingModel(conversationId, seedModel, seedThinking);
      markConversationStreaming(conversationId, true);
      try {
        await sendMessageWithBusyRetry(
          workspacePath,
          conversationId,
          prompt,
          [
            {
              path: plan.absolutePath ?? plan.path,
              name: basename(plan.path),
            },
          ],
          seedModel,
          seedThinking,
          "act",
          null,
          undefined,
          "implementPlan",
          "systemReminder",
        );
        const loaded = await api.loadConversation(workspacePath, conversationId);
        startTransition(() => {
          setActiveConv((current) =>
            current.id === conversationId ? loaded : current,
          );
        });
      } catch (err) {
        markConversationStreaming(conversationId, false);
        throw err;
      }
    },
    [workspacePath, markConversationStreaming, markConversationStreamingModel, onBootstrapReplace],
  );

  // axe:stop-force — Stop ne reste jamais sans effet (voir chat/arretForce.ts) :
  // encore en cours 10 s apres Stop => « Arret force… » et arret renvoye ; un
  // clic sur « Arret force… », ou un arret que personne ne prend (tour
  // fantome), libere la conversation dans toutes ses vues.
  const demandesArretRef = useRef<DemandesArret>(new Map());
  const [demandesArret, setDemandesArret] = useState<DemandesArret>(demandesArretRef.current);
  const majDemandesArret = useCallback(
    (maj: (actuel: DemandesArret) => DemandesArret) => {
      const suivant = maj(demandesArretRef.current);
      if (suivant === demandesArretRef.current) return;
      demandesArretRef.current = suivant;
      setDemandesArret(suivant);
    },
    [],
  );
  const libererConversation = useCallback((conversationId: string) => {
    // Comme un tour termine cote moteur : chaque vue sort de « en cours ».
    for (const handler of Array.from(agentSubsRef.current)) {
      handler(conversationId, { type: "interrupted" });
      handler(conversationId, { type: "turn_finished", duration_ms: null });
    }
  }, []);
  const envoyerArret = useCallback(
    async (conversationId: string, liberer: boolean) => {
      let pris = false;
      try {
        pris = await api.cancelTurn(workspacePath, conversationId);
      } catch (err) {
        console.error(err);
      }
      // axe:stuck - tour fantome (plus rien cote moteur) : Stop libere toujours l'etat local.
      markConversationStreaming(conversationId, false);
      if (liberer || !pris) libererConversation(conversationId);
    },
    [workspacePath, markConversationStreaming, libererConversation],
  );
  useEffect(() => {
    const handler = (conversationId: string, event: AgentEvent) => {
      if (clotLaDemande(event.type)) majDemandesArret((m) => clore(m, conversationId));
    };
    agentSubsRef.current.add(handler);
    return () => {
      agentSubsRef.current.delete(handler);
    };
  }, [majDemandesArret]);
  useEffect(() => {
    majDemandesArret((m) => (m.size === 0 ? m : new Map()));
  }, [workspacePath, majDemandesArret]);
  useEffect(() => {
    const maintenant = Date.now();
    const minuteries: number[] = [];
    for (const [conversationId, demande] of demandesArret) {
      const delai = delaiAvantForcage(demande, maintenant);
      if (delai === null) continue;
      minuteries.push(
        window.setTimeout(() => {
          if (!demandesArretRef.current.has(conversationId)) return;
          majDemandesArret((m) => forcer(m, conversationId));
          void envoyerArret(conversationId, false);
        }, delai),
      );
    }
    return () => minuteries.forEach((minuterie) => window.clearTimeout(minuterie));
  }, [demandesArret, majDemandesArret, envoyerArret]);

  const stopTurnForConversation = useCallback(
    async (conversation: SavedConversation) => {
      const liberer = libereAuClic(demandesArretRef.current.get(conversation.id));
      majDemandesArret((m) => demander(m, conversation.id, Date.now()));
      await envoyerArret(conversation.id, liberer);
    },
    [majDemandesArret, envoyerArret],
  );

  // axe:arriere-plan — « Arrière-plan » : le travail en cours continue dans une
  // session d'arrière-plan, enfant de la conversation (vue Agents), et la
  // conversation est libérée (voir chat/arrierePlan.ts).
  const mettreConversationEnArrierePlan = useCallback(
    async (conversation: SavedConversation) => {
      const connexion = cloudConnection ?? LOCAL_CONNECTION;
      const resultat = await mettreEnArrierePlan(
        {
          arreter: (id) => agentsApi.stop(id, connexion),
          statut: async (id) => (await agentsApi.get(id, connexion)).status ?? null,
          forker: (id, nom, parentId) => agentsApi.fork(id, undefined, nom, connexion, parentId),
          envoyer: (id, texte) => agentsApi.send(id, texte, connexion),
          attendre: (ms) => sleep(ms),
          // axe:bg-a — la conversation est prévenue (message système, sans lancer de tour).
          prevenir: (conversationId, depuis, texte) =>
            agentsApi.call("sessions.message", { sessionId: conversationId, from: depuis, text: texte, wake: false }, connexion),
        },
        { id: conversation.id, titre: conversation.title },
      );
      // Le démon a fini le tour : le pont le dit d'habitude dans la foulée ;
      // sinon, au bout de 3 s, chaque vue sort de « en cours » ici.
      for (let i = 0; i < 30 && streamingIdsRef.current.has(conversation.id); i += 1) {
        await sleep(100);
      }
      if (streamingIdsRef.current.has(conversation.id)) libererConversation(conversation.id);
      return resultat;
    },
    [cloudConnection, libererConversation],
  );

  const conversationExecutors = useMemo(
    () => ({
      send: sendMessageForConversation,
      compact: compactConversationFor,
      changeMode: changeConversationModeFor,
      changeModelPreference: changeConversationModelPreferenceFor,
      implementPlanFresh: implementPlanFreshForConversation,
      stop: stopTurnForConversation,
      background: mettreConversationEnArrierePlan, // axe:arriere-plan
    }),
    [
      sendMessageForConversation,
      compactConversationFor,
      changeConversationModeFor,
      changeConversationModelPreferenceFor,
      implementPlanFreshForConversation,
      stopTurnForConversation,
      mettreConversationEnArrierePlan,
    ],
  );
  const activeConversationActions = useMemo(
    () => createConversationActions(activeConv, conversationExecutors),
    [activeConv, conversationExecutors],
  );

  // ---------------- Layout state ----------------
  // axe:e18 — detacher libere la place : un volet detache se replie en liseré et
  // le voisin prend le terrain. C'est le but du geste (retour de l'utilisateur).
  const explorateurDetache = volets.estDetache("explorateur");
  const panneauBasDetache = volets.estDetache("panneauBas");
  const gaucheRepliee = explorateurDetache && panneauBasDetache;
  const chatDetacheSeul =
    chatDetache !== null && ongletsChat.filter((t) => t.id !== chatDetache).length === 0;
  const droiteRepliee = volets.estDetache("chat") || chatDetacheSeul;
  // Demande de l'utilisateur : réduire entièrement un volet (Ctrl+B gauche, Ctrl+Alt+B
  // droite) pour donner toute la place au terminal ou au chat ; état mémorisé.
  const [gaucheReduite, setGaucheReduite] = useState(() => {
    try { return localStorage.getItem("axe:volet-gauche-reduit") === "1"; } catch { return false; }
  });
  const [droiteReduite, setDroiteReduite] = useState(() => {
    try { return localStorage.getItem("axe:volet-droit-reduit") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try {
      localStorage.setItem("axe:volet-gauche-reduit", gaucheReduite ? "1" : "0");
      localStorage.setItem("axe:volet-droit-reduit", droiteReduite ? "1" : "0");
    } catch { /* stockage indisponible : l'état vit le temps de la session */ }
  }, [gaucheReduite, droiteReduite]);
  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.code !== "KeyB") return;
      e.preventDefault();
      if (e.altKey) setDroiteReduite((v) => !v);
      else setGaucheReduite((v) => !v);
    };
    window.addEventListener("keydown", touche, true);
    return () => window.removeEventListener("keydown", touche, true);
  }, []);
  const [leftWidth, setLeftWidth] = useState(INITIAL_LEFT);
  const [rightWidth, setRightWidth] = useState(INITIAL_RIGHT);
  // axe:barre-titre — les boutons de la barre s'arrêtent avant la marque (et la
  // pastille de mise à jour) : jamais de chevauchement, même fenêtre étroite.
  const barreTitreRef = useRef<HTMLDivElement | null>(null);
  const [largeurDroiteBarre, setLargeurDroiteBarre] = useState(0);
  // axe:barre-place — et à gauche, la place des éléments posés en début de barre
  // (quota d'abonnement, import cloud) : les boutons prennent tout le reste de la
  // barre au lieu de la seule largeur de l'éditeur (rognés à 800-1024 px, et dès
  // que le chat s'élargit pour ses colonnes).
  const [largeurGaucheBarre, setLargeurGaucheBarre] = useState(0);
  useEffect(() => {
    const barre = barreTitreRef.current;
    if (!barre || typeof ResizeObserver === "undefined") return;
    const cibles = () =>
      Array.from(barre.querySelectorAll<HTMLElement>(".titlebar__brand, .titlebar__update"));
    const aGauche = () =>
      Array.from(barre.children).filter(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          !el.matches(".titlebar__actions, .titlebar__brand, .titlebar__update, .titlebar__window-controls") &&
          getComputedStyle(el).position !== "absolute",
      );
    const mesurer = () => {
      const boite = barre.getBoundingClientRect();
      let gauche = boite.right;
      for (const el of cibles()) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) gauche = Math.min(gauche, r.left);
      }
      const besoin = Math.max(0, Math.ceil(boite.right - gauche) + 8);
      setLargeurDroiteBarre((v) => (v === besoin ? v : besoin));
      let droite = boite.left;
      for (const el of aGauche()) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) droite = Math.max(droite, r.right);
      }
      const besoinGauche = Math.max(0, Math.ceil(droite - boite.left) + 8);
      setLargeurGaucheBarre((v) => (v === besoinGauche ? v : besoinGauche));
    };
    const tailles = new ResizeObserver(mesurer);
    const suivre = () => {
      tailles.disconnect();
      tailles.observe(barre);
      for (const el of cibles()) tailles.observe(el);
      for (const el of aGauche()) tailles.observe(el);
      mesurer();
    };
    // La pastille de mise à jour apparaît plus tard : on suit les ajouts.
    const ajouts = new MutationObserver(suivre);
    ajouts.observe(barre, { childList: true });
    suivre();
    return () => {
      ajouts.disconnect();
      tailles.disconnect();
    };
  }, []);
  const [topSplit, setTopSplit] = useState(INITIAL_SPLIT_TOP);
  const [terminalAvailable, setTerminalAvailable] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalFullHeight, setTerminalFullHeight] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(INITIAL_TERMINAL_HEIGHT);

  const clampColumn = useCallback((v: number) => {
    if (typeof window === "undefined") return v;
    const max = window.innerWidth * MAX_COL_RATIO;
    return Math.max(MIN_COL, Math.min(max, v));
  }, []);

  const clampTerminal = useCallback((v: number) => {
    if (typeof window === "undefined") return v;
    const max = Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight * MAX_TERMINAL_RATIO);
    return Math.max(MIN_TERMINAL_HEIGHT, Math.min(max, v));
  }, []);

  const showTerminal = useCallback(() => {
    setTerminalAvailable(true);
    setTerminalOpen(true);
    setTerminalHeight((value) => clampTerminal(value));
  }, [clampTerminal]);

  const hideTerminal = useCallback(() => {
    setTerminalOpen(false);
    setTerminalFullHeight(false);
  }, []);

  const closeTerminalPanel = useCallback(() => {
    setTerminalOpen(false);
    setTerminalFullHeight(false);
    setTerminalAvailable(false);
  }, []);

  const toggleTerminal = useCallback(() => {
    if (terminalOpen) {
      hideTerminal();
    } else {
      showTerminal();
    }
  }, [hideTerminal, showTerminal, terminalOpen]);
  toggleTerminalRef.current = toggleTerminal;

  const toggleTerminalFullHeight = useCallback(() => {
    setTerminalFullHeight((value) => !value);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen(TERMINAL_OPEN_EVENT, () => {
      showTerminal();
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showTerminal]);

  const sidebarHeightRef = useRef<HTMLDivElement | null>(null);
  const applyTopDelta = useCallback((delta: number) => {
    const el = sidebarHeightRef.current;
    if (!el) return;
    const h = el.clientHeight;
    if (h <= 0) return;
    setTopSplit((prev) => {
      const nextPx = Math.max(80, Math.min(h - 80, prev * h + delta));
      return nextPx / h;
    });
  }, []);

  const onDragFile = useCallback(
    (entry: WorkspaceEntry, event: React.DragEvent) => {
      if (entry.kind !== "file") return;
      const payload = JSON.stringify({
        relativePath: entry.relativePath,
        absolutePath: entry.absolutePath,
        name: entry.name,
      });
      event.dataTransfer.setData("application/x-axecode-file", payload);
      event.dataTransfer.setData("text/plain", entry.relativePath);
      event.dataTransfer.effectAllowed = "copy";
    },
    [],
  );

  const activeFilePath =
    !settingsActive && !remoteActive && activeTabIndex >= 0 && tabs[activeTabIndex]
      ? tabs[activeTabIndex].relativePath
      : null;
  const terminalVisible = terminalAvailable && terminalOpen;
  const activeConversationIsStreaming = streamingConversationIds.has(
    activeConv.id,
  );
  const activeStreamingModel = activeConversationIsStreaming
    ? streamingModelsByConversation.get(activeConv.id) ?? activeConv.model
    : null;
  const chatModeModelSettings = activeConv.modeModelSettings;

  // axe:e17b — colonnes de chat. Chaque colonne garde ses onglets ; la colonne
  // qui a le focus porte la conversation active (titre, raccourcis, liste de
  // gauche, sélection de texte) ; les autres montrent leur dernier fil lu.
  const [etatColonnesChat, setEtatColonnesChat] = useState<EtatColonnes<string>>(
    () =>
      relireColonnes(window.localStorage.getItem(`axe:v2:colonnes-chat:${workspacePath}`)) ?? {
        colonnes: [[]],
        focus: 0,
      },
  );
  const colonnesChat = etatColonnesChat.colonnes;
  // axe:colonnes-place — place demandée par les colonnes (une seule : la largeur réglée).
  const besoinColonnesChat =
    colonnesChat.length > 1
      ? colonnesChat.length * LARGEUR_MIN_COLONNE_CHAT + (colonnesChat.length - 1) + LARGEUR_AJOUT_COLONNE
      : 0;
  const largeurChat = Math.max(rightWidth, besoinColonnesChat);
  const [recentsChat, setRecentsChat] = useState<string[]>([]);
  const [conversationsColonnes, setConversationsColonnes] = useState<
    Record<string, SavedConversation>
  >({});
  useEffect(() => {
    try {
      window.localStorage.setItem(
        `axe:v2:colonnes-chat:${workspacePath}`,
        JSON.stringify(etatColonnesChat),
      );
    } catch {
      /* stockage plein : les colonnes vivent le temps de la session */
    }
  }, [etatColonnesChat, workspacePath]);
  // axe:hotfix-largeurs — largeur de chaque colonne de chat (poids flex), réglée
  // par la poignée entre deux colonnes ; double-clic = parts égales.
  const colonnesChatRef = useRef<HTMLDivElement | null>(null);
  const [poidsColonnesChat, setPoidsColonnesChat] = useState<number[]>(() => {
    try {
      const brut = JSON.parse(
        window.localStorage.getItem(`axe:v2:colonnes-chat-largeurs:${workspacePath}`) ?? "[]",
      );
      return Array.isArray(brut) ? brut : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        `axe:v2:colonnes-chat-largeurs:${workspacePath}`,
        JSON.stringify(poidsColonnesChat),
      );
    } catch {
      /* stockage plein : les largeurs vivent le temps de la session */
    }
  }, [poidsColonnesChat, workspacePath]);
  const poidsChat = poidsColonnesChatValides(poidsColonnesChat, colonnesChat.length);
  const redimensionnerColonneChat = useCallback(
    (index: number, delta: number) => {
      const hote = colonnesChatRef.current;
      if (!hote) return;
      let largeur = 0;
      for (const el of Array.from(hote.children))
        if (el.classList.contains("colonne-chat")) largeur += el.getBoundingClientRect().width;
      setPoidsColonnesChat((avant) =>
        redimensionnerPoids(poidsColonnesChatValides(avant, colonnesChat.length), index, delta, largeur),
      );
    },
    [colonnesChat.length],
  );
  // Les onglets sont la source des conversations ouvertes : chaque onglet a une
  // colonne (celle du focus par défaut), un onglet fermé quitte sa colonne.
  // axe:hotfix — le focus suit la conversation active (voir synchroniser).
  const idActifColonnesRef = useRef(activeConv.id);
  idActifColonnesRef.current = activeConv.id;
  useEffect(() => {
    setEtatColonnesChat((etat) =>
      synchroniserColonnes(
        etat,
        ongletsChat.map((t) => t.id),
        idActifColonnesRef.current,
      ),
    );
  }, [ongletsChat]);
  useEffect(() => {
    setEtatColonnesChat((etat) => suivreColonne(etat, activeConv.id));
  }, [activeConv.id]);
  // La conversation active : la plus récente, gardée en instantané pour sa
  // colonne quand le focus partira ailleurs ; et sa colonne prend le focus.
  useEffect(() => {
    setRecentsChat((r) => [activeConv.id, ...r.filter((id) => id !== activeConv.id)].slice(0, 64));
    setConversationsColonnes((m) => ({ ...m, [activeConv.id]: activeConv }));
    setEtatColonnesChat((etat) => {
      const ou = trouverColonne(etat.colonnes, activeConv.id);
      return ou ? focaliserColonne(etat, ou[0]) : etat;
    });
  }, [activeConv]);
  // axe:colonne-echec — chargement impossible (conversation supprimée ailleurs,
  // moteur pas prêt…) : un message avec « Réessayer » et « Fermer l'onglet » au
  // lieu d'« Ouverture de la conversation… » affiché pour toujours.
  const [echecsColonnes, setEchecsColonnes] = useState<Record<string, string>>({});
  const visibleDeColonne = useCallback(
    (colonne: string[]) => {
      if (colonne.includes(activeConv.id)) return activeConv.id;
      return recentsChat.find((id) => colonne.includes(id)) ?? colonne[0] ?? null;
    },
    [activeConv.id, recentsChat],
  );
  // Une colonne sans focus doit avoir son fil chargé pour être lisible (et la
  // conversation détachée aussi, même si aucune colonne ne la montre).
  useEffect(() => {
    const aCharger = new Set<string>();
    colonnesChat.forEach((colonne, index) => {
      if (index === etatColonnesChat.focus) return;
      const id = visibleDeColonne(colonne);
      if (id) aCharger.add(id);
    });
    if (chatDetache && chatDetache !== activeConv.id) aCharger.add(chatDetache);
    for (const id of aCharger) {
      if (conversationsColonnes[id] || echecsColonnes[id]) continue;
      void api
        .loadConversation(workspacePath, id)
        .then((c) => setConversationsColonnes((m) => ({ ...m, [c.id]: c })))
        .catch((err) => {
          console.error(err);
          setEchecsColonnes((m) => ({ ...m, [id]: String(err) }));
        });
    }
  }, [colonnesChat, etatColonnesChat.focus, visibleDeColonne, conversationsColonnes, echecsColonnes, workspacePath, chatDetache, activeConv.id]);
  // axe:colonne-echec — ce qu'affiche une colonne (ou la fenêtre détachée) dont le fil n'est pas là.
  const renduFilAbsent = (id: string | null) =>
    !id ? (
      <p className="onglets-chat__absent">Colonne vide : glissez-y un onglet.</p>
    ) : echecsColonnes[id] ? (
      <div className="onglets-chat__absent" role="alert">
        <span>Impossible d&apos;ouvrir cette conversation ({echecsColonnes[id]}).</span>
        <button
          type="button"
          onClick={() =>
            setEchecsColonnes((m) => {
              const reste = { ...m };
              delete reste[id];
              return reste;
            })
          }
        >
          Réessayer
        </button>
        <button type="button" onClick={() => fermerOngletChat(id)}>
          Fermer l&apos;onglet
        </button>
      </div>
    ) : (
      <p className="onglets-chat__absent">Ouverture de la conversation…</p>
    );
  const focaliserColonneChat = useCallback(
    (index: number) => {
      const colonne = colonnesChat[index];
      if (!colonne) return;
      setEtatColonnesChat((etat) => focaliserColonne(etat, index));
      const id = visibleDeColonne(colonne);
      if (id && id !== activeConv.id) void selectConversation(id);
    },
    [colonnesChat, visibleDeColonne, activeConv.id, selectConversation],
  );
  const deplacerOngletChat = useCallback(
    (id: string, vers: number, position?: number) => {
      setEtatColonnesChat((etat) => deplacerColonne(etat, id, vers, position));
      if (id !== activeConv.id) void selectConversation(id);
    },
    [activeConv.id, selectConversation],
  );
  const ajouterColonneChat = useCallback(() => {
    // « + colonne » : on y range l'onglet actif s'il n'est pas seul dans la
    // sienne (sinon la colonne resterait vide, ce qui n'a pas de sens).
    setEtatColonnesChat((etat) => {
      const ou = trouverColonne(etat.colonnes, activeConv.id);
      if (ou && etat.colonnes[ou[0]].length > 1)
        return deplacerColonne(etat, activeConv.id, etat.colonnes.length);
      return etat;
    });
  }, [activeConv.id]);

  // axe:hotfix — « Fermer la colonne » : ses onglets rejoignent la colonne voisine.
  const fermerColonneChat = useCallback((index: number) => {
    setEtatColonnesChat((etat) => fermerColonneEtat(etat, index));
  }, []);

  // axe:e17b — archiver = la conversation quitte l'archive des onglets et sa colonne.
  const archiverConversationColonne = useCallback(
    async (id: string) => {
      await archiveConversation(id);
      setChatDetache((actuel) => (actuel === id ? null : actuel));
      setOngletsChat((liste) => liste.filter((t) => t.id !== id));
      setEtatColonnesChat((etat) => retirerColonne(etat, id));
    },
    [archiveConversation],
  );

  // axe:raccourcis — les actions de l'IDE pour le registre unique (axe/raccourcis.ts).
  // Une ref garde la version courante : on s'inscrit une seule fois.
  const actionsRaccourcisRef = useRef<Parameters<typeof fournirActions>[0]>({});
  actionsRaccourcisRef.current = {
    fermerOnglet: () => closeActiveEditorTab(),
    terminal: () => toggleTerminalRef.current(),
    enregistrer: () => {
      if (settingsActive) return;
      if (activeTabIndex >= 0) void saveTab(activeTabIndex);
    },
    rechercheFichiers: () => setFileSearchOpen(true),
    nouvelleConversation: () => startCreate(),
    ongletSuivant: () => {
      if (tabs.length) activateFileTab((Math.max(activeTabIndex, -1) + 1) % tabs.length);
    },
    ongletPrecedent: () => {
      if (tabs.length) activateFileTab((Math.max(activeTabIndex, 0) - 1 + tabs.length) % tabs.length);
    },
    conversationSuivante: () => {
      const ids = ongletsChat.map((t) => t.id);
      if (ids.length < 2) return;
      void selectConversation(ids[(ids.indexOf(activeConv.id) + 1) % ids.length]);
    },
    conversationPrecedente: () => {
      const ids = ongletsChat.map((t) => t.id);
      if (ids.length < 2) return;
      void selectConversation(ids[(Math.max(ids.indexOf(activeConv.id), 0) - 1 + ids.length) % ids.length]);
    },
    settings: () => openSettings(),
    accueil: () => onSwitchWorkspace(),
    pousserCloud: () => void pousserDossierCloud(),
    remote: () => {
      setRemoteOpen(true);
      setRemoteActive(true);
    },
    dictee: () => (document.querySelector('.composer button[aria-label="Dicter"]') as HTMLButtonElement | null)?.click(),
    colonneChat: () => ajouterColonneChat(),
    archiver: () => void archiverConversationColonne(activeConv.id),
    stop: () => void stopTurnForConversation(activeConv),
    focusChat: () => (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.focus(),
    focusExplorateur: () => (document.querySelector(".sidebar__body") as HTMLElement | null)?.focus(),
  };
  useEffect(() => {
    const ids = Object.keys(actionsRaccourcisRef.current) as (keyof typeof actionsRaccourcisRef.current)[];
    const relais: Parameters<typeof fournirActions>[0] = {};
    for (const id of ids) relais[id] = () => actionsRaccourcisRef.current[id]?.();
    return fournirActions(relais);
  }, []);

  // axe:e14 — les gestes des onglets du chat.
  const fermerOngletChat = useCallback(
    (id: string) => {
      const index = ongletsChat.findIndex((t) => t.id === id);
      const reste = ongletsChat.filter((t) => t.id !== id);
      setOngletsChat(reste);
      setChatDetache((actuel) => (actuel === id ? null : actuel));
      if (id === activeConv.id) {
        // On ne laisse jamais le chat vide : on glisse sur l'onglet voisin.
        // axe:hotfix — d'abord le voisin dans SA colonne, sinon la conversation
        // visible de la colonne d'à côté (avant : un onglet d'une autre colonne).
        let voisin: string | null = null;
        const ou = trouverColonne(colonnesChat, id);
        if (ou) {
          const colonne = colonnesChat[ou[0]];
          if (colonne.length > 1) voisin = colonne[ou[1] > 0 ? ou[1] - 1 : 1];
          else {
            const autre = colonnesChat[ou[0] > 0 ? ou[0] - 1 : ou[0] + 1];
            if (autre && autre.length > 0) voisin = visibleDeColonne(autre) ?? autre[0];
          }
        }
        voisin = voisin ?? (reste[Math.max(0, index - 1)] ?? reste[0])?.id ?? null;
        if (voisin) void selectConversation(voisin);
      }
    },
    [activeConv.id, ongletsChat, colonnesChat, visibleDeColonne, selectConversation],
  );
  const detacherChat = useCallback(
    (id: string) => {
      // axe:e18 — la fenetre montre la conversation detachee ; la colonne garde
      // les autres onglets lisibles (on bascule sur la voisine s'il y en a une).
      setChatDetache(id);
      const autres = ongletsChat.filter((t) => t.id !== id);
      // On ne bascule que si la conversation detachee etait celle de la colonne :
      // detacher un onglet de fond ne doit pas changer ce qu'on lit.
      if (id === activeConv.id && autres.length > 0) {
        void selectConversation(autres[0].id);
      }
    },
    [activeConv.id, ongletsChat, selectConversation],
  );

  // axe:freechat — the same ChatPane serves both layouts.
  // axe:e17b — un ChatPane par colonne : chacun reçoit SA conversation et ses
  // actions liées (createConversationActions), jamais celles du fil actif.
  const renduChatPane = (conv: SavedConversation, enFocus: boolean) => {
    const actions =
      conv.id === activeConv.id
        ? activeConversationActions
        : createConversationActions(conv, conversationExecutors);
    const streaming = streamingConversationIds.has(conv.id);
    return (
      <ChatPane
        key={enFocus ? "chat-focus" : `chat-${conv.id}`}
        workspacePath={workspacePath}
        conversationId={conv.id}
        activeModel={conv.model}
        modeModelSettings={conv.modeModelSettings}
        streamingModel={
          streaming ? streamingModelsByConversation.get(conv.id) ?? conv.model : null
        }
        planWorkflow={conv.planWorkflow}
        goalWorkflow={conv.goalWorkflow}
        isStreaming={streaming}
        history={conv.history}
        subscribeEvents={subscribeEvents}
        onSend={actions.onSend}
        onCompact={actions.onCompact}
        onModeChange={actions.onModeChange}
        onModelPreferenceChange={actions.onModelPreferenceChange}
        onImplementPlanFresh={actions.onImplementPlanFresh}
        onStop={actions.onStop}
        onBackground={actions.onBackground}
        stopForce={demandesArret.get(conv.id)?.forcee === true}
        onOpenFile={layout === "chat" ? openFreeChatFile : openChatFile}
        onOpenSettings={openSettings}
        externalDrops={externalDropFeed}
        dropZoneRef={enFocus ? chatDropZoneRef : chatDropZoneMorteRef}
      />
    );
  };
  const chatPane = renduChatPane(activeConv, true);

  const noticeEl = notice ? (
    <div className="ws-notice" data-kind={notice.kind} role="status">
      {notice.text}
    </div>
  ) : null;

  if (layout === "chat") {
    return (
      <>
      <FreechatView
        scratchRoot={workspacePath}
        conversations={conversations}
        activeConversation={activeConv}
        streamingIds={streamingConversationIds}
        onSelect={(id) => void selectConversation(id)}
        onCreate={(titre) => void createConversation(titre)}
        onRename={(id, title) => void renameConversation(id, title)}
        onDelete={(id) => void archiveConversation(id)} // axe:archive-locale
        onHome={onSwitchWorkspace}
        onOpenFolder={(path, conversationId) => onOpenFolder?.(path, conversationId)}
        settingsOpen={settingsOpen}
        onOpenSettings={() => openSettings()}
        onCloseSettings={closeSettings}
        settingsView={<SettingsPane workspacePath={workspacePath} />}
        chat={chatPane}
      />
      {/* axe:agents — /tree works in the free conversation view too */}
      {treeSessionId ? (
        <div className="axe-tree-overlay" onClick={() => setTreeSessionId(null)}>
          <div className="axe-tree-overlay__panel" onClick={(e) => e.stopPropagation()}>
            <SessionTree sessionId={treeSessionId} connectionId={cloudConnection ?? undefined /* axe:parcours-collegue (D11) : arbre lu sur l'espace, pas sur le PC */} onClose={() => setTreeSessionId(null)} />
          </div>
        </div>
      ) : null}
      {noticeEl}
      </>
    );
  }
  // axe:freechat end

  // axe:e6 — les cinq volets sont definis une seule fois : ils se rendent a
  // leur place, ou dans une fenetre flottante quand ils sont detaches. Une
  // copie (exemplaire >= 1) est un composant independant.
  const voletExplorateur = (
    <div
      className="sidebar__section"
      // Le volet remplit son emplacement (l'enveloppe porte déjà topSplit %) :
      // sinon la liste ne prend que topSplit² de la hauteur et s'arrête au milieu.
      style={{ flex: "1 1 0" }}
      ref={fileTreeDropZoneRef}
      data-drop-active={fileTreeDropState.active ? "true" : "false"}
    >
      <div className="sidebar__head">
        <span className="sidebar__head-title">
          <Icon icon="solar:folder-bold-duotone" width={16} height={16} />
          <span>{bootstrap.workspace.name}</span>
        </span>
        <span className="sidebar__head-actions">
          <button
            type="button"
            className="sidebar__head-btn"
            title="Nouveau fichier"
            onClick={() => startRootCreate("file")}
          >
            <Icon icon="solar:document-add-linear" width={15} height={15} />
          </button>
          <button
            type="button"
            className="sidebar__head-btn"
            title="Nouveau dossier"
            onClick={() => startRootCreate("directory")}
          >
            <Icon
              icon="solar:add-folder-linear"
              width={15}
              height={15}
            />
          </button>
          <button
            type="button"
            className="sidebar__head-btn"
            data-active={fileSearchOpen ? "true" : "false"}
            title={fileSearchOpen ? "Afficher les fichiers" : "Rechercher dans les fichiers"}
            onClick={() => setFileSearchOpen((value) => !value)}
          >
            <Icon
              icon={
                fileSearchOpen
                  ? "solar:folder-open-linear"
                  : "solar:magnifer-linear"
              }
              width={15}
              height={15}
            />
          </button>
          <VoletOutils volet="explorateur" volets={volets} classeBouton="sidebar__head-btn" />
        </span>
      </div>
      {fileSearchOpen ? (
        <SearchPane
          workspacePath={workspacePath}
          onOpenFile={openFile}
          refreshToken={fileTreeRefreshToken}
        />
      ) : (
        <FileTree
          ref={fileTreeRef}
          workspacePath={workspacePath}
          activeFile={activeFilePath}
          onOpenFile={openFile}
          onDragFile={onDragFile}
          onEntryRenamed={handleTreeEntryRenamed}
          onEntryDeleted={handleTreeEntryDeleted}
          onEntriesMoved={handleTreeEntriesMoved}
          refreshToken={fileTreeRefreshToken}
          dropActive={fileTreeDropState.active}
          dropTargetRelative={fileTreeDropState.targetRelative}
        />
      )}
      {importError && (
        <div
          className="sidebar__import-error"
          onClick={() => setImportError(null)}
          title="Cliquer pour masquer"
        >
          {importError}
        </div>
      )}
    </div>  );

  const voletPanneauBas = (
    <div
      className="sidebar__section sidebar__section--bottom"
      style={{ flex: "1 1 0" }}
    >
      <ConnectionSelector onManage={() => openSettings()} /> {/* axe:remote */}
      <div className="sidebar__head sidebar__head--tabs">
        <div className="sidebar-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="sidebar-tab"
            data-active={bottomTab === "conversations" ? "true" : "false"}
            aria-selected={bottomTab === "conversations"}
            onClick={() => setBottomTab("conversations")}
            title="Conversations" // axe:laterale-etroite — barre étroite : icône seule
            aria-label="Conversations"
          >
            <Icon
              icon="solar:chat-round-dots-linear"
              width={13}
              height={13}
            />
            <span>Conversations</span>
          </button>
          {/* axe:agents */}
          <button
            type="button"
            role="tab"
            className="sidebar-tab"
            data-active={bottomTab === "agents" ? "true" : "false"}
            aria-selected={bottomTab === "agents"}
            onClick={() => setBottomTab("agents")}
            title="Agents" // axe:laterale-etroite
            aria-label="Agents"
          >
            <Icon icon="solar:branching-paths-down-linear" width={13} height={13} />
            <span>Agents</span>
          </button>
          {/* axe:agents end */}
        </div>
        <VoletOutils volet="panneauBas" volets={volets} classeBouton="sidebar__head-btn" />
        {bottomTab === "conversations" &&
          (activeConnection === LOCAL_CONNECTION || cloudConnection) && ( // axe:remote / axe:e12b
          <div className="sidebar__head-actions">
            <button
              type="button"
              className="sidebar__head-btn"
              onClick={startCreate}
              title="Nouvelle conversation"
            >
              <Icon
                icon="solar:add-square-linear"
                width={15}
                height={15}
              />
            </button>
          </div>
        )}
      </div>
      {/*
        Both panels stay mounted so swapping tabs preserves any
        transient state (a half-typed commit message, an open
        "New worktree" form, etc). We toggle visibility with
        display:none to avoid double-mounting their effects.
      */}
      <div
        className="sidebar-tab-pane"
        role="tabpanel"
        aria-hidden={bottomTab !== "conversations"}
        style={{
          display: bottomTab === "conversations" ? "flex" : "none",
        }}
      >
        {/* axe:e12b — sur un espace (Axe Cloud), ce panneau n'est QUE la liste :
            on choisit, on renomme, on archive, on supprime ; la conversation
            elle-meme se lit et s'ecrit dans le volet de droite. Le lecteur integre
            ne reste que pour une connexion distante classique (SSH), ou il n'y a
            pas de fil a droite. */}
        {activeConnection !== LOCAL_CONNECTION && !cloudConnection ? (
          <RemoteConversations connectionId={activeConnection} />
        ) : (
        <>
        {creating ? (
          <NouvelleConversation
            onCancel={cancelCreate}
            onCreate={confirmCreate}
          />
        ) : null}
        <ConversationList
          conversations={conversations}
          activeId={activeConv.id}
          streamingIds={streamingConversationIds}
          onSelect={(id) => {
            // axe:bg-e — une conversation choisie dans la liste remplace la vue d'un agent.
            setJournalSession(null);
            void selectConversation(id);
          }}
          onRename={renameConversation}
          onDelete={archiveConversation} // axe:suppr=archive
          // axe:e3 / axe:archive-locale — local comme espace cloud : on archive
          // au lieu de supprimer ; la suppression n'existe que depuis l'archive.
          onArchive={archiveConversation}
          archived={archivedConversations}
          onRestoreArchived={restoreArchivedConversation}
          onDeleteArchived={deleteArchivedConversation}
        />
        </>
        )}
      </div>
      {/* axe:agents */}
      {bottomTab === "agents" ? (
        <div className="sidebar-tab-pane" role="tabpanel" style={{ display: "flex" }}>
          <AgentsView
            workspacePath={workspacePath}
            onOpenConversation={(id) => {
              setJournalSession(null); // axe:sub-m
              void selectConversation(id);
            }}
            onOpenJournal={(id, conn, title) => setJournalSession({ id, conn, title })} // axe:sub-m
            onOpenFreeConversation={onOpenFreeChat} // axe:freechat
          />
        </div>
      ) : null}
      {treeSessionId ? (
        <div className="axe-tree-overlay" onClick={() => setTreeSessionId(null)}>
          <div className="axe-tree-overlay__panel" onClick={(e) => e.stopPropagation()}>
            <SessionTree sessionId={treeSessionId} connectionId={cloudConnection ?? undefined /* axe:parcours-collegue (D11) : arbre lu sur l'espace, pas sur le PC */} onClose={() => setTreeSessionId(null)} />
          </div>
        </div>
      ) : null}
      {/* axe:agents end */}
    </div>  );

  // axe:e17b — colonnes de fichiers : la disposition garde les chemins par
  // colonne ; `colonnesFichiers` (EditorTab[][]) en est la vue sur `tabs`.
  const [dispositionFichiers, setDispositionFichiers] = useState<EtatColonnes<string>>({
    colonnes: [[]],
    focus: 0,
  });
  useEffect(() => {
    setDispositionFichiers((etat) => {
      let suivant = etat;
      const chemins = new Set(tabs.map((t) => t.relativePath));
      for (const col of etat.colonnes)
        for (const c of col) if (!chemins.has(c)) suivant = retirerColonne(suivant, c);
      for (const t of tabs) suivant = ouvrirColonne(suivant, t.relativePath);
      return suivant;
    });
  }, [tabs]);
  const colonnesFichiers = useMemo<EditorTab[][]>(
    () =>
      dispositionFichiers.colonnes.map((col) =>
        col
          .map((chemin) => tabs.find((t) => t.relativePath === chemin))
          .filter((t): t is EditorTab => Boolean(t)),
      ),
    [dispositionFichiers, tabs],
  );
  const [actifsColonnes, setActifsColonnes] = useState<Record<number, string | undefined>>({});
  const [poidsColonnes, setPoidsColonnes] = useState<number[]>([]);
  const indexGlobal = useCallback(
    (onglet: EditorTab | undefined) =>
      onglet ? tabs.findIndex((t) => t.relativePath === onglet.relativePath) : -1,
    [tabs],
  );

  // axe:e17b — deplacement d'onglet de fichier entre colonnes sans DnD HTML5.
  const [menuOnglet, setMenuOnglet] = useState<{ chemin: string; col: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menuOnglet) return;
    const fermer = () => setMenuOnglet(null);
    const touche = (e: KeyboardEvent) => { if (e.key === "Escape") fermer(); };
    window.addEventListener("pointerdown", fermer);
    window.addEventListener("keydown", touche);
    window.addEventListener("blur", fermer);
    return () => {
      window.removeEventListener("pointerdown", fermer);
      window.removeEventListener("keydown", touche);
      window.removeEventListener("blur", fermer);
    };
  }, [menuOnglet]);
  const deplacerOngletFichier = useCallback(
    (chemin: string, vers: number) => setDispositionFichiers((etat) => deplacerColonne(etat, chemin, vers)),
    [],
  );
  const glisserOngletFichier = useCallback(
    (chemin: string, nom: string, depart: { clientX: number; clientY: number; pointerId: number }) => {
      const x0 = depart.clientX, y0 = depart.clientY;
      let fantome: HTMLDivElement | null = null;
      let survol: HTMLElement | null = null;
      const marquer = (el: HTMLElement | null) => {
        if (survol === el) return;
        survol?.removeAttribute("data-depot");
        survol = el;
        survol?.setAttribute("data-depot", "true");
      };
      const cibleSous = (x: number, y: number) =>
        (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-colonne-index]") ?? null;
      const bouger = (m: PointerEvent) => {
        if (m.pointerId !== depart.pointerId) return;
        if (!fantome) {
          if (!depasseSeuil(m.clientX - x0, m.clientY - y0)) return;
          fantome = document.createElement("div");
          fantome.className = "onglet-fantome";
          fantome.textContent = nom;
          Object.assign(fantome.style, {
            position: "fixed", zIndex: "10000", pointerEvents: "none", padding: "3px 10px",
            borderRadius: "4px", fontSize: "12px", background: "var(--bg-elevated, #2b2d31)",
            color: "var(--text, #fff)", border: "1px solid var(--accent, #4c8bf5)", opacity: "0.9",
            boxShadow: "0 4px 12px rgba(0,0,0,.35)", whiteSpace: "nowrap",
          } as CSSStyleDeclaration);
          document.body.appendChild(fantome);
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
        }
        m.preventDefault();
        fantome.style.left = `${m.clientX + 12}px`;
        fantome.style.top = `${m.clientY + 8}px`;
        marquer(cibleSous(m.clientX, m.clientY));
      };
      const finir = (u: PointerEvent) => {
        if (u.pointerId !== depart.pointerId) return;
        window.removeEventListener("pointermove", bouger, true);
        window.removeEventListener("pointerup", finir, true);
        window.removeEventListener("pointercancel", finir, true);
        if (!fantome) return;
        fantome.remove();
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        marquer(null);
        // Avaler le clic qui suit le relachement (sinon activation parasite).
        const avaler = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", avaler, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", avaler, true), 0);
        if (u.type !== "pointerup") return;
        const el = cibleSous(u.clientX, u.clientY);
        const attr = el?.getAttribute("data-colonne-index");
        setDispositionFichiers((etat) => {
          const vers = colonneCible(attr, etat.colonnes.length);
          return vers === null ? etat : deplacerColonne(etat, chemin, vers);
        });
      };
      window.addEventListener("pointermove", bouger, true);
      window.addEventListener("pointerup", finir, true);
      window.addEventListener("pointercancel", finir, true);
    },
    [],
  );

  const voletEditeur = (
    <div
      className="editor-shell"
      data-hidden={terminalVisible && terminalFullHeight ? "true" : "false"}
    >
      <div className="colonnes-fichiers">
        {colonnesFichiers.map((onglets, col) => {
          const premiere = col === 0;
          // Chaque colonne garde SON onglet visible : deux fichiers côte à côte.
          const cheminActif = tabs[activeTabIndex]?.relativePath;
          let actifIci = onglets.findIndex((t) => t.relativePath === cheminActif);
          if (actifIci === -1) {
            const memo = actifsColonnes[col];
            actifIci = Math.max(0, onglets.findIndex((t) => t.relativePath === memo));
            if (!onglets.length) actifIci = -1;
          }
          return (
            <Fragment key={col}>
            <div
              className="colonne-fichiers"
              style={{ flex: `${poidsColonnes[col] ?? 1} 1 0` }}
              data-focus={col === dispositionFichiers.focus ? "true" : "false"}
              data-colonne-index={col}
              onPointerDownCapture={() =>
                setDispositionFichiers((etat) => focaliserColonne(etat, col))
              }
              // Phase de CAPTURE : Monaco (dropIntoEditor) intercepte dragover/drop
              // sur la zone d'édition et n'en laisse rien remonter ; en bubbling, le
              // dépôt sur une colonne existante (ex. vers la gauche) était perdu.
              onDragOverCapture={(event) => {
                if (!event.dataTransfer.types.includes(MIME_ONGLET_FICHIER)) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
              }}
              onDropCapture={(event) => {
                const chemin = event.dataTransfer.getData(MIME_ONGLET_FICHIER);
                if (!chemin) return;
                event.preventDefault();
                event.stopPropagation();
                setDispositionFichiers((etat) => deplacerColonne(etat, chemin, col));
              }}
            >
              <EditorPane
                tabs={onglets}
                activeIndex={actifIci}
                pendingPaths={offlineView.dirtyPaths}
                onActivate={(i) => { setActifsColonnes((m) => ({ ...m, [col]: onglets[i]?.relativePath })); activateFileTab(indexGlobal(onglets[i])); }}
                onClose={(i) => closeTab(indexGlobal(onglets[i]))}
                onTabMenu={(i, x, y) => {
                  const chemin = onglets[i]?.relativePath;
                  if (chemin) setMenuOnglet({ chemin, col, x, y });
                }}
                onTabPointerDown={(i, e) => {
                  const t = onglets[i];
                  if (t) glisserOngletFichier(t.relativePath, t.doc.name, e);
                }}
                onChange={(i, v) => updateBuffer(indexGlobal(onglets[i]), v)}
                onSave={(i) => saveTab(indexGlobal(onglets[i]))}
                onOpenFile={openChatFile}
                settingsOpen={premiere && settingsOpen}
                settingsActive={settingsActive}
                settingsView={<SettingsPane workspacePath={workspacePath} />}
                remoteOpen={!EDITION_LOCALE && premiere && remoteOpen}
                remoteActive={remoteActive}
                remoteView={
                  <RemotePanel
                    initialStatus={remoteStatus}
                    onStatusChange={setRemoteStatus}
                  />
                }
                onRemoteActivate={() => {
                  setRemoteActive(true);
                  setSettingsActive(false);
                }}
                onRemoteClose={closeRemote}
                revealTarget={editorRevealTarget}
                onSettingsActivate={() => {
                  setRemoteActive(false);
                  setSettingsActive(true);
                }}
                onSettingsClose={closeSettings}
              />
            </div>
            {col < colonnesFichiers.length - 1 ? (
              // Glisser entre deux colonnes : agrandir l'une ou l'autre (comme Excel).
              <div
                className="colonnes-fichiers__poignee"
                onPointerDown={(e) => {
                  const hote = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;
                  const depart = e.clientX;
                  const base = colonnesFichiers.map((_, i) => poidsColonnes[i] ?? 1);
                  const total = base.reduce((s, v) => s + v, 0);
                  const bouger = (m: PointerEvent) => {
                    const d = ((m.clientX - depart) / hote) * total;
                    const g = Math.max(0.15, base[col] + d), r = Math.max(0.15, base[col + 1] - d);
                    setPoidsColonnes(() => { const n = base.slice(); n[col] = g; n[col + 1] = r; return n; });
                  };
                  const lacher = () => { window.removeEventListener("pointermove", bouger); window.removeEventListener("pointerup", lacher); };
                  window.addEventListener("pointermove", bouger);
                  window.addEventListener("pointerup", lacher);
                }}
              />
            ) : null}
            </Fragment>
          );
        })}
        <button
          type="button"
          className="colonnes-chat__ajout"
          title="Nouvelle colonne de fichiers (y glisser un onglet)"
          data-colonne-index="nouvelle"
          aria-label="Ajouter une colonne de fichiers"
          onClick={() =>
            setDispositionFichiers((etat) => {
              const chemin = tabs[activeTabIndex]?.relativePath;
              const ou = chemin ? trouverColonne(etat.colonnes, chemin) : null;
              return chemin && ou && etat.colonnes[ou[0]].length > 1
                ? deplacerColonne(etat, chemin, etat.colonnes.length)
                : etat;
            })
          }
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(MIME_ONGLET_FICHIER)) event.preventDefault();
          }}
          onDrop={(event) => {
            const chemin = event.dataTransfer.getData(MIME_ONGLET_FICHIER);
            if (!chemin) return;
            event.preventDefault();
            setDispositionFichiers((etat) => deplacerColonne(etat, chemin, etat.colonnes.length));
          }}
        >
          <Icon icon="solar:add-square-linear" width={14} height={14} />
        </button>
      </div>
      {menuOnglet ? (() => {
        const nb = colonnesFichiers.length;
        const seul = (colonnesFichiers[menuOnglet.col]?.length ?? 0) <= 1;
        const items: { label: string; vers: number; actif: boolean }[] = [
          { label: "Déplacer vers la colonne gauche", vers: menuOnglet.col - 1, actif: menuOnglet.col > 0 },
          { label: "Déplacer vers la colonne droite", vers: menuOnglet.col + 1, actif: menuOnglet.col < nb - 1 },
          { label: "Nouvelle colonne", vers: nb, actif: !(seul && menuOnglet.col === nb - 1) },
        ];
        return (
          <div
            className="menu-onglet-fichier"
            role="menu"
            style={{
              position: "fixed", left: menuOnglet.x, top: menuOnglet.y, zIndex: 10000,
              background: "var(--bg-elevated, #2b2d31)", border: "1px solid var(--border, #444)",
              borderRadius: 6, padding: 4, boxShadow: "0 6px 18px rgba(0,0,0,.35)", minWidth: 220,
              display: "flex", flexDirection: "column",
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={!it.actif}
                style={{
                  textAlign: "left", padding: "5px 10px", background: "transparent", border: 0,
                  color: "inherit", opacity: it.actif ? 1 : 0.4, cursor: it.actif ? "pointer" : "default",
                  font: "inherit", fontSize: 12,
                }}
                onClick={() => {
                  deplacerOngletFichier(menuOnglet.chemin, it.vers);
                  setMenuOnglet(null);
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        );
      })() : null}
    </div>  );

  const renduTerminal = (cle: string) => (
    <>
      {terminalAvailable && (cloudConnection || cloudReady) ? (
        // axe:e8 / axe:e15 — le terminal a onglets (Bash du service, terminal
        // local, « Prime Agent » epingle) s'affiche aussi depuis l'interface
        // classique : il suffit d'une session Axe Cloud ouverte. La cle de
        // stockage est stable, donc on retrouve les memes onglets partout.
        <CloudTerminalPanel
          key={cle}
          storageKey={cle === "principal" ? "principal" : `copie-${cle}`}
          connectionId={cloudConnection ?? (cloudReady as string)}
          workspacePath={workspacePath}
        />
      ) : null}
      {terminalAvailable && !cloudConnection && !cloudReady && (
        <TerminalPanel
          key={cle}
          active={terminalVisible}
          fullHeight={terminalFullHeight}
          workspacePath={workspacePath}
          onClose={hideTerminal}
          onCloseLastSession={closeTerminalPanel}
          onToggleFullHeight={toggleTerminalFullHeight}
          onOpenTerminalPath={openTerminalPath}
        />
      )}
    </>
  );

  return (
    <div className="workspace">
      {noticeEl}
      {/* axe:e6 — les volets detaches vivent ici, dans la fenetre de l'application. */}
      <VoletsFlottants
        volets={volets}
        contenu={(fenetre) => {
          switch (fenetre.volet) {
            case "explorateur":
              return voletExplorateur;
            case "panneauBas":
              return voletPanneauBas;
            case "editeur":
              return voletEditeur;
            case "terminal":
              return renduTerminal(fenetre.cle);
            case "chat":
              return chatPane;
            default:
              return null;
          }
        }}
      />
      {/* axe:e14 — l'onglet de chat detache vit devant, dans sa fenetre ; le
          refermer le remet a sa place. */}
      {chatDetache ? (
        <FenetreOnglet
          key={`chat-${chatDetache}`}
          id={`chat-${chatDetache}`}
          titre={ongletsChat.find((t) => t.id === chatDetache)?.titre ?? "Conversation"}
          sousTitre="chat"
          icone="solar:chat-round-dots-linear"
          onClose={() => setChatDetache(null)}
          extra={
            // Le bouton X n'est affiché que sur un chat détaché et sert à archiver ou ré-ancrer la conversation
            <ChatCloseButton
              conversationId={chatDetache}
              peutArchiver={true}
              onReancrer={() => setChatDetache(null)}
              onArchiver={archiverConversationColonne}
            />
          }
        >
          {chatDetache === activeConv.id ? (
            chatPane
          ) : conversationsColonnes[chatDetache] ? (
            renduChatPane(conversationsColonnes[chatDetache], false)
          ) : (
            renduFilAbsent(chatDetache)
          )}
        </FenetreOnglet>
      ) : null}
      <div
        className="titlebar"
        data-tauri-drag-region
        data-platform={IS_WINDOWS ? "windows" : undefined}
        ref={barreTitreRef}
      >
        <div
          className="titlebar__actions"
          data-tauri-drag-region
          style={{ left: Math.max(IS_MAC ? 80 : 8, largeurGaucheBarre), right: largeurDroiteBarre }}
        >
          {EDITION_LOCALE ? null : <button
            className="titlebar__btn titlebar__btn--remote"
            data-on={remoteActive || remoteStatus?.enabled ? "true" : "false"}
            onClick={() => {
              setRemoteOpen(true);
              setRemoteActive(true);
              setSettingsActive(false);
            }}
            title="Accès à distance"
          >
            <Icon icon="solar:smartphone-2-linear" width={12} height={12} />
            <span className="titlebar__btn-label">À distance</span>
            {remoteStatus?.devices.some((device) => device.connected) && (
              <span className="titlebar__btn-dot" aria-hidden />
            )}
          </button>}
          <button
            className="titlebar__btn"
            data-on={terminalVisible ? "true" : "false"}
            onClick={toggleTerminal}
            title={terminalVisible ? "Masquer le terminal" : "Afficher le terminal"}
          >
            <Icon
              icon={
                terminalVisible
                  ? "solar:command-bold-duotone"
                  : "solar:command-linear"
              }
              width={12}
              height={12}
            />
            <span className="titlebar__btn-label">Terminal</span>
          </button>
          <button
            className="titlebar__btn"
            data-on={gaucheReduite ? "false" : "true"}
            onClick={() => setGaucheReduite((v) => !v)}
            title={gaucheReduite ? "Afficher le volet de gauche (Ctrl+B)" : "Réduire le volet de gauche (Ctrl+B)"}
            aria-label={gaucheReduite ? "Afficher le volet de gauche" : "Réduire le volet de gauche"}
          >
            <Icon icon="solar:sidebar-minimalistic-linear" width={12} height={12} />
          </button>
          <button
            className="titlebar__btn"
            data-on={droiteReduite ? "false" : "true"}
            onClick={() => setDroiteReduite((v) => !v)}
            title={droiteReduite ? "Afficher le volet de droite (Ctrl+Alt+B)" : "Réduire le volet de droite (Ctrl+Alt+B)"}
            aria-label={droiteReduite ? "Afficher le volet de droite" : "Réduire le volet de droite"}
          >
            <Icon icon="solar:sidebar-minimalistic-linear" width={12} height={12} style={{ transform: "scaleX(-1)" }} />
          </button>
          {/* axe:e18 — le menu « Volets » est retire : chaque volet a son bouton,
              et un volet detache se replie en liseré. */}
          <button
            className="titlebar__btn"
            data-on={settingsActive ? "true" : "false"}
            data-action="reglages"
            onClick={() => openSettings()}
            title="Réglages (Ctrl+,)"
          >
            <Icon icon="solar:settings-linear" width={12} height={12} />
            <span className="titlebar__btn-label">Réglages</span>
          </button>
          <button
            className="titlebar__btn"
            data-action="accueil"
            onClick={onSwitchWorkspace}
            title="Revenir à l'accueil (nouvelle conversation, autre dossier)"
          >
            <Icon icon="solar:home-2-linear" width={12} height={12} />
            <span className="titlebar__btn-label">Accueil</span>
          </button>
          {/* axe:push-dossier - un seul espace : pousser un dossier du PC sur la VM, depuis l'IDE. */}
          {EDITION_LOCALE ? null : <button
            className="titlebar__btn"
            title="Pousser un dossier de ce PC sur le cloud (VM)"
            onClick={() => void pousserDossierCloud()}
          >
            <Icon icon="solar:upload-linear" width={12} height={12} />
            <span className="titlebar__btn-label">Pousser sur le cloud</span>
          </button>}
          <CloudLoginButton className="titlebar__btn" barre />
        </div>
        <div className="titlebar__brand" data-tauri-drag-region>
          <span className="titlebar__brand-mark">
            <AxeLogo variant="wordmark" size={16} />
          </span>
          <span className="titlebar__brand-name">SavIDE</span>
          {miroir && !EDITION_LOCALE ? (
            <span className="titlebar__mirror" title={miroir.ok ? "Copie des conversations de ce PC sur la VM (.axe-conversations/) : OK" : !cloudReady ? "Copie des conversations vers la VM impossible : non connecté à Axe Cloud" : `Copie des conversations de ce PC vers la VM en échec : ${miroir.error ?? "erreur inconnue"}`}
              style={{ marginLeft: 8, fontSize: 11, color: miroir.ok ? "#22c55e" : !cloudReady ? "#9ca3af" : "#ef4444" }}>
              {miroir.ok ? `VM ✓ ${miroir.n} · ${new Date(miroir.atMs).toLocaleTimeString("fr-FR")}` : !cloudReady ? "VM —" : "VM ✗"}
            </span>
          ) : null}
          {connexionCloud ? (
            <>
              <span
                className={`titlebar__cloud${cloudStatus === "offline" ? " titlebar__cloud--muted" : ""}`}
                title={
                  cloudConnection
                    ? `Espace de travail cloud (${cloudConnection}) : vos fichiers sont sur le serveur`
                    : `Espace Axe Cloud (${connexionCloud}) : de votre côté tout est à jour`
                }
              >
                <span className="titlebar__cloud-dot" aria-hidden />
                Synchronisé
              </span>
              {cloudStatus === "offline" ? (
                <span
                  className="titlebar__cloud titlebar__cloud--offline"
                  title={`Service injoignable — nouvelle tentative dans ${cloudProbeIn} s`}
                >
                  <span className="titlebar__cloud-dot" aria-hidden />
                  {offlineView.pendingCount > 0
                    ? `Hors ligne · ${offlineView.pendingCount} en attente`
                    : cloudConnection
                      ? "Hors ligne"
                      : "Espace cloud injoignable"}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        <QuotaIndicator /> {/* axe:providers */}
        {cloudConnection ? (
          // axe:import — copier un dossier du PC dans l'espace, puis l'ouvrir.
          <button
            type="button"
            className="skills-badge"
            title="Importer un dossier de ce PC dans mon espace Axe Cloud"
            onClick={async () => {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const dir = await open({ directory: true });
              if (typeof dir !== "string") return;
              try {
                const r = await importerDossier(dir, workspacePath);
                window.alert(`${r.copies} fichiers importés dans « ${r.nom} » (${r.ignores} ignorés : binaires, trop gros).`);
                void refreshFileTree();
              } catch (e) {
                window.alert(`Import impossible : ${String(e)}`);
              }
            }}
          >
            Importer un dossier
          </button>
        ) : null}
        <UpdateBadge />
        <SkillsBadge sync={skillSync} /> {/* axe:e4 */}
        <WindowControls />
      </div>

      <div
        className="main"
        data-gauche-reduit={gaucheReduite ? "true" : "false"}
        data-droite-reduit={droiteReduite ? "true" : "false"}
      >
        <div
          className="sidebar"
          style={
            gaucheReduite
              ? { display: "none" }
              : gaucheRepliee
              ? { width: 34, flex: "0 0 34px", padding: 0, overflow: "hidden" }
              : { width: leftWidth, flex: `0 1 ${leftWidth}px` }
          }
          ref={sidebarHeightRef}
        >
          {gaucheRepliee ? (
            <>
              <VoletRappel volet="explorateur" volets={volets} compact />
              <VoletRappel volet="panneauBas" volets={volets} compact />
            </>
          ) : (
            <>
              {explorateurDetache ? (
                <div className="sidebar__section" style={{ flex: `0 0 ${topSplit * 100}%` }}>
                  <VoletRappel volet="explorateur" volets={volets} compact />
                </div>
              ) : (
                <div
                  className="sidebar__section"
                  style={{ flex: panneauBasDetache ? "1 1 0" : `0 0 ${topSplit * 100}%` }}
                >
                  {voletExplorateur}
                </div>
              )}
              {!explorateurDetache && !panneauBasDetache ? (
                <Splitter orientation="horizontal" onDelta={applyTopDelta} />
              ) : null}
              {panneauBasDetache ? null : voletPanneauBas}
            </>
          )}
        </div>
        {gaucheReduite ? null : (
          <Splitter
            orientation="vertical"
            onDelta={(delta) => setLeftWidth((v) => clampColumn(v + delta))}
          />
        )}
        <div
          className="workbench-center"
          // axe:colonnes-place — plusieurs colonnes de chat : l'éditeur cède un peu de place.
          style={colonnesChat.length > 1 ? { minWidth: 240 } : undefined}
        >
          {/* E2 — le seul cas ou l'interface demande quelque chose : le meme
              fichier a change des deux cotes. Francais courant, choix concrets. */}
          {cloudConnection && offlineView.conflicts.length > 0 ? (
            <div className="offline-conflicts" role="status">
              <p className="offline-conflicts__intro">
                {offlineView.conflicts.length > 1
                  ? "Ces fichiers ont changé des deux côtés (ici et dans l'espace). Que garder ?"
                  : "Ce fichier a changé des deux côtés (ici et dans l'espace). Que garder ?"}
              </p>
              <div className="offline-conflicts__list">
                {offlineView.conflicts.map((conflict) => (
                  <div className="offline-conflict" key={conflict.path}>
                    <span className="offline-conflict__path" title={conflict.path}>
                      {conflict.path}
                    </span>
                    <div className="offline-conflict__actions">
                      <button
                        type="button"
                        onClick={() => void handleResolveConflict(conflict.path, "local")}
                      >
                        Garder ma version
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveConflict(conflict.path, "server")}
                      >
                        Garder celle de l'espace
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveConflict(conflict.path, "both")}
                      >
                        Garder les deux
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {/* E2 — ce qui n'a vraiment pas pu partir, dit une fois, sans bloquer. */}
          {cloudConnection && offlineView.stuckPaths.length > 0 ? (
            <div className="offline-stuck" role="status">
              {offlineView.stuckPaths.length === 1
                ? `« ${offlineView.stuckPaths[0]} » n'a pas pu être transmis à l'espace : il repartira tout seul.`
                : `${offlineView.stuckPaths.length} modifications n'ont pas pu être transmises à l'espace : elles repartiront toutes seules.`}
            </div>
          ) : null}
              {volets.estDetache("editeur") ? (
                <div className="volet-repli-hote">
                  <VoletRappel volet="editeur" volets={volets} sens="horizontal" compact />
                </div>
              ) : (
                voletEditeur
              )}
          {terminalVisible && !terminalFullHeight && (
            <Splitter
              orientation="horizontal"
              onDelta={(delta) =>
                setTerminalHeight((value) => clampTerminal(value - delta))
              }
            />
          )}
          <div
            className="terminal-shell"
            data-full-height={terminalFullHeight ? "true" : "false"}
            style={{
              display: terminalVisible ? "block" : "none",
              height: terminalVisible
                ? terminalFullHeight
                  ? "auto"
                  : terminalHeight
                : 0,
              flex: terminalVisible
                ? terminalFullHeight
                  ? "1 1 0"
                  : `0 0 ${terminalHeight}px`
                : "0 0 0",
            }}
          >
            {volets.estDetache("terminal") ? (
              <VoletRappel volet="terminal" volets={volets} sens="horizontal" compact />
            ) : (
              renduTerminal("principal")
            )}
          </div>
          {terminalAvailable && !terminalOpen && (
            <div className="terminal-restore">
              <button
                type="button"
                className="terminal-restore__button"
                onClick={showTerminal}
                title="Afficher le terminal"
              >
                <Icon icon="solar:square-alt-arrow-up-linear" width={14} height={14} />
              </button>
            </div>
          )}
        </div>
        {droiteReduite ? null : (
          <Splitter
            orientation="vertical"
            onDelta={(delta) => setRightWidth((v) => clampColumn(Math.max(v, besoinColonnesChat) - delta))}
          />
        )}
        <div
          style={
            droiteReduite
              ? { display: "none" }
              : droiteRepliee
              ? { width: 34, flex: "0 0 34px", minWidth: 0, display: "flex" }
              : {
                  width: largeurChat,
                  flex: `0 1 ${largeurChat}px`,
                  minWidth: 0,
                  display: "flex",
                }
          }
        >
          {droiteRepliee ? (
            // axe:e18 — le chat detache ne garde plus sa colonne : liseré, et
            // l'editeur prend toute la largeur.
            <div className="volet-repli-hote">
              {chatDetacheSeul ? (
                <div
                  className="volet-repli"
                  data-sens="vertical"
                  title="Conversation détachée — cliquer pour la réancrer"
                >
                  <button
                    type="button"
                    className="volet-repli__bouton"
                    onClick={() => setChatDetache(null)}
                    aria-label="Réancrer la conversation"
                  >
                    <Icon icon="solar:chat-round-dots-linear" width={14} height={14} />
                  </button>
                  <span className="volet-repli__nom">Conversation</span>
                </div>
              ) : (
                <VoletRappel volet="chat" volets={volets} compact />
              )}
            </div>
          ) : (
            /* axe:e14 — les conversations en onglets ; axe:e18 — un onglet
               detache laisse les AUTRES lisibles a droite.
               axe:e17b — une colonne par liste d'onglets, « + colonne » a droite
               de la derniere, glisser un onglet d'une colonne a l'autre. */
            <div className="colonnes-chat" data-testid="colonnes-chat" ref={colonnesChatRef}>
              {colonnesChat.map((colonne, index) => {
                const enFocus = index === etatColonnesChat.focus;
                const onglets = colonne
                  .map((id) => ongletsChat.find((t) => t.id === id))
                  .filter((t): t is OngletChat => Boolean(t));
                const visible = enFocus ? activeConv.id : visibleDeColonne(colonne);
                const conv = visible ? conversationsColonnes[visible] : undefined;
                return (
                  <Fragment key={index}>
                  <div
                    className="onglets-chat-hote colonne-chat"
                    style={colonnesChat.length > 1 ? { flex: `${poidsChat[index]} 1 0` } : undefined}
                    data-focus={enFocus ? "true" : "false"}
                    data-colonne={index}
                    onPointerDownCapture={(event) => {
                      if (enFocus) return;
                      // axe:hotfix — fermer/détacher un onglet d'une autre colonne (ou
                      // clic du milieu) n'ouvre plus d'abord sa conversation : elle
                      // revenait aussitôt après sa fermeture.
                      const cible = event.target as HTMLElement | null;
                      if (
                        event.button === 1 ||
                        cible?.closest?.(".onglets-chat__btn, .onglets-chat__fermer-colonne")
                      )
                        return;
                      // Un onglet : c'est lui qui choisit la conversation (le focus suit).
                      // Le reste (dont « + », qui ouvre la boîte du titre) : comme avant.
                      if (cible?.closest?.(".onglets-chat__tab")) return;
                      focaliserColonneChat(index);
                    }}
                    onDragOver={(event) => {
                      if (event.dataTransfer.types.includes(MIME_ONGLET_CHAT)) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(event) => {
                      const id = event.dataTransfer.getData(MIME_ONGLET_CHAT);
                      if (!id) return;
                      event.preventDefault();
                      event.stopPropagation();
                      deplacerOngletChat(id, index);
                    }}
                  >
                    <OngletsChat
                      onglets={onglets}
                      actif={visible ?? ""}
                      detache={chatDetache}
                      onActiver={(id) => {
                        setJournalSession(null); // axe:sub-m
                        void selectConversation(id);
                      }}
                      onFermer={fermerOngletChat}
                      onDetacher={detacherChat}
                      onNouvelle={startCreate}
                      onDeposer={(id, position) => deplacerOngletChat(id, index, position)}
                      fermable={colonnesChat.length > 1}
                      onFermerColonne={
                        colonnesChat.length > 1 ? () => fermerColonneChat(index) : undefined
                      }
                    />
                    {enFocus && journalSession ? (
                      <SessionJournal
                        key={`${journalSession.conn}:${journalSession.id}`}
                        sessionId={journalSession.id}
                        connectionId={journalSession.conn}
                        title={journalSession.title}
                        onClose={() => setJournalSession(null)}
                      />
                    ) : enFocus ? (
                      chatDetache === activeConv.id ? (
                        <p className="onglets-chat__absent">Conversation détachée, devant.</p>
                      ) : (
                        chatPane
                      )
                    ) : conv && conv.id === chatDetache ? (
                      // axe:colonne-echec — son fil est dans la fenêtre détachée (avant :
                      // « Ouverture de la conversation… » pour toujours).
                      <p className="onglets-chat__absent">Conversation détachée, devant.</p>
                    ) : conv ? (
                      renduChatPane(conv, false)
                    ) : (
                      renduFilAbsent(visible)
                    )}
                  </div>
                  {index < colonnesChat.length - 1 ? (
                    <Splitter
                      orientation="vertical"
                      onDelta={(delta) => redimensionnerColonneChat(index, delta)}
                      onReset={() => setPoidsColonnesChat([])}
                    />
                  ) : null}
                  </Fragment>
                );
              })}
              <button
                type="button"
                className="colonnes-chat__ajout"
                title="Nouvelle colonne (y glisser un onglet)"
                aria-label="Ajouter une colonne de chat"
                onClick={ajouterColonneChat}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes(MIME_ONGLET_CHAT)) event.preventDefault();
                }}
                onDrop={(event) => {
                  const id = event.dataTransfer.getData(MIME_ONGLET_CHAT);
                  if (!id) return;
                  event.preventDefault();
                  deplacerOngletChat(id, colonnesChat.length);
                }}
              >
                <Icon icon="solar:add-square-linear" width={14} height={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

async function sendMessageWithBusyRetry(
  ...args: Parameters<typeof api.sendMessage>
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await api.sendMessage(...args);
      return;
    } catch (err) {
      const delayMs = SEND_BUSY_RETRY_DELAYS_MS[attempt];
      if (!isConversationBusyError(err) || delayMs === undefined) {
        throw err;
      }
      await sleep(delayMs);
    }
  }
}

function isConversationBusyError(err: unknown): boolean {
  return String(err).includes("a turn is already running for this conversation");
}

function conversationContinuationMode(conversation: SavedConversation): AgentMode {
  if (conversation.planWorkflow.status !== "idle") return "plan";
  if (conversation.goalWorkflow.status === "active") return "goal";
  return "act";
}

function titleFromOutgoingUserText(text: string): string | null {
  const title = text.trim();
  if (!title) return null;
  const chars = Array.from(title);
  if (chars.length <= 48) return title;
  return `${chars.slice(0, 45).join("")}...`;
}

function titleFromPlanImplementation(plan: PlanArtifact): string {
  const planTitle = plan.title?.trim();
  const fileTitle = basename(plan.path).replace(/\.md$/i, "").trim();
  const base = planTitle || fileTitle || "plan";
  return titleFromOutgoingUserText(`Exécuter : ${base}`) ?? "Exécuter le plan";
}

function sortConversationSummaries(
  conversations: ConversationSummary[],
): ConversationSummary[] {
  return [...conversations].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function fileChangesFromAgentEvent(event: AgentEvent): FileChange[] {
  if (event.type === "tool_finished") return event.file_changes;
  if (event.type === "sub_agent_event") {
    return fileChangesFromAgentEvent(event.event);
  }
  return [];
}

function entryContainsPath(entry: WorkspaceEntry, relativePath: string): boolean {
  return (
    relativePath === entry.relativePath ||
    (entry.kind === "directory" &&
      relativePath.startsWith(`${entry.relativePath}/`))
  );
}

function replaceTreePath(
  relativePath: string,
  oldRelativePath: string,
  entry: WorkspaceEntry,
): string | null {
  if (relativePath === oldRelativePath) return entry.relativePath;
  if (relativePath.startsWith(`${oldRelativePath}/`)) {
    return `${entry.relativePath}${relativePath.slice(oldRelativePath.length)}`;
  }
  return null;
}

function retargetTab(
  tab: EditorTab,
  relativePath: string,
  workspacePath: string,
  entry: WorkspaceEntry,
): EditorTab {
  const exactEntry = relativePath === entry.relativePath && entry.kind === "file";
  const absolutePath = exactEntry
    ? entry.absolutePath
    : `${workspacePath}/${relativePath}`;
  const name = basename(relativePath);
  return {
    ...tab,
    relativePath,
    doc: {
      ...tab.doc,
      name,
      relativePath,
      absolutePath,
    },
  };
}

/** Windows verbatim prefix (`\\?\C:\…`, `\\?\UNC\srv\share\…`), as built by
 * Rust `canonicalize` on the backend: strip it so chat/tool paths look normal
 * and match the workspace path when resolving a click. */
function stripVerbatimPath(path: string): string {
  const unc = /^(?:\\\\\?\\|\/\/\?\/)UNC[\\/](.*)$/i.exec(path);
  if (unc) return `\\\\${unc[1]}`;
  return path.replace(/^(?:\\\\\?\\|\/\/\?\/)/i, "");
}

/** Shared cleanup for chat-referenced paths (quotes, line suffixes, verbatim prefix). */
function cleanChatFilePath(rawPath: string): string {
  return stripVerbatimPath(
    rawPath
      .trim()
      .replace(/^['"`<]+|['"`>,.;:]+$/g, "")
      .replace(/#L\d+(?:C\d+)?$/i, "")
      .replace(/:\d+(?::\d+)?$/, ""),
  );
}

function chatPathToRelative(rawPath: string, workspacePath: string): string | null {
  let path = cleanChatFilePath(rawPath).replace(/\\/g, "/");

  if (!path || path.includes("://")) return null;

  const root = stripVerbatimPath(workspacePath.replace(/\\/g, "/")).replace(/\/+$/, "");
  const pathKey = path.toLowerCase();
  const rootKey = root.toLowerCase();
  if (pathKey === rootKey) return null;
  if (root && pathKey.startsWith(`${rootKey}/`)) {
    path = path.slice(root.length + 1);
  } else if (/^[a-zA-Z]:\//.test(path) || path.startsWith("//")) {
    // Absolute path outside the workspace: not an editor-relative file.
    return null;
  } else if (path.startsWith("/")) {
    return null;
  }

  path = path.replace(/^\.\//, "");
  if (!path || path.startsWith("../") || path.includes("/../")) return null;

  return path;
}
