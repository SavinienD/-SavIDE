import { useCallback, useEffect, useState } from "react";
import "./repl.css";
import {
  connectionsApi,
  describeConnection,
  type Connection,
  type ServiceStatus,
} from "./connectionsApi";

// axe:e5 — « Joindre un autre appareil » : ce n'est pas « choisir où tourne
// l'application » (l'application travaille toujours dans l'espace Axe Cloud),
// c'est ajouter un service SavIDE déjà installé ailleurs pour lui confier
// du calcul. Les appareils sont de vrais services distants : SSH ou adresse.

type Draft = {
  id: string;
  name: string;
  kind: "remote" | "ssh";
  url: string;
  username: string;
  password: string;
  token: string;
  sshUser: string;
  sshHost: string;
  sshPort: string;
  remotePort: string;
  identityFile: string;
  startService: boolean;
  remoteCommand: string;
};

const EMPTY: Draft = {
  id: "",
  name: "",
  kind: "remote",
  url: "",
  username: "",
  password: "",
  token: "",
  sshUser: "",
  sshHost: "",
  sshPort: "22",
  remotePort: "9119",
  identityFile: "",
  startService: true,
  remoteCommand: "",
};

function toDraft(c: Connection): Draft {
  return {
    ...EMPTY,
    id: c.id,
    name: c.name,
    kind: c.kind === "ssh" ? "ssh" : "remote",
    url: c.url ?? "",
    username: c.username ?? "",
    sshUser: c.ssh?.user ?? "",
    sshHost: c.ssh?.host ?? "",
    sshPort: String(c.ssh?.port ?? 22),
    remotePort: String(c.ssh?.remotePort ?? 9119),
    identityFile: c.ssh?.identityFile ?? "",
    startService: c.ssh?.startService ?? true,
    remoteCommand: c.ssh?.remoteCommand ?? "",
  };
}

function fromDraft(d: Draft): Connection {
  const base: Connection = { id: d.id, name: d.name.trim(), kind: d.kind, username: d.username.trim() };
  if (d.kind === "remote") return { ...base, url: d.url.trim() };
  return {
    ...base,
    ssh: {
      user: d.sshUser.trim(),
      host: d.sshHost.trim(),
      port: Number(d.sshPort) || 22,
      remotePort: Number(d.remotePort) || 9119,
      identityFile: d.identityFile.trim() || null,
      startService: d.startService,
      remoteCommand: d.remoteCommand.trim() || null,
    },
  };
}

/// Reçoit « compte@machine:port » tapé d'un seul coup.
function parseSshShorthand(value: string): Partial<Draft> | null {
  const match = /^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/.exec(value.trim());
  if (!match) return null;
  return { sshUser: match[1] ?? "", sshHost: match[2], sshPort: match[3] ?? "22" };
}

type TestState = { ok: boolean; text: string } | "pending";

export function ConnectionsPane() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [active, setActive] = useState("");
  const [live, setLive] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await connectionsApi.list();
      // L'ordinateur sur lequel on est n'est pas un « appareil joint » : il ne
      // s'affiche pas ici.
      setConnections(list.connections.filter((c) => c.kind !== "local"));
      setActive(list.active);
      setLive(await connectionsApi.state());
    } catch (err) {
      setMessage(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = connectionsApi.onActiveChange(() => void refresh());
    return () => {
      void off.then((fn) => fn());
    };
  }, [refresh]);

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "pending" }));
    try {
      const status: ServiceStatus = await connectionsApi.test(id);
      const s = status.sessions;
      const text = `Répond — v${status.version ?? "?"}${status.latencyMs != null ? `, ${status.latencyMs} ms` : ""}${
        s ? `, ${s.total} sessions (${s.running} en cours)` : ""
      }`;
      setTests((t) => ({ ...t, [id]: { ok: true, text } }));
    } catch (err) {
      setTests((t) => ({ ...t, [id]: { ok: false, text: String(err) } }));
    }
    void refresh();
  };

  const remove = async (c: Connection) => {
    if (!window.confirm(`Ne plus joindre « ${c.name} » ? Rien n'est supprimé sur cet appareil.`)) return;
    try {
      await connectionsApi.remove(c.id);
      void refresh();
    } catch (err) {
      setMessage(String(err));
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await connectionsApi.save(fromDraft(draft), {
        password: draft.password ? draft.password : undefined,
        token: draft.token ? draft.token : undefined,
      });
      setDraft(null);
      await refresh();
      void test(saved.id);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(false);
    }
  };

  const clearSecret = async (c: Connection, which: "password" | "token") => {
    try {
      await connectionsApi.save(c, { [which]: "" });
      void refresh();
    } catch (err) {
      setMessage(String(err));
    }
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="axe-repl axe-connections">
      <header className="axe-repl__header">
        <div>
          <h2>Joindre un autre appareil</h2>
          <p className="axe-repl__muted">
            Les gros calculs (sous-agents, longues analyses) tournent sur la machine de ton espace. Joindre un autre
            appareil lui ajoute de la puissance de calcul.
          </p>
          <p className="axe-repl__muted">
            Ce n'est ni une sauvegarde ni un déplacement de fichiers : tes fichiers restent là où ils sont, et rien
            n'est copié sur l'autre appareil.
          </p>
        </div>
        <button
          type="button"
          className="axe-connections__joindre"
          onClick={() => {
            setDraft({ ...EMPTY });
          }}
        >
          + Joindre un appareil
        </button>
      </header>
      {message ? <p className="axe-repl__error">{message}</p> : null}

      {connections.length === 0 ? (
        <p className="axe-repl__muted">
          Aucun appareil joint pour l'instant : tout tourne sur la machine de ton espace.
        </p>
      ) : (
        <ul className="axe-connections__list">
          {connections.map((c) => {
            const t = tests[c.id];
            const state = live[c.id] ?? "disconnected";
            return (
              <li key={c.id} className="axe-repl__card" data-active={c.id === active ? "true" : "false"}>
                <div className="axe-repl__row">
                  <span
                    className="axe-connections__dot"
                    data-state={state}
                    title={state === "connected" ? "joignable" : "pas de réponse"}
                  />
                  <strong className="axe-repl__ellipsis">{c.name}</strong>
                  <span className="axe-connections__badge">
                    {c.kind === "ssh" ? "par tunnel SSH" : "par adresse directe"}
                  </span>
                  <span className="axe-repl__muted axe-repl__ellipsis">{describeConnection(c)}</span>
                  <span style={{ flex: 1 }} />
                  <span className="axe-repl__muted">
                    {state === "connected" ? "joignable" : "sans réponse"}
                  </span>
                  <button type="button" disabled={t === "pending"} onClick={() => void test(c.id)}>
                    {t === "pending" ? "Vérification…" : "Vérifier"}
                  </button>
                  <button type="button" onClick={() => setDraft(toDraft(c))}>
                    Modifier
                  </button>
                  <button type="button" className="axe-repl__danger" onClick={() => void remove(c)}>
                    Retirer
                  </button>
                </div>
                <div className="axe-repl__row axe-repl__muted">
                  {c.hasToken ? (
                    <span>
                      jeton enregistré{" "}
                      <button type="button" onClick={() => void clearSecret(c, "token")}>
                        oublier
                      </button>
                    </span>
                  ) : null}
                  {c.hasPassword ? (
                    <span>
                      mot de passe enregistré ({c.username}){" "}
                      <button type="button" onClick={() => void clearSecret(c, "password")}>
                        oublier
                      </button>
                    </span>
                  ) : null}
                  {!c.hasToken && !c.hasPassword ? <span>aucun identifiant enregistré</span> : null}
                </div>
                {t && t !== "pending" ? (
                  <p className={t.ok ? "axe-repl__status" : "axe-repl__error"}>{t.text}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <p className="axe-repl__muted">
        Joindre un appareil en un clic (sans SSH) n'existe pas encore : pour le moment, l'appareil doit déjà avoir
        SavIDE installé et joignable.
      </p>

      {draft ? (
        <section className="axe-repl__card axe-connections__form">
          <h3>{draft.id ? "Modifier cet appareil" : "Joindre un appareil qui a déjà SavIDE"}</h3>
          <div className="axe-repl__row">
            <label>
              <input type="radio" checked={draft.kind === "ssh"} onChange={() => set({ kind: "ssh" })} /> Par compte
              et clé (SSH)
            </label>
            <label>
              <input type="radio" checked={draft.kind === "remote"} onChange={() => set({ kind: "remote" })} /> Par
              l'adresse de son service
            </label>
          </div>
          <div className="axe-repl__kv">
            <span>Nom de l'appareil</span>
            <input
              value={draft.name}
              placeholder="Machine de la maison"
              onChange={(e) => set({ name: e.target.value })}
            />
            {draft.kind === "remote" ? (
              <>
                <span>Adresse du service</span>
                <input
                  value={draft.url}
                  placeholder="https://axe.example.com ou 192.168.1.20:9119"
                  onChange={(e) => set({ url: e.target.value })}
                />
              </>
            ) : (
              <>
                <span>Machine</span>
                <input
                  value={draft.sshHost ? `${draft.sshUser ? `${draft.sshUser}@` : ""}${draft.sshHost}:${draft.sshPort}` : ""}
                  placeholder="compte@machine:22"
                  onChange={(e) => {
                    const parsed = parseSshShorthand(e.target.value);
                    set(parsed ?? { sshHost: e.target.value });
                  }}
                />
                <span>Port du service sur cet appareil</span>
                <input value={draft.remotePort} onChange={(e) => set({ remotePort: e.target.value })} />
                <span>Clé privée (facultatif)</span>
                <input
                  value={draft.identityFile}
                  placeholder="~/.ssh/id_ed25519 (sinon agent / ~/.ssh/config)"
                  onChange={(e) => set({ identityFile: e.target.value })}
                />
                <span>Démarrer SavIDE s'il ne répond pas</span>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.startService}
                    onChange={(e) => set({ startService: e.target.checked })}
                  />{" "}
                  lancer{" "}
                  <code>
                    {draft.remoteCommand || "axecode"} --daemon serve --listen 127.0.0.1:{draft.remotePort}
                  </code>{" "}
                  à distance
                </label>
                <span>Exécutable distant</span>
                <input
                  value={draft.remoteCommand}
                  placeholder="axecode"
                  onChange={(e) => set({ remoteCommand: e.target.value })}
                />
              </>
            )}
            <span>Compte du service</span>
            <input
              value={draft.username}
              placeholder="axe (vide si jeton)"
              onChange={(e) => set({ username: e.target.value })}
            />
            <span>Mot de passe</span>
            <input
              type="password"
              value={draft.password}
              placeholder={draft.id ? "inchangé" : ""}
              onChange={(e) => set({ password: e.target.value })}
            />
            <span>ou jeton</span>
            <input
              type="password"
              value={draft.token}
              placeholder={draft.id ? "inchangé" : "axs_…"}
              onChange={(e) => set({ token: e.target.value })}
            />
          </div>
          <p className="axe-repl__muted">
            Sur l'autre appareil : <code>axecode --daemon set-password</code> ou{" "}
            <code>axecode --daemon token</code>, puis <code>axecode --daemon serve --listen 0.0.0.0:9119</code>{" "}
            derrière TLS. En SSH, la clé et le tunnel sont gérés par votre client <code>ssh</code> ; le service peut
            n'écouter que sur 127.0.0.1. Les identifiants restent sur cette machine et ne sont jamais réaffichés.
          </p>
          <div className="axe-repl__row">
            <button
              type="button"
              className="axe-repl__save"
              disabled={busy || !draft.name.trim()}
              onClick={() => void save()}
            >
              Enregistrer et vérifier
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
              }}
            >
              Annuler
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
