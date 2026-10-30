// axe:e8 / axe:v2-e12 — le terminal, a onglets :
//   • « Bash » = une session du service (elle survit a la deconnexion et se reprend) ;
//   • « Terminal local » = un shell du poste ou tourne l'appli ;
//   • « Prime Agent » = epingle : on s'ATTACHE a la session de production de Prime
//     (le portail la garde ouverte), on ne la relance jamais.
//
// axe:e15 — deux changements demandes par l'utilisateur :
//   1. les onglets se voient aussi depuis l'interface classique (le panneau n'est
//      plus reserve a l'espace : il suffit d'une session Axe Cloud ouverte) ;
//   2. un onglet se DETACHE comme dans un navigateur : il part devant dans sa
//      propre fenetre, les autres restent en bas (detacher le Bash et laisser
//      Prime Agent dans le panneau). Refermer la fenetre le reancre.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { RemoteTerminal } from "./RemoteTerminal";
import { cloudSubdirFromPath } from "../../lib/ipc"; // axe:cloud-sous-dossier
import { LocalTerminal } from "./LocalTerminal";
import { PrimeTerminal } from "./PrimeTerminal";
import { GitPanel } from "../GitPanel"; // axe:git-onglet
import { FenetreOnglet } from "../onglets/FenetreOnglet"; // axe:e15

type Kind = "cloud" | "local" | "prime" | "git";

type Tab = {
  /** Nom de la session cote service (aussi le nom tmux) ; pour un local : l'identifiant du shell. */
  name: string;
  title: string;
  /** Un onglet epingle ne peut pas etre ferme. */
  pinned?: boolean;
  kind?: Kind;
  /** axe:e15 — l'onglet vit dans sa propre fenetre, devant le reste. */
  detached?: boolean;
};

type Props = {
  connectionId: string;
  workspacePath: string;
  /** axe:e6 — un volet dupliqué garde ses propres onglets (clé distincte dans
   *  localStorage) au lieu de reprendre ceux du terminal ancré. */
  storageKey?: string;
};

const STORAGE_PREFIX = "axe:e8:terminaux:";

/// L'agent de la machine : epingle, non fermable.
const PINNED: Tab = { name: "prime", title: "Prime Agent", pinned: true, kind: "prime" };
// axe:git-onglet - Git en onglet epingle a cote de Prime Agent et des bash.
const GIT_TAB: Tab = { name: "git", title: "Git", pinned: true, kind: "git" };

function kindOf(tab: Tab): Kind {
  return tab.kind ?? (tab.name === "prime" ? "prime" : tab.name === "git" ? "git" : "cloud");
}

function iconeDe(kind: Kind): string {
  if (kind === "prime") return "solar:cpu-bolt-linear";
  if (kind === "git") return "solar:branching-paths-up-linear";
  if (kind === "local") return "solar:laptop-linear";
  return "solar:server-square-linear";
}

function load(workspacePath: string): Tab[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + workspacePath);
    if (!raw) return null;
    const list = JSON.parse(raw) as Tab[];
    if (!Array.isArray(list) || list.length === 0) return null;
    // axe:v2-e12 — les onglets deja enregistres s'appelaient « Terminal N » :
    // ce sont des bash du service, ils prennent leur vrai nom.
    const migres = list.map((t) => {
      if (!t || typeof t.name !== "string" || t.name.length === 0) return t;
      if (t.name === "prime") return { ...t, kind: "prime" as Kind, title: "Prime Agent" };
      const ancien = /^Terminal (\d+)$/.exec(t.title ?? "");
      if (ancien) return { ...t, kind: "cloud" as Kind, title: `Bash ${ancien[1]}` };
      return t;
    });
    const clean = migres.filter((t) => t && typeof t.name === "string" && t.name.length > 0);
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
}

function save(workspacePath: string, tabs: Tab[]) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + workspacePath, JSON.stringify(tabs));
  } catch {
    /* plein ou interdit : on garde la liste en memoire */
  }
}

export function CloudTerminalPanel({ connectionId, workspacePath, storageKey }: Props) {
  const cleStockage = storageKey ?? workspacePath; // axe:e6
  const [tabs, setTabs] = useState<Tab[]>(() => {
    // axe:e15 — les onglets deja enregistres sous l'ancienne cle (le chemin de
    // l'espace) sont repris : on ne perd pas les sessions ouvertes en changeant
    // de cle de stockage.
    const stored =
      load(cleStockage) ?? (cleStockage === workspacePath ? null : load(workspacePath));
    const base = !stored ? [PINNED, { name: "axe-main", title: "Bash 1", kind: "cloud" as Kind }] : stored.some((t) => t.name === PINNED.name) ? stored : [PINNED, ...stored];
    return base.some((t) => t.name === GIT_TAB.name) ? base : [base[0], GIT_TAB, ...base.slice(1)];
  });
  const [active, setActive] = useState<string>(tabs[0]?.name ?? PINNED.name);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    save(cleStockage, tabs);
  }, [tabs, cleStockage]);

  const ancres = useMemo(() => tabs.filter((t) => !t.detached), [tabs]);
  const detaches = useMemo(() => tabs.filter((t) => t.detached), [tabs]);

  useEffect(() => {
    if (!ancres.some((t) => t.name === active)) setActive(ancres[0]?.name ?? "");
  }, [ancres, active]);

  useEffect(() => {
    if (!menu) return;
    const fermer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", fermer);
    return () => window.removeEventListener("mousedown", fermer);
  }, [menu]);

  const prochainNumero = useCallback(
    (kind: Kind) => {
      let index = 1;
      const prefixe = kind === "local" ? "axe-local-" : "axe-term-";
      while (tabs.some((t) => t.name === `${prefixe}${index}`)) index += 1;
      return index;
    },
    [tabs],
  );

  const ajouter = useCallback(
    (kind: Kind) => {
      setMenu(false);
      if (kind === "local") {
        const index = prochainNumero("local");
        const tab: Tab = { name: `axe-local-${index}`, title: `Terminal local ${index}`, kind: "local" };
        setTabs((list) => [...list, tab]);
        setActive(tab.name);
        return;
      }
      const index = prochainNumero("cloud");
      const existants = tabs.filter((t) => kindOf(t) === "cloud").length;
      const tab: Tab = { name: `axe-term-${index}`, title: `Bash ${existants + 1}`, kind: "cloud" };
      setTabs((list) => [...list, tab]);
      setActive(tab.name);
    },
    [prochainNumero, tabs],
  );

  const close = useCallback((name: string) => {
    setTabs((list) => {
      const tab = list.find((t) => t.name === name);
      if (!tab || tab.pinned) return list;
      const next = list.filter((t) => t.name !== name);
      return next.length > 0 ? next : [{ name: "axe-main", title: "Bash 1", kind: "cloud" }];
    });
  }, []);

  const rename = useCallback(
    (name: string) => {
      const tab = tabs.find((t) => t.name === name);
      if (!tab) return;
      const title = window.prompt("Nom de l'onglet", tab.title);
      if (title === null) return;
      const clean = title.trim().slice(0, 48);
      if (!clean) return;
      setTabs((list) => list.map((t) => (t.name === name ? { ...t, title: clean } : t)));
    },
    [tabs],
  );

  // axe:e15 — detacher / reancrer. Une session cloud ou Prime se rattache par son
  // nom (tmux garde tout) ; un shell local repart, c'est le seul compromis.
  const detacher = useCallback((name: string) => {
    setTabs((list) => list.map((t) => (t.name === name ? { ...t, detached: true } : t)));
  }, []);

  const reancrer = useCallback((name: string) => {
    setTabs((list) => list.map((t) => (t.name === name ? { ...t, detached: false } : t)));
    setActive(name);
  }, []);

  // Le contenu d'un onglet, rendu soit dans le panneau, soit dans sa fenetre.
  // Une seule instance a la fois : deux montages ouvriraient deux sessions.
  const contenu = useCallback(
    (tab: Tab) => {
      const kind = kindOf(tab);
      if (kind === "local") return <LocalTerminal workspacePath={workspacePath} sessionId={tab.name} />;
      if (kind === "prime") return <PrimeTerminal connectionId={connectionId} />;
      if (kind === "git") return <GitPanel workspacePath={workspacePath} active={true} hasStreamingConversation={false} onSwitchWorkspace={async () => undefined} />;
      return <RemoteTerminal key={tab.name} connectionId={connectionId} name={tab.name} cwd={cloudSubdirFromPath(workspacePath)} />;
    },
    [connectionId, workspacePath],
  );

  const current = useMemo(() => ancres.find((t) => t.name === active) ?? ancres[0], [ancres, active]);
  // Les shells locaux restent montes tant qu'ils sont ancres : changer d'onglet ne
  // doit pas tuer le shell du poste.
  const locauxAncres = useMemo(() => ancres.filter((t) => kindOf(t) === "local"), [ancres]);

  return (
    <div className="cloud-term">
      <div className="terminal-tabs">
        <div className="terminal-tabs__list">
          {ancres.map((tab) => (
            <div
              key={tab.name}
              role="tab"
              aria-selected={tab.name === current?.name}
              className="terminal-tab"
              data-tab={kindOf(tab)}
              data-active={tab.name === current?.name ? "true" : "false"}
              onClick={() => setActive(tab.name)}
              onDoubleClick={() => rename(tab.name)}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => {
                // Clic molette : fermer l'onglet.
                if (event.button === 1) { event.preventDefault(); event.stopPropagation(); if (!tab.pinned) close(tab.name); }
              }}
              title={kindOf(tab) === "prime" ? "L'agent de la machine (il tourne en production)" : tab.name}
            >
              <Icon icon={iconeDe(kindOf(tab))} width={13} height={13} />
              <span>{tab.title}</span>
              <button
                type="button"
                className="terminal-tab__rename"
                title="Renommer"
                aria-label={`Renommer ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  rename(tab.name);
                }}
              >
                <Icon icon="solar:pen-linear" width={12} height={12} />
              </button>
              <button
                type="button"
                className="terminal-tab__rename"
                title="Détacher cet onglet dans une fenêtre (les autres restent ici)"
                aria-label={`Détacher ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  detacher(tab.name);
                }}
              >
                <Icon icon="solar:pip-linear" width={12} height={12} />
              </button>
              {tab.pinned ? (
                <span className="terminal-tab__status" title="Épinglé" />
              ) : (
                <span
                  className="terminal-tab__close"
                  role="button"
                  tabIndex={-1}
                  title="Fermer cet onglet"
                  onClick={(event) => {
                    event.stopPropagation();
                    close(tab.name);
                  }}
                >
                  <Icon icon="solar:close-circle-linear" width={13} height={13} />
                </span>
              )}
            </div>
          ))}
          {detaches.length > 0 ? (
            <div className="terminal-tabs__detaches" title="Onglets détachés, ouverts dans une fenêtre">
              <Icon icon="solar:pip-linear" width={12} height={12} />
              {detaches.length}
            </div>
          ) : null}
        </div>
        <div className="terminal-tabs__actions" ref={menuRef}>
          <button
            type="button"
            className="terminal-action"
            onClick={() => setMenu((v) => !v)}
            title="Nouvel onglet"
            aria-haspopup="menu"
            aria-expanded={menu}
          >
            <Icon icon="solar:add-circle-linear" width={14} height={14} />
          </button>
          {menu ? (
            <div className="terminal-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => ajouter("cloud")}>
                <Icon icon="solar:server-square-linear" width={14} height={14} />
                <span>Nouveau terminal cloud</span>
                <small>sur la machine distante</small>
              </button>
              <button type="button" role="menuitem" onClick={() => ajouter("local")}>
                <Icon icon="solar:laptop-linear" width={14} height={14} />
                <span>Nouveau terminal local</span>
                <small>sur ce poste</small>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="cloud-term__body">
        {locauxAncres.map((tab) => (
          <div
            key={`pane-${tab.name}`}
            className="cloud-term__pane"
            style={{ display: tab.name === current?.name ? "flex" : "none" }}
          >
            {contenu(tab)}
          </div>
        ))}
        {current && kindOf(current) !== "local" ? (
          <div className="cloud-term__pane" style={{ display: "flex" }}>
            {contenu(current)}
          </div>
        ) : null}
        {detaches.map((tab) => (
          <FenetreOnglet
            key={`fenetre-${tab.name}`}
            id={`terminal-${cleStockage}-${tab.name}`}
            titre={tab.title}
            sousTitre={kindOf(tab) === "prime" ? "agent" : kindOf(tab)}
            icone={iconeDe(kindOf(tab))}
            onClose={() => reancrer(tab.name)}
          >
            {contenu(tab)}
          </FenetreOnglet>
        ))}
      </div>
    </div>
  );
}
