import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./repl.css";
import { connectionArg, LOCAL_CONNECTION, useActiveConnection } from "./connectionsApi"; // axe:remote

// axe:daemon — Settings > Service: state of the background service that owns
// the sessions (pid, clients, sessions by status), with inspection and a
// forced shutdown.

type DaemonStatus = {
  running: boolean;
  pid?: number;
  version?: string;
  endpoint?: string;
  dataDir?: string;
  startedAtMs?: number;
  clients?: { id: number; name: string }[];
  sessions?: { total: number; running: number; idle: number; inactive: number };
  listen?: string | null; // axe:remote
  remote?: boolean; // axe:remote
};

type SessionMeta = {
  id: string;
  name: string;
  status: "running" | "idle" | "inactive";
  parentId?: string;
  model: { provider: string; name: string };
  updatedAtMs: number;
  entryCount: number;
};

const STATUS_LABEL: Record<SessionMeta["status"], string> = {
  running: "en cours",
  idle: "en mémoire",
  inactive: "archivée",
};

const STATUS_HINT: Record<SessionMeta["status"], string> = {
  running: "Un tour est en train de tourner dans cette session.",
  idle: "Gardée en mémoire par le service, prête à reprendre — fermer l'IDE ne l'interrompt pas.",
  inactive: "Rangée sur disque : elle se rechargera automatiquement à sa prochaine ouverture.",
};

function since(ms?: number): string {
  if (!ms) return "—";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`;
}

export function ServicePane() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connectionId = useActiveConnection(); // axe:remote
  const connection = connectionArg(connectionId);
  const isRemote = connectionId !== LOCAL_CONNECTION;

  const refresh = useCallback(async () => {
    try {
      const value = await invoke<DaemonStatus>("daemon_status", { connection });
      setStatus(value);
      if (value.running) {
        setSessions(await invoke<SessionMeta[]>("daemon_sessions", { connection }));
      } else {
        setSessions([]);
      }
    } catch (err) {
      setStatus(isRemote ? { running: false, remote: true } : null);
      setMessage(String(err));
    }
  }, [connection, isRemote]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const unlisten = listen<{ event: string }>("axe://daemon", (event) => {
      if (event.payload.event === "status" || event.payload.event === "daemon") void refresh();
    });
    return () => {
      window.clearInterval(timer);
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const shutdown = async (force: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      await invoke("daemon_shutdown", { input: { force, connection } });
      setMessage(
        isRemote
          ? "Service distant arrêté. Relancez-le sur la machine distante (ou via SSH)."
          : "Service arrêté. Il sera relancé automatiquement au prochain message.",
      );
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
      window.setTimeout(() => void refresh(), 800);
    }
  };

  const unload = async (id: string) => {
    try {
      await invoke("daemon_call", { input: { method: "sessions.unload", params: { sessionId: id }, connection } });
      void refresh();
    } catch (err) {
      setMessage(String(err));
    }
  };

  return (
    <div className="axe-repl">
      <header className="axe-repl__header">
        <div>
          <h2>Moteur de ton espace</h2>
          <p className="axe-repl__muted">
            C'est le programme qui fait travailler l'IA{isRemote ? " sur ton espace Axe Cloud" : " sur ce PC"}.
            Tu peux fermer l'application : les conversations en cours continuent ici.
          </p>
          <ul className="axe-repl__muted">
            <li><b>Actif</b> = tout va bien, rien à faire.</li>
            <li><b>Conversations chargées</b> = celles qui occupent de la mémoire ; « Libérer » les décharge sans rien effacer.</li>
            <li><b>Arrêter</b> ne sert qu'en cas de blocage : il redémarre seul au prochain message.</li>
          </ul>
        </div>
        <button type="button" onClick={() => void refresh()}>Actualiser</button>
      </header>
      {message ? <p className="axe-repl__status">{message}</p> : null}

      <section className="axe-repl__card">
        {status === null ? (
          <p className="axe-repl__muted">Connexion…</p>
        ) : !status.running ? (
          <p>
            {isRemote
              ? "Le service distant ne répond pas. Vérifiez la connexion dans Réglages > Connexions."
              : "Le service n'est pas démarré. Il démarrera au prochain message envoyé."}
          </p>
        ) : (
          <div className="axe-repl__kv">
            <span className="axe-repl__muted">État</span>
            <span>✅ Actif <small className="axe-repl__muted">(version {status.version})</small></span>
            <span className="axe-repl__muted">Démarré</span>
            <span>{since(status.startedAtMs)}</span>
            <span className="axe-repl__muted">Fenêtres attachées</span>
            <span>{status.clients?.length ?? 0}</span>
            <span className="axe-repl__muted">Sessions</span>
            <span>
              {status.sessions?.running ?? 0} en cours · {status.sessions?.idle ?? 0} en mémoire ·{" "}
              {status.sessions?.inactive ?? 0} archivées
            </span>
            {status.listen ? (
              <>
                <span className="axe-repl__muted">Écoute réseau</span>
                <code>{status.listen}</code>
              </>
            ) : null}
            <span className="axe-repl__muted">Point de connexion</span>
            <code className="axe-repl__ellipsis">{status.endpoint}</code>
            <span className="axe-repl__muted">Données</span>
            <code className="axe-repl__ellipsis">{status.dataDir}</code>
          </div>
        )}
        {status?.running ? (
          <div className="axe-repl__row">
            <button type="button" disabled={busy} onClick={() => void shutdown(false)}>
              Arrêter (si rien ne tourne)
            </button>
            <button type="button" className="axe-repl__danger" disabled={busy} onClick={() => void shutdown(true)}>
              Arrêt forcé
            </button>
          </div>
        ) : null}
      </section>

      {status?.running ? (
        <section className="axe-repl__card">
          <h3>Sessions</h3>
          <p className="axe-repl__muted">
            Une session = une conversation suivie par le service. « En cours » : un tour est en train
            de tourner. « En mémoire » : gardée prête à reprendre — fermer l'IDE ne l'interrompt pas.
            « Archivée » : rangée sur disque, elle se recharge à sa prochaine ouverture.
          </p>
          {sessions.length ? (
            <table className="axe-repl__sessions">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th>État</th>
                  <th>Modèle</th>
                  <th title="Nombre d'entrées du journal : messages, appels d'outils, résultats…">Entrées</th>
                  <th title="Dernière activité de la session.">Activité</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="axe-repl__ellipsis">{s.parentId ? "↳ " : ""}{s.name}</td>
                    <td title={STATUS_HINT[s.status]}>{STATUS_LABEL[s.status]}</td>
                    <td><code>{s.model.provider}/{s.model.name}</code></td>
                    <td>{s.entryCount}</td>
                    <td>{since(s.updatedAtMs)}</td>
                    <td>
                      {s.status === "idle" ? (
                        <button
                          type="button"
                          title="Libère la mémoire : la session est rangée sur disque (« archivée ») et se rechargera à sa prochaine ouverture. Rien n'est perdu."
                          onClick={() => void unload(s.id)}
                        >
                          Décharger
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="axe-repl__muted">
              Aucune session pour l'instant — elles apparaissent ici dès qu'une conversation est utilisée.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
