import { useCallback, useEffect, useState } from "react";
import { auth, service, type AuthState, type SessionMeta } from "./api";
import { Conversation } from "./Conversation";
import { ConversationList } from "./ConversationList";
import { Login } from "./Login";
import { NewConversation } from "./NewConversation"; // axe:freechat

// axe:freechat — `#/new` starts a free conversation.
const NEW_ROUTE = "#/new";

function useRoute(): [string | null, (id: string | null) => void, boolean] {
  const read = () => {
    const match = /^#\/c\/(.+)$/.exec(location.hash);
    return match ? decodeURIComponent(match[1]) : null;
  };
  const [id, setId] = useState<string | null>(read);
  const [isNew, setIsNew] = useState(() => location.hash === NEW_ROUTE);
  useEffect(() => {
    const onHash = () => {
      setId(read());
      setIsNew(location.hash === NEW_ROUTE);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((next: string | null) => {
    location.hash = next ? `#/c/${encodeURIComponent(next)}` : "#/";
  }, []);
  return [id, go, isNew];
}

export function App() {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    auth
      .state()
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(refresh, [refresh]);

  if (error) {
    return (
      <div className="login">
        <div className="login__card">
          <h1>SavIDE</h1>
          <p className="error">Service injoignable : {error}</p>
          <button type="button" onClick={refresh}>
            Réessayer
          </button>
        </div>
      </div>
    );
  }
  if (!state) return <div className="splash muted">Chargement…</div>;
  if (!state.authenticated) return <Login onDone={refresh} />;
  return <Shell auth={state} onLogout={refresh} />;
}

function Shell({ auth: authState, onLogout }: { auth: AuthState; onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [connected, setConnected] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [activeId, open, isNew] = useRoute();

  useEffect(() => {
    const load = () =>
      service
        .list()
        .then((list) => {
          setSessions(list);
          setProblem(null);
        })
        .catch((e) => setProblem(String(e.message ?? e)));
    const offState = service.onState((value) => {
      setConnected(value);
      if (value) void load();
    });
    const offEvent = service.onEvent((ev) => {
      if (ev.event === "status" && ev.data?.id) {
        const meta = ev.data as SessionMeta;
        setSessions((list) => {
          const index = list.findIndex((s) => s.id === meta.id);
          if (index < 0) return [...list, meta];
          const next = list.slice();
          next[index] = meta;
          return next;
        });
      } else if (ev.event === "entry" && ev.sessionId) {
        setSessions((list) =>
          list.map((s) => (s.id === ev.sessionId ? { ...s, updatedAtMs: Date.now() } : s)),
        );
      }
    });
    service.connect().catch(() => setProblem("Connexion au service impossible (session expirée ?)."));
    return () => {
      offState();
      offEvent();
    };
  }, []);

  const logout = async () => {
    await auth.logout().catch(() => {});
    service.close();
    onLogout();
  };

  const active = sessions.find((s) => s.id === activeId) ?? null;

  // axe:freechat — the new session is shown right away (its `status` event
  // may arrive after the reply of `sessions.create`).
  const created = (meta: SessionMeta) => {
    setSessions((list) => (list.some((s) => s.id === meta.id) ? list : [...list, meta]));
    open(meta.id);
  };

  return (
    <div className="shell" data-open={Boolean(active) || isNew}>
      <aside className="sidebar">
        <header className="sidebar__head">
          <img src="/icon.svg" alt="" width={22} height={22} />
          <strong>SavIDE</strong>
          <span className="dot" data-status={connected ? "idle" : "inactive"} title={connected ? "Connecté" : "Déconnecté"} />
          {authState.loginRequired && (
            <button type="button" className="ghost" onClick={logout}>
              Déconnexion
            </button>
          )}
        </header>
        {problem && <p className="error sidebar__problem">{problem}</p>}
        {/* axe:freechat */}
        <button
          type="button"
          className="sidebar__new"
          data-active={isNew}
          onClick={() => (location.hash = NEW_ROUTE)}
        >
          + Nouvelle conversation
        </button>
        <ConversationList sessions={sessions} activeId={activeId} onOpen={open} />
      </aside>
      <main className="main">
        {isNew ? (
          <NewConversation sessions={sessions} onCreated={created} onBack={() => open(null)} />
        ) : active ? (
          <Conversation key={active.id} meta={active} onBack={() => open(null)} />
        ) : (
          <div className="empty muted">
            {activeId && sessions.length > 0 ? "Conversation introuvable." : "Choisissez une conversation."}
          </div>
        )}
      </main>
    </div>
  );
}
