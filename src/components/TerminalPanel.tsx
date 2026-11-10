import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import {
  Terminal,
  type IBufferRange,
  type ILink,
  type ILinkProvider,
} from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/ipc";
import { GitPanel, GitMark } from "./GitPanel"; // git-onglet
import { GIT_TAB_ID, cycleTab, isExecutablePathTitle, resolveActiveTab, vueScindee, type PaireScindee } from "./terminalTabs"; // terminal-onglets
import { onThemeChange } from "../axe/theme"; // theme
import { xtermTheme } from "../axe/themeTargets"; // theme
import { MONO_BASE_PX } from "../axe/zoom"; // zoom — taille fixe (e19 : le reglage ne concerne que le chat et les documents)
import { identifiantPty } from "../lib/terminalDossier";
import { prendreCommandeDepart } from "./worktrees/terminauxDepart"; // worktrees
import { suivreMesuresTerminal } from "./terminalMesures";
import type { TerminalDataPayload, TerminalExitPayload } from "../types";
import { ouvrirLien } from "./navigateur/liens"; // navigateur intégré ou du système
import { BoutonNouvelAgent, type LancementAgent } from "./agents-cli/NouvelAgentMenu"; // agents en ligne de commande
import { lancerTerminalAgent, titreAgent } from "./agents-cli/catalogueCli";
import {
  compilerInvites, emettreNotification, libelleEtat, messageOsc777, messageOsc9, notificationAgent,
  suiviInitial, surFin, surHorloge, surSaisie, surSignal, surSortie, type EtatAgent, type Suivi, type Transition,
} from "./agents-cli/etatAgent";
import { BoutonPlusActions, BoutonTerminauxOuverts, type LigneTerminal } from "./agents-cli/ActionsTerminal";
import { RechercheTerminal, lignesTerminal } from "./agents-cli/RechercheTerminal";
import { cheminsDeposes, entreesGlissees, glisseDepuisExplorateur, texteComplet } from "./agents-cli/outilsTerminal";
import { copierTexte } from "./chat/PreCopiable";
import { BoutonCommandesTerminal } from "./agents-cli/CommandesEnregistrees";
import { donneesCollage, type GenreCommande } from "./agents-cli/stockageCommandes";
import { dansTerminal, fournirActions } from "../axe/raccourcis";
import { estWindows } from "../lib/plateforme";

type TerminalStatus = "idle" | "starting" | "running" | "exited" | "error";

type TerminalSession = {
  id: string;
  index: number;
  title: string;
  /** Name given by the user; wins over the title sent by the shell. */
  customTitle?: string;
  status: TerminalStatus;
  shell?: string;
  /** Agent en ligne de commande lancé dans ce terminal (sinon un shell). */
  agent?: AgentDuTerminal;
  // Champs du moment, jamais enregistrés :
  /** État de l'agent (travaille, attend, fini…). */
  etat?: EtatAgent;
  etatLibelle?: string;
  /** Compteur de relances : une relance remonte un terminal neuf. */
  relance?: number;
  /** Lancer avec la commande de reprise de session de l'agent. */
  reprendre?: boolean;
  /** Agent rouvert avec l'appli : rien ne tourne tant qu'on ne le relance pas. */
  enPause?: boolean;
};

type AgentDuTerminal = {
  cli: string;
  nom: string;
  dossier: string;
  branche?: string;
  /** L'agent sait reprendre une session. */
  reprise?: boolean;
  /** Expressions qui reconnaissent son invite (catalogue). */
  invites?: string[];
};

type Props = {
  active: boolean;
  fullHeight: boolean;
  workspacePath: string;
  onClose: () => void;
  onCloseLastSession: () => void;
  onToggleFullHeight: () => void;
  /**
   * Invoked when the user cmd/ctrl+clicks a file path detected in the
   * terminal buffer. The parent decides how to open it (workspace tab,
   * external read-only tab, file-tree reveal, ...).
   */
  onOpenTerminalPath?: (rawPath: string) => void;
  /** Panneau d'un dossier quitté : caché, ses terminaux restent vivants. */
  masque?: boolean;
};

const SAVED_LINES = 3000;
const SAVE_DELAY_MS = 5000;
const terminalBuffers = new Map<string, Terminal>();
const pendingSaves = new Map<string, number>();
function terminalBufferKey(workspacePath: string, sessionId: string) { return `axecode:terminal-buffer:${workspacePath}:${sessionId}`; }
function saveBuffer(key: string, terminal: Terminal) {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - SAVED_LINES);
  const lines = Array.from({ length: buffer.length - start }, (_, offset) => buffer.getLine(start + offset)?.translateToString(true) ?? "");
  try { localStorage.setItem(key, JSON.stringify(lines)); } catch { /* storage can be disabled/full */ }
}
function persistTerminalBuffer(workspacePath: string, sessionId: string) {
  const key = terminalBufferKey(workspacePath, sessionId);
  window.clearTimeout(pendingSaves.get(key));
  pendingSaves.delete(key);
  const terminal = terminalBuffers.get(key);
  if (terminal) saveBuffer(key, terminal);
}
/** Saves at most once per SAVE_DELAY_MS while output keeps coming. */
function scheduleTerminalBufferSave(workspacePath: string, sessionId: string) {
  const key = terminalBufferKey(workspacePath, sessionId);
  if (pendingSaves.has(key)) return;
  pendingSaves.set(key, window.setTimeout(() => persistTerminalBuffer(workspacePath, sessionId), SAVE_DELAY_MS));
}
function persistAllTerminalBuffers() {
  for (const [key, terminal] of terminalBuffers) saveBuffer(key, terminal);
}
window.addEventListener("beforeunload", persistAllTerminalBuffers);
window.addEventListener("pagehide", persistAllTerminalBuffers);

type Disposable = {
  dispose: () => void;
};

/** Ce que le panneau peut faire d'un terminal affiché (recherche, copie, écriture, arrêt). */
type ApiSurface = { terminal: Terminal; arreter: () => void; ecrire: (donnees: string) => boolean };

// Ctrl+F (registre des raccourcis, modifiable) : le panneau dont le terminal a le focus ouvre
// sa recherche ; ailleurs la touche continue son chemin.
const ouvreursRecherche = new Set<(cible: EventTarget | null) => boolean>();
let rechercheInstallee = false;
function installerRechercheTerminal() {
  if (rechercheInstallee) return;
  rechercheInstallee = true;
  fournirActions({
    rechercheTerminal: (e) => {
      if (!dansTerminal(e.target)) return false;
      for (const ouvrir of ouvreursRecherche) if (ouvrir(e.target)) return true;
      return false;
    },
  });
}

const LIBELLES_STATUT: Record<TerminalStatus, string> = {
  idle: "Pas lancé",
  starting: "Démarre",
  running: "En cours",
  exited: "Terminé",
  error: "Erreur",
};

export function TerminalPanel({
  active,
  fullHeight,
  workspacePath,
  onClose,
  onCloseLastSession,
  onToggleFullHeight,
  onOpenTerminalPath,
  masque = false,
}: Props) {
  const [sessions, setSessions] = useState<TerminalSession[]>(() => loadTerminalSessions(workspacePath));
  const [activeId, setActiveId] = useState(() => loadTerminalSessions(workspacePath)[0]?.id ?? "terminal-1");
  // git-tabs - branche git du dossier affichee dans chaque onglet.
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.gitSnapshot(workspacePath)
        .then((snap) => { if (alive) { setGitBranch(snap.isRepository ? snap.currentBranch ?? null : null); setGitDirty(snap.dirtyCount ?? 0); } })
        .catch(() => { if (alive) setGitBranch(null); });
    };
    tick();
    const id = window.setInterval(tick, 15000);
    return () => { alive = false; window.clearInterval(id); };
  }, [workspacePath]);
  const nextSessionIndex = useRef(1 + Math.max(0, ...loadTerminalSessions(workspacePath).map((session) => session.index)));
  // Recherche, terminal scindé, terminaux affichés (pour copier, chercher, arrêter).
  const panneauRef = useRef<HTMLElement | null>(null);
  const surfaces = useRef(new Map<string, ApiSurface>());
  const [recherche, setRecherche] = useState(false);
  const [paire, setPaire] = useState<PaireScindee | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    try { localStorage.setItem(terminalStorageKey(workspacePath), JSON.stringify(sessions.map(({ id, status, etat, etatLibelle, relance, reprendre, enPause, ...session }) => session))); } catch { /* storage can be disabled/full */ }
  }, [sessions, workspacePath]);

  // Cycle terminal tabs without intercepting shortcuts while typing in inputs.
  // xterm's own input is a textarea: it lets Ctrl+Tab through (see
  // attachCustomKeyEventHandler) so the shortcut also works from the terminal.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!active || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "tab" || sessions.length < 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]") && !target.closest(".xterm")) return;
      event.preventDefault();
      setActiveId(cycleTab(activeId, sessions.map((session) => session.id), event.shiftKey ? -1 : 1));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, activeId, sessions]);

  // terminal-onglets - id d'onglet reellement affiche (jamais orphelin) ; Git est un onglet a part.
  const shownId = resolveActiveTab(activeId, sessions.map((session) => session.id));
  const activeSession =
    sessions.find((session) => session.id === shownId) ?? sessions[0];
  const vue = vueScindee(paire, shownId, sessions.map((session) => session.id));

  useEffect(() => {
    installerRechercheTerminal();
    const ouvrir = (cible: EventTarget | null) => {
      if (!active || !panneauRef.current?.contains(cible as Node | null)) return false;
      setRecherche(true);
      return true;
    };
    ouvreursRecherche.add(ouvrir);
    return () => {
      ouvreursRecherche.delete(ouvrir);
    };
  }, [active]);

  const avertir = useCallback((texte: string) => {
    setNotice(texte);
    window.setTimeout(() => setNotice((n) => (n === texte ? "" : n)), 2500);
  }, []);

  const copierToutLaSortie = useCallback(() => {
    const terminal = surfaces.current.get(shownId)?.terminal;
    if (!terminal) return;
    void copierTexte(texteComplet(lignesTerminal(terminal))).then((ok) => avertir(ok ? "Sortie copiée" : "Copie impossible"));
  }, [avertir, shownId]);

  // Commande enregistrée : collée dans le terminal affiché, puis exécutée (Entrée) ; un prompt
  // est seulement collé (à valider soi-même, l'agent ne perd pas l'Entrée pendant le collage).
  const envoyerAuTerminal = useCallback((texte: string, genre: GenreCommande) => {
    const surface = surfaces.current.get(shownId);
    const encadre = !!surface?.terminal.modes.bracketedPasteMode;
    if (!surface || !surface.ecrire(donneesCollage(texte, encadre, genre === "commande"))) {
      avertir("Aucun terminal en cours");
      return;
    }
    surface.terminal.focus();
  }, [avertir, shownId]);

  const scinder = useCallback(() => {
    if (vue) {
      setPaire(null);
      return;
    }
    if (shownId === GIT_TAB_ID) return;
    const session = createSession(nextSessionIndex.current++);
    setSessions((prev) => [...prev, session]);
    setPaire({ gauche: shownId, droite: session.id });
    setActiveId(session.id);
  }, [shownId, vue]);

  const lignesGestionnaire: LigneTerminal[] = sessions.map((s) => ({
    id: s.id,
    titre: s.customTitle ?? s.title,
    agent: !!s.agent,
    etat: s.agent ? s.etatLibelle ?? (s.enPause ? "Arrêté" : LIBELLES_STATUT[s.status]) : LIBELLES_STATUT[s.status],
    enCours: s.status === "running" || s.status === "starting",
    actif: s.id === shownId,
  }));

  const patchSession = useCallback(
    (id: string, patch: Partial<TerminalSession>) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === id ? { ...session, ...patch } : session,
        ),
      );
    },
    [],
  );

  const addSession = useCallback(() => {
    const session = createSession(nextSessionIndex.current++);
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
  }, []);

  // Nouvel agent : un onglet « agent · dossier » qui lance le programme de l'agent.
  const addAgentSession = useCallback((l: LancementAgent) => {
    const session: TerminalSession = {
      ...createSession(nextSessionIndex.current++),
      title: titreAgent(l.nom, l.dossier),
      agent: { cli: l.cli, nom: l.nom, dossier: l.dossier, branche: l.branche, reprise: l.reprise, invites: l.invites },
      reprendre: l.reprendre,
    };
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
  }, []);

  // Relancer le même programme (ou reprendre une session de l'agent) : un terminal neuf
  // remplace l'ancien dans le même onglet ; l'historique affiché est gardé.
  const relancer = useCallback((id: string, reprendre: boolean) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, relance: (s.relance ?? 0) + 1, reprendre, enPause: false, status: "idle", etat: undefined, etatLibelle: undefined } : s,
      ),
    );
    setActiveId(id);
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      persistTerminalBuffer(workspacePath, id);
      if (sessions.length <= 1) {
        onCloseLastSession();
        return;
      }
      const index = sessions.findIndex((session) => session.id === id);
      const next = sessions.filter((session) => session.id !== id);
      setSessions(next);
      setActiveId((current) => {
        if (current !== id) return current;
        return next[Math.max(0, Math.min(index, next.length - 1))].id;
      });
    },
    [onCloseLastSession, sessions, workspacePath],
  );

  const closeAllSessions = useCallback(() => {
    for (const session of sessions) persistTerminalBuffer(workspacePath, session.id);
    onCloseLastSession();
  }, [onCloseLastSession, sessions, workspacePath]);

  // git-onglet - onglet Git epingle (comme dans CloudTerminalPanel).
  const gitActive = shownId === GIT_TAB_ID;

  if (!activeSession) return null;

  return (
    <section className="terminal-panel" ref={panneauRef} style={masque ? { display: "none" } : undefined}>
      <div className="terminal-tabs">
        <div className="terminal-tabs__list">
          <div
            role="tab"
            aria-selected={gitActive}
            className="terminal-tab"
            data-tab="git"
            data-active={gitActive ? "true" : "false"}
            onClick={() => setActiveId(GIT_TAB_ID)}
            title={gitBranch ? `Git · ${gitBranch}` : "Git"}
          >
            <GitMark size={13} />
            <span className="terminal-tab__label">Git</span>
            {gitBranch ? (
              <span className="terminal-tab__git" title={`Branche git : ${gitBranch}${gitDirty ? ` (${gitDirty} modif.)` : ""}`}>
                {gitBranch}{gitDirty ? "*" : ""}
              </span>
            ) : null}
          </div>
          {sessions.map((session) => (
            <div
              key={session.id}
              role="tab"
              aria-selected={session.id === shownId}
              className="terminal-tab"
              data-shell={session.agent ? undefined : session.shell}
              data-agent={session.agent?.cli}
              data-active={session.id === shownId ? "true" : "false"}
              onClick={() => setActiveId(session.id)}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => {
                // Clic molette : fermer l'onglet.
                if (event.button === 1) { event.preventDefault(); event.stopPropagation(); closeSession(session.id); }
              }}
              data-etat={session.agent ? session.etat ?? (session.enPause ? "pause" : "demarre") : undefined}
              title={session.agent ? `${session.customTitle ?? session.title} · ${session.etatLibelle ?? (session.enPause ? "Arrêté" : "Démarre")}\n${session.agent.dossier}${session.agent.branche ? ` (branche ${session.agent.branche})` : ""}` : session.customTitle ?? session.title}
              onContextMenu={(event) => {
                event.preventDefault();
                if (session.agent) return;
                const choice = window.prompt("Choisir le shell : powershell ou bash", session.shell ?? "powershell");
                const shell = choice?.trim().toLowerCase();
                if (shell === "bash" || shell === "powershell") patchSession(session.id, { shell });
              }}
            >
              {session.etat === "travaille" ? (
                <span className="onglets-chat__spinner acli-onglet__travail" role="status" aria-label="L'agent travaille" />
              ) : (
                <Icon icon={session.agent ? "solar:cpu-bolt-linear" : "solar:command-linear"} width={13} height={13} />
              )}
              <span className="terminal-tab__label">{session.customTitle ?? session.title}</span>
              <button
                type="button"
                className="terminal-tab__rename"
                title="Renommer le terminal (vide = nom donné par le shell)"
                aria-label={`Renommer ${session.customTitle ?? session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  const name = window.prompt("Nom du terminal", session.customTitle ?? session.title);
                  if (name === null) return;
                  patchSession(session.id, { customTitle: name.trim().slice(0, 48) || undefined });
                }}
              ><Icon icon="solar:pen-linear" width={12} height={12} /></button>
              <span
                className="terminal-tab__status"
                data-status={session.status}
                data-etat={session.agent ? session.etat ?? (session.enPause ? "pause" : undefined) : undefined}
              />
              <span
                className="terminal-tab__close"
                role="button"
                tabIndex={-1}
                title="Fermer le terminal"
                onClick={(event) => {
                  event.stopPropagation();
                  closeSession(session.id);
                }}
              >
                <Icon icon="solar:close-circle-linear" width={13} height={13} />
              </span>
            </div>
          ))}
        </div>
        <div className="terminal-tabs__actions">
          <BoutonNouvelAgent workspacePath={workspacePath} onLancer={addAgentSession} />
          <BoutonTerminauxOuverts
            lignes={lignesGestionnaire}
            onAller={(id) => setActiveId(id)}
            onArreter={(id) => surfaces.current.get(id)?.arreter()}
            onToutArreter={() => {
              for (const l of lignesGestionnaire) if (l.enCours) surfaces.current.get(l.id)?.arreter();
            }}
          />
          <BoutonCommandesTerminal dossier={activeSession.agent?.dossier ?? workspacePath} onChoisir={envoyerAuTerminal} />
          <BoutonPlusActions
            scinde={!!vue}
            peutScinder={shownId !== GIT_TAB_ID}
            onRechercher={() => setRecherche(true)}
            onCopierTout={copierToutLaSortie}
            onScinder={scinder}
          />
          <button
            type="button"
            className="terminal-action"
            onClick={addSession}
            title="Nouveau terminal"
          >
            <Icon icon="solar:add-circle-linear" width={14} height={14} />
          </button>
          <button
            type="button"
            className="terminal-action"
            onClick={closeAllSessions}
            title="Fermer tous les terminaux"
            aria-label="Fermer tous les terminaux"
          >
            <Icon icon="solar:trash-bin-trash-linear" width={14} height={14} />
          </button>
          <button
            type="button"
            className="terminal-action"
            data-active={fullHeight ? "true" : "false"}
            onClick={onToggleFullHeight}
            title={fullHeight ? "Hauteur normale du terminal" : "Pleine hauteur"}
          >
            <Icon
              icon={
                fullHeight
                  ? "solar:quit-full-screen-square-linear"
                  : "solar:full-screen-square-linear"
              }
              width={14}
              height={14}
            />
          </button>
          <button
            type="button"
            className="terminal-action"
            onClick={onClose}
            title="Masquer le terminal"
          >
            <Icon
              icon="solar:square-alt-arrow-down-linear"
              width={14}
              height={14}
            />
          </button>
        </div>
      </div>

      <div className="terminal-views" data-scinde={vue ? "true" : "false"}>
        {recherche && !gitActive ? (
          <RechercheTerminal key={shownId} terminal={surfaces.current.get(shownId)?.terminal ?? null} onFermer={() => setRecherche(false)} />
        ) : null}
        {notice ? <div className="acli-notice" role="status">{notice}</div> : null}
        {gitActive ? (
          <div className="terminal-viewport terminal-viewport--git" data-active="true">
            <GitPanel workspacePath={workspacePath} active={active} hasStreamingConversation={false} onSwitchWorkspace={async () => undefined} />
          </div>
        ) : null}
        {sessions.map((session) => (
          <TerminalSurface
            key={`${session.id}:${session.relance ?? 0}`}
            session={session}
            active={active && (session.id === shownId || session.id === vue?.gauche || session.id === vue?.droite)}
            focus={active && session.id === shownId}
            cote={vue ? (session.id === vue.gauche ? "gauche" : session.id === vue.droite ? "droite" : undefined) : undefined}
            onFocusSurface={() => {
              if (vue && session.id !== shownId) setActiveId(session.id);
            }}
            onApi={(api) => {
              if (api) surfaces.current.set(session.id, api);
              else surfaces.current.delete(session.id);
            }}
            workspacePath={workspacePath}
            onStatus={(status) => patchSession(session.id, { status })}
            onTitle={(title) => patchSession(session.id, { title })}
            onEtat={(etat, etatLibelle) => patchSession(session.id, { etat, etatLibelle })}
            onRelancer={(reprendre) => relancer(session.id, reprendre)}
            onOpenTerminalPath={onOpenTerminalPath}
          />
        ))}
      </div>
    </section>
  );
}

function TerminalSurface({
  session,
  active,
  workspacePath,
  onStatus,
  onTitle,
  onEtat,
  onRelancer,
  onOpenTerminalPath,
  focus,
  cote,
  onFocusSurface,
  onApi,
}: {
  session: TerminalSession;
  active: boolean;
  /** Ce terminal prend le focus (le second d'un terminal scindé ne le prend pas). */
  focus: boolean;
  cote?: "gauche" | "droite";
  onFocusSurface: () => void;
  onApi: (api: ApiSurface | null) => void;
  workspacePath: string;
  onStatus: (status: TerminalStatus) => void;
  onTitle: (title: string) => void;
  onEtat: (etat: EtatAgent, libelle: string) => void;
  onRelancer: (reprendre: boolean) => void;
  onOpenTerminalPath?: (rawPath: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const tokenRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const disposablesRef = useRef<Disposable[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disposedRef = useRef(false);
  // Latest path-click handler kept in a ref so the link provider sees
  // updates without having to re-register every time the parent re-renders.
  const onOpenTerminalPathRef = useRef(onOpenTerminalPath);
  onOpenTerminalPathRef.current = onOpenTerminalPath;
  // terminal-onglets - valeur courante de `active` pour les observateurs
  // crees une seule fois (le ResizeObserver gardait la valeur du demarrage).
  const activeRef = useRef(active);
  activeRef.current = active;
  // État d'un agent (travaille / attend / fini) : suivi hors rendu, publié au panneau.
  const suiviRef = useRef<Suivi>(suiviInitial(Date.now()));
  const onEtatRef = useRef(onEtat);
  onEtatRef.current = onEtat;
  const horlogeRef = useRef<number | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;
  const [depot, setDepot] = useState(false);
  // Identifiant donné au service : l'onglet et son dossier (lib/terminalDossier.ts).
  const idPty = identifiantPty(workspacePath, session.id);

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    const token = tokenRef.current;
    if (!terminal || !fit || !container) return;

    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    try {
      fit.fit();
    } catch {
      // xterm cannot measure while the panel is hidden.
      return;
    }

    if (token) {
      void api.resizeTerminal(
        idPty,
        token,
        terminal.cols,
        terminal.rows,
        Math.max(0, Math.round(rect.width)),
        Math.max(0, Math.round(rect.height)),
      );
    }
  }, [idPty]);

  const startTerminal = useCallback(() => {
    const container = containerRef.current;
    if (!container || terminalRef.current) return;
    // terminal-onglets - ne jamais ouvrir xterm dans un conteneur invisible
    // ou de taille 0 (onglet Git affiche, panneau en cours de mise en page) :
    // le rendu resterait vide. On attend qu'il ait une taille.
    const firstRect = container.getBoundingClientRect();
    if (firstRect.width <= 0 || firstRect.height <= 0) {
      if (!resizeObserverRef.current) {
        const waiter = new ResizeObserver(() => {
          const r = container.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && activeRef.current) {
            waiter.disconnect();
            if (resizeObserverRef.current === waiter) resizeObserverRef.current = null;
            startTerminalRef.current?.();
          }
        });
        waiter.observe(container);
        resizeObserverRef.current = waiter;
      }
      return;
    }
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;

    disposedRef.current = false;
    const token = createTerminalToken(session.id);
    tokenRef.current = token;
    onStatus("starting");

    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    const fontFamily = cssVar(
      "--font-mono",
      '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    );
    // zoom — `--fs-mono` is a calc() expression now: scale the base
    // ourselves so xterm keeps exact cell metrics.
    // e19 — le terminal ne suit plus le reglage « taille du texte » : seuls le
    // chat et les documents s'agrandissent.
    const fontSize = MONO_BASE_PX;

    const terminal = new Terminal({
      // Required for `unicode11` and a few other addons we register below.
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily,
      fontSize,
      letterSpacing: 0,
      // VS Code-style line height: keeps cells flush so WebGL redraws
      // don't leave half-pixel artefacts when TUIs repaint full-screen.
      lineHeight: 1.0,
      macOptionIsMeta: true,
      scrollback: 50_000,
      // Smooth pasted text in apps that don't enable bracketed paste.
      convertEol: false,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    const webLinks = new WebLinksAddon((event, uri) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      ouvrirLien(uri, (u) => api.openExternalUrl(u), event.shiftKey); // Maj : l'autre navigateur
    });
    const unicode11 = new Unicode11Addon();
    const clipboard = new ClipboardAddon();

    terminal.loadAddon(fit);
    terminal.onWriteParsed(() => scheduleTerminalBufferSave(workspacePath, session.id));
    // Ctrl+Tab / Ctrl+Shift+Tab switch terminals: not sent to the shell.
    terminal.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.key === "Tab"));
    terminal.loadAddon(webLinks);
    terminal.loadAddon(unicode11);
    terminal.loadAddon(clipboard);
    try {
      terminal.unicode.activeVersion = "11";
    } catch {
      // Older xterm versions or proposed API disabled: silently ignore.
    }
    terminal.open(container);
    terminalBuffers.set(terminalBufferKey(workspacePath, session.id), terminal);
    try {
      const saved = localStorage.getItem(terminalBufferKey(workspacePath, session.id));
      if (saved) {
        const lines = JSON.parse(saved) as string[];
        terminal.write(`\x1b[2m--- historique enregistré (session précédente) ---\x1b[0m\r\n${lines.join("\r\n")}\r\n`);
      }
    } catch { /* no stored scrollback */ }

    // GPU renderer with graceful fallback to the built-in DOM renderer.
    // We try WebGL first (closest to VS Code), and if the context is
    // ever lost or the addon refuses to load we just dispose it -- xterm
    // automatically falls back to the DOM renderer.
    const tryEnableWebgl = () => {
      if (webglRef.current) return;
      // terminal-onglets - sous Windows (WebView2) le canvas WebGL de xterm
      // peut rester vide alors que le shell tourne : rendu DOM, toujours fiable.
      if (/windows/i.test(navigator.userAgent)) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // Lost the GPU context (suspend / driver crash / tab background):
          // dispose the addon so xterm falls back to the DOM renderer.
          addon.dispose();
          webglRef.current = null;
        });
        terminal.loadAddon(addon);
        webglRef.current = addon;
      } catch (err) {
        // WebGL is unavailable or initialisation failed: stay on the
        // DOM renderer, which is slower but always works.
        console.warn("WebGL renderer unavailable, falling back to DOM", err);
      }
    };
    tryEnableWebgl();

    // Register the path link provider *after* the addons are loaded.
    // The provider opens files in the editor on cmd/ctrl+click; plain
    // hover decoration is handled by xterm.js for free.
    const linkProvider = createPathLinkProvider(terminal, () =>
      onOpenTerminalPathRef.current,
    );
    const linkProviderDisposable = terminal.registerLinkProvider(linkProvider);

    terminalRef.current = terminal;
    fitRef.current = fit;
    onApiRef.current({
      terminal,
      arreter: () => {
        const jeton = tokenRef.current;
        if (jeton) void api.killTerminal(idPty, jeton);
      },
      ecrire: (donnees) => {
        const jeton = tokenRef.current;
        if (!jeton) return false;
        if (session.agent) suiviRef.current = surSaisie(suiviRef.current, Date.now());
        void api.writeTerminal(idPty, jeton, donnees);
        return true;
      },
    });

    // Agent : chaque transition est publiée ; une attente ou une fin prévient l'IDE si
    // l'onglet n'est pas sous les yeux (événement « ide-notification »).
    const agent = session.agent;
    const invites = compilerInvites(agent?.invites);
    let message: string | null = null;
    const suivre = (t: Transition) => {
      const avant = suiviRef.current.etat;
      suiviRef.current = t.suivi;
      if (t.suivi.etat !== avant) onEtatRef.current(t.suivi.etat, libelleEtat(t.suivi));
      if (agent && t.notifier && !(activeRef.current && document.hasFocus())) {
        emettreNotification(notificationAgent(agent.nom, agent.dossier, t.suivi, message));
      }
      message = null;
    };
    const signal = (texte: string | null) => {
      message = texte;
      suivre(surSignal(suiviRef.current, Date.now(), texte));
    };

    disposablesRef.current = [
      linkProviderDisposable,
      terminal.onData((data) => {
        const currentToken = tokenRef.current;
        if (!currentToken) return;
        if (agent) suiviRef.current = surSaisie(suiviRef.current, Date.now());
        void api.writeTerminal(idPty, currentToken, data);
      }),
      terminal.onBell(() => {
        if (agent) signal(null);
      }),
      terminal.parser.registerOscHandler(9, (data) => {
        const texte = messageOsc9(data);
        if (agent && texte) signal(texte);
        return false;
      }),
      terminal.parser.registerOscHandler(777, (data) => {
        const texte = messageOsc777(data);
        if (agent && texte) signal(texte);
        return false;
      }),
      terminal.onResize(({ cols, rows }) => {
        const currentToken = tokenRef.current;
        if (!currentToken) return;
        const rect = containerRef.current?.getBoundingClientRect();
        void api.resizeTerminal(
          idPty,
          currentToken,
          cols,
          rows,
          Math.max(0, Math.round(rect?.width ?? 0)),
          Math.max(0, Math.round(rect?.height ?? 0)),
        );
      }),
      terminal.onTitleChange((title) => {
        // Onglet d'agent : le titre reste « agent · dossier ».
        if (session.agent) return;
        const trimmed = title.trim();
        // pwsh annonce le chemin de son exe (« C:\\Program Files\\... ») : on garde « Terminal N ».
        if (trimmed && !isExecutablePathTitle(trimmed)) onTitle(trimmed);
      }),
    ];

    resizeObserverRef.current = new ResizeObserver(() => {
      if (activeRef.current) fitTerminal();
    });
    resizeObserverRef.current.observe(container);
    // Cells resized without the host resizing (screen scale, font metrics): refit so the
    // grid stays inside the panel and the PTY gets the size really shown.
    const arreterMesures = suivreMesuresTerminal(window, document.fonts, () => {
      if (!activeRef.current) return;
      fitTerminal();
      // New cell size: redraw every row (glyphs are re-rasterised for the new scale).
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
    disposablesRef.current.push({ dispose: arreterMesures });

    // Agent rouvert avec l'appli : historique affiché, rien ne tourne (« Relancer »).
    if (session.enPause) {
      tokenRef.current = null;
      onStatus("idle");
      return;
    }
    if (agent) {
      horlogeRef.current = window.setInterval(() => {
        suivre(surHorloge(suiviRef.current, Date.now(), ecranBas(terminal), invites));
      }, 500);
    }

    const dataListener = listen<TerminalDataPayload>(
      "terminal-data",
      (event) => {
        const payload = event.payload;
        if (payload.sessionId !== idPty || payload.token !== token) return;
        terminal.write(payload.data);
        if (agent) suivre({ suivi: surSortie(suiviRef.current, Date.now()), notifier: false });
      },
    );

    const exitListener = listen<TerminalExitPayload>(
      "terminal-exit",
      (event) => {
        const payload = event.payload;
        if (payload.sessionId !== idPty || payload.token !== token) return;
        tokenRef.current = null;
        onStatus(payload.exitCode === 0 ? "exited" : "error");
        if (agent) suivre(surFin(suiviRef.current, payload.exitCode ?? null));
        terminal.write("\r\n\x1b[2m[processus terminé]\x1b[0m\r\n");
      },
    );

    void Promise.all([dataListener, exitListener]).then((unlisteners) => {
      for (const unlisten of unlisteners) {
        if (disposedRef.current) {
          unlisten();
        } else {
          unlistenersRef.current.push(unlisten);
        }
      }

      requestAnimationFrame(() => {
        if (disposedRef.current) return;
        try {
          fit.fit();
        } catch {
          // panel may still be measuring; spawn with current cols/rows anyway.
        }
        const rect = container.getBoundingClientRect();
        const lancement = session.agent
          ? lancerTerminalAgent({
              dossier: session.agent.dossier,
              cli: session.agent.cli,
              reprendre: !!session.reprendre,
              sessionId: idPty,
              token,
              cols: Math.max(terminal.cols, 20),
              rows: Math.max(terminal.rows, 4),
              pixelWidth: Math.max(0, Math.round(rect.width)),
              pixelHeight: Math.max(0, Math.round(rect.height)),
            })
          : api.spawnTerminal(
              workspacePath,
              idPty,
              token,
              Math.max(terminal.cols, 20),
              Math.max(terminal.rows, 4),
              Math.max(0, Math.round(rect.width)),
              Math.max(0, Math.round(rect.height)),
              session.shell,
            );
        void lancement
          .then(() => {
            if (disposedRef.current || tokenRef.current !== token) return;
            onStatus("running");
            // worktrees : commande de l'onglet ([[terminaux]] de worktrees.toml), une seule fois.
            const depart = prendreCommandeDepart(workspacePath, session.id);
            if (depart) void api.writeTerminal(idPty, token, `${depart}\r`);
            if (focusRef.current) terminal.focus();
          })
          .catch((err) => {
            if (disposedRef.current) return;
            tokenRef.current = null;
            onStatus("error");
            terminal.write(`\r\n\x1b[31m${stripAnsi(String(err))}\x1b[0m\r\n`);
          });
      });
    }).catch((err) => {
      if (disposedRef.current) return;
      tokenRef.current = null;
      onStatus("error");
      terminal.write(`\r\n\x1b[31m${stripAnsi(String(err))}\x1b[0m\r\n`);
    });
  }, [active, fitTerminal, onStatus, onTitle, session.id, idPty, workspacePath]);
  const startTerminalRef = useRef(startTerminal);
  startTerminalRef.current = startTerminal;

  useEffect(() => {
    if (active) startTerminal();
  }, [active, startTerminal]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitTerminal();
      // Retour depuis l'onglet Git (display:none) : redessiner tout l'ecran.
      const terminal = terminalRef.current;
      if (terminal) terminal.refresh(0, Math.max(0, terminal.rows - 1));
      if (focusRef.current) terminal?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, focus, fitTerminal]);

  // theme — follow the background colour picked in Settings > Apparence.
  useEffect(
    () =>
      onThemeChange(() => {
        const terminal = terminalRef.current;
        if (terminal) terminal.options.theme = terminalTheme();
      }),
    [],
  );

  // e19 — le reglage « taille du texte » ne concerne plus le terminal : son
  // texte garde 12 px, quelle que soit la valeur choisie pour le chat et les documents.

  useEffect(() => {
    return () => {
      disposedRef.current = true;
      if (horlogeRef.current !== null) window.clearInterval(horlogeRef.current);
      horlogeRef.current = null;
      const token = tokenRef.current;
      tokenRef.current = null;
      if (token) {
        void api.killTerminal(idPty, token);
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      for (const dispose of disposablesRef.current) dispose.dispose();
      disposablesRef.current = [];
      for (const unlisten of unlistenersRef.current) unlisten();
      unlistenersRef.current = [];
      // WebGL must be disposed before the parent terminal so its GPU
      // resources are released cleanly.
      try {
        webglRef.current?.dispose();
      } catch {
        // ignore
      }
      webglRef.current = null;
      persistTerminalBuffer(workspacePath, session.id);
      terminalBuffers.delete(terminalBufferKey(workspacePath, session.id));
      onApiRef.current(null);
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [session.id, idPty, workspacePath]);

  // Processus arrêté (ou agent rouvert avec l'appli) : Relancer / Reprendre une session.
  const arrete = !!session.enPause || session.status === "exited" || session.status === "error";
  const texteFin = session.enPause
    ? "Agent arrêté (appli rouverte)"
    : session.agent
      ? session.etatLibelle ?? "Arrêté"
      : "Processus terminé";
  return (
    <div
      className="terminal-viewport acli-surface"
      data-active={active ? "true" : "false"}
      data-arrete={arrete ? "true" : "false"}
      data-agent={session.agent?.cli}
      data-cote={cote}
      data-depot={depot ? "true" : undefined}
      onFocus={onFocusSurface}
      // Fichier glissé depuis l'explorateur : son chemin, entre guillemets, tapé dans le terminal.
      onDragOver={(event) => {
        if (!glisseDepuisExplorateur(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDepot(true);
      }}
      onDragLeave={() => setDepot(false)}
      onDrop={(event) => {
        setDepot(false);
        if (!glisseDepuisExplorateur(event.dataTransfer)) return;
        event.preventDefault();
        const entrees = entreesGlissees(event.dataTransfer);
        const jeton = tokenRef.current;
        if (!entrees.length || !jeton) return;
        const wsl = estWindows() && !session.agent && session.shell === "bash";
        void api.writeTerminal(idPty, jeton, cheminsDeposes(entrees, session.agent ?? null, wsl));
        terminalRef.current?.focus();
      }}
    >
      {/* No global onMouseDown focus -- it would steal the mouse selection. Click on the
          empty area still focuses thanks to xterm's own handlers. */}
      <div ref={containerRef} className="acli-surface__xterm" />
      {arrete ? (
        <div className="acli-fin" role="status">
          <span className="acli-fin__texte" title={texteFin}>{texteFin}</span>
          <button type="button" className="acli-fin__bouton" data-action="relancer" onClick={() => onRelancer(false)}>
            Relancer
          </button>
          {session.agent?.reprise ? (
            <button type="button" className="acli-fin__bouton" data-action="reprendre" onClick={() => onRelancer(true)}>
              Reprendre une session
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Dernières lignes non vides de l'écran (invite de l'agent). */
function ecranBas(terminal: Terminal, lignes = 8): string {
  const buffer = terminal.buffer.active;
  const sortie: string[] = [];
  for (let y = buffer.viewportY + terminal.rows - 1; y >= buffer.viewportY && sortie.length < lignes; y -= 1) {
    const texte = buffer.getLine(y)?.translateToString(true) ?? "";
    if (texte.trim()) sortie.unshift(texte);
  }
  return sortie.join("\n");
}

function terminalStorageKey(workspacePath: string): string {
  return `axecode:terminals:${workspacePath}`;
}

function loadTerminalSessions(workspacePath: string): TerminalSession[] {
  try {
    const raw = localStorage.getItem(terminalStorageKey(workspacePath));
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ index?: number; title?: string; customTitle?: string; shell?: string; agent?: unknown }>;
      const sessions = parsed.filter((item) => Number.isInteger(item.index) && typeof item.title === "string").map((item) => ({
        id: `terminal-${item.index}`,
        index: item.index!,
        // Old default name of the first tab (it only ever ran PowerShell).
        // terminal-onglets - ancien titre = chemin de pwsh.exe : on revient a « Terminal N ».
        title: item.title === "Prime Agent" || isExecutablePathTitle(item.title!) ? `Terminal ${item.index}` : item.title!,
        customTitle: typeof item.customTitle === "string" && item.customTitle ? item.customTitle : undefined,
        shell: item.shell === "bash" ? "bash" : "powershell",
        agent: agentLu(item.agent),
        enPause: agentLu(item.agent) ? true : undefined,
        status: "idle" as TerminalStatus,
      }));
      if (sessions.length) return sessions;
    }
  } catch { /* use defaults */ }
  return [createSession(1)];
}

/** Agent d'un onglet relu du stockage (forme vérifiée, sinon un simple shell). */
function agentLu(brut: unknown): AgentDuTerminal | undefined {
  const a = brut as Partial<AgentDuTerminal> | null | undefined;
  if (!a || typeof a.cli !== "string" || typeof a.nom !== "string" || typeof a.dossier !== "string") return undefined;
  return {
    cli: a.cli,
    nom: a.nom,
    dossier: a.dossier,
    branche: typeof a.branche === "string" ? a.branche : undefined,
    reprise: a.reprise === true,
    invites: Array.isArray(a.invites) ? a.invites.filter((i): i is string => typeof i === "string") : undefined,
  };
}

function createSession(index: number): TerminalSession {
  return {
    id: `terminal-${index}`,
    index,
    title: `Terminal ${index}`,
    status: "idle",
    shell: "powershell",
  };
}

function createTerminalToken(sessionId: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${sessionId}-${crypto.randomUUID()}`;
  }
  return `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// theme — derived from the app theme so light backgrounds get a light terminal.
function terminalTheme() {
  return xtermTheme();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

// ---------------------------------------------------------------------------
// Path link provider
// ---------------------------------------------------------------------------
//
// VS Code-style cmd/ctrl+click on file paths printed in the terminal.
// Detects the most common path shapes emitted by CLIs (compilers, AI
// coding agents, grep/rg, ...):
//
//   foo.tsx                 (bare filename with known-ish extension)
//   src/foo/bar.ts          (relative path with at least one slash)
//   ./foo.ts, ../foo.ts     (explicitly relative)
//   /Users/.../foo.ts       (absolute POSIX)
//   ~/.config/foo.ts        (home-relative)
//   foo.tsx:42, foo.tsx:42:5
//
// URLs (http/https/...) are deliberately ignored -- the WebLinksAddon
// handles those.

const PATH_LINK_REGEX =
  // 1) (~ or ./ or ../)?/... or 2) bare path with slash or 3) bare filename
  //    .ext, all with an optional :line[:col] suffix.
  /(?:(?:~|\.{1,2})?\/[A-Za-z0-9_.+\-@~/]+|[A-Za-z0-9_.+\-@]+(?:\/[A-Za-z0-9_.+\-@]+)+|[A-Za-z0-9_.+\-@]+\.[A-Za-z][A-Za-z0-9]{0,6})(?::\d+(?::\d+)?)?/g;

const URL_LIKE_PREFIX = /^(?:https?:|ftp:|ssh:|file:|mailto:|git\+|tel:)/i;

function createPathLinkProvider(
  terminal: Terminal,
  getHandler: () => ((rawPath: string) => void) | undefined,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const text = readLogicalLine(terminal, bufferLineNumber);
      if (!text) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      // `lastIndex` cursor handles overlapping potential matches.
      PATH_LINK_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PATH_LINK_REGEX.exec(text)) !== null) {
        const raw = match[0];
        if (!raw || URL_LIKE_PREFIX.test(raw)) continue;
        // Strip trailing punctuation that the regex may have eaten
        // ("see foo.ts." or "(foo.ts)").
        const trimmed = raw.replace(/[),.;:\]]+$/g, (tail) => {
          // Keep `:N` and `:N:M` line/col suffixes.
          if (/^:\d+(?::\d+)?$/.test(tail)) return tail;
          // Drop other trailing punctuation only if it isn't part of a
          // line/col suffix.
          return tail.replace(/[),.;\]]+$/g, "");
        });
        if (!trimmed) continue;

        const startIndex = match.index;
        const endIndex = startIndex + trimmed.length;
        const range = logicalRangeToBufferRange(
          terminal,
          bufferLineNumber,
          startIndex,
          endIndex,
        );
        if (!range) continue;

        links.push({
          range,
          text: trimmed,
          activate(event) {
            // VS Code semantics: cmd/ctrl+click only.
            if (!event.metaKey && !event.ctrlKey) return;
            event.preventDefault();
            event.stopPropagation();
            getHandler()?.(trimmed);
          },
          hover() {
            // xterm.js applies the default link styling automatically.
          },
          leave() {
            // no-op
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * xterm represents wrapped lines as multiple buffer rows. For accurate
 * path matching we collapse the wrapped slice back into a single logical
 * string starting at `bufferLineNumber`.
 */
function readLogicalLine(terminal: Terminal, bufferLineNumber: number): string {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(bufferLineNumber);
  if (!line) return "";
  // Walk back to the start of a wrapped logical line so the regex sees
  // the full text. We then stitch all wrapped rows forward.
  let start = bufferLineNumber;
  while (start > 0) {
    const prev = buffer.getLine(start - 1);
    if (!prev || !buffer.getLine(start)?.isWrapped) break;
    start -= 1;
  }
  const parts: string[] = [];
  let cursor = start;
  while (true) {
    const current = buffer.getLine(cursor);
    if (!current) break;
    parts.push(current.translateToString(true));
    const next = buffer.getLine(cursor + 1);
    if (!next || !next.isWrapped) break;
    cursor += 1;
  }
  return parts.join("");
}

/**
 * Convert a [start,end] offset inside the *logical* (unwrapped) line
 * starting at `bufferLineNumber` to xterm's wrapped-buffer coordinates.
 */
function logicalRangeToBufferRange(
  terminal: Terminal,
  bufferLineNumber: number,
  startIndex: number,
  endIndex: number,
): IBufferRange | null {
  const cols = terminal.cols;
  if (cols <= 0) return null;
  // Find the first row of the wrapped logical line.
  const buffer = terminal.buffer.active;
  let firstRow = bufferLineNumber;
  while (firstRow > 0) {
    if (!buffer.getLine(firstRow)?.isWrapped) break;
    firstRow -= 1;
  }
  const startRowOffset = Math.floor(startIndex / cols);
  const startCol = startIndex - startRowOffset * cols;
  const endRowOffset = Math.floor(Math.max(0, endIndex - 1) / cols);
  const endCol = (endIndex - 1) - endRowOffset * cols;
  return {
    // xterm.js link ranges are 1-based.
    start: { x: startCol + 1, y: firstRow + startRowOffset + 1 },
    end: { x: endCol + 1, y: firstRow + endRowOffset + 1 },
  };
}
