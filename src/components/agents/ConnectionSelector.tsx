import { useCallback, useEffect, useState } from "react";
import {
  connectionsApi,
  describeConnection,
  useActiveConnection,
  type Connection,
} from "../settings/connectionsApi";
import "./agents.css";

// axe:remote — sidebar selector: which machine (service) conversations, the
// Agents view and Settings > Service apply to.

type Props = {
  /** Opens Settings > Connexions. */
  onManage?: () => void;
};

export function ConnectionSelector({ onManage }: Props) {
  const active = useActiveConnection();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await connectionsApi.list();
      // axe:e1 — le poste local n'est plus une connexion proposee : il n'y a
      // plus qu'un espace, celui d'Axe Cloud.
      setConnections(list.connections.filter((c) => c.kind !== "local"));
      setLive(await connectionsApi.state());
    } catch {
      /* registre injoignable : on garde la derniere liste connue */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh, active]);

  // axe:e1 — un seul espace : le selecteur ne s'affiche pas, il n'y a rien a choisir.
  if (connections.length <= 1) return null;

  const change = async (id: string) => {
    if (id === "__manage") {
      onManage?.();
      return;
    }
    setError(null);
    try {
      await connectionsApi.setActive(id);
      await connectionsApi.test(id).catch((e) => setError(String(e)));
      void refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const current = connections.find((c) => c.id === active);
  const state = live[active] ?? "disconnected";
  return (
    <div className="axe-connsel" title={current ? describeConnection(current) : undefined}>
      <span className="axe-connsel__dot" data-state={state} />
      <select value={active} onChange={(e) => void change(e.target.value)} aria-label="Connexion active">
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        {onManage ? <option value="__manage">Gérer les connexions…</option> : null}
      </select>
      {error ? <span className="axe-connsel__error" title={error}>hors ligne</span> : null}
    </div>
  );
}
