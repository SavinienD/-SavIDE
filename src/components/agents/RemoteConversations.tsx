import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { agentsApi, STATUS_LABEL, type JournalEntry, type JournalTree, type SessionMeta } from "./agentsApi";
import { LOCAL_CONNECTION } from "../settings/connectionsApi";
import {
  branchEntries,
  buildRemoteItems,
  explainConnectionError,
  modelChoices,
  modelKey,
  parseModel,
  rememberedModel,
  rememberModel,
} from "./remoteItems";
import "./agents.css";

// axe:remote — Conversations of a remote connection: sessions live on the
// remote service (they keep running when the IDE closes). Transcript built
// from the journal (errors included), new session with a model the service
// can serve (Axe Cloud first), model switch, send, stop, live updates.

type Props = {
  connectionId: string;
  /** axe:v2-e10 — dossier du compte, donné par le service ; jamais demandé à
   *  l'utilisateur (vide = le service prend la racine de travail du compte). */
  defaultWorkspace?: string;
};

const OTHER = "__autre__";

export function RemoteConversations({ connectionId, defaultWorkspace }: Props) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  // axe:v2-e12 — les archives se gerent ICI, la ou vivent les conversations
  // (avant, seul l'espace local avait « Archives » : on ne trouvait rien sur un espace).
  const [archives, setArchives] = useState<SessionMeta[]>([]);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tree, setTree] = useState<JournalTree | null>(null);
  const [streaming, setStreaming] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState(() => modelKey(rememberedModel(connectionId)));
  const [customModel, setCustomModel] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const treeRef = useRef<JournalTree | null>(null);
  treeRef.current = tree;
  // Lu dans un effet : evite de relancer le chargement du journal a chaque rafraichissement.
  const archivesRef = useRef<SessionMeta[]>([]);
  archivesRef.current = archives;

  useEffect(() => setNewModel(modelKey(rememberedModel(connectionId))), [connectionId]);

  const load = useCallback(async () => {
    try {
      const actives = await agentsApi.list(connectionId);
      setSessions(actives);
      setError(null);
    } catch (e) {
      setError(explainConnectionError(String(e)));
    }
    // Les archives sont une seconde liste (le service ne melange jamais les deux).
    try {
      const liste = await agentsApi.call<SessionMeta[]>("sessions.list", { archived: true }, connectionId);
      setArchives(Array.isArray(liste) ? liste : []);
    } catch {
      /* pas d'archives lisibles : la liste active reste utilisable */
    }
  }, [connectionId]);

  const loadTree = useCallback(
    async (id: string) => {
      try {
        const fresh = await agentsApi.tree(id, connectionId);
        if (selectedRef.current === id) {
          setTree(fresh);
          setStreaming("");
        }
      } catch (e) {
        setError(explainConnectionError(String(e)));
      }
    },
    [connectionId],
  );

  useEffect(() => {
    setSelectedId(null);
    setTree(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) return;
    setTree(null);
    setStreaming("");
    // axe:v2-e12 — une conversation archivee n'est plus lisible cote service :
    // on la montre sans journal, avec seulement « Rétablir » et « Supprimer ».
    if (archivesRef.current.some((s) => s.id === selectedId)) return;
    void loadTree(selectedId);
    void agentsApi.call("sessions.attach", { sessionId: selectedId }, connectionId).catch(() => undefined);
  }, [selectedId, loadTree, connectionId]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    void agentsApi
      .onEvent((event) => {
        if ((event.connectionId ?? LOCAL_CONNECTION) !== connectionId) return;
        if (event.event === "connection") {
          setError("Connexion au service distant perdue.");
          return;
        }
        if (event.event === "status") void load();
        const id = selectedRef.current;
        if (!id || event.sessionId !== id) return;
        if (event.event === "entry") {
          // The event carries the journal entry itself: append it (no reload).
          const entry = event.data as JournalEntry | undefined;
          const known = treeRef.current;
          if (!entry?.id || !known || known.entries.some((x) => x.id === entry.id)) return;
          // A missed entry (unknown parent): resync instead of showing a cut branch.
          if (entry.parent && !known.entries.some((x) => x.id === entry.parent)) {
            void loadTree(id);
            return;
          }
          setTree((t) =>
            t && !t.entries.some((x) => x.id === entry.id) ? { ...t, entries: [...t.entries, entry], leaf: entry.id } : t,
          );
          if (entry.kind === "message") setStreaming("");
        } else if (event.event === "status") {
          // End of a turn: resync the whole journal once.
          if ((event.data as { status?: string } | undefined)?.status !== "running") void loadTree(id);
        } else if (event.event === "stream") {
          const data = (event.data as { event?: { type?: string; delta?: string } } | undefined)?.event;
          if (data?.type === "text_delta" && data.delta) setStreaming((s) => s + data.delta);
          // axe:reprise — stream cut, request sent again: the reply starts over.
          else if (data?.type === "stream_retry") setStreaming("");
        }
      })
      .then((fn) => (disposed ? fn() : (off = fn)));
    return () => {
      disposed = true;
      off?.();
    };
  }, [connectionId, load, loadTree]);

  const items = useMemo(() => (tree ? buildRemoteItems(branchEntries(tree)) : []), [tree]);
  // axe:robustesse — défiler la zone des messages ELLE-MÊME : scrollIntoView fait aussi défiler tous les conteneurs parents
  // (y compris la racine de l'appli, en overflow:hidden), ce qui peut sortir toute l'interface de l'écran.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [items, streaming]);

  const roots = useMemo(
    () => sessions.filter((s) => !s.parentId && !s.archived).sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    [sessions],
  );
  const selected = [...sessions, ...archives].find((s) => s.id === selectedId) ?? null;
  const choices = useMemo(() => modelChoices(sessions, rememberedModel(connectionId)), [sessions, connectionId]);

  const retry = () => {
    setError(null);
    void load();
    if (selectedId) void loadTree(selectedId);
  };

  const send = async () => {
    const text = draft.trim();
    if (!selectedId || !text) return;
    try {
      await agentsApi.send(selectedId, text, connectionId);
      setDraft("");
      setError(null);
    } catch (e) {
      setError(explainConnectionError(String(e)));
    }
  };

  const switchModel = async (value: string) => {
    const model = parseModel(value);
    if (!selected || !model) return;
    try {
      await agentsApi.call("sessions.set_model", { sessionId: selected.id, model }, connectionId);
      rememberModel(connectionId, model);
      await load();
    } catch (e) {
      setError(explainConnectionError(String(e)));
    }
  };

  // axe:v2-e12 — archiver / rétablir / supprimer une conversation distante, là
  // où on la lit. Le service impose l'ordre : on archive d'abord, on ne supprime
  // que depuis l'archive (rien ne disparaît par surprise).
  const archiver = async (id: string) => {
    try {
      await agentsApi.call("sessions.archive", { sessionId: id }, connectionId);
      if (selectedId === id) setSelectedId(null);
      await load();
      setArchivesOpen(true);
    } catch (e) {
      setError(explainConnectionError(String(e)));
    }
  };

  const retablir = async (id: string) => {
    try {
      await agentsApi.call("sessions.restore", { sessionId: id }, connectionId);
      await load();
    } catch (e) {
      setError(explainConnectionError(String(e)));
    }
  };

  const supprimer = async (id: string, nom: string) => {
    if (!window.confirm(`Supprimer définitivement « ${nom || "cette conversation"} » ?\n\nElle est déjà archivée : elle ne pourra pas être récupérée.`)) return;
    try {
      await agentsApi.call("sessions.delete", { sessionId: id }, connectionId);
      if (selectedId === id) setSelectedId(null);
      await load();
    } catch (e) {
      setError(explainConnectionError(String(e)));
    }
  };

  const create = async () => {
    // axe:v2-e12 — le modèle ne se choisit PAS à la création : il se change dans
    // la conversation, une fois qu'elle existe. On part du dernier modèle utilisé.
    const premier = choices[0];
    const model =
      parseModel(newModel === OTHER ? customModel : newModel) ??
      (premier ? { provider: premier.provider, name: premier.name } : null);
    if (!model) {
      setError("Aucun modèle disponible pour l'instant : le service n'en propose aucun.");
      return;
    }
    try {
      // axe:v2-e10 — le dossier n'est pas demandé : quand la porte le donne
      // (`defaultWorkspace`), on l'envoie ; sinon on envoie vide et le service
      // prend la racine de travail du compte connecté.
      const meta = await agentsApi.create(newName.trim() || "Nouvelle conversation", defaultWorkspace ?? "", model, connectionId);
      rememberModel(connectionId, model);
      setCreating(false);
      setNewName("");
      setError(null);
      await load();
      setSelectedId(meta.id);
    } catch (e) {
      setError(explainConnectionError(String(e)));
    }
  };

  const errorBlock = error ? (
    <p className="axe-agents__error" role="alert">
      {error}{" "}
      <button type="button" onClick={retry}>Réessayer</button>
    </p>
  ) : null;

  if (selected) {
    const running = selected.status === "running";
    const sessionChoices = modelChoices(sessions, selected.model);
    if (selected.archived) {
      // axe:v2-e12 — une conversation archivee n'est plus lisible : on ne propose
      // que les deux suites logiques (retablir, ou supprimer pour de bon).
      return (
        <div className="axe-agents axe-remote-conv">
          <header className="axe-agents__head">
            <button type="button" onClick={() => setSelectedId(null)}>← Conversations</button>
            <span className="axe-agents__name">{selected.name}</span>
            <span className="axe-agents__model">archivée</span>
          </header>
          {errorBlock}
          <p className="axe-agents__muted">
            Cette conversation est archivée : elle n'est plus lisible, et rien ne tourne dessus.
            Rétablissez-la pour continuer à l'utiliser, ou supprimez-la définitivement.
          </p>
          <div className="axe-agents__actions">
            <button type="button" onClick={() => void retablir(selected.id)}>Rétablir</button>
            <button type="button" onClick={() => void supprimer(selected.id, selected.name)}>
              Supprimer définitivement
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="axe-agents axe-remote-conv">
        <header className="axe-agents__head">
          <button type="button" onClick={() => setSelectedId(null)}>← Conversations</button>
          <span className="axe-agents__dot" data-status={selected.status} title={STATUS_LABEL[selected.status]} />
          <strong className="axe-agents__name">{selected.name}</strong>
          <select
            className="axe-remote-conv__model"
            title={running ? "Modèle (modifiable quand l'agent a fini)" : "Modèle de cette session"}
            value={modelKey(selected.model)}
            disabled={running}
            onChange={(e) => void switchModel(e.target.value)}
          >
            {sessionChoices.map((m) => (
              <option key={modelKey(m)} value={modelKey(m)}>{m.label}</option>
            ))}
          </select>
          {/* axe:v2-e12 — archiver se fait ici, sur la conversation ouverte. */}
          <button
            type="button"
            className="axe-agents__icon-btn"
            title="Archiver cette conversation"
            aria-label="Archiver cette conversation"
            onClick={() => void archiver(selected.id)}
          >
            <Icon icon="solar:archive-linear" width={15} height={15} />
          </button>
        </header>
        {errorBlock}
        <div className="axe-remote-conv__log" ref={logRef}>
          {tree === null && !error ? <p className="axe-agents__muted">Chargement…</p> : null}
          {tree !== null && items.length === 0 && !streaming ? (
            <p className="axe-agents__muted">Aucun message. L'agent travaille sur la machine distante.</p>
          ) : null}
          {items.map((it) =>
            it.type === "message" ? (
              <div key={it.key} className="axe-remote-conv__msg" data-role={it.role}>{it.text}</div>
            ) : (
              <div key={it.key} className="axe-remote-conv__note" data-tone={it.tone}>
                {it.text}
                {it.detail ? (
                  <details className="axe-remote-conv__detail">
                    <summary>Détail technique</summary>
                    <code>{it.detail}</code>
                  </details>
                ) : null}
              </div>
            ),
          )}
          {streaming ? <div className="axe-remote-conv__msg" data-role="assistant">{streaming}</div> : null}
          {running && !streaming ? <p className="axe-agents__muted">L'agent travaille…</p> : null}
        </div>
        <textarea
          className="axe-agents__input"
          placeholder="Message ou /commande (exécuté sur la machine distante)…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="axe-agents__actions">
          {running ? (
            <button type="button" onClick={() => void agentsApi.stop(selected.id, connectionId).catch((e) => setError(String(e)))}>
              Arrêter
            </button>
          ) : null}
          <button type="button" disabled={!draft.trim()} onClick={() => void send()}>
            Envoyer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="axe-agents axe-remote-conv">
      <header className="axe-agents__head">
        <strong>Conversations</strong>
        <button type="button" onClick={() => setCreating((v) => !v)}>
          Nouvelle
        </button>
      </header>
      {errorBlock}
      {creating ? (
        <section className="axe-agents__detail">
          <input
            placeholder="Nom de la conversation"
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          {/* axe:v2-e12 — une seule chose à faire ici : lui donner un nom. Le
              dossier est choisi par le service, et le modèle se choisit ensuite
              dans la conversation : rien d'autre n'est demandé à la création. */}
          <div className="axe-agents__actions">
            <button type="button" onClick={() => setCreating(false)}>Annuler</button>
            <button type="button" onClick={() => void create()}>Créer</button>
          </div>
        </section>
      ) : null}
      <ul className="axe-agents__list">
        {roots.length === 0 ? <li className="axe-agents__muted">Aucune conversation sur cette machine.</li> : null}
        {roots.map((s) => (
          <li key={s.id}>
            <div className="axe-agents__row" onClick={() => setSelectedId(s.id)} title={s.name}>
              <span className="axe-agents__dot" data-status={s.status} title={STATUS_LABEL[s.status]} />
              <span className="axe-agents__name">{s.name || s.id.slice(0, 8)}</span>
              <span className="axe-agents__model">{s.model.name}</span>
              <button
                type="button"
                className="axe-agents__icon-btn"
                title="Archiver"
                aria-label={`Archiver ${s.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void archiver(s.id);
                }}
              >
                <Icon icon="solar:archive-linear" width={14} height={14} />
              </button>
            </div>
          </li>
        ))}
        {/* axe:v2-e12 — les archives se trouvent et se traitent ici : rétablir,
            ou supprimer définitivement (le service n'efface que ce qui est archivé). */}
        {archives.length > 0 ? (
          <li className="axe-agents__archives">
            <button
              type="button"
              className="axe-agents__archives-head"
              aria-expanded={archivesOpen}
              onClick={() => setArchivesOpen((v) => !v)}
            >
              <Icon
                icon={archivesOpen ? "solar:alt-arrow-down-linear" : "solar:alt-arrow-right-linear"}
                width={13}
                height={13}
              />
              <span>Archives ({archives.length})</span>
            </button>
            {archivesOpen
              ? archives.map((s) => (
                  <div
                    key={s.id}
                    className="axe-agents__row axe-agents__row--archived"
                    onClick={() => setSelectedId(s.id)}
                  >
                    <Icon icon="solar:archive-linear" width={14} height={14} />
                    <span className="axe-agents__name">{s.name || s.id.slice(0, 8)}</span>
                    <button
                      type="button"
                      className="axe-agents__icon-btn"
                      title="Rétablir"
                      aria-label={`Rétablir ${s.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void retablir(s.id);
                      }}
                    >
                      <Icon icon="solar:refresh-linear" width={14} height={14} />
                    </button>
                    <button
                      type="button"
                      className="axe-agents__icon-btn"
                      title="Supprimer définitivement"
                      aria-label={`Supprimer définitivement ${s.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void supprimer(s.id, s.name);
                      }}
                    >
                      <Icon icon="solar:trash-bin-minimalistic-linear" width={14} height={14} />
                    </button>
                  </div>
                ))
              : null}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
