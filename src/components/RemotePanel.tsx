import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import { api } from "../lib/ipc";
import type { RemoteDevice, RemoteStatus } from "../types";

type Props = {
  initialStatus?: RemoteStatus | null;
  onStatusChange?: (status: RemoteStatus) => void;
};

const REMOTE_STATUS_EVENT = "remote-status-changed";

function publicUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
}

export function RemotePanel({ initialStatus = null, onStatusChange }: Props) {
  const [status, setStatus] = useState<RemoteStatus | null>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // axe:cleanup — self-hosted relay URL (empty until configured).
  const [relayDraft, setRelayDraft] = useState(initialStatus?.relayUrl ? publicUrl(initialStatus.relayUrl) : "") // axe:relais-defaut;
  const [relayTouched, setRelayTouched] = useState(false);
  const relayTouchedRef = useRef(false);
  relayTouchedRef.current = relayTouched;

  const applyStatus = useCallback(
    (next: RemoteStatus) => {
      setStatus(next);
      setRelayDraft((draft) => (relayTouchedRef.current ? draft : next.relayUrl ? publicUrl(next.relayUrl) : ""));
      onStatusChange?.(next);
    },
    [onStatusChange],
  );

  const refresh = useCallback(async () => {
    try {
      applyStatus(await api.remoteGetStatus());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [applyStatus]);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void listen<RemoteStatus>(REMOTE_STATUS_EVENT, (event) => {
      applyStatus(event.payload);
    }).then((nextUnlisten) => {
      if (cancelled) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyStatus]);

  const runAction = useCallback(
    async (action: () => Promise<RemoteStatus>) => {
      setBusy(true);
      try {
        applyStatus(await action());
        setError(null);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [applyStatus],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => runAction(() => api.remoteSetEnabled(enabled)),
    [runAction],
  );
  const saveRelay = useCallback(async () => {
    await runAction(() => api.remoteSetEnabled(status?.enabled ?? false, relayDraft.trim()));
    setRelayTouched(false);
  }, [runAction, status?.enabled, relayDraft]);
  const startPairing = useCallback(
    () => runAction(() => api.remoteStartPairing()),
    [runAction],
  );
  const stopPairing = useCallback(
    () => runAction(() => api.remoteStopPairing()),
    [runAction],
  );

  const revokeDevice = useCallback(
    (device: RemoteDevice) => {
      if (
        !window.confirm(
          `Révoquer ${device.name} ? L'accès est coupé immédiatement et il devra être appairé de nouveau.`,
        )
      ) {
        return;
      }
      void runAction(() => api.remoteRevokeDevice(device.id));
    },
    [runAction],
  );

  const enabled = status?.enabled ?? false;
  const relayConfigured = !!status?.relayUrl;
  const pairing = status?.pairing ?? null;
  const devices = status?.devices ?? [];
  const activeDevices = devices.filter((device) => !device.revokedAtMs);
  const revokedDevices = devices.filter((device) => device.revokedAtMs);
  const onlineCount = activeDevices.filter((device) => device.connected).length;

  return (
    <div className="remote-panel">
      <div className="remote-panel__inner">
        <header className="remote-panel__head">
          <div className="remote-panel__head-text">
            <h1>Accès à distance</h1>
            <p>
              Pilotez les conversations SavIDE depuis un téléphone appairé, via votre propre relais
              (image Docker du dossier <code>remote/</code>). Les messages restent chiffrés de bout
              en bout entre ce PC et vos appareils.
            </p>
          </div>
          <button
            type="button"
            className="remote-panel__switch"
            role="switch"
            aria-checked={enabled}
            data-on={enabled ? "true" : "false"}
            disabled={busy || !status || (!enabled && !relayConfigured)}
            onClick={() => setEnabled(!enabled)}
            title={!relayConfigured ? "Renseignez d'abord l'adresse du relais" : enabled ? "Désactiver l'accès à distance" : "Activer l'accès à distance"}
          >
            <span className="remote-panel__switch-thumb" />
          </button>
        </header>

        <section className="remote-panel__block">
          <div className="remote-panel__block-head">
            <div>
              <h2>Relais</h2>
              <p>Adresse HTTPS de votre relais auto-hébergé, par exemple https://relay.exemple.fr.</p>
            </div>
          </div>
          <div className="remote-panel__relay">
            <input
              type="url"
              value={relayDraft}
              placeholder="https://relay.exemple.fr"
              spellCheck={false}
              onChange={(e) => {
                setRelayDraft(e.target.value);
                setRelayTouched(true);
              }}
            />
            <button
              type="button"
              className="settings-pane__btn"
              data-primary={relayTouched ? "true" : "false"}
              disabled={busy || !relayTouched}
              onClick={() => void saveRelay()}
            >
              Enregistrer
            </button>
          </div>
          {!relayConfigured ? (
            <p className="remote-panel__hint" data-tone="warn">
              Aucun relais configuré : l'accès à distance reste inactif. Déployez le relais (voir <code>remote/README.md</code>),
              puis saisissez son URL ici.
            </p>
          ) : null}
        </section>

        <div className="remote-panel__status" role="list">
          <StatusChip
            icon="solar:cloud-linear"
            label="Relais"
            value={status?.relayConnected ? "Connecté" : "Hors ligne"}
            tone={status?.relayConnected ? "ok" : "off"}
          />
          <StatusChip
            icon="solar:smartphone-linear"
            label="Appareils"
            value={
              activeDevices.length === 0
                ? "Aucun appairé"
                : `${onlineCount}/${activeDevices.length} en ligne`
            }
            tone={onlineCount > 0 ? "ok" : "off"}
          />
          <StatusChip
            icon="solar:shield-check-linear"
            label="Joignable"
            value={status?.reachable ? "Oui" : "Non"}
            tone={status?.reachable ? "ok" : "off"}
          />
        </div>

        <section className="remote-panel__block">
          <div className="remote-panel__block-head">
            <div>
              <h2>Appairage</h2>
              <p>Le code à 6 chiffres n'est accepté que tant que cet écran est ouvert.</p>
            </div>
            <button
              type="button"
              className="settings-pane__btn"
              data-primary={enabled && !pairing ? "true" : "false"}
              disabled={busy || !enabled}
              onClick={pairing ? stopPairing : startPairing}
            >
              {pairing ? "Fermer" : "Ouvrir l'appairage"}
            </button>
          </div>

          {pairing ? (
            <div className="remote-panel__pairing">
              <div className="remote-panel__code" aria-label="Code d'appairage">
                {pairing.code.split("").map((digit, index) => (
                  <span key={`${digit}-${index}`}>{digit}</span>
                ))}
              </div>
              <QrCode value={pairing.qrUrl} />
              <div className="remote-panel__pairing-copy">
                <span>Scannez le code, ou ouvrez ce lien sur le téléphone :</span>
                <a href={pairing.qrUrl}>{pairing.qrUrl}</a>
                <small>
                  {pairing.attemptsRemaining} essai
                  {pairing.attemptsRemaining === 1 ? "" : "s"} restant{pairing.attemptsRemaining === 1 ? "" : "s"} avant blocage.
                </small>
              </div>
            </div>
          ) : (
            <p className="remote-panel__hint">
              {enabled
                ? "Ouvrez l'appairage pour afficher un nouveau code et un QR pour un téléphone."
                : "Activez l'accès à distance, puis ouvrez l'appairage pour ajouter un appareil."}
            </p>
          )}
        </section>

        <section className="remote-panel__block">
          <div className="remote-panel__block-head">
            <div>
              <h2>Appareils appairés</h2>
              <p>Révoquez immédiatement un téléphone perdu, vendu ou remplacé.</p>
            </div>
          </div>

          {activeDevices.length === 0 ? (
            <p className="remote-panel__hint">Aucun appareil appairé pour l'instant.</p>
          ) : (
            <div className="remote-panel__devices">
              {activeDevices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  busy={busy}
                  onRevoke={() => revokeDevice(device)}
                />
              ))}
            </div>
          )}

          {revokedDevices.length > 0 && (
            <details className="remote-panel__revoked">
              <summary>
                {revokedDevices.length} appareil{revokedDevices.length === 1 ? "" : "s"} révoqué
                {revokedDevices.length === 1 ? "" : "s"}
              </summary>
              <div className="remote-panel__devices">
                {revokedDevices.map((device) => (
                  <DeviceRow key={device.id} device={device} busy revoked />
                ))}
              </div>
            </details>
          )}
        </section>

        {error && (
          <button
            type="button"
            className="remote-panel__error"
            onClick={() => setError(null)}
            title="Fermer"
          >
            <Icon icon="solar:danger-triangle-linear" width={14} height={14} />
            <span>{error}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function StatusChip({
  icon,
  label,
  value,
  tone,
}: {
  icon: string;
  label: string;
  value: string;
  tone: "ok" | "off";
}) {
  return (
    <div className="remote-panel__chip" data-tone={tone} role="listitem">
      <Icon icon={icon} width={15} height={15} />
      <span className="remote-panel__chip-label">{label}</span>
      <span className="remote-panel__chip-value">{value}</span>
    </div>
  );
}

function DeviceRow({
  device,
  busy,
  revoked = false,
  onRevoke,
}: {
  device: RemoteDevice;
  busy: boolean;
  revoked?: boolean;
  onRevoke?: () => void;
}) {
  const connected = !revoked && device.connected;
  return (
    <div
      className="remote-panel__device"
      data-revoked={revoked ? "true" : "false"}
      data-connected={connected ? "true" : "false"}
    >
      <span className="remote-panel__device-icon">
        <Icon icon="solar:smartphone-linear" width={16} height={16} />
      </span>
      <div className="remote-panel__device-text">
        <strong>{device.name}</strong>
        <span>
          {revoked
            ? "Révoqué"
            : connected
              ? "Connecté"
              : device.lastSeenAtMs
                ? `Vu le ${formatDate(device.lastSeenAtMs)}`
                : `Appairé le ${formatDate(device.pairedAtMs)}`}
        </span>
      </div>
      <div className="remote-panel__device-actions">
        {device.pushEnabled && !revoked && (
          <span className="remote-panel__device-push" title="Notifications push activées">
            <Icon icon="solar:bell-linear" width={12} height={12} />
            Notifications
          </span>
        )}
        {!revoked && (
          <button
            type="button"
            className="settings-pane__btn"
            disabled={busy}
            onClick={onRevoke}
          >
            Révoquer
          </button>
        )}
      </div>
    </div>
  );
}

function QrCode({ value }: { value: string }) {
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=0&data=${encodeURIComponent(value)}`;
  return (
    <div className="remote-panel__qr">
      <img src={src} alt="QR code d'appairage" width={112} height={112} />
    </div>
  );
}

function formatDate(ms: number) {
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString("fr-FR");
  }
}
