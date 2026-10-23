import { AxeLogo } from "../../axe/Logo";
import { useCallback, useEffect, useState } from "react";
import { WindowControls, isWindowsPlatform } from "../WindowControls";
import { connectionsApi, type ServiceStatus } from "../settings/connectionsApi";
import { errorText, type CloudState } from "./cloudApi";

const IS_WINDOWS = isWindowsPlatform();

export function isServiceStatus(value: ServiceStatus): boolean {
  return Boolean(value && (typeof value.pid === "number" || typeof value.version === "string" || typeof value.listen === "string"));
}

type Props = {
  cloud: CloudState;
  onOpenPrime: () => Promise<void>;
  /** Ouvre l'unique espace SavIDE (IDE) sur la connexion cloud. */
  onEnterWorkspace: () => Promise<void>;
  onLogout: () => Promise<void>;
};

/** V2 post-login entry: dashboard opens in system browser; the existing remote sessions view is the L1 bridge to the VM. */
export function ConnectedScreen({ cloud, onOpenPrime, onEnterWorkspace, onLogout }: Props) {
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const list = await connectionsApi.list();
    setConnectionIds(list.connections.map((c) => c.id));
  }, []);

  useEffect(() => { void refresh().catch((e) => setError(errorText(e))); }, [refresh]);

  const returnToAxe = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!connectionIds.includes("axe-cloud")) throw new Error("La connexion Axe Cloud n'est pas enregistrée. Déconnectez-vous puis reconnectez-vous.");
      await connectionsApi.setActive("axe-cloud");
      const status = await connectionsApi.test("axe-cloud");
      // Daemon `status` reports pid/version/listen, not a boolean `running`.
      // A successful status RPC proves liveness; requiring that absent field
      // made every healthy service look unavailable.
      if (!isServiceStatus(status)) {
        throw new Error("Le service Axe Cloud a répondu avec un statut invalide. Vérifiez la connexion distante dans Réglages > Connexions.");
      }
      await onEnterWorkspace();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  const openDashboard = async () => {
    setBusy(true);
    setError(null);
    try { await onOpenPrime(); } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try { await onLogout(); } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="axc-login axc-connected">
      {IS_WINDOWS ? <div className="welcome__titlebar" data-tauri-drag-region><WindowControls /></div> : null}
      <main className="axc-login__card" aria-labelledby="v2-connected-title">
        <div className="axc-login__mark"><AxeLogo variant="mark" size={56} /></div>
        <p className="axc-connected__status" role="status">Vous êtes connecté</p>
        <h1 className="axc-login__title" id="v2-connected-title">{cloud.email}</h1>
        <>
            <p className="axc-login__subtitle">Votre espace de travail SavIDE est prêt.</p>
            <div className="axc-connected__actions">
              <button type="button" className="axc-login__google" disabled={busy} onClick={() => void returnToAxe()}>{busy ? "Ouverture…" : "Revenir dans SavIDE"}</button>
              <button type="button" className="axc-btn axc-btn--ghost" disabled={busy} onClick={() => void openDashboard()}>Ouvrir le tableau de bord Prime</button>
            </div>
            {error ? <p className="axc-login__error" role="alert">{error}</p> : null}
            <button type="button" className="axc-login__local" disabled={busy} onClick={() => void logout()}>Se déconnecter</button>
        </>
      </main>
    </div>
  );
}
