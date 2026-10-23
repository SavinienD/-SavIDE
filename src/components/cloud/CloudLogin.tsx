// axe:cloud — « Se connecter avec Google » screen (first launch, after a
// logout or when the session expired). The browser does the Google part;
// this screen only waits for `cloud_login` to come back.
import { useState } from "react";
import { AxeLogo } from "../../axe/Logo";
import { WindowControls, isWindowsPlatform } from "../WindowControls";
import { cloudApi, errorText, type CloudState } from "./cloudApi";

type Props = {
  /** Reason shown above the button (session expired…). */
  notice?: string | null;
  onConnected: (state: CloudState) => void;
};

const IS_WINDOWS = isWindowsPlatform();

function GoogleMark() {
  // Generic « G » (not the official Google logo).
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M20.5 12.2c0-.6-.1-1.2-.2-1.8H12v3.5h4.8a4.2 4.2 0 0 1-1.8 2.7v2.3h2.9c1.7-1.6 2.6-3.9 2.6-6.7Z"
        fill="currentColor"
      />
      <path
        d="M12 21c2.4 0 4.5-.8 5.9-2.2L15 16.6c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.3A9 9 0 0 0 12 21ZM7 13.8a5.4 5.4 0 0 1 0-3.6V7.9H4a9 9 0 0 0 0 8.2l3-2.3ZM12 6.5c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 4 7.9l3 2.3c.7-2.1 2.7-3.7 5-3.7Z"
        fill="currentColor"
        opacity=".7"
      />
    </svg>
  );
}

export function CloudLogin({ notice, onConnected }: Props) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setWaiting(true);
    try {
      const state = await cloudApi.login();
      onConnected(state);
    } catch (err) {
      const message = errorText(err);
      setError(message.startsWith("connexion annulée") ? null : message);
    } finally {
      setWaiting(false);
    }
  };

  return (
    <div className="axc-login">
      {IS_WINDOWS && (
        <div className="welcome__titlebar" data-tauri-drag-region>
          <WindowControls />
        </div>
      )}
      <main className="axc-login__card">
        <div className="axc-login__mark">
          <AxeLogo variant="mark" size={56} />
        </div>
        <h1 className="axc-login__title">SavIDE</h1>
        <p className="axc-login__subtitle">L'espace de travail de SavIDE</p>

        {notice && !waiting && !error ? (
          <p className="axc-banner axc-banner--warn" role="status">
            {notice}
          </p>
        ) : null}

        {waiting ? (
          <div className="axc-login__wait" role="status">
            <p>
              <span className="axc-spinner" aria-hidden="true" /> Votre navigateur s'est ouvert. Choisissez votre compte de
              l'entreprise, puis revenez ici.
            </p>
            <div className="axc-login__actions">
              <button type="button" className="axc-btn axc-btn--ghost" onClick={() => void cloudApi.reopenLogin().catch(() => undefined)}>
                Rouvrir la page de connexion
              </button>
              <button type="button" className="axc-btn" onClick={() => void cloudApi.cancelLogin()}>
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <>
            {error ? (
              <p className="axc-login__error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="button" className="axc-login__google" onClick={() => void start()} autoFocus>
              <GoogleMark />
              <span>{error ? "Réessayer avec une autre adresse" : "Se connecter avec Google"}</span>
            </button>
            <p className="axc-login__hint">Utilisez votre adresse @exemple.invalid</p>
          </>
        )}


      </main>
    </div>
  );
}
