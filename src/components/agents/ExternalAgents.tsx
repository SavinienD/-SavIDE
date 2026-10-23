import { useCallback, useEffect, useState } from "react";
import { cloudConnectionFromPath } from "../../lib/ipc";
import {
  getCloudStatus,
  subscribeCloudStatus,
  type CloudStatus,
} from "../../lib/cloudOnline";
import { LOCAL_CONNECTION, useActiveConnection } from "../settings/connectionsApi";
import {
  SERVICE_AGENT_LABEL,
  agentErrorText,
  serviceAgentsApi,
  type ServiceAgent,
  type ServiceAgentDetail,
  type ServiceAgentResult,
} from "./agentsApi";
import "./agents.css";

type Props = {
  /** IDE workspace: a cloud workspace carries its service connection. */
  workspacePath: string;
};

type Form = {
  brief: string;
  label: string;
  modele: string;
  commande: string;
  /** `true` when the command is typed instead of picked. */
  autre: boolean;
};

const EMPTY_FORM: Form = {
  brief: "",
  label: "",
  modele: "opencode/nemotron-3.5-super-vl-free",
  commande: "opencode",
  autre: false,
};

/** Commands proposed by the panel (the service only accepts its configured keys). */
const COMMANDS: { id: string; label: string }[] = [{ id: "opencode", label: "OpenCode" }];

function startLabel(ms?: number | null): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time}`;
}

function resumeText(agent: ServiceAgent): string {
  const text = (agent.resume ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** axe:agents — external agents (OpenCode/DeepSeek CLIs) launched by the
 *  service in <workspace>/.axecode/agents. In local mode the panel stays inert:
 *  those agents only run on the service. */
export function ExternalAgents({ workspacePath }: Props) {
  const active = useActiveConnection();
  const cloudConnection = cloudConnectionFromPath(workspacePath);
  const connection =
    cloudConnection ?? (active !== LOCAL_CONNECTION ? active : null);

  const [agents, setAgents] = useState<ServiceAgent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceAgentDetail | null>(null);
  const [result, setResult] = useState<ServiceAgentResult | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>(() =>
    connection ? getCloudStatus(connection) : "unknown",
  );

  const offline = cloudStatus === "offline";
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;

  useEffect(() => {
    if (!connection) {
      setCloudStatus("unknown");
      return;
    }
    setCloudStatus(getCloudStatus(connection));
    return subscribeCloudStatus(connection, setCloudStatus);
  }, [connection]);

  useEffect(() => {
    setAgents([]);
    setSelectedId(null);
    setDetail(null);
    setResult(null);
    setListError(null);
    setActionError(null);
    setNotice(null);
  }, [connection]);

  const load = useCallback(async () => {
    if (!connection) return;
    try {
      setAgents(await serviceAgentsApi.list(connection));
      setUnavailable(false);
      setListError(null);
    } catch (e) {
      const message = agentErrorText(e);
      // A service without the agents module is not an error the user can fix.
      if (/agents externes ne sont pas encore disponibles/i.test(message)) {
        setUnavailable(true);
        setListError(null);
      } else {
        setListError(message);
      }
    }
  }, [connection]);

  // List: refreshed every 2 s while the service is reachable; offline it stays
  // as the last known snapshot (read-only).
  useEffect(() => {
    if (!connection || offline) return;
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [connection, offline, load]);

  // Detail: live journal every 2 s while an agent is open.
  useEffect(() => {
    if (!connection || !selectedId || offline) return;
    let alive = true;
    const refresh = async () => {
      try {
        const fresh = await serviceAgentsApi.status(selectedId, connection);
        if (alive) {
          setDetail(fresh);
          setListError(null);
        }
      } catch (e) {
        if (alive) setListError(agentErrorText(e));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [connection, selectedId, offline]);

  const open = (agent: ServiceAgent) => {
    setSelectedId(agent.id);
    setDetail(null);
    setResult(null);
    setNotice(null);
  };

  const spawn = async () => {
    if (!connection) return;
    if (offline) {
      setNotice("Hors ligne : lancement impossible");
      return;
    }
    const brief = form.brief.trim();
    if (!brief) {
      setActionError("Le brief est obligatoire.");
      return;
    }
    setSpawning(true);
    setActionError(null);
    setNotice(null);
    try {
      const created = await serviceAgentsApi.spawn(
        {
          brief,
          label: form.label.trim() || undefined,
          commande: form.commande,
          modele: form.modele.trim() || undefined,
        },
        connection,
      );
      // Show it at once; the 2 s refresh replaces this provisional row.
      const provisional: ServiceAgent = {
        id: created.id,
        label: form.label.trim() || brief.slice(0, 40),
        commande: form.commande,
        modele: form.modele.trim(),
        statut: created.statut,
        debutMs: Date.now(),
        resume: null,
      };
      setAgents((current) => [provisional, ...current.filter((a) => a.id !== created.id)]);
      setForm((current) => ({ ...current, brief: "", label: "" }));
      setShowForm(false);
      setSelectedId(created.id);
      setDetail(null);
      setResult(null);
      setNotice(
        created.statut === "en_attente"
          ? "Agent mis en file d'attente."
          : "Agent lancé.",
      );
      await load();
    } catch (e) {
      setActionError(agentErrorText(e));
    } finally {
      setSpawning(false);
    }
  };

  const stop = async (agent: ServiceAgent) => {
    if (!connection) return;
    if (offline) {
      setNotice("Hors ligne : action impossible");
      return;
    }
    if (!window.confirm(`Arrêter l'agent « ${agent.label} » ?`)) return;
    try {
      await serviceAgentsApi.stop(agent.id, connection);
      setNotice("Arrêt demandé.");
      setActionError(null);
      await load();
      if (selectedId === agent.id) {
        setDetail(await serviceAgentsApi.status(agent.id, connection));
      }
    } catch (e) {
      setActionError(agentErrorText(e));
    }
  };

  const loadResult = async () => {
    if (!connection || !selectedId) return;
    try {
      setResult(await serviceAgentsApi.result(selectedId, connection));
      setActionError(null);
    } catch (e) {
      setActionError(agentErrorText(e));
    }
  };

  const heading = (
    <div className="axe-agents__section-head">
      <strong>Agents externes</strong>
      <span className="axe-agents__muted">
        Lancés par le service · {agents.length} tâche{agents.length > 1 ? "s" : ""}
      </span>
      {connection && offline ? (
        <span className="axe-agents__offline" role="status">
          ○ Hors ligne
        </span>
      ) : null}
      {connection && !unavailable ? (
        <button
          type="button"
          className="axe-agents__launch"
          onClick={() => {
            if (offline) {
              setNotice("Hors ligne : lancement impossible");
              return;
            }
            setShowForm((open) => !open);
          }}
        >
          {showForm ? "Masquer le formulaire" : "Lancer un agent"}
        </button>
      ) : null}
    </div>
  );

  // Local mode: those agents run on the service only. Nothing is broken.
  if (!connection) {
    return (
      <section className="axe-agents__section" aria-label="Agents externes">
        {heading}
        <p className="axe-agents__muted">Les agents tournent sur le service.</p>
      </section>
    );
  }

  return (
    <section className="axe-agents__section" aria-label="Agents externes">
      {heading}
      {listError ? (
        <p className="axe-agents__error" role="alert">
          {listError}
        </p>
      ) : null}
      {actionError ? (
        <p className="axe-agents__error" role="alert">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p className="axe-agents__status" role="status">
          {notice}
        </p>
      ) : null}
      {unavailable ? (
        <p className="axe-agents__muted">
          Les agents externes ne sont pas encore disponibles sur ce service.
        </p>
      ) : null}

      {showForm ? (
        <div className="axe-agents__form">
          <label className="axe-agents__field">
            <span>Brief (obligatoire)</span>
            <textarea
              className="axe-agents__input"
              rows={4}
              value={form.brief}
              placeholder="Décrivez la tâche à confier à l'agent…"
              onChange={(e) => setForm((f) => ({ ...f, brief: e.target.value }))}
            />
          </label>
          <label className="axe-agents__field">
            <span>Libellé</span>
            <input
              value={form.label}
              placeholder="Court nom (par défaut : début du brief)"
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
          </label>
          <label className="axe-agents__field">
            <span>Modèle</span>
            <input
              value={form.modele}
              placeholder="opencode/nemotron-3.5-super-vl-free"
              onChange={(e) => setForm((f) => ({ ...f, modele: e.target.value }))}
            />
          </label>
          <label className="axe-agents__field">
            <span>Commande</span>
            <select
              value={form.autre ? "__autre__" : form.commande}
              onChange={(e) => {
                const value = e.target.value;
                setForm((f) =>
                  value === "__autre__"
                    ? { ...f, autre: true, commande: "" }
                    : { ...f, autre: false, commande: value },
                );
              }}
            >
              {COMMANDS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
              <option value="__autre__">Autre commande…</option>
            </select>
          </label>
          {form.autre ? (
            <label className="axe-agents__field">
              <span>Nom de la commande</span>
              <input
                value={form.commande}
                placeholder="ex. opencode"
                onChange={(e) => setForm((f) => ({ ...f, commande: e.target.value }))}
              />
            </label>
          ) : null}
          <div className="axe-agents__actions">
            <button type="button" onClick={() => setShowForm(false)}>
              Annuler
            </button>
            <button
              type="button"
              disabled={spawning || !form.brief.trim() || !form.commande.trim()}
              onClick={() => void spawn()}
            >
              {spawning ? "Lancement…" : "Lancer"}
            </button>
          </div>
        </div>
      ) : null}

      <ul className="axe-agents__list axe-agents__tasks">
        {agents.length === 0 ? (
          <li className="axe-agents__muted">
            {offline ? "Liste indisponible hors ligne." : "Aucun agent lancé pour l'instant."}
          </li>
        ) : null}
        {agents.map((agent) => {
          const excerpt = resumeText(agent);
          return (
            <li key={agent.id}>
              <div
                className="axe-agents__row axe-agents__task"
                data-active={agent.id === selectedId ? "true" : "false"}
                role="button"
                tabIndex={0}
                aria-label={`${agent.label || agent.id} — ${SERVICE_AGENT_LABEL[agent.statut]}`}
                onClick={() => open(agent)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(agent);
                  }
                }}
              >
                <span
                  className="axe-agents__dot"
                  data-statut={agent.statut}
                  title={SERVICE_AGENT_LABEL[agent.statut]}
                />
                <span className="axe-agents__name">{agent.label || agent.id.slice(0, 8)}</span>
                <span className="axe-agents__task-state">{SERVICE_AGENT_LABEL[agent.statut]}</span>
                <span className="axe-agents__task-time" title="Heure de début">
                  {startLabel(agent.debutMs)}
                </span>
                <span className="axe-agents__task-model">{agent.modele || agent.commande}</span>
                {excerpt ? <span className="axe-agents__task-resume">{excerpt}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>

      {selected ? (
        <div className="axe-agents__detail axe-agents__task-detail">
          <div className="axe-agents__detail-head">
            <span
              className="axe-agents__dot"
              data-statut={(detail ?? selected).statut}
              title={SERVICE_AGENT_LABEL[(detail ?? selected).statut]}
            />
            <strong>{selected.label || selected.id.slice(0, 8)}</strong>
            <span className="axe-agents__muted">
              {SERVICE_AGENT_LABEL[(detail ?? selected).statut]} ·{" "}
              {selected.commande}
              {selected.modele ? ` · ${selected.modele}` : ""} · début{" "}
              {startLabel((detail ?? selected).debutMs ?? selected.debutMs)}
            </span>
            <button type="button" className="axe-agents__close" onClick={() => setSelectedId(null)}>
              Fermer
            </button>
          </div>
          <div className="axe-agents__actions">
            <button
              type="button"
              disabled={
                offline ||
                !["en_cours", "en_attente"].includes((detail ?? selected).statut)
              }
              onClick={() => void stop(selected)}
            >
              Arrêter
            </button>
            <button type="button" disabled={offline} onClick={() => void loadResult()}>
              Résultat
            </button>
          </div>
          {result ? (
            <div className="axe-agents__result">
              <div className="axe-agents__muted">
                {result.present ? "Résultat de l'agent" : "Aucun résultat écrit pour l'instant."}
              </div>
              {result.present && result.resultat ? (
                <pre className="axe-agents__journal">{result.resultat}</pre>
              ) : null}
            </div>
          ) : null}
          <div className="axe-agents__muted">Journal</div>
          <pre className="axe-agents__journal">
            {offline
              ? "Hors ligne : journal indisponible."
              : detail?.journal?.trim()
                ? detail.journal
                : "Journal vide pour l'instant."}
          </pre>
        </div>
      ) : null}
    </section>
  );
}
