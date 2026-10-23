// axe:freechat — start a free conversation (no project folder) from the web
// interface. The service gives the session a private scratch folder.
import { useMemo, useState } from "react";
import { service, type ModelRef, type SessionMeta } from "./api";

type Props = {
  sessions: SessionMeta[];
  onCreated: (meta: SessionMeta) => void;
  onBack: () => void;
};

/** Used only when no session exists yet to borrow a model from. */
const FALLBACK_MODEL: ModelRef = { provider: "anthropic", name: "claude-opus-5-5" };

const modelKey = (m: ModelRef) => `${m.provider}/${m.name}`;

/** Models already used by sessions, most recent first (no model picker
 *  exists in the web interface; the IDE configures providers). */
function knownModels(sessions: SessionMeta[]): ModelRef[] {
  const seen = new Map<string, ModelRef>();
  for (const s of [...sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs)) {
    if (s.model?.provider && !seen.has(modelKey(s.model))) seen.set(modelKey(s.model), s.model);
  }
  return seen.size ? [...seen.values()] : [FALLBACK_MODEL];
}

export function NewConversation({ sessions, onCreated, onBack }: Props) {
  const models = useMemo(() => knownModels(sessions), [sessions]);
  const [model, setModel] = useState(() => modelKey(models[0]));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = models.find((m) => modelKey(m) === model) ?? models[0];
      onCreated(await service.createFree(chosen, message));
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  };

  return (
    <div className="newconv">
      <button type="button" className="conv__back" onClick={onBack} aria-label="Retour">
        ←
      </button>
      <div className="newconv__card">
        <h1>Nouvelle conversation</h1>
        <p className="muted">Discutez sans dossier de projet ; les fichiers produits restent dans un dossier privé.</p>
        <textarea
          rows={5}
          autoFocus
          placeholder="Votre message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="newconv__row">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modèle">
            {models.map((m) => (
              <option key={modelKey(m)} value={modelKey(m)}>
                {m.provider} / {m.name}
              </option>
            ))}
          </select>
          <button type="button" className="primary" disabled={!text.trim() || busy} onClick={() => void start()}>
            {busy ? "Création…" : "Démarrer"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
