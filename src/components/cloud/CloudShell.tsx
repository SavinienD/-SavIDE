// axe:cloud — signed-in shell of the cloud mode: top bar (tabs + account
// menu) and the three tabs. Tabs stay mounted once opened so a running chat
// or SavIDE session keeps its state when switching.
import { useEffect, useRef, useState } from "react";
import { AxeLogo } from "../../axe/Logo";
import { WindowControls, isWindowsPlatform } from "../WindowControls";
import { RemoteConversations } from "../agents/RemoteConversations";
import { ErrorBoundary } from "../ErrorBoundary"; // axe:robustesse
import { PrimeAgentTab } from "./PrimeAgentTab";
import { TerminalTab } from "./TerminalTab";
import { CLOUD_CONNECTION, cloudApi, errorText, primeApi, roleLabel, type CloudState } from "./cloudApi";

type Tab = "prime" | "atelier" | "terminal";

type Props = {
  cloud: CloudState;
  onLoggedOut: () => void;
  onLocalMode: () => void;
};

const IS_WINDOWS = isWindowsPlatform();
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

export function CloudShell({ cloud, onLoggedOut, onLocalMode }: Props) {
  const isAdmin = cloud.role === "admin";
  const [tab, setTab] = useState<Tab>("prime");
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set<Tab>(["prime"]));
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [workDir, setWorkDir] = useState<string | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);

  // Refreshes role / expiry (Rust updates its copy on /app/moi) and the SavIDE folder.
  useEffect(() => {
    void primeApi
      .appMoi()
      .then((moi) => setWorkDir(moi.dossier_atelier ?? undefined))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isAdmin && tab !== "prime") setTab("prime");
  }, [isAdmin, tab]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const show = (next: Tab) => {
    setTab(next);
    setOpened((set) => (set.has(next) ? set : new Set(set).add(next)));
  };

  const openWeb = async (suite: string) => {
    setMenuOpen(false);
    setNotice(null);
    try {
      await cloudApi.openWeb(suite);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  const logout = async () => {
    setMenuOpen(false);
    try {
      await cloudApi.logout();
    } finally {
      onLoggedOut();
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "prime", label: "Prime Agent" },
    ...(isAdmin
      ? [
          { id: "terminal" as Tab, label: "Terminal" },
        ]
      : []),
  ];

  return (
    <div className="axc-shell">
      <header className="axc-topbar" data-tauri-drag-region style={IS_MAC ? { paddingLeft: 84 } : undefined}>
        <span className="axc-topbar__brand" data-tauri-drag-region>
          <AxeLogo variant="mark" size={18} /> SavIDE
        </span>
        <nav className="axc-tabs" role="tablist" aria-label="Espaces">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="axc-tab"
              aria-selected={tab === item.id}
              onClick={() => show(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <span className="axc-topbar__spacer" data-tauri-drag-region />
        <div className="axc-account" ref={menuRef}>
          <button
            type="button"
            className="axc-account__button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={cloud.email}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {(cloud.email.charAt(0) || "?").toUpperCase()}
          </button>
          {menuOpen ? (
            <div className="axc-account__menu" role="menu">
              <div className="axc-account__who">
                <strong>{cloud.email}</strong>
                <span className={isAdmin ? "axc-badge axc-badge--admin" : "axc-badge"}>{roleLabel(cloud.role)}</span>
              </div>
              <button type="button" role="menuitem" className="axc-account__item" onClick={() => void openWeb("/prime/")}>
                Ouvrir le portail dans le navigateur
              </button>
              {isAdmin ? (
                <button type="button" role="menuitem" className="axc-account__item" onClick={() => void openWeb("/admin/")}>
                  Administration (utilisateurs, coûts)
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="axc-account__item"
                onClick={() => {
                  setMenuOpen(false);
                  onLocalMode();
                }}
              >
                Mode local (hors ligne)
              </button>
              <button type="button" role="menuitem" className="axc-account__item axc-account__item--danger" onClick={() => void logout()}>
                Se déconnecter
              </button>
            </div>
          ) : null}
        </div>
        {IS_WINDOWS ? <WindowControls /> : null}
      </header>

      {notice ? (
        <p className="axc-banner axc-banner--warn" role="alert">
          {notice}
        </p>
      ) : null}

      <main className="axc-body">
        <div className="axc-pane" hidden={tab !== "prime"} role="tabpanel">
          <ErrorBoundary label="onglet Prime Agent">
            <PrimeAgentTab active={tab === "prime"} />
          </ErrorBoundary>
        </div>
        {isAdmin && opened.has("atelier") ? (
          <div className="axc-pane axc-atelier" hidden={tab !== "atelier"} role="tabpanel">
            <ErrorBoundary label="onglet SavIDE">
              <RemoteConversations connectionId={CLOUD_CONNECTION} defaultWorkspace={workDir} />
            </ErrorBoundary>
          </div>
        ) : null}
        {isAdmin && opened.has("terminal") ? (
          <div className="axc-pane" hidden={tab !== "terminal"} role="tabpanel">
            <ErrorBoundary label="onglet Terminal">
              <TerminalTab />
            </ErrorBoundary>
          </div>
        ) : null}
      </main>
    </div>
  );
}
