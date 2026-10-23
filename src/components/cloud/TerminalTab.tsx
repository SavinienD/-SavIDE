// axe:cloud — « Terminal » tab (admin): opens /prime/terminal on the server
// (Prime, OpenCode or bash in tmux, resumed after a cut) in the system
// browser, already signed in through /app/code-web. Never in a window of the
// app: a remote page there would reach the app's local commands.
import { useState } from "react";
import { cloudApi, errorText } from "./cloudApi";

const CHOICES = [
  { id: "prime", title: "Prime", text: "La session de Prime sur le serveur (reprise si elle existe déjà)." },
  { id: "opencode", title: "OpenCode", text: "L'assistant de code gratuit, dans un terminal du serveur." },
  { id: "bash", title: "bash", text: "Un terminal du serveur, pour l'administration." },
] as const;

export function TerminalTab() {
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (session: string) => {
    setBusy(session);
    setError(null);
    setOpened(null);
    try {
      await cloudApi.openWeb(`/prime/terminal?session=${session}`);
      setOpened(session);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="axc-pane">
      <div className="axc-terminal">
        <h2 className="axc-login__title">Terminal du serveur</h2>
        <p className="axc-login__subtitle">
          Chaque choix ouvre un onglet de votre navigateur, déjà connecté. Si vous le fermez, la session continue sur le serveur et
          reprend à la prochaine ouverture.
        </p>
        <div className="axc-terminal__choices">
          {CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="axc-terminal__choice"
              onClick={() => void open(choice.id)}
              disabled={busy !== null}
            >
              <strong>{busy === choice.id ? "Ouverture…" : choice.title}</strong>
              <span>{choice.text}</span>
            </button>
          ))}
        </div>
        {opened ? (
          <p className="axc-login__hint" role="status">
            Terminal « {opened} » ouvert dans votre navigateur.
          </p>
        ) : null}
        {error ? (
          <p className="axc-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
