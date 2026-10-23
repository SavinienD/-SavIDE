// axe:gemini-web — Settings > Providers card for Gemini through the
// gemini.google.com web app (models of the Google AI subscription that the
// APIs do not expose, e.g. Gemini 4 Argon with Google AI Pro).
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";

export type GeminiWebStatus = {
  connected: boolean;
  browserFound: boolean;
  browserPath?: string | null;
  updatedMs?: number | null;
  models: { id: string; label: string; description: string }[];
  error?: string | null;
};

const PROVIDERS_CHANGED_EVENT = "axecode:providers-changed";

export const geminiWebApi = {
  status: (verify = false) => invoke<GeminiWebStatus>("gemini_web_status", { verify }),
  login: () => invoke<GeminiWebStatus>("gemini_web_login"),
  logout: () => invoke<GeminiWebStatus>("gemini_web_logout"),
};

export function GeminiWebCard() {
  const [status, setStatus] = useState<GeminiWebStatus | null>(null);
  const [busy, setBusy] = useState<"login" | "check" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (verify: boolean) => {
    try {
      const next = await geminiWebApi.status(verify);
      setStatus(next);
      setError(next.error ?? null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const run = async (kind: "login" | "check" | "logout") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "check") {
        await refresh(true);
      } else {
        const next = kind === "login" ? await geminiWebApi.login() : await geminiWebApi.logout();
        setStatus(next);
        setError(next.error ?? null);
        window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const connected = Boolean(status?.connected);
  const tone = busy === "login" ? "pending" : error ? "error" : connected ? "ok" : "off";
  const label =
    busy === "login" ? "Connexion…" : error ? "À vérifier" : connected ? "Connecté" : "Non connecté";

  return (
    <section className="settings-pane__provider-card">
      <div className="settings-pane__provider-main">
        <div className="settings-pane__provider-mark" aria-hidden>
          <Icon icon="simple-icons:googlegemini" width={24} height={24} />
        </div>
        <div className="settings-pane__provider-copy">
          <div className="settings-pane__provider-title-row">
            <h2>Gemini (app web)</h2>
            <span className="settings-pane__chip" data-tone={tone}>
              <span className="settings-pane__chip-dot" />
              {label}
            </span>
          </div>
          <p>
            Utilise votre abonnement Google AI via gemini.google.com (Gemini 4 Argon, 3.1 Pro, 3.8 Flash).
            Connexion une seule fois dans une fenêtre Chrome dédiée ; SavIDE la réutilise ensuite en arrière-plan.
            Non officiel : l'outil python est imité par du texte.
          </p>
          {busy === "login" && (
            <div className="settings-pane__provider-meta">
              <span>Connectez-vous dans la fenêtre Chrome qui vient de s'ouvrir (elle se ferme toute seule).</span>
            </div>
          )}
          {connected && (
            <div className="settings-pane__provider-meta">
              {status?.models.length ? (
                status.models.map((m) => <span key={m.id}>{m.label}</span>)
              ) : (
                <span>
                  Session enregistrée
                  {status?.updatedMs ? ` (${new Date(status.updatedMs).toLocaleString("fr-FR")})` : ""}
                </span>
              )}
            </div>
          )}
          {status && !status.browserFound && (
            <div className="settings-pane__provider-error">Chrome, Edge ou Brave est nécessaire.</div>
          )}
          {error && <div className="settings-pane__provider-error">{error}</div>}
        </div>
      </div>
      <div className="settings-pane__provider-actions">
        {connected ? (
          <>
            <button type="button" className="settings-pane__btn" onClick={() => void run("check")} disabled={busy !== null}>
              <Icon icon="solar:refresh-linear" width={13} height={13} />
              <span>{busy === "check" ? "Vérification…" : "Vérifier"}</span>
            </button>
            <button type="button" className="settings-pane__btn" onClick={() => void run("login")} disabled={busy !== null}>
              <Icon icon="solar:login-2-linear" width={13} height={13} />
              <span>Se reconnecter</span>
            </button>
            <button type="button" className="settings-pane__btn" onClick={() => void run("logout")} disabled={busy !== null}>
              <Icon icon="solar:logout-2-linear" width={13} height={13} />
              <span>{busy === "logout" ? "Déconnexion…" : "Déconnecter"}</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            className="settings-pane__btn"
            data-primary="true"
            onClick={() => void run("login")}
            disabled={busy !== null || (status !== null && !status.browserFound)}
          >
            <Icon icon="solar:login-2-linear" width={13} height={13} />
            <span>{busy === "login" ? "En attente de la connexion…" : "Se connecter"}</span>
          </button>
        )}
      </div>
    </section>
  );
}
